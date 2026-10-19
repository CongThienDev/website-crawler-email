import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import ExcelJS from "exceljs";
import JSZip from "jszip";
import { afterEach, describe, expect, it } from "vitest";
import { LEAD_HEADERS, loadLeadRows } from "../src/input.js";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

async function writeLeads(rows: unknown[][], { stripCellRefs = false } = {}): Promise<string> {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "email-crawler-input-"));
  temporaryDirectories.push(directory);
  const filePath = path.join(directory, "input.xlsx");
  const workbook = new ExcelJS.Workbook();
  const worksheet = workbook.addWorksheet("Leads");
  worksheet.addRow(LEAD_HEADERS);
  rows.forEach((row) => worksheet.addRow(row));
  await workbook.xlsx.writeFile(filePath);
  if (stripCellRefs) {
    // lead-ledger writes <c> and <row> without r="..." references.
    const zip = await JSZip.loadAsync(fs.readFileSync(filePath));
    const xml = await zip.file("xl/worksheets/sheet1.xml")!.async("string");
    zip.file("xl/worksheets/sheet1.xml", xml.replace(/<(c|row)\b([^>]*?) r="[^"]*"/g, "<$1$2"));
    fs.writeFileSync(filePath, await zip.generateAsync({ type: "nodebuffer" }));
  }
  return filePath;
}

const lead = (website: string, domain: string): unknown[] =>
  [1, "Acme", "1 Main St", "+1555", website, "", "4.5", "10", "plumber", "Austin", "https://maps/x", "1", "2", domain];

describe("loadLeadRows", () => {
  it("keys rows by the lead-ledger Domain, even without cell references", async () => {
    const filePath = await writeLeads(
      [
        lead("https://www.acme.com/locations/austin?utm_source=maps", "acme.com"),
        lead("https://acme.com/", "acme.com"),
        lead("https://acme.wixsite.com/home", ""),
        lead("", ""),
      ],
      { stripCellRefs: true },
    );
    const rows = await loadLeadRows(filePath);
    expect(rows.map((row) => [row.crawlKey, row.preflightStatus])).toEqual([
      ["acme.com", undefined],
      ["acme.com", undefined],
      [undefined, "shared_host"],
      [undefined, "no_website"],
    ]);
    expect(rows[0]!.normalizedWebsite).toBe("https://www.acme.com/locations/austin");
    expect(rows[0]!.values.City).toBe("Austin");
  });

  it("rejects files that are not a lead-ledger export", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "email-crawler-input-"));
    temporaryDirectories.push(directory);
    const filePath = path.join(directory, "old.xlsx");
    const workbook = new ExcelJS.Workbook();
    workbook.addWorksheet("Leads").addRow(["Name", "Website"]);
    await workbook.xlsx.writeFile(filePath);
    await expect(loadLeadRows(filePath)).rejects.toThrow(/thiếu cột STT/);
  });
});
