// Turns saved deal files that aren't PDFs into plain text Claude can read:
// Word (.docx), Excel (.xlsx / .xlsm), CSV and text. Returns null for types we can't read.
import mammoth from "mammoth";
import ExcelJS from "exceljs";
import { Readable } from "stream";

export const TEXT_READABLE = /\.(docx|xlsx|xlsm|csv|txt|md)$/i;

function cellText(v: ExcelJS.CellValue): string {
  if (v == null) return "";
  if (v instanceof Date) return isNaN(v.getTime()) ? "" : v.toISOString().slice(0, 10);
  if (typeof v === "object") {
    if ("result" in v) return cellText(v.result as ExcelJS.CellValue);    // formula: use its last calculated value
    if ("richText" in v) return v.richText.map(r => r.text).join("");
    if ("text" in v) return String(v.text);                               // hyperlink
    if ("error" in v) return "";
    return "";
  }
  return String(v);
}

// Big models can hold far more than Claude needs; stop collecting past this many characters.
const MAX_EXCEL_CHARS = 400_000;

// One block per sheet, one line per row, cells separated by tabs (keeps statement columns lined up).
// Streams the workbook row by row: loading a large model whole can take gigabytes of memory.
async function excelToText(buffer: Buffer): Promise<string> {
  const reader = new ExcelJS.stream.xlsx.WorkbookReader(Readable.from(buffer), {
    sharedStrings: "cache", styles: "cache", hyperlinks: "ignore", worksheets: "emit", entries: "ignore",
  });
  const out: string[] = [];
  let total = 0, truncated = false;
  for await (const sheet of reader as AsyncIterable<any>) {
    const rows: string[] = [];
    const hidden = sheet.state && sheet.state !== "visible";
    for await (const row of sheet as AsyncIterable<ExcelJS.Row>) {
      if (hidden || truncated) continue; // keep draining the stream
      // row.values is sparse (blank cells are holes), so fill the holes with "".
      const values = row.values as ExcelJS.CellValue[];
      const cells = Array.from({ length: Math.max(0, values.length - 1) }, (_, i) => cellText(values[i + 1]));
      while (cells.length && !cells[cells.length - 1].trim()) cells.pop();
      if (!cells.some(c => c.trim())) continue;
      const line = cells.join("\t");
      total += line.length + 1;
      if (total > MAX_EXCEL_CHARS) { truncated = true; continue; }
      rows.push(line);
    }
    if (rows.length) out.push(`Sheet: ${sheet.name ?? "Sheet"}\n${rows.join("\n")}`);
  }
  if (truncated) out.push("(Workbook truncated here: it is larger than can be read in one go.)");
  return out.join("\n\n");
}

export async function fileToText(name: string, buffer: Buffer): Promise<string | null> {
  if (/\.docx$/i.test(name)) return (await mammoth.extractRawText({ buffer })).value.trim();
  if (/\.xls[xm]$/i.test(name)) return (await excelToText(buffer)).trim();
  if (/\.(csv|txt|md)$/i.test(name)) return buffer.toString("utf8").trim();
  return null;
}
