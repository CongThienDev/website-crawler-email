#!/usr/bin/env node
import path from "node:path";
import process from "node:process";
import { Command, Option } from "commander";
import { z } from "zod";
import { crawlBrowserFallback, crawlHttpTargets } from "./crawler.js";
import { loadLeadRows } from "./input.js";
import { ResultJournal } from "./journal.js";
import { writeOutputs } from "./output.js";
import { formatResultLine, formatStartLine, RunLogger } from "./runLogger.js";
import type { CrawlConfig, CrawlResult, CrawlTarget, RunSummary } from "./types.js";

function collect(value: string, previous: string[]): string[] {
  return [...previous, value];
}

const program = new Command()
  .name("website-email-crawler")
  .description("Lấy email công khai từ website trong file lead-ledger (sheet Leads), mỗi Domain crawl một lần.")
  .requiredOption("-i, --input <file>", "File XLSX đầu vào; lặp lại option để đọc nhiều file", collect, [])
  .option("-o, --output <directory>", "Folder kết quả/checkpoint", `runs/run-${new Date().toISOString().replace(/[:.]/g, "-")}`)
  .option("--limit <number>", "Chỉ chạy N website duy nhất đầu tiên để benchmark", "0")
  .option("--concurrency <number>", "Số website chạy HTTP đồng thời", "25")
  .option("--max-pages <number>", "Số trang tối đa mỗi website", "5")
  .option("--contact-pages <number>", "Số trang contact/about ưu tiên khi homepage chưa có email", "3")
  .option("--timeout-ms <number>", "Timeout mỗi HTTP request", "15000")
  .option("--robots-timeout-ms <number>", "Timeout riêng cho robots.txt", "5000")
  .option("--retries <number>", "Số lần retry HTTP", "1")
  .option("--domain-delay-ms <number>", "Khoảng nghỉ tối thiểu giữa request cùng hostname", "300")
  .option("--browser-concurrency <number>", "Số browser page chạy đồng thời (khuyến nghị 4-6)", "4")
  .option("--browser-timeout-ms <number>", "Timeout mỗi lần điều hướng browser", "25000")
  .option("--no-browser-fallback", "Không dùng Playwright khi HTTP không thấy email")
  .option("--collect-all", "Tiếp tục các trang liên hệ sau khi đã thấy email", false)
  .option("--no-respect-robots", "Bỏ kiểm tra robots.txt")
  .option("--log-every <number>", "Giữ tương thích với lệnh cũ; log từng URL luôn bật", "50")
  .addOption(
    new Option("--user-agent <value>", "HTTP User-Agent")
      .default("WebsiteEmailCrawler/1.0")
      .env("EMAIL_CRAWLER_USER_AGENT"),
  )
  .showHelpAfterError();

program.parse();
const raw = program.opts();

const optionsSchema = z.object({
  input: z.array(z.string()).min(1),
  output: z.string().min(1),
  limit: z.coerce.number().int().min(0),
  concurrency: z.coerce.number().int().min(1).max(200),
  maxPages: z.coerce.number().int().min(1).max(20),
  contactPages: z.coerce.number().int().min(1).max(10),
  timeoutMs: z.coerce.number().int().min(1000).max(120000),
  robotsTimeoutMs: z.coerce.number().int().min(1000).max(30000),
  retries: z.coerce.number().int().min(0).max(5),
  domainDelayMs: z.coerce.number().int().min(0).max(60000),
  browserConcurrency: z.coerce.number().int().min(1).max(8),
  browserTimeoutMs: z.coerce.number().int().min(1000).max(120000),
  browserFallback: z.boolean(),
  collectAll: z.boolean(),
  respectRobots: z.boolean(),
  logEvery: z.coerce.number().int().min(1),
  userAgent: z.string().min(1),
});

