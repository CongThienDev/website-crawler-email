import path from "node:path";
import sax, { type QualifiedAttribute, type QualifiedTag, type Tag } from "sax";
import unzipper, { type File as ZipFile } from "unzipper";
import type { LeadRow, PrimitiveCell } from "./types.js";
import { crawlKey, normalizeWebsite } from "./url.js";

function xmlAttribute(attributes: string, name: string): string | null {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return attributes.match(new RegExp(`(?:^|\\s)${escaped}="([^"]*)"`))?.[1] ?? null;
}

function decodeXml(value: string): string {
  return value
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/&#(\d+);/g, (_match, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([a-f\d]+);/gi, (_match, code) => String.fromCodePoint(Number.parseInt(code, 16)));
}

function saxAttribute(node: QualifiedTag | Tag, name: string): string {
  const attribute = node.attributes[name];
  if (typeof attribute === "string") return attribute;
  return (attribute as QualifiedAttribute | undefined)?.value ?? "";
}

async function resolveWorksheetPath(
  archive: unzipper.CentralDirectory,
  sheetName: string,
): Promise<string | null> {
  const workbookEntry = archive.files.find((entry) => entry.path === "xl/workbook.xml");
  const relationshipsEntry = archive.files.find((entry) => entry.path === "xl/_rels/workbook.xml.rels");
  if (!workbookEntry || !relationshipsEntry) return null;
  const [workbookXml, relationshipsXml] = await Promise.all([
    workbookEntry.buffer().then((buffer) => buffer.toString("utf8")),
    relationshipsEntry.buffer().then((buffer) => buffer.toString("utf8")),
  ]);

  let relationshipId: string | null = null;
  for (const match of workbookXml.matchAll(/<sheet\b([^>]*)\/?\s*>/gi)) {
    const attributes = match[1] ?? "";
    const name = xmlAttribute(attributes, "name");
    if (name && decodeXml(name) === sheetName) {
      relationshipId = xmlAttribute(attributes, "r:id");
      break;
    }
  }
  if (!relationshipId) return null;

  for (const match of relationshipsXml.matchAll(/<Relationship\b([^>]*)\/?\s*>/gi)) {
    const attributes = match[1] ?? "";
    if (xmlAttribute(attributes, "Id") !== relationshipId) continue;
    const target = decodeXml(xmlAttribute(attributes, "Target") ?? "").replace(/\\/g, "/");
    if (!target) return null;
    if (target.startsWith("/xl/")) return target.slice(1);
    if (target.startsWith("xl/")) return target;
    return path.posix.normalize(path.posix.join("xl", target));
  }
  return null;
}

function parseXml(xml: string, configure: (parser: sax.SAXParser) => void): void {
  const parser = sax.parser(true, { trim: false, normalize: false, xmlns: false });
  configure(parser);
  let parseError: Error | null = null;
  parser.onerror = (error) => {
    parseError = error;
    parser.resume();
  };
  parser.write(xml).close();
  if (parseError) throw parseError;
}

async function loadSharedStrings(entry?: ZipFile): Promise<string[]> {
  if (!entry) return [];
  const xml = (await entry.buffer()).toString("utf8");
  const values: string[] = [];
  let insideItem = false;
  let insideText = false;
  let current = "";
  parseXml(xml, (parser) => {
    parser.onopentag = (node) => {
      if (node.name === "si") {
        insideItem = true;
        current = "";
      } else if (insideItem && node.name === "t") {
        insideText = true;
      }
    };
    parser.ontext = (text) => {
      if (insideText) current += text;
    };
    parser.oncdata = (text) => {
      if (insideText) current += text;
    };
    parser.onclosetag = (name) => {
      if (name === "t") insideText = false;
      if (name === "si") {
        values.push(current);
        insideItem = false;
      }
    };
  });
  return values;
}

function columnNumber(reference: string): number {
  const letters = reference.match(/^[A-Z]+/i)?.[0]?.toUpperCase() ?? "";
  let value = 0;
  for (const letter of letters) value = value * 26 + letter.charCodeAt(0) - 64;
  return value;
}

function parsedCellValue(type: string, raw: string, sharedStrings: string[]): PrimitiveCell {
  if (type === "s") return sharedStrings[Number(raw)] ?? "";
  if (type === "b") return raw === "1";
  if (type === "n" || (!type && raw !== "")) {
    const numeric = Number(raw);
    return Number.isFinite(numeric) ? numeric : raw;
  }
  return raw;
}

