import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import express, { type NextFunction, type Request, type Response } from "express";
import multer from "multer";
import {
  AUTH_COOKIE_NAME,
  credentialsMatch,
  expiredSessionCookie,
  loadAuthConfig,
  LoginRateLimiter,
  readCookie,
  sessionCookie,
  SessionStore,
} from "./auth.js";
import { buildOutputRecords, recordsToCsv, writeLiveXlsx } from "./output.js";
import { loadLeadRows } from "./input.js";
import type { CrawlResult } from "./types.js";

const rootDirectory = process.cwd();
const runsDirectory = path.join(rootDirectory, "ui-runs");
const publicDirectory = path.join(rootDirectory, "ui", "public");
fs.mkdirSync(runsDirectory, { recursive: true });
const authConfig = loadAuthConfig();
const sessions = new SessionStore(authConfig.sessionTtlMs);
const loginLimiter = new LoginRateLimiter();
const MAX_MEMORY_LOG_LINES = 300;
const LOG_FLUSH_INTERVAL_MS = 250;
const MAX_SSE_LOG_BATCH_LINES = 80;
const QUALITY_REFRESH_INTERVAL_MS = 5000;

type JobStatus = "queued" | "running" | "completed" | "failed" | "stopped";

interface JobOptions {
  limit: number;
  concurrency: number;
  browserConcurrency: number;
  contactPages: number;
  maxPages: number;
  retries: number;
  browserFallback: boolean;
}

interface SourceStats {
  totalRows: number;
  rowsWithWebsite: number;
  validWebsiteRows: number;
  uniqueWebsites: number;
  noWebsiteRows: number;
  invalidUrlRows: number;
  rowKeyCounts: Map<string, number>;
}

interface Job {
  id: string;
  createdAt: string;
  status: JobStatus;
  options: JobOptions;
  inputFiles: string[];
  outputDirectory: string;
  child?: ChildProcess;
  stopRequested?: boolean;
  logs: string[];
  logCount: number;
  pendingLogs: string[];
  logFlushTimer?: NodeJS.Timeout;
  listeners: Set<Response>;
  lastSnapshot?: string;
  results: Map<string, CrawlResult>;
  resultFileOffset: number;
  resultRemainder: string;
  totalFromEvents: number;
  activeFromEvents: number;
  eventFileOffset: number;
  eventRemainder: string;
  lastMetric?: Record<string, unknown>;
  statusCounts: Map<string, number>;
  errorClassCounts: Map<string, number>;
  httpStatusCounts: Map<string, number>;
  emailSources: Map<string, number>;
  foundWebsites: number;
  foundEmails: number;
  processedRows: number;
  browserUsed: number;
  sourceStats: SourceStats;
  resultVersion: number;
  qualityVersion: number;
  qualityUpdatedAt: number;
  qualitySnapshot?: Record<string, number>;
}

const jobs = new Map<string, Job>();
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { files: 4, fileSize: 200 * 1024 * 1024 },
});

function safeFileName(name: string): string {
  return path.basename(name).replace(/[^a-zA-Z0-9._-]+/g, "_").slice(-180) || "input.xlsx";
}

function asInt(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = Number(value ?? fallback);
  return Number.isInteger(parsed) ? Math.min(max, Math.max(min, parsed)) : fallback;
}

function readResults(job: Job): CrawlResult[] {
  const filePath = path.join(job.outputDirectory, "checkpoint-results.jsonl");
  if (!fs.existsSync(filePath)) return [];
  const latest = new Map<string, CrawlResult>();
  for (const line of fs.readFileSync(filePath, "utf8").split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const result = JSON.parse(line) as CrawlResult;
      if (result.key) latest.set(result.key, result);
    } catch {
      // Ignore a partial final line while the crawler is appending a checkpoint.
    }
  }
  return [...latest.values()];
}

function changeCount(counts: Map<string, number>, key: string, delta: number): void {
  const next = (counts.get(key) ?? 0) + delta;
  if (next > 0) counts.set(key, next);
  else counts.delete(key);
}

