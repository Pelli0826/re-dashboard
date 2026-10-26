import OpenAI from "openai";
import { PDFParse } from "pdf-parse";
import { fromBuffer } from "pdf2pic";
import { claudeConfigured, claudeJsonFromPdf, claudeJsonFromText } from "./claude";

// Lazy init — only create client when a request actually comes in
function getOpenAI() {
  return new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
}

// ── What we want to extract from each document type ──────────────────────
const PROMPTS: Record<string, string> = {
  om: `You are a real estate underwriting assistant analyzing an Offering Memorandum (OM).
Extract key financial and property data from these pages.

Return ONLY a valid JSON object with these fields (use null if not found, numbers only — no $ signs or commas):
{
  "dealName": string or null,
  "address": string or null,
  "dealType": "multifamily" | "commercial" | "development" | "value-add" | null,
  "purchasePrice": number or null,
  "units": number or null,
  "sqft": number or null,
  "grossPotentialRent": number or null,
  "vacancyRate": number or null,
  "otherIncome": number or null,
  "operatingExpenses": number or null,
  "noi": number or null,
  "capRate": number or null,
  "notes": string or null
}`,

  rentroll: `You are a real estate underwriting assistant analyzing a Rent Roll.
Extract rental income data from these pages.

Return ONLY a valid JSON object with these fields (use null if not found, numbers only — no $ signs or commas):
{
  "totalUnits": number or null,
  "occupiedUnits": number or null,
  "vacancyRate": number or null,
  "grossPotentialRent": number or null,
  "currentActualRent": number or null,
  "averageRentPerUnit": number or null,
  "notes": string or null
}`,

  pl: `You are a real estate underwriting assistant analyzing a Profit & Loss or Operating Statement (often a trailing-12-month "T12").
Extract financial data from this document. Use the most recent full 12 months (or the annual total column); annualize only if the statement covers less than a year.
operatingExpenses is TOTAL operating expenses, excluding debt service, interest, depreciation, amortization and capital expenditures.
managementFees is the management fee line if there is one (it may be included in operatingExpenses).

Return ONLY a valid JSON object with these fields (use null if not found, numbers only — no $ signs or commas):
{
  "grossPotentialRent": number or null,
  "vacancyLoss": number or null,
  "otherIncome": number or null,
  "effectiveGrossIncome": number or null,
  "operatingExpenses": number or null,
  "managementFees": number or null,
  "managementFeesIncludedInOperatingExpenses": true | false | null,
  "noi": number or null,
  "periodCovered": string or null,
  "notes": string or null
}`,
};

export type DocType = "om" | "rentroll" | "pl";

export interface ExtractedData {
  docType: DocType;
  raw: Record<string, any>;
  method: "claude" | "vision" | "text";
  dealName?: string | null;
  address?: string | null;
  dealType?: string | null;
  purchasePrice?: number | null;
  grossPotentialRent?: number | null;
  vacancyRate?: number | null;
  otherIncome?: number | null;
  operatingExpenses?: number | null;
  noi?: number | null;
  managementFeeRate?: number | null;
  notes?: string | null;
}

// ── Convert first N pages of PDF to base64 images ────────────────────────
async function pdfToImages(buffer: Buffer, maxPages = 8): Promise<string[]> {
  const convert = fromBuffer(buffer, {
    density: 150,        // DPI — 150 is good balance of quality vs size
    format: "jpeg",
    width: 1200,
    height: 1600,
    preserveAspectRatio: true,
  });

  const images: string[] = [];
  for (let i = 1; i <= maxPages; i++) {
    try {
      const result = await convert(i, { responseType: "base64" });
      if (result?.base64) {
        images.push(result.base64);
      }
    } catch {
      // Page doesn't exist — stop
      break;
    }
  }
  return images;
}

