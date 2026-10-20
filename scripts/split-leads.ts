// Merges lead files (old exports without Domain, new lead-ledger exports) into lead-ledger format chunks.
// Newest file first wins on duplicate place; rows without a crawlable Domain are dropped; a Domain never spans
// two chunks. Usage: tsx scripts/split-leads.ts <outDir> <rowsPerChunk> <newest.xlsx> ...
import fs from "node:fs";
import path from "node:path";
import ExcelJS from "exceljs";
import { LEAD_HEADERS, loadLeadRows } from "../src/input.js";

// Hosts lead-ledger leaves Domain blank for (shared by unrelated businesses), taken from its exports.
const SHARED_HOSTS = [
  "wixsite.com", "google.com", "godaddysites.com", "squarespace.com", "nextdoor.com", "linkedin.com", "thumbtack.com",
  "business.site", "bbb.org", "houzz.com", "angi.com", "yellowpages.com", "facebook.com", "instagram.com",
];

function domainOf(website: string): string {
  try {
    const host = new URL(/^https?:\/\//i.test(website) ? website : `http://${website}`).hostname.toLowerCase().replace(/^www\./, "");
    return SHARED_HOSTS.some((shared) => host === shared || host.endsWith(`.${shared}`)) ? "" : host;
  } catch {
    return "";
  }
}

// google_maps_url carries per-export query params (g_ep, rclk...); the place id inside the path is stable.
const placeKey = (url: string): string => url.match(/!1s(0x[0-9a-f]+:0x[0-9a-f]+)/i)?.[1] ?? url.split("?")[0]!;

const [outDir, chunkSize, ...inputs] = process.argv.slice(2);
if (!outDir || !Number(chunkSize) || !inputs.length) throw new Error("Usage: tsx scripts/split-leads.ts <outDir> <rowsPerChunk> <newest.xlsx>...");

const seen = new Set<string>();
const byDomain = new Map<string, unknown[][]>();
for (const file of inputs) {
  // Crawled result files keep the lead columns in an "Email results" sheet.
  const rows = await loadLeadRows(file).catch(() => loadLeadRows(file, "Email results"));
  let kept = 0;
  for (const row of rows) {
    const url = String(row.values.google_maps_url ?? "");
    const key = url ? placeKey(url) : `${row.values.Name}|${row.values.Address}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (!row.websiteRaw || row.preflightStatus === "invalid_url") continue;
    const domain = row.values.Domain === undefined ? domainOf(row.websiteRaw) : String(row.values.Domain ?? "").trim().toLowerCase();
    if (!domain) continue;
    const values = LEAD_HEADERS.map((header) => (header === "Domain" ? domain : (row.values[header] ?? "")));
    if (!byDomain.has(domain)) byDomain.set(domain, []);
    byDomain.get(domain)!.push(values);
    kept += 1;
  }
  console.log(`${path.basename(file)}: ${rows.length} rows, kept ${kept}`);
}

fs.mkdirSync(outDir, { recursive: true });
let part = 0;
let buffer: unknown[][] = [];
async function flush(): Promise<void> {
  if (!buffer.length) return;
  part += 1;
  const file = path.join(outDir, `leads-part-${String(part).padStart(3, "0")}.xlsx`);
  const workbook = new ExcelJS.stream.xlsx.WorkbookWriter({ filename: file });
  const sheet = workbook.addWorksheet("Leads");
  sheet.addRow(LEAD_HEADERS).commit();
  buffer.forEach((values, index) => sheet.addRow([index + 1, ...values.slice(1)]).commit());
  await workbook.commit();
  console.log(`${path.basename(file)}: ${buffer.length} rows`);
  buffer = [];
}
let domains = 0;
for (const rows of byDomain.values()) {
  if (buffer.length + rows.length > Number(chunkSize)) await flush();
  buffer.push(...rows);
  domains += 1;
}
await flush();
console.log(`done: ${domains} domains in ${part} files -> ${outDir}`);
