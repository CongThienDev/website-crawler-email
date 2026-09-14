import fs from "node:fs";
import path from "node:path";
import type { CrawlResult } from "./types.js";

export class ResultJournal {
  readonly filePath: string;
  private readonly results = new Map<string, CrawlResult>();

  constructor(outputDirectory: string) {
    fs.mkdirSync(outputDirectory, { recursive: true });
    this.filePath = path.join(outputDirectory, "checkpoint-results.jsonl");
    this.load();
  }

  private load(): void {
    if (!fs.existsSync(this.filePath)) return;
    const lines = fs.readFileSync(this.filePath, "utf8").split(/\r?\n/);
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const result = JSON.parse(line) as CrawlResult;
        if (result?.key) this.results.set(result.key, result);
      } catch {
        // Ignore a final partial line left by an interrupted process.
      }
    }
  }

  has(key: string): boolean {
    return this.results.has(key);
  }

  get(key: string): CrawlResult | undefined {
    return this.results.get(key);
  }

  values(): CrawlResult[] {
    return [...this.results.values()];
  }

  append(result: CrawlResult): void {
    fs.appendFileSync(this.filePath, `${JSON.stringify(result)}\n`, "utf8");
    this.results.set(result.key, result);
  }
}
