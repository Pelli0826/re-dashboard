// Turns saved deal files that aren't PDFs into plain text Claude can read:
// Word (.docx), Excel (.xlsx / .xlsm), CSV and text. Returns null for types we can't read.
import mammoth from "mammoth";
import JSZip from "jszip";

export const TEXT_READABLE = /\.(docx|xlsx|xlsm|csv|txt|md)$/i;

// Big models can hold far more than Claude needs; stop collecting past this many characters.
const MAX_EXCEL_CHARS = 400_000;

// ── Excel ──────────────────────────────────────────────────────────────────
// An .xlsx/.xlsm file is a zip of XML parts. We read cell values straight from the XML:
// one sheet at a time, in order, with each formula's last calculated value. (Full Excel
// libraries load every style and formula into memory, which takes gigabytes for large
// models, and the streaming one skipped sheets at random.)

const decode = (s: string) => s
  .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
  .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
  .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&");

const attrs = (tag: string): Record<string, string> => {
  const out: Record<string, string> = {};
  for (const m of Array.from(tag.matchAll(/([\w:]+)="([^"]*)"/g))) out[m[1]] = decode(m[2]);
  return out;
};

// All text runs inside an element (shared strings and inline strings can be rich text).
const runs = (xml: string) =>
  Array.from(xml.replace(/<rPh\b[\s\S]*?<\/rPh>/g, "").matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)).map(m => decode(m[1])).join("");

// Built-in date formats, and custom formats that contain day/month/year codes (not inside quotes or [colors]).
const DATE_IDS = new Set([14, 15, 16, 17, 18, 19, 20, 21, 22, 27, 30, 36, 45, 46, 47, 50, 57]);
const isDateFormat = (code: string) => /[dmy]/i.test(code.replace(/"[^"]*"|\[[^\]]*\]|\\./g, ""));

function colIndex(ref: string): number {
  let n = 0;
  for (const ch of ref.replace(/\d+$/, "")) n = n * 26 + (ch.toUpperCase().charCodeAt(0) - 64);
  return n - 1;
}

function serialToDate(n: number, date1904: boolean): string {
  const ms = Math.round((n - (date1904 ? -1462 : 0) - 25569) * 86400000); // 25569 = days from 1899-12-30 to 1970-01-01
  const d = new Date(ms);
  return isNaN(d.getTime()) ? String(n) : d.toISOString().slice(0, 10);
}

// Calls onRow for each row with cell text, sheet by sheet in workbook order (visible sheets only).
// onRow returns false to stop reading.
export async function readExcelRows(
  buffer: Buffer,
  onSheet: (name: string) => void,
  onRow: (row: number, cells: string[]) => boolean,
): Promise<void> {
  const zip = await JSZip.loadAsync(buffer);
  const read = async (p: string) => (await zip.file(p)?.async("string")) ?? "";

  const workbook = await read("xl/workbook.xml");
  const date1904 = /<workbookPr\b[^>]*date1904="(1|true)"/.test(workbook);
  const rels: Record<string, string> = {};
  for (const m of Array.from((await read("xl/_rels/workbook.xml.rels")).matchAll(/<Relationship\b[^>]*>/g))) {
    const a = attrs(m[0]);
    rels[a.Id] = a.Target.startsWith("/") ? a.Target.slice(1) : `xl/${a.Target}`;
  }
  const shared = Array.from((await read("xl/sharedStrings.xml")).matchAll(/<si\b[^>]*?(?:\/>|>([\s\S]*?)<\/si>)/g)).map(m => runs(m[1] ?? ""));

  const styles = await read("xl/styles.xml");
  const customFormats: Record<number, string> = {};
  for (const m of Array.from(styles.matchAll(/<numFmt\b[^>]*>/g))) { const a = attrs(m[0]); customFormats[Number(a.numFmtId)] = a.formatCode ?? ""; }
  const xfs = styles.match(/<cellXfs\b[^>]*>([\s\S]*?)<\/cellXfs>/)?.[1] ?? "";
  const dateStyle = Array.from(xfs.matchAll(/<xf\b[^>]*>/g)).map(m => {
    const id = Number(attrs(m[0]).numFmtId ?? 0);
    return DATE_IDS.has(id) || (id in customFormats && isDateFormat(customFormats[id]));
  });

  for (const m of Array.from(workbook.matchAll(/<sheet\b[^>]*>/g))) {
    const a = attrs(m[0]);
    if (a.state && a.state !== "visible") continue;
    const path = rels[a["r:id"]];
    const xml = path ? await read(path) : "";
    onSheet(a.name ?? "Sheet");
    let rowNum = 0;
    for (const r of Array.from(xml.matchAll(/<row\b([^>]*?)(?:\/>|>([\s\S]*?)<\/row>)/g))) {
      rowNum = Number(attrs(r[1]).r) || rowNum + 1;
      const cells: string[] = [];
      for (const c of Array.from((r[2] ?? "").matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g))) {
        const ca = attrs(c[1]);
        const body = c[2] ?? "";
        const v = body.match(/<v(?:\s[^>]*)?>([\s\S]*?)<\/v>/)?.[1]; // <v xml:space="preserve"> keeps edge spaces
        let text = "";
        if (ca.t === "s") text = v != null ? shared[Number(v)] ?? "" : "";
        else if (ca.t === "inlineStr") text = runs(body);
        else if (ca.t === "str") text = v != null ? decode(v) : "";
        else if (ca.t === "b") text = v === "1" ? "TRUE" : v === "0" ? "FALSE" : "";
        else if (ca.t === "e") text = "";
        else if (v != null) {
          const n = Number(v);
          text = !Number.isFinite(n) ? v : dateStyle[Number(ca.s ?? 0)] ? serialToDate(n, date1904) : String(n);
        }
        const i = ca.r ? colIndex(ca.r) : cells.length;
        while (cells.length < i) cells.push("");
        cells[i] = text;
      }
      if (onRow(rowNum, cells) === false) return;
    }
  }
}

// One block per sheet, one line per row, cells separated by tabs (keeps statement columns lined up).
async function excelToText(buffer: Buffer): Promise<string> {
  const out: string[] = [];
  let rows: string[] = [], sheet = "", total = 0, truncated = false;
  const flush = () => { if (rows.length) out.push(`Sheet: ${sheet}\n${rows.join("\n")}`); rows = []; };
  await readExcelRows(buffer, name => { flush(); sheet = name; }, (_row, cells) => {
    while (cells.length && !cells[cells.length - 1].trim()) cells.pop();
    if (!cells.some(x => x.trim())) return true;
    const line = cells.join("\t");
    total += line.length + 1;
    if (total > MAX_EXCEL_CHARS) { truncated = true; return false; }
    rows.push(line);
    return true;
  });
  flush();
  if (truncated) out.push("(Workbook truncated here: it is larger than can be read in one go.)");
  return out.join("\n\n");
}

export async function fileToText(name: string, buffer: Buffer): Promise<string | null> {
  if (/\.docx$/i.test(name)) return (await mammoth.extractRawText({ buffer })).value.trim();
  if (/\.xls[xm]$/i.test(name)) return (await excelToText(buffer)).trim();
  if (/\.(csv|txt|md)$/i.test(name)) return buffer.toString("utf8").trim();
  return null;
}