function makeLead(
  filePath: string,
  sheetName: string,
  rowNumber: number,
  cells: Map<number, PrimitiveCell>,
  headers: string[],
  websiteColumn: number,
): LeadRow {
  const values: Record<string, PrimitiveCell> = {};
  headers.forEach((header, index) => {
    if (header) values[header] = cells.get(index + 1) ?? null;
  });
  const websiteRaw = String(cells.get(websiteColumn) ?? "").trim();
  const lead: LeadRow = {
    inputFile: path.basename(filePath),
    inputSheet: sheetName,
    sourceRow: rowNumber,
    values,
    websiteRaw,
  };
  if (!websiteRaw) {
    lead.preflightStatus = "no_website";
  } else {
    const normalized = normalizeWebsite(websiteRaw);
    if (!normalized) {
      lead.preflightStatus = "invalid_url";
    } else {
      lead.normalizedWebsite = normalized;
      lead.crawlKey = crawlKey(normalized);
    }
  }
  return lead;
}

async function parseWorksheet(
  entry: ZipFile,
  sharedStrings: string[],
  filePath: string,
  sheetName: string,
): Promise<LeadRow[]> {
  const xml = (await entry.buffer()).toString("utf8");
  const leads: LeadRow[] = [];
  let headers: string[] = [];
  let websiteColumn = 0;
  let currentRowNumber = 0;
  let currentCells = new Map<number, PrimitiveCell>();
  let currentCellReference = "";
  let currentCellType = "";
  let currentCellRaw = "";
  let insideCellValue = false;

  parseXml(xml, (parser) => {
    parser.onopentag = (node) => {
      if (node.name === "row") {
        currentRowNumber = Number(saxAttribute(node, "r")) || currentRowNumber + 1;
        currentCells = new Map();
      } else if (node.name === "c") {
        currentCellReference = saxAttribute(node, "r");
        currentCellType = saxAttribute(node, "t");
        currentCellRaw = "";
      } else if (currentCellReference && (node.name === "v" || node.name === "t")) {
        insideCellValue = true;
      }
    };
    parser.ontext = (text) => {
      if (insideCellValue) currentCellRaw += text;
    };
    parser.oncdata = (text) => {
      if (insideCellValue) currentCellRaw += text;
    };
    parser.onclosetag = (name) => {
      if (name === "v" || name === "t") insideCellValue = false;
      if (name === "c") {
        const column = columnNumber(currentCellReference);
        if (column) currentCells.set(column, parsedCellValue(currentCellType, currentCellRaw, sharedStrings));
        currentCellReference = "";
        currentCellType = "";
        currentCellRaw = "";
      }
      if (name === "row") {
        if (!websiteColumn) {
          const maxColumn = Math.max(0, ...currentCells.keys());
          const candidateHeaders = Array.from({ length: maxColumn }, (_unused, index) =>
            String(currentCells.get(index + 1) ?? "").trim(),
          );
          const match = candidateHeaders.findIndex((header) => header.toLowerCase() === "website");
          if (match >= 0) {
            headers = candidateHeaders;
            websiteColumn = match + 1;
          }
        } else if (currentCells.size) {
          leads.push(makeLead(filePath, sheetName, currentRowNumber, currentCells, headers, websiteColumn));
        }
      }
    };
  });
  if (!websiteColumn) throw new Error(`Không tìm thấy cột Website trong sheet "${sheetName}" của ${filePath}`);
  return leads;
}

export async function loadLeadRows(filePath: string, sheetName: string): Promise<LeadRow[]> {
  const archive = await unzipper.Open.file(filePath);
  const worksheetPath = await resolveWorksheetPath(archive, sheetName);
  if (!worksheetPath) throw new Error(`Không tìm thấy sheet "${sheetName}" trong ${filePath}`);
  const worksheetEntry = archive.files.find((entry) => entry.path === worksheetPath);
  if (!worksheetEntry) throw new Error(`Thiếu worksheet XML cho sheet "${sheetName}" trong ${filePath}`);
  const sharedStrings = await loadSharedStrings(archive.files.find((entry) => entry.path === "xl/sharedStrings.xml"));
  return parseWorksheet(worksheetEntry, sharedStrings, filePath, sheetName);
}
