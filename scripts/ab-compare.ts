// Compares two crawl runs on the same sample, per Domain. Prints rates and writes ab-diff.csv with every
// domain whose email differs, for manual review. Usage: tsx scripts/ab-compare.ts <runA dir> <runB dir> [out.csv]
import fs from "node:fs";
import path from "node:path";
import ExcelJS from "exceljs";
import { csvCell } from "../src/output.js";

interface DomainResult {
  website: string;
  email: string;
  all: string;
  status: string;
}

const latest = (dir: string, prefix: string, ext: string): string => {
  const file = fs.readdirSync(dir).filter((f) => f.startsWith(prefix) && f.endsWith(ext)).sort().at(-1);
  if (!file) throw new Error(`No ${prefix}*${ext} in ${dir}`);
  return path.join(dir, file);
};

async function load(dir: string): Promise<{ domains: Map<string, DomainResult>; summary: Record<string, number> }> {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(latest(dir, "email-results-", ".xlsx"));
  const sheet = workbook.worksheets[0]!;
  const headers = (sheet.getRow(1).values as unknown[]).map((v) => String(v ?? ""));
  const col = (...names: string[]): number => headers.findIndex((h) => names.includes(h));
  const [dCol, wCol, eCol, aCol, sCol] = [
    col("Domain"), col("Website"), col("Email", "Primary Email"), col("All Emails"), col("Email Status", "Crawl Status"),
  ];
  const domains = new Map<string, DomainResult>();
  sheet.eachRow((row, index) => {
    if (index === 1) return;
    const cell = (i: number): string => String(row.getCell(i).text ?? "").trim();
    const domain = cell(dCol);
    if (!domain) return;
    const current = domains.get(domain);
    // Baseline crawled per URL, so one domain may have several results: keep the first with an email.
    if (current?.email) return;
    domains.set(domain, { website: cell(wCol), email: cell(eCol), all: cell(aCol), status: cell(sCol) });
  });
  const summary = JSON.parse(fs.readFileSync(latest(dir, "benchmark-summary-", ".json"), "utf8"));
  return { domains, summary };
}

const sameDomain = (email: string, domain: string): boolean => {
  const host = email.split("@")[1] ?? "";
  return host === domain || domain.endsWith(`.${host}`) || host.endsWith(`.${domain}`);
};

function stats(domains: Map<string, DomainResult>, summary: Record<string, number>) {
  const list = [...domains.entries()];
  const found = list.filter(([, r]) => r.email).length;
  const own = list.filter(([d, r]) => r.email && sameDomain(r.email, d)).length;
  const sites = summary.processedThisRun || summary.selectedWebsites || 1;
  return {
    domains: list.length,
    found,
    hitRate: `${((found / list.length) * 100).toFixed(1)}%`,
    ownDomainRate: `${((own / list.length) * 100).toFixed(1)}%`,
    minutes: (summary.durationMs / 60000).toFixed(1),
    httpReqPerSite: (summary.totalHttpRequests / sites).toFixed(2),
    browserPagesPerSite: (summary.totalBrowserPages / sites).toFixed(2),
  };
}

const [dirA, dirB, outFile = "ab-diff.csv"] = process.argv.slice(2);
if (!dirA || !dirB) throw new Error("Usage: tsx scripts/ab-compare.ts <runA> <runB> [out.csv]");
const [a, b] = await Promise.all([load(dirA), load(dirB)]);
console.table({ A: stats(a.domains, a.summary), B: stats(b.domains, b.summary) });

const lines = [["Domain", "Website", "Change", "A Email", "B Email", "A All", "B All", "A Status", "B Status"].join(",")];
const changes = new Map<string, number>();
for (const domain of new Set([...a.domains.keys(), ...b.domains.keys()])) {
  const ra = a.domains.get(domain);
  const rb = b.domains.get(domain);
  if ((ra?.email ?? "") === (rb?.email ?? "")) continue;
  const change = !ra?.email ? "gained" : !rb?.email ? "lost" : "changed";
  changes.set(change, (changes.get(change) ?? 0) + 1);
  lines.push(
    [domain, ra?.website ?? rb?.website, change, ra?.email, rb?.email, ra?.all, rb?.all, ra?.status, rb?.status]
      .map(csvCell)
      .join(","),
  );
}
fs.writeFileSync(outFile, `${lines.join("\n")}\n`, "utf8");
console.log(`Diff: ${JSON.stringify(Object.fromEntries(changes))} -> ${outFile}`);
