import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import ExcelJS from "exceljs";
import { afterEach, describe, expect, it } from "vitest";
import { loadLeadRows } from "../src/input.js";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

describe("loadLeadRows", () => {
  it("finds a Website header after title rows and reads shared strings", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "email-crawler-input-"));
    temporaryDirectories.push(directory);
    const filePath = path.join(directory, "input.xlsx");
    const workbook = new ExcelJS.Workbook();
    const worksheet = workbook.addWorksheet("Data unique");
    worksheet.addRow(["Danh sách leads"]);
    worksheet.addRow([]);
    worksheet.addRow([]);
    worksheet.addRow([]);
    worksheet.addRow(["STT unique", "Name", "Website"]);
    worksheet.addRow([1, "Acme", "acme.example/contact?utm_source=maps"]);
    await workbook.xlsx.writeFile(filePath);

    const rows = await loadLeadRows(filePath, "Data unique");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      sourceRow: 6,
      websiteRaw: "acme.example/contact?utm_source=maps",
      normalizedWebsite: "https://acme.example/contact",
      crawlKey: "acme.example/contact",
    });
  });
});
