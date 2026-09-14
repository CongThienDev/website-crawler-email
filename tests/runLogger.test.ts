import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { formatResultLine, formatStartLine, RunLogger } from "../src/runLogger.js";
import type { CrawlResult, CrawlTarget } from "../src/types.js";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

const target: CrawlTarget = { key: "stattner.com/", url: "https://stattner.com/" };
const result: CrawlResult = {
  key: target.key,
  inputUrl: target.url,
  finalUrl: target.url,
  status: "found_http",
  primaryEmail: "contact@stattner.com",
  emails: [{ email: "contact@stattner.com", sourceUrl: target.url, sourceType: "mailto", score: 70 }],
  pagesCrawled: 1,
  httpRequests: 1,
  browserPages: 0,
  httpStatus: 200,
  durationMs: 123,
  error: "",
  completedAt: new Date().toISOString(),
};

describe("run logger", () => {
  it("formats per-website progress and persists it", () => {
    expect(formatStartLine(target, "HTTP", 3, 500)).toContain("START PHASE=HTTP URL=STATTNER.COM");
    expect(formatResultLine(result, "HTTP", 4, 500)).toContain(
      "DONE URL=STATTNER.COM EMAIL=contact@stattner.com SOURCE=mailto SCORE=70 STATUS=FOUND_HTTP",
    );

    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "email-crawler-log-"));
    temporaryDirectories.push(directory);
    const logger = new RunLogger(directory);
    logger.info("TEST LINE");
    expect(fs.readFileSync(logger.filePath, "utf8")).toContain("[INFO] TEST LINE");
    logger.event({ event: "done", key: target.key, status: "found_http" });
    expect(fs.readFileSync(logger.eventsFilePath, "utf8")).toContain('"event":"done"');
  });
});