function resultHttpStatus(result: CrawlResult): string {
  return result.httpStatus === null ? "-" : String(result.httpStatus);
}

function removeResultStats(job: Job, result: CrawlResult): void {
  changeCount(job.statusCounts, result.status, -1);
  if (result.errorClass) changeCount(job.errorClassCounts, result.errorClass, -1);
  changeCount(job.httpStatusCounts, resultHttpStatus(result), -1);
  if (result.primaryEmail) {
    job.foundWebsites -= 1;
    changeCount(job.emailSources, result.emails[0]?.sourceType ?? "unknown", -1);
  }
  job.foundEmails -= result.emails.length;
}

function addResultStats(job: Job, result: CrawlResult): void {
  changeCount(job.statusCounts, result.status, 1);
  if (result.errorClass) changeCount(job.errorClassCounts, result.errorClass, 1);
  changeCount(job.httpStatusCounts, resultHttpStatus(result), 1);
  if (result.primaryEmail) {
    job.foundWebsites += 1;
    changeCount(job.emailSources, result.emails[0]?.sourceType ?? "unknown", 1);
  }
  job.foundEmails += result.emails.length;
}

function applyResult(job: Job, result: CrawlResult): void {
  const previous = job.results.get(result.key);
  if (previous) removeResultStats(job, previous);
  if (!previous) job.processedRows += job.sourceStats.rowKeyCounts.get(result.key) ?? 0;
  const previousUsedBrowser = Boolean(previous?.browserPages);
  const nextUsesBrowser = Boolean(result.browserPages);
  if (previousUsedBrowser !== nextUsesBrowser) job.browserUsed += nextUsesBrowser ? 1 : -1;
  job.results.set(result.key, result);
  addResultStats(job, result);
  job.resultVersion += 1;
}

function hostOf(rawUrl: string): string {
  try {
    return (new URL(rawUrl).hostname || "").toLowerCase().replace(/^www\./, "");
  } catch {
    return "";
  }
}

function domainsRelated(left: string, right: string): boolean {
  return Boolean(left && right && (left === right || left.endsWith(`.${right}`) || right.endsWith(`.${left}`)));
}

function isSuspiciousEmailToken(email: string): boolean {
  const [local = "", domain = ""] = email.toLowerCase().split("@");
  return email.length > 64 || local.length > 40 || domain.length > 40 ||
    /(?:about|services|privacy|contact|instagram|created|press|follow|additional|submit|thanks|projects|lecture|exhibition|for)$/.test(email.toLowerCase());
}

function getQualitySnapshot(job: Job): Record<string, number> {
  const primaryEmails = [...job.results.values()]
    .map((result) => result.primaryEmail.trim())
    .filter(Boolean);
  const uniquePrimaryEmails = new Set(primaryEmails.map((email) => email.toLowerCase()));
  let validPrimaryEmails = 0;
  let scoreAtLeast70 = 0;
  let scoreBelow55 = 0;
  let domainMismatch = 0;
  let suspiciousAllEmails = 0;
  for (const result of job.results.values()) {
    const primaryEmail = result.primaryEmail.trim();
    if (primaryEmail && /^[^\s@;]+@[^\s@;]+\.[^\s@;]+$/.test(primaryEmail)) validPrimaryEmails += 1;
    const score = result.primaryEmailScore ?? result.emails[0]?.score;
    if (primaryEmail && score !== undefined) {
      if (score >= 70) scoreAtLeast70 += 1;
      if (score < 55) scoreBelow55 += 1;
    }
    if (primaryEmail) {
      const emailDomain = primaryEmail.split("@").at(-1)?.toLowerCase() ?? "";
      if (!domainsRelated(emailDomain, hostOf(result.inputUrl))) domainMismatch += 1;
    }
    if (result.emails.some((hit) => isSuspiciousEmailToken(hit.email))) suspiciousAllEmails += 1;
  }
  return {
    foundRows: primaryEmails.length,
    validPrimaryEmails,
    uniquePrimaryEmails: uniquePrimaryEmails.size,
    duplicatePrimaryEmails: Math.max(0, primaryEmails.length - uniquePrimaryEmails.size),
    duplicatePrimaryEmailRate: primaryEmails.length ? Math.max(0, primaryEmails.length - uniquePrimaryEmails.size) / primaryEmails.length : 0,
    scoreAtLeast70,
    scoreBelow55,
    domainMismatch,
    suspiciousAllEmails,
  };
}

