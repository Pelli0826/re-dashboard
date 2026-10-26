// Turns saved deal files that aren't PDFs into plain text Claude can read:
// Word (.docx), Excel (.xlsx), CSV and text. Returns null for types we can't read.
import mammoth from "mammoth";
import ExcelJS from "exceljs";

export const TEXT_READABLE = /\.(docx|xlsx|csv|txt|md)$/i;

function cellText(v: ExcelJS.CellValue): string {
  if (v == null) return "";
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  if (typeof v === "object") {
    if ("result" in v) return cellText(v.result as ExcelJS.CellValue);    // formula: use its last calculated value
    if ("richText" in v) return v.richText.map(r => r.text).join("");
    if ("text" in v) return String(v.text);                               // hyperlink
    if ("error" in v) return "";
    return "";
  }
  return String(v);
}

// One block per sheet, one line per row, cells separated by tabs (keeps statement columns lined up).
async function excelToText(buffer: Buffer): Promise<string> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer as any);
  const out: string[] = [];
  wb.eachSheet(sheet => {
    if (sheet.state && sheet.state !== "visible") return;
    const rows: string[] = [];
    sheet.eachRow({ includeEmpty: false }, row => {
      const cells = (row.values as ExcelJS.CellValue[]).slice(1).map(cellText);
      while (cells.length && !cells[cells.length - 1].trim()) cells.pop();
      if (cells.some(c => c.trim())) rows.push(cells.join("\t"));
    });
    if (rows.length) out.push(`Sheet: ${sheet.name}\n${rows.join("\n")}`);
  });
  return out.join("\n\n");
}

export async function fileToText(name: string, buffer: Buffer): Promise<string | null> {
  if (/\.docx$/i.test(name)) return (await mammoth.extractRawText({ buffer })).value.trim();
  if (/\.xlsx$/i.test(name)) return (await excelToText(buffer)).trim();
  if (/\.(csv|txt|md)$/i.test(name)) return buffer.toString("utf8").trim();
  return null;
}
