import fs from "node:fs";
import path from "node:path";
import ExcelJS from "exceljs";
import type { CrawlResult, LeadRow, RunSummary } from "./types.js";

export function csvCell(value: unknown): string {
  const text = value === null || value === undefined ? "" : value instanceof Date ? value.toISOString() : String(value);
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export function outputRecord(row: LeadRow, result?: CrawlResult): Record<string, unknown> {
  return {
    "Input File": row.inputFile,
    "Input Sheet": row.inputSheet,
    "Source Row": row.sourceRow,
    ...row.values,
    "Normalized Website": row.normalizedWebsite ?? "",
    "Primary Email": result?.primaryEmail ?? "",
    "All Emails": result?.emails.map((hit) => hit.email).join("; ") ?? "",
    "Email Source URL": result?.emails[0]?.sourceUrl ?? "",
    "Discovery Method": result?.emails[0]?.sourceType ?? "",
    "Primary Email Score": result?.primaryEmailScore ?? result?.emails[0]?.score ?? "",
    "Primary Email Confidence": result?.primaryEmailScore === undefined && result?.emails[0]?.score === undefined
      ? ""
      : Number(((result?.primaryEmailScore ?? result?.emails[0]?.score ?? 0) / 100).toFixed(2)),
    "Crawl Status": result?.status ?? row.preflightStatus ?? "not_processed",
    "Final URL": result?.finalUrl ?? "",
    "HTTP Status": result?.httpStatus ?? "",
    "Pages Crawled": result?.pagesCrawled ?? 0,
    "HTTP Requests": result?.httpRequests ?? 0,
    "Browser Pages": result?.browserPages ?? 0,
    "Fallback Reason": result?.fallbackReason ?? "",
    "Error Class": result?.errorClass ?? "",
    "Robots ms": result?.robotsMs ?? 0,
    "Fetch ms": result?.fetchMs ?? 0,
    "Parse ms": result?.parseMs ?? 0,
    "Navigation ms": result?.navigationMs ?? 0,
    "Duration ms": result?.durationMs ?? 0,
    Error: result?.error ?? "",
  };
}

export function buildOutputRecords(rows: LeadRow[], results: Map<string, CrawlResult>): Record<string, unknown>[] {
  return rows.map((row) => outputRecord(row, row.crawlKey ? results.get(row.crawlKey) : undefined));
}

export function recordsToCsv(records: Record<string, unknown>[]): string {
  const headers = records.length ? Object.keys(records[0]!) : [];
  return [headers.map(csvCell).join(","), ...records.map((record) => headers.map((header) => csvCell(record[header])).join(","))].join("\n") + "\n";
}

export async function writeLiveXlsx(
  filePath: string,
  records: Record<string, unknown>[],
): Promise<void> {
  const headers = records.length ? Object.keys(records[0]!) : [];
  const workbook = new ExcelJS.stream.xlsx.WorkbookWriter({ filename: filePath, useStyles: true });
  const sheet = workbook.addWorksheet("Email results", { views: [{ state: "frozen", ySplit: 1 }] });
  if (headers.length) {
    const header = sheet.addRow(headers);
    applyWorksheetStyle(sheet, header, headers);
    header.commit();
    for (const record of records) sheet.addRow(headers.map((name) => record[name] ?? "")).commit();
  }
  sheet.commit();
  await workbook.commit();
}

function applyWorksheetStyle(worksheet: ExcelJS.Worksheet, header: ExcelJS.Row, headers: string[]): void {
  worksheet.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: headers.length } };
  header.font = { bold: true, color: { argb: "FFFFFFFF" } };
  header.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF17324D" } };
  header.alignment = { vertical: "middle" };
  header.height = 24;
  headers.forEach((name, index) => {
    const width = /url|website|address|error/i.test(name) ? 42 : /email/i.test(name) ? 30 : 18;
    worksheet.getColumn(index + 1).width = width;
  });
}

export async function writeOutputs(
  outputDirectory: string,
  rows: LeadRow[],
  results: Map<string, CrawlResult>,
  summary: RunSummary,
): Promise<{ xlsx: string; csv: string; summary: string }> {
  fs.mkdirSync(outputDirectory, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const xlsxPath = path.join(outputDirectory, `email-results-${stamp}.xlsx`);
  const csvPath = path.join(outputDirectory, `email-results-${stamp}.csv`);
  const summaryPath = path.join(outputDirectory, `benchmark-summary-${stamp}.json`);
  const records = buildOutputRecords(rows, results);
  const headers = records.length ? Object.keys(records[0]!) : [];

  const workbook = new ExcelJS.stream.xlsx.WorkbookWriter({ filename: xlsxPath, useStyles: true });
  const sheet = workbook.addWorksheet("Email results", { views: [{ state: "frozen", ySplit: 1 }] });
  if (headers.length) {
    const header = sheet.addRow(headers);
    applyWorksheetStyle(sheet, header, headers);
    header.commit();
    for (const record of records) sheet.addRow(headers.map((header) => record[header] ?? "")).commit();
  }
  sheet.commit();

  const summarySheet = workbook.addWorksheet("Benchmark summary");
  summarySheet.columns = [
    { key: "metric", width: 30 },
    { key: "value", width: 45 },
  ];
  const summaryHeader = summarySheet.addRow(["Metric", "Value"]);
  summaryHeader.font = { bold: true, color: { argb: "FFFFFFFF" } };
  summaryHeader.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF17324D" } };
  summaryHeader.commit();
  Object.entries(summary).forEach(([metric, value]) => {
    summarySheet.addRow({ metric, value: typeof value === "object" ? JSON.stringify(value) : value });
  });
  summarySheet.commit();
  await workbook.commit();

  fs.writeFileSync(csvPath, recordsToCsv(records), "utf8");
  fs.writeFileSync(summaryPath, `${JSON.stringify(summary, null, 2)}\n`, "utf8");
  return { xlsx: xlsxPath, csv: csvPath, summary: summaryPath };
}