async function main(): Promise<void> {
  const options = optionsSchema.parse(raw);
  const inputFiles = options.input.map((file) => path.resolve(file));
  const outputDirectory = path.resolve(options.output);
  const logger = new RunLogger(outputDirectory);
  const config: CrawlConfig = {
    concurrency: options.concurrency,
    browserConcurrency: options.browserConcurrency,
    browserFallback: options.browserFallback,
    collectAll: options.collectAll,
    maxPages: options.maxPages,
    contactPages: options.contactPages,
    timeoutMs: options.timeoutMs,
    robotsTimeoutMs: options.robotsTimeoutMs,
    browserTimeoutMs: options.browserTimeoutMs,
    retries: options.retries,
    domainDelayMs: options.domainDelayMs,
    respectRobots: options.respectRobots,
    userAgent: options.userAgent,
    logEvery: options.logEvery,
  };

  const runStarted = new Date();
  logger.info(`READING ${inputFiles.length} INPUT FILE(S), SHEET "Leads"`);
  const rows = (await Promise.all(inputFiles.map((file) => loadLeadRows(file)))).flat();
  const allTargets = new Map<string, CrawlTarget>();
  for (const row of rows) {
    if (row.crawlKey && row.normalizedWebsite && !allTargets.has(row.crawlKey)) {
      allTargets.set(row.crawlKey, { key: row.crawlKey, url: row.normalizedWebsite });
    }
  }
  const selectedTargets = [...allTargets.values()].slice(0, options.limit || undefined);
  const selectedKeys = new Set(selectedTargets.map((target) => target.key));
  for (const row of rows) {
    if (row.crawlKey && !selectedKeys.has(row.crawlKey)) row.preflightStatus = "not_selected_limit";
  }

  const journal = new ResultJournal(outputDirectory);
  const resumed = selectedTargets.filter((target) => journal.has(target.key)).length;
  const pending = selectedTargets.filter((target) => !journal.has(target.key));
  logger.info(
    `Dòng dữ liệu: ${rows.length.toLocaleString("vi-VN")}; website duy nhất hợp lệ: ${allTargets.size.toLocaleString("vi-VN")}; chọn chạy: ${selectedTargets.length.toLocaleString("vi-VN")}; resume: ${resumed.toLocaleString("vi-VN")}.`,
  );

  const save = (result: CrawlResult): void => journal.append(result);
  const completedKeys = new Set(selectedTargets.filter((target) => journal.has(target.key)).map((target) => target.key));
  let active = 0;
  const phaseResults = new Map<string, number>();
  const errorClasses = new Map<string, number>();
  const durations: number[] = [];
  const metricsStarted = Date.now();
  const metricsTimer = setInterval(() => {
    const elapsed = Math.max(1, Date.now() - metricsStarted);
    const rate = ((completedKeys.size - resumed) * 60000) / elapsed;
    logger.info(`METRICS DONE=${completedKeys.size}/${selectedTargets.length} ACTIVE=${active} RATE=${rate.toFixed(1)}/MIN STATUS=${JSON.stringify(Object.fromEntries(phaseResults))}`);
    logger.event({ event: "metrics", done: completedKeys.size, total: selectedTargets.length, active, ratePerMinute: rate, statuses: Object.fromEntries(phaseResults) });
  }, 10000);
  metricsTimer.unref?.();
  const observer = {
    onStart: (target: CrawlTarget, phase: "HTTP" | "BROWSER"): void => {
      active += 1;
      const line = formatStartLine(target, phase, completedKeys.size, selectedTargets.length, active);
      logger.info(line);
      logger.event({ event: "start", key: target.key, url: target.url, phase, done: completedKeys.size, total: selectedTargets.length, active });
    },
    onResult: (result: CrawlResult, phase: "HTTP" | "BROWSER"): void => {
      active = Math.max(0, active - 1);
      completedKeys.add(result.key);
      phaseResults.set(result.status, (phaseResults.get(result.status) ?? 0) + 1);
      if (result.errorClass) errorClasses.set(result.errorClass, (errorClasses.get(result.errorClass) ?? 0) + 1);
      durations.push(result.durationMs);
      const line = formatResultLine(result, phase, completedKeys.size, selectedTargets.length, active);
      logger.info(line);
      logger.event({
        event: "done",
        key: result.key,
        url: result.inputUrl,
        phase,
        status: result.status,
        email: result.primaryEmail || null,
        emailSource: result.emails[0]?.sourceType ?? null,
        emailScore: result.primaryEmailScore ?? result.emails[0]?.score ?? null,
        done: completedKeys.size,
        total: selectedTargets.length,
        active,
        durationMs: result.durationMs,
        pagesCrawled: result.pagesCrawled,
        httpRequests: result.httpRequests,
        browserPages: result.browserPages,
        httpStatus: result.httpStatus,
        error: result.error || null,
        errorClass: result.errorClass ?? null,
        fallbackReason: result.fallbackReason ?? null,
      });
    },
    onThrottle: (phase: "HTTP" | "BROWSER", previous: number, next: number, reason: string): void => {
      logger.warn(`THROTTLE PHASE=${phase} CONCURRENCY=${previous}->${next} REASON=${reason}`);
      logger.event({ event: "throttle", phase, previous, next, reason });
    },
  };
  await crawlHttpTargets(pending, config, save, observer);

  const browserPending = selectedTargets
    .map((target) => journal.get(target.key))
    .filter(
      (result): result is CrawlResult =>
        Boolean(
          result &&
            result.browserPages === 0 &&
            (result.status === "no_email" ||
              ["timeout", "javascript"].includes(result.fallbackReason ?? "") ||
              // Bot walls (Cloudflare and similar) often answer plain HTTP with 403/503 but let a real browser in.
              [403, 503].includes(result.httpStatus ?? 0)),
        ),
    );
  if (config.browserFallback && browserPending.length) {
    logger.info(`PLAYWRIGHT FALLBACK ${browserPending.length.toLocaleString("vi-VN")} WEBSITE(S)`);
    try {
      await crawlBrowserFallback(browserPending, config, save, observer);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error(`BROWSER FALLBACK STOPPED: ${message}`);
      logger.error("INSTALL CHROMIUM WITH: npx playwright install chromium");
      for (const previous of browserPending) {
        const current = journal.get(previous.key);
        if (current && current.browserPages === 0) {
          journal.append({
            ...current,
            status: "browser_error",
            error: `Browser fallback unavailable: ${message}`,
            completedAt: new Date().toISOString(),
          });
        }
      }
    }
  }

  const selectedResults = selectedTargets
    .map((target) => journal.get(target.key))
    .filter((result): result is CrawlResult => Boolean(result));
  const runFinished = new Date();
  clearInterval(metricsTimer);
  const durationMs = runFinished.getTime() - runStarted.getTime();
  const foundByHttp = selectedResults.filter((result) => result.status === "found_http").length;
  const foundByBrowser = selectedResults.filter((result) => result.status === "found_browser").length;
  const foundEmails = foundByHttp + foundByBrowser;
  const errors = selectedResults.filter((result) => ["http_error", "browser_error"].includes(result.status)).length;
  const summary: RunSummary = {
    runStartedAt: runStarted.toISOString(),
    runFinishedAt: runFinished.toISOString(),
    durationMs,
    inputFiles,
    inputRows: rows.length,
    rowsWithWebsite: rows.filter((row) => row.websiteRaw).length,
    uniqueValidWebsites: allTargets.size,
    selectedWebsites: selectedTargets.length,
    resumedWebsites: resumed,
    processedThisRun: pending.length,
    foundEmails,
    foundByHttp,
    foundByBrowser,
    noEmail: selectedResults.filter((result) => result.status === "no_email").length,
    errors,
    robotsDenied: selectedResults.filter((result) => result.status === "robots_denied").length,
    emailHitRate: selectedResults.length ? foundEmails / selectedResults.length : 0,
    sitesPerMinute: durationMs ? (pending.length * 60000) / durationMs : 0,
    totalHttpRequests: selectedResults.reduce((sum, result) => sum + result.httpRequests, 0),
    totalBrowserPages: selectedResults.reduce((sum, result) => sum + result.browserPages, 0),
    options: config,
    statusCounts: Object.fromEntries(selectedResults.reduce((counts, result) => counts.set(result.status, (counts.get(result.status) ?? 0) + 1), new Map<string, number>())),
    errorClassCounts: Object.fromEntries(errorClasses),
    durationP50Ms: percentile(durations, 0.5),
    durationP95Ms: percentile(durations, 0.95),
    browserFallbackCandidates: browserPending.length,
  };
  const resultMap = new Map(journal.values().map((result) => [result.key, result]));
  const outputs = await writeOutputs(outputDirectory, rows, resultMap, summary);
  logger.info(`FINISHED. EMAILS: ${foundEmails}/${selectedResults.length} (${(summary.emailHitRate * 100).toFixed(1)}%).`);
  logger.info(`XLSX: ${outputs.xlsx}`);
  logger.info(`CSV: ${outputs.csv}`);
  logger.info(`BENCHMARK: ${outputs.summary}`);
  logger.info(`CHECKPOINT: ${journal.filePath}`);
  logger.info(`LOG: ${logger.filePath}`);
  logger.info(`EVENTS: ${logger.eventsFilePath}`);
}

function percentile(values: number[], fraction: number): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * fraction))] ?? 0;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});