// ── Main extraction function ──────────────────────────────────────────────
export async function extractFromPdf(buffer: Buffer, docType: DocType): Promise<ExtractedData> {
  const prompt = PROMPTS[docType];
  if (!prompt) throw new Error("Unknown document type");

  let raw: Record<string, any> = {};
  let method: "claude" | "vision" | "text" = "vision";

  if (claudeConfigured()) {
    // Claude reads the whole PDF (text + page images) in one request.
    raw = await claudeJsonFromPdf(buffer, prompt);
    method = "claude";
  } else {
  // Strategy 1: Try vision-based extraction (works on scanned PDFs)
  try {
    const images = await pdfToImages(buffer, 10);
    if (images.length > 0) {
      const imageContent = images.map(b64 => ({
        type: "image_url" as const,
        image_url: { url: `data:image/jpeg;base64,${b64}`, detail: "high" as const },
      }));

      const response = await getOpenAI().chat.completions.create({
        model: "gpt-4o",
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: prompt },
              ...imageContent,
            ],
          },
        ],
        response_format: { type: "json_object" },
        temperature: 0,
        max_tokens: 1000,
      });

      const content = response.choices[0]?.message?.content ?? "{}";
      raw = JSON.parse(content);
      method = "vision";
    } else {
      throw new Error("No images generated — falling back to text");
    }
  } catch (visionErr: any) {
    // Strategy 2: Fallback to text extraction for text-based PDFs
    try {
      // pdf-parse v2 API (the old default-export call no longer exists)
      const parser = new PDFParse({ data: buffer });
      let fullText = "";
      try {
        fullText = (await parser.getText()).text;
      } finally {
        await parser.destroy();
      }
      const text = fullText.slice(0, 20000);
      if (!text || text.trim().length < 50) {
        throw new Error("PDF appears to be empty or unreadable.");
      }

      const response = await getOpenAI().chat.completions.create({
        model: "gpt-4o",
        messages: [{ role: "user", content: prompt + "\n\nDocument text:\n" + text }],
        response_format: { type: "json_object" },
        temperature: 0,
        max_tokens: 1000,
      });

      const content = response.choices[0]?.message?.content ?? "{}";
      raw = JSON.parse(content);
      method = "text";
    } catch (textErr: any) {
      throw new Error(
        "Could not read this PDF. Make sure it is not password-protected. " +
        (textErr.message ?? "")
      );
    }
  }

  }

  return normalize(docType, raw, method);
}

// Excel, Word or CSV already converted to text (Claude only).
export async function extractFromText(name: string, text: string, docType: DocType): Promise<ExtractedData> {
  const prompt = PROMPTS[docType];
  if (!prompt) throw new Error("Unknown document type");
  if (!claudeConfigured()) throw new Error("Set ANTHROPIC_API_KEY in Railway to read Excel and Word files.");
  return normalize(docType, await claudeJsonFromText(name, text.slice(0, 400_000), prompt), "claude");
}

// ── Normalize into underwriting fields ──────────────────────────────────
function normalize(docType: DocType, raw: Record<string, any>, method: ExtractedData["method"]): ExtractedData {
  const result: ExtractedData = { docType, raw, method };

  if (docType === "om") {
    result.dealName = raw.dealName ?? null;
    result.address = raw.address ?? null;
    result.dealType = raw.dealType ?? null;
    result.purchasePrice = toNum(raw.purchasePrice);
    result.grossPotentialRent = toNum(raw.grossPotentialRent);
    result.vacancyRate = toNum(raw.vacancyRate);
    result.otherIncome = toNum(raw.otherIncome);
    result.operatingExpenses = toNum(raw.operatingExpenses);
    result.noi = toNum(raw.noi);
    result.notes = raw.notes ?? null;
  } else if (docType === "rentroll") {
    result.grossPotentialRent = toNum(raw.grossPotentialRent);
    result.vacancyRate = toNum(raw.vacancyRate);
    result.notes = raw.notes ?? `${raw.totalUnits ?? "?"} units, ${raw.occupiedUnits ?? "?"} occupied`;
  } else if (docType === "pl") {
    const gpr = toNum(raw.grossPotentialRent), egi = toNum(raw.effectiveGrossIncome), loss = toNum(raw.vacancyLoss);
    result.grossPotentialRent = gpr ?? egi;
    // Without a gross figure, the effective income already reflects vacancy: don't deduct it twice.
    result.vacancyRate = gpr && loss ? Math.round((loss / gpr) * 1000) / 10 : !gpr && egi ? 0 : null;
    result.otherIncome = toNum(raw.otherIncome);
    // The model adds its own management fee (a % of income), so take the statement's fee out of
    // operating expenses and use it to set that %. Otherwise the fee would be counted twice.
    const opex = toNum(raw.operatingExpenses), fee = toNum(raw.managementFees);
    result.operatingExpenses = opex != null && fee != null && raw.managementFeesIncludedInOperatingExpenses !== false ? Math.max(0, opex - fee) : opex;
    const income = (gpr ?? egi ?? 0) * (1 - (result.vacancyRate ?? 0) / 100) + (result.otherIncome ?? 0);
    result.managementFeeRate = fee != null && income > 0 ? Math.round((fee / income) * 1000) / 10 : null;
    result.noi = toNum(raw.noi);
    result.notes = raw.notes ?? null;
  }

  return result;
}

function toNum(v: any): number | null {
  if (v == null) return null;
  const n = typeof v === "string" ? parseFloat(v.replace(/[^0-9.-]/g, "")) : Number(v);
  return isFinite(n) && n > 0 ? n : null;
}
