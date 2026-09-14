import fs from "node:fs";
import path from "node:path";
import type { CrawlResult, CrawlTarget } from "./types.js";

export type CrawlPhase = "HTTP" | "BROWSER";

function displayUrl(rawUrl: string): string {
  try {
    const url = new URL(rawUrl);
    const pathPart = url.pathname === "/" ? "" : url.pathname;
    const queryPart = url.search ? url.search.slice(0, 80) : "";
    return `${url.hostname.toUpperCase()}${pathPart}${queryPart}`.slice(0, 180);
  } catch {
    return rawUrl.slice(0, 180).toUpperCase();
  }
}

function cleanError(error: string): string {
  return error.replace(/\u001b\[[0-?]*[ -\/]*[@-~]/g, "").replace(/\s+/g, " ").trim().slice(0, 260);
}

function resultOutcome(result: CrawlResult): string {
  if (result.primaryEmail) {
    const source = result.emails[0]?.sourceType ?? "unknown";
    const score = result.primaryEmailScore ?? result.emails[0]?.score;
    return `EMAIL=${result.primaryEmail} SOURCE=${source}${score === undefined ? "" : ` SCORE=${score}`}`;
  }
  if (result.status === "robots_denied") return "ROBOTS DENIED";
  if (result.status === "no_email") return "NOT FOUND EMAIL";
  if (result.error) return `ERROR=${cleanError(result.error)}`;
  return "NOT FOUND EMAIL";
}

export function formatStartLine(target: CrawlTarget, phase: CrawlPhase, completed: number, total: number, active = 0): string {
  return `START PHASE=${phase} URL=${displayUrl(target.url)} DONE=${completed}/${total} ACTIVE=${active}`;
}

export function formatResultLine(
  result: CrawlResult,
  phase: CrawlPhase,
  completed: number,
  total: number,
  active = 0,
): string {
  const details = [
    `STATUS=${result.status.toUpperCase()}`,
    `PHASE=${phase}`,
    `PROGRESS=${completed}/${total}`,
    `ACTIVE=${active}`,
    `DURATION_MS=${result.durationMs}`,
    `PAGES=${result.pagesCrawled}`,
    `HTTP_REQUESTS=${result.httpRequests}`,
    `BROWSER_PAGES=${result.browserPages}`,
    result.httpStatus === null ? "HTTP_STATUS=-" : `HTTP_STATUS=${result.httpStatus}`,
    result.errorClass ? `ERROR_CLASS=${result.errorClass}` : "",
    result.fallbackReason && result.fallbackReason !== "none" ? `FALLBACK_REASON=${result.fallbackReason}` : "",
  ].filter(Boolean).join(" ");
  return `DONE URL=${displayUrl(result.inputUrl)} ${resultOutcome(result)} ${details}`;
}

export class RunLogger {
  readonly filePath: string;
  readonly eventsFilePath: string;

  constructor(outputDirectory: string) {
    fs.mkdirSync(outputDirectory, { recursive: true });
    this.filePath = path.join(outputDirectory, "crawl.log");
    this.eventsFilePath = path.join(outputDirectory, "events.ndjson");
  }

  write(level: "INFO" | "WARN" | "ERROR" | "DEBUG", message: string): void {
    const cleanMessage = cleanError(message);
    const line = `[${new Date().toISOString()}] [${level}] ${cleanMessage}`;
    fs.appendFileSync(this.filePath, `${line}\n`, "utf8");
    console.log(line);
  }

  info(message: string): void {
    this.write("INFO", message);
  }

  warn(message: string): void {
    this.write("WARN", message);
  }

  error(message: string): void {
    this.write("ERROR", message);
  }

  debug(message: string): void {
    this.write("DEBUG", message);
  }

  event(event: Record<string, unknown>): void {
    fs.appendFileSync(this.eventsFilePath, `${JSON.stringify({ timestamp: new Date().toISOString(), ...event })}\n`, "utf8");
  }
}
