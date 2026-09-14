import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import express, { type Request, type Response } from "express";
import multer from "multer";
import { buildOutputRecords, recordsToCsv, writeLiveXlsx } from "./output.js";
import { loadLeadRows } from "./input.js";
import type { CrawlResult } from "./types.js";

const rootDirectory = process.cwd();
const runsDirectory = path.join(rootDirectory, "ui-runs");
const publicDirectory = path.join(rootDirectory, "ui", "public");
fs.mkdirSync(runsDirectory, { recursive: true });

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
  listeners: Set<Response>;
  lastSnapshot?: string;
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

function readEvents(job: Job): Record<string, unknown>[] {
  const filePath = path.join(job.outputDirectory, "events.ndjson");
  if (!fs.existsSync(filePath)) return [];
  const events: Record<string, unknown>[] = [];
  for (const line of fs.readFileSync(filePath, "utf8").split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const event = JSON.parse(line) as Record<string, unknown>;
      events.push(event);
    } catch {
      // Ignore a partial final line.
    }
  }
  return events;
}

function countValues(values: string[]): Record<string, number> {
  return values.reduce<Record<string, number>>((counts, value) => {
    counts[value] = (counts[value] ?? 0) + 1;
    return counts;
  }, {});
}

function getSnapshot(job: Job): Record<string, unknown> {
  const results = readResults(job);
  const events = readEvents(job);
  const doneEvents = events.filter((event) => event.event === "done");
  const starts = events.filter((event) => event.event === "start");
  const lastMetric = [...events].reverse().find((event) => event.event === "metrics");
  const totalFromEvents = Number([...events].reverse().find((event) => event.total)?.total ?? 0);
  const total = job.options.limit || totalFromEvents || results.length;
  const emailResults = results.filter((result) => Boolean(result.primaryEmail));
  const foundEmailCount = results.reduce((sum, result) => sum + result.emails.length, 0);
  const statusCounts = countValues(results.map((result) => result.status));
  const errorClassCounts = countValues(results.map((result) => result.errorClass).filter(Boolean).map(String));
  const httpStatusCounts = countValues(results.map((result) => result.httpStatus === null ? "-" : String(result.httpStatus)));
  const emailSources = countValues(
    emailResults.map((result) => result.emails[0]?.sourceType ?? "unknown"),
  );
  const elapsedMs = Math.max(1, Date.now() - new Date(job.createdAt).getTime());
  const done = results.length;
  const calculatedRate = (done * 60000) / elapsedMs;
  return {
    id: job.id,
    status: job.status,
    createdAt: job.createdAt,
    total,
    done,
    active: Math.max(0, starts.length - doneEvents.length),
    progress: total ? Math.min(100, (done / total) * 100) : 0,
    foundWebsites: emailResults.length,
    foundEmails: foundEmailCount,
    noEmail: statusCounts.no_email ?? 0,
    errors: (statusCounts.http_error ?? 0) + (statusCounts.browser_error ?? 0),
    browserFound: statusCounts.found_browser ?? 0,
    browserUsed: results.filter((result) => result.browserPages > 0).length,
    ratePerMinute: Number(lastMetric?.ratePerMinute ?? calculatedRate),
    statusCounts,
    errorClassCounts,
    httpStatusCounts,
    emailSources,
    options: job.options,
    logs: job.logs.slice(-220),
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
  if (job.logs.length > 300) job.logs.splice(0, job.logs.length - 300);
  broadcast(job, { type: "log", line: clean });
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
    job.status = job.stopRequested || signal === "SIGINT" ? "stopped" : code === 0 ? "completed" : "failed";
    broadcast(job, { type: "status", status: job.status, snapshot: getSnapshot(job) });
  });
  broadcast(job, { type: "status", status: "running", snapshot: getSnapshot(job) });
}

async function buildLiveFiles(job: Job): Promise<{ rows: Awaited<ReturnType<typeof loadLeadRows>>; results: Map<string, CrawlResult> }> {
  const rows = (await Promise.all(job.inputFiles.map((file) => loadLeadRows(file, "Data unique")))).flat();
  const results = new Map(readResults(job).map((result) => [result.key, result]));
  return { rows, results };
}

const app = express();
app.use(express.json());
app.use(express.static(publicDirectory));

app.get("/api/jobs", (_request, response) => {
  response.json([...jobs.values()].map(getSnapshot));
});

app.post("/api/jobs", upload.array("files", 4), (request: Request, response: Response) => {
  void (async () => {
    const files = (request.files as Express.Multer.File[] | undefined) ?? [];
    if (!files.length) {
      response.status(400).json({ error: "Upload ít nhất một file XLSX." });
      return;
    }
    if (files.some((file) => !/\.xlsx$/i.test(file.originalname))) {
      response.status(400).json({ error: "UI hiện nhận file .xlsx để giữ nguyên sheet Data unique." });
      return;
    }
    const id = randomUUID().slice(0, 8);
    const jobDirectory = path.join(runsDirectory, id);
    const inputDirectory = path.join(jobDirectory, "inputs");
    const outputDirectory = path.join(jobDirectory, "output");
    fs.mkdirSync(inputDirectory, { recursive: true });
    fs.mkdirSync(outputDirectory, { recursive: true });
    const inputFiles = files.map((file) => {
      const destination = path.join(inputDirectory, safeFileName(file.originalname));
      fs.writeFileSync(destination, file.buffer);
      return destination;
    });
    const job: Job = {
      id,
      createdAt: new Date().toISOString(),
      status: "queued",
      options: {
        limit: asInt(request.body.limit, 500, 0, 1000000),
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
      listeners: new Set(),
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
