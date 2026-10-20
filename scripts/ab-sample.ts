// Builds a fixed A/B sample from a lead-ledger export: N domains picked by hash (same file + N => same sample),
// keeping every row of each picked domain. Usage: tsx scripts/ab-sample.ts <input.xlsx> <output.xlsx> [N]
import { createHash } from "node:crypto";
import ExcelJS from "exceljs";
import { loadLeadRows } from "../src/input.js";

const [input, output, size = "1000"] = process.argv.slice(2);
if (!input || !output) throw new Error("Usage: tsx scripts/ab-sample.ts <input.xlsx> <output.xlsx> [N]");

const rows = await loadLeadRows(input);
const headers = Object.keys(rows[0]?.values ?? {});
const byDomain = new Map<string, typeof rows>();
for (const row of rows) {
  const domain = String(row.values.Domain ?? "").trim();
  if (!domain) continue;
  if (!byDomain.has(domain)) byDomain.set(domain, []);
  byDomain.get(domain)!.push(row);
}
const hash = (value: string): string => createHash("sha1").update(value).digest("hex");
const picked = [...byDomain.keys()].sort((a, b) => hash(a).localeCompare(hash(b))).slice(0, Number(size));

const workbook = new ExcelJS.Workbook();
const sheet = workbook.addWorksheet("Leads");
sheet.addRow(headers);
for (const domain of picked) for (const row of byDomain.get(domain)!) sheet.addRow(headers.map((h) => row.values[h] ?? ""));
await workbook.xlsx.writeFile(output);
console.log(`rows=${rows.length} domains=${byDomain.size} picked=${picked.length} sampleRows=${sheet.rowCount - 1}`);