function getSourceSnapshot(job: Job): Record<string, number> {
  return {
    totalRows: job.sourceStats.totalRows,
    rowsWithWebsite: job.sourceStats.rowsWithWebsite,
    uniqueWebsites: job.sourceStats.uniqueWebsites,
    processedWebsites: job.results.size,
    processedRows: job.processedRows,
    notProcessedRows: Math.max(0, job.sourceStats.validWebsiteRows - job.processedRows),
    noWebsiteRows: job.sourceStats.noWebsiteRows,
    invalidUrlRows: job.sourceStats.invalidUrlRows,
  };
}

function refreshJobFiles(job: Job): void {
  const resultPath = path.join(job.outputDirectory, "checkpoint-results.jsonl");
  if (fs.existsSync(resultPath)) {
    const size = fs.statSync(resultPath).size;
    if (size < job.resultFileOffset) {
      job.resultFileOffset = 0;
      job.resultRemainder = "";
      job.results.clear();
      job.statusCounts.clear();
      job.errorClassCounts.clear();
      job.httpStatusCounts.clear();
      job.emailSources.clear();
      job.foundWebsites = 0;
      job.foundEmails = 0;
      job.processedRows = 0;
      job.browserUsed = 0;
    }
    if (size > job.resultFileOffset) {
      const handle = fs.openSync(resultPath, "r");
      try {
        const buffer = Buffer.alloc(size - job.resultFileOffset);
        fs.readSync(handle, buffer, 0, buffer.length, job.resultFileOffset);
        job.resultFileOffset = size;
        const lines = `${job.resultRemainder}${buffer.toString("utf8")}`.split(/\r?\n/);
        job.resultRemainder = lines.pop() ?? "";
        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const result = JSON.parse(line) as CrawlResult;
            if (result.key) applyResult(job, result);
          } catch {
            // Keep malformed/partial lines out of the live snapshot.
          }
        }
      } finally {
        fs.closeSync(handle);
      }
    }
  }

  const eventsPath = path.join(job.outputDirectory, "events.ndjson");
  if (!fs.existsSync(eventsPath)) return;
  const size = fs.statSync(eventsPath).size;
  if (size < job.eventFileOffset) {
    job.eventFileOffset = 0;
    job.eventRemainder = "";
    job.totalFromEvents = 0;
    job.activeFromEvents = 0;
    job.lastMetric = undefined;
  }
  if (size <= job.eventFileOffset) return;
  const handle = fs.openSync(eventsPath, "r");
  try {
    const buffer = Buffer.alloc(size - job.eventFileOffset);
    fs.readSync(handle, buffer, 0, buffer.length, job.eventFileOffset);
    job.eventFileOffset = size;
    const lines = `${job.eventRemainder}${buffer.toString("utf8")}`.split(/\r?\n/);
    job.eventRemainder = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const event = JSON.parse(line) as Record<string, unknown>;
        if (Number(event.total) > 0) job.totalFromEvents = Number(event.total);
        if (Number.isFinite(Number(event.active))) job.activeFromEvents = Number(event.active);
        if (event.event === "metrics") job.lastMetric = event;
      } catch {
        // Keep malformed/partial lines out of the live snapshot.
      }
    }
  } finally {
    fs.closeSync(handle);
  }
}

