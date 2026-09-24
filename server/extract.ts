import OpenAI from "openai";
import { PDFParse } from "pdf-parse";
import { fromBuffer } from "pdf2pic";
import { claudeConfigured, claudeJsonFromPdf } from "./claude";

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

  pl: `You are a real estate underwriting assistant analyzing a Profit & Loss or Operating Statement.
Extract financial data from these pages. Annualize any monthly figures.

Return ONLY a valid JSON object with these fields (use null if not found, numbers only — no $ signs or commas):
{
  "grossPotentialRent": number or null,
  "vacancyLoss": number or null,
  "otherIncome": number or null,
  "effectiveGrossIncome": number or null,
  "operatingExpenses": number or null,
  "managementFees": number or null,
  "noi": number or null,
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

  // ── Normalize into underwriting fields ──────────────────────────────────
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
    result.grossPotentialRent = toNum(raw.grossPotentialRent) ?? toNum(raw.effectiveGrossIncome);
    result.vacancyRate = raw.grossPotentialRent && raw.vacancyLoss
      ? Math.round((raw.vacancyLoss / raw.grossPotentialRent) * 100 * 10) / 10
      : null;
    result.otherIncome = toNum(raw.otherIncome);
    result.operatingExpenses = toNum(raw.operatingExpenses);
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
