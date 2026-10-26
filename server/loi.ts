// Builds the letter of intent as a Word document in the firm's LOI layout:
// date and recipient, Re: line, two-column terms, signature and acceptance blocks.
import {
  Document, Packer, Paragraph, TextRun, Table, TableRow, TableCell, WidthType, BorderStyle, PageBreak,
} from "docx";
import { loiSections, buyerEntity, LOI_INTRO, type LoiTerms } from "@shared/loi";

const FONT = "Times New Roman";
const SIZE = 23; // half-points: 11.5 pt
const NONE = { style: BorderStyle.NONE, size: 0, color: "FFFFFF" };
const NO_BORDERS = { top: NONE, bottom: NONE, left: NONE, right: NONE, insideHorizontal: NONE, insideVertical: NONE };

function longDate(ymd: string): string {
  const [y, m, d] = ymd.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric", timeZone: "UTC" });
}

const p = (text: string, opts: { bold?: boolean; after?: number; justify?: boolean } = {}) =>
  new Paragraph({
    spacing: { after: opts.after ?? 200 },
    alignment: opts.justify ? "both" : undefined,
    children: [new TextRun({ text, bold: opts.bold, font: FONT, size: SIZE })],
  });

const line = (text = "") => p(text, { after: 0 });

function signatureBlock(party: string, entity: string, name: string, title: string): Paragraph[] {
  return [
    p(`${party}:`, { bold: true, after: 60 }),
    line(entity),
    line(""),
    line("By: _______________________________"),
    line(`Name: ${name}`),
    line(`Title: ${title}`),
    p("Date: _____________________________", { after: 360 }),
  ];
}

export async function buildLoiDocx(t: LoiTerms): Promise<Buffer> {
  const first = t.recipientName.trim().split(/\s+/)[0];
  const termsTable = new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    borders: NO_BORDERS,
    rows: loiSections(t).map(sec => new TableRow({
      cantSplit: false,
      children: [
        new TableCell({ width: { size: 27, type: WidthType.PERCENTAGE }, borders: NO_BORDERS, children: [p(`${sec.label}:`, { bold: true })] }),
        new TableCell({ width: { size: 73, type: WidthType.PERCENTAGE }, borders: NO_BORDERS, children: sec.paragraphs.map(x => p(x, { justify: true })) }),
      ],
    })),
  });

  const doc = new Document({
    creator: "RE Dashboard",
    title: `Letter of Intent - ${t.property}`,
    styles: { default: { document: { run: { font: FONT, size: SIZE } } } },
    sections: [{
      properties: { page: { margin: { top: 1440, bottom: 1440, left: 1440, right: 1440 } } },
      children: [
        p(longDate(t.date), { after: 240 }),
        ...[t.recipientName, t.recipientCompany].filter(s => s.trim()).map(s => line(s)),
        ...(t.recipientEmail.trim() ? [line(`Via EMAIL: ${t.recipientEmail.trim()}`)] : []),
        line(""),
        p(`Re: Letter of Intent to Purchase ${t.property} (the "Property")`, { bold: true, after: 240 }),
        p(first ? `${first}:` : "To whom it may concern:"),
        p(LOI_INTRO, { justify: true }),
        termsTable,
        p("Thank you for your consideration of this proposal. We look forward to your response.", { justify: true }),
        p(`If you have any questions regarding this proposal, please feel free to call me${t.signerPhone.trim() ? ` at ${t.signerPhone.trim()}` : ""}.`, { justify: true }),
        p("Respectfully,", { after: 600 }),
        line(t.signerName),
        p(buyerEntity(t.buyer), { after: 0 }),
        new Paragraph({ children: [new PageBreak()] }),
        p("AGREED AND ACCEPTED", { bold: true, after: 240 }),
        p("IN WITNESS WHEREOF, the parties hereto have executed this LOI as of the dates written below.", { justify: true, after: 360 }),
        ...signatureBlock("BUYER", buyerEntity(t.buyer), t.signerName, t.signerTitle),
        ...signatureBlock("SELLER", t.seller, "", ""),
      ],
    }],
  });
  return Packer.toBuffer(doc);
}