function getSnapshot(job: Job, forceQuality = false): Record<string, unknown> {
  refreshJobFiles(job);
  const now = Date.now();
  if (
    forceQuality ||
    !job.qualitySnapshot ||
    job.qualityVersion !== job.resultVersion && now - job.qualityUpdatedAt >= QUALITY_REFRESH_INTERVAL_MS
  ) {
    job.qualitySnapshot = getQualitySnapshot(job);
    job.qualityVersion = job.resultVersion;
    job.qualityUpdatedAt = now;
  }
  const total = job.totalFromEvents || job.options.limit || job.results.size;
  const elapsedMs = Math.max(1, Date.now() - new Date(job.createdAt).getTime());
  const done = job.results.size;
  const calculatedRate = (done * 60000) / elapsedMs;
  return {
    id: job.id,
    status: job.status,
    createdAt: job.createdAt,
    total,
    done,
    active: Math.max(0, job.activeFromEvents),
    progress: total ? Math.min(100, (done / total) * 100) : 0,
    foundWebsites: job.foundWebsites,
    foundEmails: job.foundEmails,
    noEmail: job.statusCounts.get("no_email") ?? 0,
    errors: (job.statusCounts.get("http_error") ?? 0) + (job.statusCounts.get("browser_error") ?? 0),
    browserFound: job.statusCounts.get("found_browser") ?? 0,
    browserUsed: job.browserUsed,
    emailHitRate: done ? job.foundWebsites / done : 0,
    ratePerMinute: Number(job.lastMetric?.ratePerMinute ?? calculatedRate),
    statusCounts: Object.fromEntries(job.statusCounts),
    errorClassCounts: Object.fromEntries(job.errorClassCounts),
    httpStatusCounts: Object.fromEntries(job.httpStatusCounts),
    emailSources: Object.fromEntries(job.emailSources),
    options: job.options,
    logs: job.logs.slice(-220),
    logCount: job.logCount,
    coverage: getSourceSnapshot(job),
    quality: job.qualitySnapshot,
    downloads: {
      csv: done > 0,
      xlsx: done > 0,
    },
  };
}

function broadcast(job: Job, payload: Record<string, unknown>): void {
  const message = `data: ${JSON.stringify(payload)}\n\n`;
  for (const listener of job.listeners) {
    try {
      listener.write(message);
    } catch {
      job.listeners.delete(listener);
    }
  }
}

