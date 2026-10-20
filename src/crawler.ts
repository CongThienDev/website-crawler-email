import { BasicCrawler } from "@crawlee/basic";
import { log } from "@crawlee/core";
import { PlaywrightCrawler } from "@crawlee/playwright";
import { gotScraping } from "got-scraping";
import { chromium } from "playwright";
import { createRequire } from "node:module";
import { DomainLimiter } from "./domainLimiter.js";
import { extractEmails, findContactLinks, hasOwnDomainEmail, mergeEmailHits } from "./extract.js";
import type { CrawlConfig, CrawlResult, CrawlTarget, EmailHit, FallbackReason } from "./types.js";
import { originOf } from "./url.js";
import type { CrawlPhase } from "./runLogger.js";

interface RobotRules {
  isAllowed(url: string, userAgent?: string): boolean | undefined;
}

const require = createRequire(import.meta.url);
const robotsParser = require("robots-parser") as (url: string, content: string) => RobotRules;

interface FetchResult {
  body: string;
  finalUrl: string;
  statusCode: number;
}

const RETRYABLE_STATUS_CODES = [408, 500, 502, 503, 504];
const RETRYABLE_ERROR_CODES = ["ETIMEDOUT", "ECONNRESET", "ECONNREFUSED", "ENOTFOUND", "ENETUNREACH", "EAI_AGAIN"];

export interface CrawlObserver {
  onStart?: (target: CrawlTarget, phase: CrawlPhase) => void;
  onResult?: (result: CrawlResult, phase: CrawlPhase) => void;
  onThrottle?: (phase: CrawlPhase, previous: number, next: number, reason: string) => void;
}

export class AdaptiveConcurrency {
  private healthy = 0;
  current: number;

  constructor(private readonly maximum: number, private readonly minimum = 1) {
    this.current = maximum;
  }

  observe(status: number | null, errorClass?: CrawlResult["errorClass"]): { previous: number; next: number; reason: string } | null {
    // Only 429 means "slow down". A 403 is one site's bot wall; every target is a different domain, so cutting
    // global concurrency for it starved the run (25 -> 3 within a minute on chain-heavy inputs).
    const blocked = status === 429 || errorClass === "http_429";
    if (blocked) {
      this.healthy = 0;
      const previous = this.current;
      this.current = Math.max(this.minimum, Math.ceil(this.current * 0.7));
      return this.current < previous ? { previous, next: this.current, reason: `HTTP ${status ?? errorClass}` } : null;
    }
    if (status !== null && status < 400) this.healthy += 1;
    if (this.healthy >= 20 && this.current < this.maximum) {
      const previous = this.current;
      this.current += 1;
      this.healthy = 0;
      return { previous, next: this.current, reason: "20 healthy responses" };
    }
    return null;
  }
}

function classifyError(error: unknown, statusCode: number | null): CrawlResult["errorClass"] {
  if (statusCode === 403) return "http_403";
  if (statusCode === 429) return "http_429";
  if (statusCode !== null && statusCode >= 400 && statusCode < 500) return "http_4xx";
  if (statusCode !== null && statusCode >= 500) return "http_5xx";
  const message = error instanceof Error ? error.message : String(error);
  if (/timeout|timed out|ETIMEDOUT/i.test(message)) return "timeout";
  if (/ENOTFOUND|ECONN|socket|network|DNS/i.test(message)) return "network";
  return "other";
}

