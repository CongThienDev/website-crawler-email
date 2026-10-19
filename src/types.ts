export type PrimitiveCell = string | number | boolean | Date | null;

export interface LeadRow {
  inputFile: string;
  inputSheet: string;
  sourceRow: number;
  values: Record<string, PrimitiveCell>;
  websiteRaw: string;
  crawlKey?: string;
  normalizedWebsite?: string;
  preflightStatus?: "no_website" | "shared_host" | "invalid_url" | "not_selected_limit";
}

export interface EmailHit {
  email: string;
  sourceUrl: string;
  sourceType: "mailto" | "text" | "obfuscated" | "cloudflare";
  score: number;
}

export type FallbackReason = "no_email" | "timeout" | "javascript" | "other_error" | "none";

export type CrawlStatus =
  | "found_http"
  | "found_browser"
  | "no_email"
  | "robots_denied"
  | "http_error"
  | "browser_error"
  | "invalid_url";

export interface CrawlResult {
  key: string;
  inputUrl: string;
  finalUrl: string;
  status: CrawlStatus;
  primaryEmail: string;
  emails: EmailHit[];
  pagesCrawled: number;
  httpRequests: number;
  browserPages: number;
  httpStatus: number | null;
  durationMs: number;
  error: string;
  completedAt: string;
  /** Why this result was (or was not) sent to the browser stage. */
  fallbackReason?: FallbackReason;
  /** Coarse error class used for retry/throttling and metrics. */
  errorClass?: "timeout" | "http_403" | "http_429" | "http_4xx" | "http_5xx" | "network" | "robots" | "other";
  robotsMs?: number;
  fetchMs?: number;
  parseMs?: number;
  navigationMs?: number;
  primaryEmailScore?: number;
}

export interface CrawlConfig {
  concurrency: number;
  browserConcurrency: number;
  browserFallback: boolean;
  collectAll: boolean;
  maxPages: number;
  contactPages: number;
  timeoutMs: number;
  robotsTimeoutMs: number;
  browserTimeoutMs: number;
  retries: number;
  domainDelayMs: number;
  respectRobots: boolean;
  userAgent: string;
  logEvery: number;
}

export interface CrawlTarget {
  key: string;
  url: string;
}

export interface RunSummary {
  runStartedAt: string;
  runFinishedAt: string;
  durationMs: number;
  inputFiles: string[];
  inputRows: number;
  rowsWithWebsite: number;
  uniqueValidWebsites: number;
  selectedWebsites: number;
  resumedWebsites: number;
  processedThisRun: number;
  foundEmails: number;
  foundByHttp: number;
  foundByBrowser: number;
  noEmail: number;
  errors: number;
  robotsDenied: number;
  emailHitRate: number;
  sitesPerMinute: number;
  totalHttpRequests: number;
  totalBrowserPages: number;
  options: CrawlConfig;
  statusCounts?: Record<string, number>;
  errorClassCounts?: Record<string, number>;
  durationP50Ms?: number;
  durationP95Ms?: number;
  browserFallbackCandidates?: number;
}