function appendLog(job: Job, line: string): void {
  const clean = line.replace(/\u001b\[[0-?]*[ -\/]*[@-~]/g, "").trim();
  if (!clean) return;
  job.logs.push(clean);
  job.logCount += 1;
  if (job.logs.length > MAX_MEMORY_LOG_LINES) job.logs.splice(0, job.logs.length - MAX_MEMORY_LOG_LINES);
  job.pendingLogs.push(clean);
  if (job.pendingLogs.length > MAX_MEMORY_LOG_LINES) {
    job.pendingLogs.splice(0, job.pendingLogs.length - MAX_MEMORY_LOG_LINES);
  }
  if (!job.logFlushTimer) {
    job.logFlushTimer = setTimeout(() => flushLogs(job), LOG_FLUSH_INTERVAL_MS);
    job.logFlushTimer.unref?.();
  }
}

function flushLogs(job: Job): void {
  job.logFlushTimer = undefined;
  if (!job.pendingLogs.length) return;
  const lines = job.pendingLogs.splice(-MAX_SSE_LOG_BATCH_LINES);
  job.pendingLogs.length = 0;
  if (job.listeners.size) broadcast(job, { type: "logs", lines, logCount: job.logCount });
}

function startJob(job: Job): void {
  job.status = "running";
  const tsxCli = path.join(rootDirectory, "node_modules", "tsx", "dist", "cli.mjs");
  const args = [tsxCli, "src/cli.ts"];
  for (const file of job.inputFiles) args.push("--input", file);
  args.push(
    "--output", job.outputDirectory,
    "--limit", String(job.options.limit),
    "--concurrency", String(job.options.concurrency),
    "--browser-concurrency", String(job.options.browserConcurrency),
    "--contact-pages", String(job.options.contactPages),
    "--max-pages", String(job.options.maxPages),
    "--retries", String(job.options.retries),
  );
  if (!job.options.browserFallback) args.push("--no-browser-fallback");
  const child = spawn(process.execPath, args, {
    cwd: rootDirectory,
    env: { ...process.env, FORCE_COLOR: "0" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  job.child = child;
  const attachLogStream = (stream: NodeJS.ReadableStream): void => {
    let remainder = "";
    stream.on("data", (chunk: Buffer) => {
      remainder += chunk.toString("utf8");
      const lines = remainder.split(/\r?\n/);
      remainder = lines.pop() ?? "";
      for (const line of lines) appendLog(job, line);
    });
    stream.on("end", () => {
      if (remainder) appendLog(job, remainder);
      remainder = "";
    });
  };
  attachLogStream(child.stdout);
  attachLogStream(child.stderr);
  child.on("close", (code, signal) => {
    if (job.logFlushTimer) clearTimeout(job.logFlushTimer);
    flushLogs(job);
    job.status = job.stopRequested || signal === "SIGINT" ? "stopped" : code === 0 ? "completed" : "failed";
    broadcast(job, { type: "status", status: job.status, snapshot: getSnapshot(job, true) });
  });
  broadcast(job, { type: "status", status: "running", snapshot: getSnapshot(job) });
}

async function buildLiveFiles(job: Job): Promise<{ rows: Awaited<ReturnType<typeof loadLeadRows>>; results: Map<string, CrawlResult> }> {
  const rows = (await Promise.all(job.inputFiles.map((file) => loadLeadRows(file)))).flat();
  const results = new Map(readResults(job).map((result) => [result.key, result]));
  return { rows, results };
}

const app = express();
app.disable("x-powered-by");
if (process.env.TRUST_PROXY === "true") app.set("trust proxy", 1);
app.use((_request, response, next) => {
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("X-Frame-Options", "DENY");
  response.setHeader("Referrer-Policy", "no-referrer");
  response.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  response.setHeader(
    "Content-Security-Policy",
    "default-src 'self'; base-uri 'self'; frame-ancestors 'none'; form-action 'self'; object-src 'none'; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; connect-src 'self'",
  );
  next();
});
app.use("/api", (_request, response, next) => {
  response.setHeader("Cache-Control", "no-store");
  next();
});
app.use(express.json({ limit: "16kb" }));
app.use(express.static(publicDirectory));

function sessionFromRequest(request: Request) {
  return sessions.get(readCookie(request.headers.cookie, AUTH_COOKIE_NAME));
}

function requireAuthentication(request: Request, response: Response, next: NextFunction): void {
  if (sessionFromRequest(request)) {
    next();
    return;
  }
  response.status(401).json({ error: "Phiên đăng nhập không hợp lệ hoặc đã hết hạn." });
}

app.get("/api/auth/session", (request, response) => {
  const session = sessionFromRequest(request);
  if (!session) return response.status(401).json({ authenticated: false });
  return response.json({ authenticated: true, username: session.username, expiresAt: session.expiresAt });
});

app.post("/api/auth/login", (request, response) => {
  const clientKey = request.ip || request.socket.remoteAddress || "unknown";
  const retryAfter = loginLimiter.retryAfterSeconds(clientKey);
  if (retryAfter > 0) {
    response.setHeader("Retry-After", String(retryAfter));
    return response.status(429).json({ error: `Đăng nhập tạm khóa. Thử lại sau ${retryAfter} giây.` });
  }

  const username = typeof request.body?.username === "string" ? request.body.username.slice(0, 256) : "";
  const password = typeof request.body?.password === "string" ? request.body.password.slice(0, 1024) : "";
  if (!credentialsMatch(username, password, authConfig)) {
    const attemptsRemaining = loginLimiter.recordFailure(clientKey);
    return response.status(401).json({
      error: attemptsRemaining > 0
        ? `Sai username hoặc password. Còn ${attemptsRemaining} lần thử.`
        : "Đăng nhập tạm khóa trong 15 phút do thử sai nhiều lần.",
    });
  }

  loginLimiter.reset(clientKey);
  const { token, session } = sessions.create(authConfig.username);
  response.setHeader("Set-Cookie", sessionCookie(token, authConfig.sessionTtlMs, authConfig.secureCookie));
  return response.json({ authenticated: true, username: session.username, expiresAt: session.expiresAt });
});

app.post("/api/auth/logout", (request, response) => {
  sessions.revoke(readCookie(request.headers.cookie, AUTH_COOKIE_NAME));
  response.setHeader("Set-Cookie", expiredSessionCookie(authConfig.secureCookie));
  return response.status(204).end();
});

app.use("/api/jobs", requireAuthentication);

app.get("/api/jobs", (_request, response) => {
  response.json([...jobs.values()].map((job) => getSnapshot(job)));
});

app.post("/api/jobs", upload.array("files", 4), (request: Request, response: Response) => {
  void (async () => {
    const files = (request.files as Express.Multer.File[] | undefined) ?? [];
    if (!files.length) {
      response.status(400).json({ error: "Upload ít nhất một file XLSX." });
      return;
    }
    if (files.some((file) => !/\.xlsx$/i.test(file.originalname))) {
      response.status(400).json({ error: "UI chỉ nhận file .xlsx do lead-ledger xuất (sheet Leads)." });
      return;
    }
    const id = randomUUID().slice(0, 8);
    const jobDirectory = path.join(runsDirectory, id);
    const inputDirectory = path.join(jobDirectory, "inputs");
    const outputDirectory = path.join(jobDirectory, "output");
    fs.mkdirSync(inputDirectory, { recursive: true });
    fs.mkdirSync(outputDirectory, { recursive: true });
    const inputFiles = files.map((file, index) => {
      const destination = path.join(inputDirectory, `${String(index + 1).padStart(2, "0")}-${safeFileName(file.originalname)}`);
      fs.writeFileSync(destination, file.buffer);
      return destination;
    });
    const sourceRows = (await Promise.all(inputFiles.map((file) => loadLeadRows(file)))).flat();
    const rowKeyCounts = new Map<string, number>();
    for (const row of sourceRows) {
      if (row.crawlKey) rowKeyCounts.set(row.crawlKey, (rowKeyCounts.get(row.crawlKey) ?? 0) + 1);
    }
    const sourceStats: SourceStats = {
      totalRows: sourceRows.length,
      rowsWithWebsite: sourceRows.filter((row) => Boolean(row.websiteRaw)).length,
      validWebsiteRows: sourceRows.filter((row) => Boolean(row.crawlKey)).length,
      uniqueWebsites: rowKeyCounts.size,
      noWebsiteRows: sourceRows.filter((row) => row.preflightStatus === "no_website").length,
      invalidUrlRows: sourceRows.filter((row) => row.preflightStatus === "invalid_url").length,
      rowKeyCounts,
    };
    const job: Job = {
      id,
      createdAt: new Date().toISOString(),
      status: "queued",
      options: {
        limit: asInt(request.body.limit, 0, 0, 1000000),
        concurrency: asInt(request.body.concurrency, 25, 1, 200),
        browserConcurrency: asInt(request.body.browserConcurrency, 4, 1, 8),
        contactPages: asInt(request.body.contactPages, 1, 1, 10),
        maxPages: asInt(request.body.maxPages, 3, 1, 20),
        retries: asInt(request.body.retries, 0, 0, 5),
        browserFallback: request.body.browserFallback !== "false",
      },
      inputFiles,
      outputDirectory,
      logs: [],
      logCount: 0,
      pendingLogs: [],
      listeners: new Set(),
      results: new Map(),
      resultFileOffset: 0,
      resultRemainder: "",
      totalFromEvents: 0,
      activeFromEvents: 0,
      eventFileOffset: 0,
      eventRemainder: "",
      statusCounts: new Map(),
      errorClassCounts: new Map(),
      httpStatusCounts: new Map(),
      emailSources: new Map(),
      foundWebsites: 0,
      foundEmails: 0,
      processedRows: 0,
      browserUsed: 0,
      sourceStats,
      resultVersion: 0,
      qualityVersion: -1,
      qualityUpdatedAt: 0,
    };
    jobs.set(id, job);
    startJob(job);
    response.status(202).json(getSnapshot(job));
  })().catch((error: unknown) => {
    response.status(500).json({ error: error instanceof Error ? error.message : String(error) });
  });
});

app.get("/api/jobs/:id", (request, response) => {
  const job = jobs.get(request.params.id);
  if (!job) return response.status(404).json({ error: "Không tìm thấy job." });
  return response.json(getSnapshot(job));
});

app.get("/api/jobs/:id/stream", (request, response) => {
  const job = jobs.get(request.params.id);
  if (!job) return response.status(404).end();
  response.setHeader("Content-Type", "text/event-stream");
  response.setHeader("Cache-Control", "no-cache");
  response.setHeader("Connection", "keep-alive");
  response.flushHeaders();
  job.listeners.add(response);
  response.write(`data: ${JSON.stringify({ type: "snapshot", snapshot: getSnapshot(job) })}\n\n`);
  request.on("close", () => job.listeners.delete(response));
  return undefined;
});

app.post("/api/jobs/:id/stop", (request, response) => {
  const job = jobs.get(request.params.id);
  if (!job) return response.status(404).json({ error: "Không tìm thấy job." });
  job.stopRequested = true;
  job.child?.kill("SIGINT");
  return response.json(getSnapshot(job));
});

app.get("/api/jobs/:id/download/:format", (request, response) => {
  void (async () => {
    const job = jobs.get(request.params.id);
    if (!job) {
      response.status(404).json({ error: "Không tìm thấy job." });
      return;
    }
    const { rows, results } = await buildLiveFiles(job);
    const records = buildOutputRecords(rows, results);
    if (request.params.format === "csv") {
      response.setHeader("Content-Type", "text/csv; charset=utf-8");
      response.setHeader("Content-Disposition", `attachment; filename="email-results-${job.id}.csv"`);
      response.send(recordsToCsv(records));
      return;
    }
    if (request.params.format !== "xlsx") {
      response.status(404).json({ error: "Định dạng tải xuống không được hỗ trợ." });
      return;
    }
    const temporaryFile = path.join(job.outputDirectory, `live-email-results-${randomUUID()}.xlsx`);
    await writeLiveXlsx(temporaryFile, records);
    response.download(temporaryFile, `email-results-${job.id}.xlsx`, () => {
      fs.rmSync(temporaryFile, { force: true });
    });
  })().catch((error: unknown) => {
    response.status(500).json({ error: error instanceof Error ? error.message : String(error) });
  });
});

app.get(/.*/, (_request, response) => response.sendFile(path.join(publicDirectory, "index.html")));

app.use((error: unknown, request: Request, response: Response, next: NextFunction) => {
  if (response.headersSent) {
    next(error);
    return;
  }
  const isUploadError = error instanceof multer.MulterError;
  const status = isUploadError ? (error.code === "LIMIT_FILE_SIZE" ? 413 : 400) : 500;
  const message = isUploadError
    ? error.code === "LIMIT_FILE_SIZE"
      ? "Mỗi file XLSX phải nhỏ hơn 200 MB."
      : "Không thể nhận file upload. Hãy kiểm tra số lượng và định dạng file."
    : "Lỗi máy chủ. Hãy thử lại hoặc kiểm tra log server.";
  if (request.path.startsWith("/api/")) {
    response.status(status).json({ error: message });
    return;
  }
  response.status(500).send("Internal server error");
});

const port = asInt(process.env.PORT, 8080, 1, 65535);
const host = process.env.HOST || "0.0.0.0";
app.listen(port, host, () => {
  console.log(`Email crawler UI listening on http://${host}:${port}`);
});

setInterval(() => {
  for (const job of jobs.values()) {
    if (!job.listeners.size) continue;
    const snapshot = getSnapshot(job);
    const serialized = JSON.stringify(snapshot);
    if (serialized === job.lastSnapshot) continue;
    job.lastSnapshot = serialized;
    broadcast(job, { type: "snapshot", snapshot });
  }
}, 1000).unref();