function isJavascriptShell(body: string): boolean {
  const scripts = (body.match(/<script\b/gi) ?? []).length;
  const visible = body.replace(/<script[\s\S]*?<\/script>/gi, "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
  return scripts >= 2 && visible.length < 160;
}

class RobotsPolicy {
  private readonly cache = new Map<string, Promise<RobotRules | null>>();

  constructor(
    private readonly enabled: boolean,
    private readonly userAgent: string,
    private readonly timeoutMs: number,
    private readonly limiter: DomainLimiter,
  ) {}

  private async load(url: string): Promise<RobotRules | null> {
    if (!this.enabled) return null;
    const origin = originOf(url);
    let pending = this.cache.get(origin);
    if (!pending) {
      pending = this.limiter
        .run(`${origin}/robots.txt`, async () => {
          try {
            const response = await gotScraping({
              url: `${origin}/robots.txt`,
              headers: { "user-agent": this.userAgent },
              timeout: { request: this.timeoutMs },
              retry: { limit: 0, statusCodes: [], errorCodes: [], enforceRetryRules: true },
              throwHttpErrors: false,
            });
            if (response.statusCode >= 400) return null;
            return robotsParser(`${origin}/robots.txt`, String(response.body));
          } catch {
            return null;
          }
        })
        .catch(() => null);
      this.cache.set(origin, pending);
    }
    return pending;
  }

  async allowed(url: string): Promise<boolean> {
    const robots = await this.load(url);
    return robots?.isAllowed(url, this.userAgent) !== false;
  }
}

async function fetchPage(
  url: string,
  config: CrawlConfig,
  limiter: DomainLimiter,
): Promise<FetchResult> {
  return limiter.run(url, async () => {
    const response = await gotScraping({
      url,
      headers: {
        "user-agent": config.userAgent,
        accept: "text/html,application/xhtml+xml,application/json;q=0.8,*/*;q=0.5",
        "accept-language": "en-US,en;q=0.9",
      },
      timeout: { request: config.timeoutMs },
      retry: {
        limit: config.retries,
        statusCodes: RETRYABLE_STATUS_CODES,
        errorCodes: RETRYABLE_ERROR_CODES,
        enforceRetryRules: true,
      },
      throwHttpErrors: false,
      followRedirect: true,
      maxRedirects: 7,
      responseType: "text",
    });
    return { body: String(response.body), finalUrl: response.url, statusCode: response.statusCode };
  });
}

async function crawlOneHttp(
  target: CrawlTarget,
  config: CrawlConfig,
  limiter: DomainLimiter,
  robots: RobotsPolicy,
): Promise<CrawlResult> {
  const startedAt = Date.now();
  let finalUrl = target.url;
  let httpStatus: number | null = null;
  let pagesCrawled = 0;
  let httpRequests = 0;
  let allHits: EmailHit[] = [];
  let error = "";
  let errorClass: CrawlResult["errorClass"];
  let robotsMs = 0;
  let fetchMs = 0;
  let parseMs = 0;
  let javascriptShell = false;
  let homepageSucceeded = false;

  const robotsStarted = Date.now();
  if (!(await robots.allowed(target.url))) {
    robotsMs = Date.now() - robotsStarted;
    return {
      key: target.key,
      inputUrl: target.url,
      finalUrl,
      status: "robots_denied",
      primaryEmail: "",
      emails: [],
      pagesCrawled: 0,
      httpRequests: 0,
      browserPages: 0,
      httpStatus: null,
      durationMs: Date.now() - startedAt,
      error: "robots.txt không cho phép crawl URL này",
      completedAt: new Date().toISOString(),
      fallbackReason: "none",
      errorClass: "robots",
      robotsMs,
    };
  }
  robotsMs = Date.now() - robotsStarted;

  try {
    httpRequests += 1;
    const fetchStarted = Date.now();
    const first = await fetchPage(target.url, config, limiter);
    fetchMs += Date.now() - fetchStarted;
    pagesCrawled += 1;
    finalUrl = first.finalUrl;
    httpStatus = first.statusCode;
    if (first.statusCode >= 400) throw new Error(`HTTP ${first.statusCode}`);
    homepageSucceeded = true;

    const parseStarted = Date.now();
    allHits = extractEmails(first.body, finalUrl);
    parseMs += Date.now() - parseStarted;
    javascriptShell = allHits.length === 0 && isJavascriptShell(first.body);
    if (config.collectAll || !hasOwnDomainEmail(allHits, finalUrl)) {
      const extraPages = Math.min(config.maxPages - 1, config.collectAll ? config.maxPages - 1 : config.contactPages);
      const links = findContactLinks(first.body, finalUrl).slice(0, Math.max(0, extraPages));
      for (const link of links) {
        if (!config.collectAll && hasOwnDomainEmail(allHits, finalUrl)) break;
        if (!(await robots.allowed(link.url))) continue;
        try {
          httpRequests += 1;
          const pageFetchStarted = Date.now();
          const page = await fetchPage(link.url, config, limiter);
          fetchMs += Date.now() - pageFetchStarted;
          pagesCrawled += 1;
          if (page.statusCode < 400) {
            const pageParseStarted = Date.now();
            allHits = mergeEmailHits(allHits, extractEmails(page.body, page.finalUrl));
            parseMs += Date.now() - pageParseStarted;
          }
        } catch (pageError) {
          error = pageError instanceof Error ? pageError.message : String(pageError);
          errorClass = classifyError(pageError, null);
        }
      }
    }
  } catch (crawlError) {
    error = crawlError instanceof Error ? crawlError.message : String(crawlError);
    errorClass = classifyError(crawlError, httpStatus);
  }

  const fallbackReason: FallbackReason = allHits.length
    ? "none"
    : javascriptShell
      ? "javascript"
      : homepageSucceeded
        ? "no_email"
        : errorClass === "timeout"
          ? "timeout"
          : "none";

  return {
    key: target.key,
    inputUrl: target.url,
    finalUrl,
    status: allHits.length ? "found_http" : homepageSucceeded ? "no_email" : error ? "http_error" : "no_email",
    primaryEmail: allHits[0]?.email ?? "",
    emails: allHits,
    pagesCrawled,
    httpRequests,
    browserPages: 0,
    httpStatus,
    durationMs: Date.now() - startedAt,
    error,
    completedAt: new Date().toISOString(),
    fallbackReason,
    errorClass,
    robotsMs,
    fetchMs,
    parseMs,
    primaryEmailScore: allHits[0]?.score,
  };
}

export async function crawlHttpTargets(
  targets: CrawlTarget[],
  config: CrawlConfig,
  onResult: (result: CrawlResult) => void,
  observer: CrawlObserver = {},
): Promise<void> {
  if (!targets.length) return;
  log.setLevel(log.LEVELS.OFF);
  const limiter = new DomainLimiter(config.domainDelayMs);
  const robots = new RobotsPolicy(config.respectRobots, config.userAgent, config.robotsTimeoutMs, limiter);
  const adaptive = new AdaptiveConcurrency(config.concurrency);
  const crawler = new BasicCrawler({
    maxConcurrency: config.concurrency,
    minConcurrency: 1,
    // Start at full concurrency; Crawlee otherwise ramps up from 1 and stalls at 3-4 on a laptop.
    autoscaledPoolOptions: { desiredConcurrency: config.concurrency },
    maxRequestRetries: 0,
    requestHandlerTimeoutSecs: Math.max(30, Math.ceil((config.timeoutMs * (config.maxPages + 2)) / 1000)),
    async requestHandler({ request }) {
      const target = request.userData.target as CrawlTarget;
      observer.onStart?.(target, "HTTP");
      const result = await crawlOneHttp(target, config, limiter, robots);
      onResult(result);
      observer.onResult?.(result, "HTTP");
      const change = adaptive.observe(result.httpStatus, result.errorClass);
      if (change && crawler.autoscaledPool) {
        crawler.autoscaledPool.maxConcurrency = change.next;
        crawler.autoscaledPool.desiredConcurrency = change.next;
        observer.onThrottle?.("HTTP", change.previous, change.next, change.reason);
      }
    },
    async failedRequestHandler({ request }, failure) {
      const target = request.userData.target as CrawlTarget;
      const result: CrawlResult = {
        key: target.key,
        inputUrl: target.url,
        finalUrl: target.url,
        status: "http_error",
        primaryEmail: "",
        emails: [],
        pagesCrawled: 0,
        httpRequests: 0,
        browserPages: 0,
        httpStatus: null,
        durationMs: 0,
        error: failure instanceof Error ? failure.message : String(failure),
        completedAt: new Date().toISOString(),
        fallbackReason: "timeout",
        errorClass: classifyError(failure, null),
      };
      observer.onStart?.(target, "HTTP");
      onResult(result);
      observer.onResult?.(result, "HTTP");
      const change = adaptive.observe(result.httpStatus, result.errorClass);
      if (change && crawler.autoscaledPool) {
        crawler.autoscaledPool.maxConcurrency = change.next;
        crawler.autoscaledPool.desiredConcurrency = change.next;
        observer.onThrottle?.("HTTP", change.previous, change.next, change.reason);
      }
    },
  });
  await crawler.run(
    targets.map((target) => ({
      url: target.url,
      uniqueKey: target.key,
      userData: { target },
    })),
  );
}

export async function crawlBrowserFallback(
  pending: CrawlResult[],
  config: CrawlConfig,
  onResult: (result: CrawlResult) => void,
  observer: CrawlObserver = {},
): Promise<void> {
  if (!config.browserFallback || !pending.length) return;
  const limiter = new DomainLimiter(config.domainDelayMs);
  const robots = new RobotsPolicy(config.respectRobots, config.userAgent, config.robotsTimeoutMs, limiter);
  const adaptive = new AdaptiveConcurrency(config.browserConcurrency);
  log.setLevel(log.LEVELS.OFF);
  const crawler = new PlaywrightCrawler({
    maxConcurrency: config.browserConcurrency,
    minConcurrency: 1,
    autoscaledPoolOptions: { desiredConcurrency: config.browserConcurrency },
    maxRequestRetries: 0,
    navigationTimeoutSecs: Math.ceil(config.browserTimeoutMs / 1000),
    requestHandlerTimeoutSecs: Math.max(45, Math.ceil((config.browserTimeoutMs * config.maxPages) / 1000)),
    launchContext: {
      launcher: chromium,
      launchOptions: { headless: true, args: ["--disable-dev-shm-usage"] },
    },
    preNavigationHooks: [
      async ({ page, request }, gotoOptions) => {
        const previous = request.userData.previous as CrawlResult;
        observer.onStart?.({ key: previous.key, url: previous.finalUrl || previous.inputUrl }, "BROWSER");
        request.userData.navigationStartedAt = Date.now();
        gotoOptions.waitUntil = "domcontentloaded";
        await page.route("**/*", async (route) => {
          const type = route.request().resourceType();
          if (["image", "media", "font"].includes(type)) await route.abort();
          else await route.continue();
        });
      },
    ],
    async requestHandler({ page, request, response }) {
      const previous = request.userData.previous as CrawlResult;
      const startedAt = Date.now();
      const navigationMs = request.userData.navigationStartedAt
        ? startedAt - Number(request.userData.navigationStartedAt)
        : 0;
      let hits = extractEmails(await page.content(), page.url());
      let browserPages = 1;
      if (config.collectAll || !hasOwnDomainEmail(hits, page.url())) {
        const extraPages = Math.min(config.maxPages - 1, config.collectAll ? config.maxPages - 1 : config.contactPages);
        const links = findContactLinks(await page.content(), page.url()).slice(0, Math.max(0, extraPages));
        for (const link of links) {
          if (!config.collectAll && hasOwnDomainEmail(hits, page.url())) break;
          if (!(await robots.allowed(link.url))) continue;
          try {
            await page.goto(link.url, { waitUntil: "domcontentloaded", timeout: config.browserTimeoutMs });
            browserPages += 1;
            hits = mergeEmailHits(hits, extractEmails(await page.content(), page.url()));
          } catch {
            // Keep the homepage result when an optional contact page fails.
          }
        }
      }
      const merged = mergeEmailHits(previous.emails, hits);
      const result: CrawlResult = {
        ...previous,
        finalUrl: page.url() || previous.finalUrl,
        status: merged.length ? "found_browser" : "no_email",
        primaryEmail: merged[0]?.email ?? "",
        emails: merged,
        pagesCrawled: previous.pagesCrawled + browserPages,
        browserPages: previous.browserPages + browserPages,
        httpStatus: response?.status() ?? previous.httpStatus,
        durationMs: previous.durationMs + navigationMs + (Date.now() - startedAt),
        error: merged.length ? "" : previous.error,
        completedAt: new Date().toISOString(),
        fallbackReason: "none",
        errorClass: undefined,
        navigationMs,
        primaryEmailScore: merged[0]?.score,
      };
      onResult(result);
      observer.onResult?.(result, "BROWSER");
      const change = adaptive.observe(result.httpStatus, undefined);
      if (change && crawler.autoscaledPool) {
        crawler.autoscaledPool.maxConcurrency = change.next;
        crawler.autoscaledPool.desiredConcurrency = change.next;
        observer.onThrottle?.("BROWSER", change.previous, change.next, change.reason);
      }
    },
    async failedRequestHandler({ request }, failure) {
      const previous = request.userData.previous as CrawlResult;
      const navigationMs = request.userData.navigationStartedAt
        ? Date.now() - Number(request.userData.navigationStartedAt)
        : 0;
      const result: CrawlResult = {
        ...previous,
        status: "browser_error",
        error: failure instanceof Error ? failure.message : String(failure),
        durationMs: previous.durationMs + navigationMs,
        completedAt: new Date().toISOString(),
        fallbackReason: "timeout",
        errorClass: classifyError(failure, previous.httpStatus),
        navigationMs,
      };
      onResult(result);
      observer.onResult?.(result, "BROWSER");
      const change = adaptive.observe(previous.httpStatus, result.errorClass);
      if (change && crawler.autoscaledPool) {
        crawler.autoscaledPool.maxConcurrency = change.next;
        crawler.autoscaledPool.desiredConcurrency = change.next;
        observer.onThrottle?.("BROWSER", change.previous, change.next, change.reason);
      }
    },
  });

  await crawler.run(
    pending.map((previous) => ({
      url: previous.finalUrl || previous.inputUrl,
      uniqueKey: `browser:${previous.key}`,
      userData: { previous },
    })),
  );
}
