// Claude API integration: reads PDFs (OMs, rent rolls, P&Ls) directly.
// Uses plain fetch, so no extra npm package is needed.
// Requires ANTHROPIC_API_KEY. Optional: ANTHROPIC_MODEL (default below).
import { DEAL_TYPES } from "@shared/pipeline";

const API_URL = process.env.ANTHROPIC_BASE_URL
  ? `${process.env.ANTHROPIC_BASE_URL.replace(/\/$/, "")}/v1/messages`
  : "https://api.anthropic.com/v1/messages";
const DEFAULT_MODEL = "claude-sonnet-5";
export const MAX_PDF_BYTES = 24 * 1024 * 1024; // base64 adds ~33%; API request cap is 32 MB

export function claudeConfigured(): boolean {
  return Boolean(process.env.ANTHROPIC_API_KEY);
}

interface ToolDef { name: string; description: string; input_schema: Record<string, unknown> }

async function callClaude(pdf: Buffer, prompt: string, tool?: ToolDef, maxTokens = 4096): Promise<any> {
  if (!process.env.ANTHROPIC_API_KEY) throw new Error("ANTHROPIC_API_KEY is not set in Railway.");
  if (pdf.length > MAX_PDF_BYTES) {
    throw new Error(`This PDF is ${(pdf.length / 1048576).toFixed(0)} MB. The limit is 24 MB. Compress it (Preview: File → Export → Reduce File Size) or upload the financial section only.`);
  }

  const body: Record<string, unknown> = {
    model: process.env.ANTHROPIC_MODEL || DEFAULT_MODEL,
    max_tokens: maxTokens,
    messages: [{
      role: "user",
      content: [
        { type: "document", source: { type: "base64", media_type: "application/pdf", data: pdf.toString("base64") } },
        { type: "text", text: prompt },
      ],
    }],
  };
  if (tool) {
    body.tools = [tool];
    body.tool_choice = { type: "tool", name: tool.name };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 240_000);
  let res: Response;
  try {
    res = await fetch(API_URL, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": process.env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (err: any) {
    throw new Error(err?.name === "AbortError" ? "Claude took too long to read this PDF. Try again, or upload a shorter file." : "Could not reach the Claude API.");
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    const messages: Record<number, string> = {
      400: "Claude could not read this PDF. Make sure it is not password-protected.",
      401: "The ANTHROPIC_API_KEY in Railway is not valid.",
      403: "The Anthropic API key does not have access to this model.",
      413: "This PDF is too large for one request. Compress it or upload the financial section only.",
      429: "Claude API rate limit reached. Wait a minute and try again.",
      529: "Claude is temporarily overloaded. Try again in a minute.",
    };
    console.error(`[claude] ${res.status}: ${detail.slice(0, 300)}`);
    throw new Error(messages[res.status] ?? `Claude API error (${res.status}).`);
  }

  const data = await res.json();
  if (tool) {
    const block = (data.content ?? []).find((b: any) => b.type === "tool_use");
    if (!block) throw new Error("Claude did not return structured results. Try again.");
    return block.input;
  }
  const text = (data.content ?? []).filter((b: any) => b.type === "text").map((b: any) => b.text).join("\n");
  return JSON.parse(text.replace(/```json|```/g, "").trim() || "{}");
}

// Used by the Underwriting page's existing per-document upload (om / rentroll / pl prompts).
export async function claudeJsonFromPdf(pdf: Buffer, prompt: string): Promise<Record<string, any>> {
  return callClaude(pdf, prompt + "\n\nRespond with the JSON object only, no other text.", undefined, 1500);
}

// ── Full OM intake: property facts + screening notes ─────────────────────
const num = { type: ["number", "null"] };
const str = { type: ["string", "null"] };

const OM_TOOL: ToolDef = {
  name: "record_offering",
  description: "Record the facts from a commercial real estate offering memorandum or broker package, plus a screening assessment.",
  input_schema: {
    type: "object",
    properties: {
      dealName: { type: "string", description: "Short deal name, usually the street address or property name" },
      address: str, municipality: { ...str, description: "Township, borough or city" },
      county: str, state: { ...str, description: "Two-letter state code" },
      propertyType: { type: "string", enum: [...DEAL_TYPES], description: "Use 'land' for development sites and redevelopment plays priced on future use" },
      askingPrice: { ...num, description: "Asking price in dollars; null if unpriced or 'call for offers'" },
      priceNotes: { ...str, description: "How pricing works if not a fixed number, e.g. 'Price determined by use and density'" },
      units: num, buildingSf: { ...num, description: "Existing building square feet" },
      acres: num, yearBuilt: num, occupancyPct: num,
      noi: { ...num, description: "Stated annual NOI in dollars (in-place, not pro forma)" },
      capRatePct: { ...num, description: "Stated cap rate as a percent, e.g. 6.25" },
      grossPotentialRent: { ...num, description: "Annual gross potential rent in dollars" },
      vacancyPct: num,
      otherIncome: { ...num, description: "Annual other income in dollars" },
      operatingExpenses: { ...num, description: "Annual operating expenses in dollars, excluding debt service" },
      zoning: str, floodZone: { ...str, description: "Floodplain / flood zone status and any flood history" },
      utilities: str, groundLease: { type: "boolean" },
      sellerName: str, reasonForSale: str,
      offersDue: { ...str, description: "Offer or call-for-offers deadline as YYYY-MM-DD if stated" },
      broker: {
        type: "object",
        description: "Listing broker primary contact",
        properties: { name: str, company: str, phone: str, email: str },
      },
      scenarios: {
        type: "array",
        description: "Development or use options the package presents (e.g. warehouse, self storage, multifamily)",
        items: {
          type: "object",
          properties: { label: { type: "string" }, use: { type: "string" }, buildingSf: num, units: num, notes: str },
          required: ["label", "use"],
        },
      },
      summary: { type: "string", description: "3-5 sentence plain-English summary of the opportunity for an investor" },
      keyRisks: { type: "array", items: { type: "string" }, description: "Most important risks, specific to this property" },
      missingInfo: { type: "array", items: { type: "string" }, description: "Information needed to underwrite that the package does not include" },
      brokerQuestions: { type: "array", items: { type: "string" }, description: "Specific questions to send the broker" },
    },
    required: ["dealName", "propertyType", "summary", "keyRisks", "missingInfo", "brokerQuestions"],
  },
};

const OM_PROMPT = `You are an acquisitions analyst screening a commercial real estate offering for an investor focused on multifamily, retail, industrial and development deals in southeastern Pennsylvania.

Read the entire document, including site plans, tables and images, and record the facts with the record_offering tool.

Rules:
- Record only what the document states. Use null for anything not given. Never estimate or invent figures.
- Dollar amounts are plain numbers (4200000, not "$4.2M"). Percents are numbers (6.25).
- Use in-place figures for NOI and income. If only pro forma figures exist, leave them null and say so in missingInfo.
- For land or redevelopment sites priced on future use, set propertyType to "land" and list each use option in scenarios.
- keyRisks, missingInfo and brokerQuestions should be specific to this property, not generic checklists. Aim for 3-6 items each.`;

export interface OmAnalysis {
  dealName: string; address?: string | null; municipality?: string | null; county?: string | null; state?: string | null;
  propertyType: string; askingPrice?: number | null; priceNotes?: string | null;
  units?: number | null; buildingSf?: number | null; acres?: number | null; yearBuilt?: number | null; occupancyPct?: number | null;
  noi?: number | null; capRatePct?: number | null; grossPotentialRent?: number | null; vacancyPct?: number | null;
  otherIncome?: number | null; operatingExpenses?: number | null;
  zoning?: string | null; floodZone?: string | null; utilities?: string | null; groundLease?: boolean;
  sellerName?: string | null; reasonForSale?: string | null; offersDue?: string | null;
  broker?: { name?: string | null; company?: string | null; phone?: string | null; email?: string | null };
  scenarios?: { label: string; use: string; buildingSf?: number | null; units?: number | null; notes?: string | null }[];
  summary: string; keyRisks: string[]; missingInfo: string[]; brokerQuestions: string[];
}

export async function analyzeOm(pdf: Buffer): Promise<OmAnalysis> {
  const raw = await callClaude(pdf, OM_PROMPT, OM_TOOL, 8000);
  const clean = (v: any) => (typeof v === "number" && isFinite(v) && v > 0 ? v : null);
  if (!DEAL_TYPES.includes(raw.propertyType)) raw.propertyType = "other";
  for (const k of ["askingPrice", "units", "buildingSf", "acres", "yearBuilt", "occupancyPct", "noi", "capRatePct",
    "grossPotentialRent", "vacancyPct", "otherIncome", "operatingExpenses"]) raw[k] = clean(raw[k]);
  raw.keyRisks = Array.isArray(raw.keyRisks) ? raw.keyRisks : [];
  raw.missingInfo = Array.isArray(raw.missingInfo) ? raw.missingInfo : [];
  raw.brokerQuestions = Array.isArray(raw.brokerQuestions) ? raw.brokerQuestions : [];
  raw.scenarios = Array.isArray(raw.scenarios) ? raw.scenarios : [];
  if (raw.offersDue && !/^\d{4}-\d{2}-\d{2}$/.test(raw.offersDue)) raw.offersDue = null;
  return raw as OmAnalysis;
}

// ── Deterministic math checks (done in code, not by the model) ───────────
export function mathCheck(a: OmAnalysis): string[] {
  const notes: string[] = [];
  const money = (n: number) => `$${Math.round(n).toLocaleString()}`;
  const { askingPrice: price, noi, capRatePct: cap, grossPotentialRent: gpr, vacancyPct: vac, otherIncome: oi, operatingExpenses: opex } = a;

  if (gpr && opex) {
    const implied = gpr * (1 - (vac ?? 0) / 100) + (oi ?? 0) - opex;
    if (noi) {
      const diff = (noi - implied) / implied;
      notes.push(Math.abs(diff) > 0.05
        ? `Stated NOI ${money(noi)} is ${Math.abs(diff * 100).toFixed(0)}% ${diff > 0 ? "higher" : "lower"} than the package's own income and expenses imply (${money(implied)}).`
        : `Stated NOI ${money(noi)} matches the income and expense figures (${money(implied)}).`);
    } else {
      notes.push(`Income and expenses imply NOI of ${money(implied)}; no NOI was stated.`);
    }
    if (vac == null) notes.push("No vacancy factor given; the implied NOI assumes 0% vacancy.");
  }
  if (price && noi) {
    const implied = (noi / price) * 100;
    if (cap && Math.abs(implied - cap) > 0.25) {
      notes.push(`Stated cap rate ${cap}% does not match NOI ÷ price (${implied.toFixed(2)}%).`);
    } else if (!cap) {
      notes.push(`Implied cap rate at asking: ${implied.toFixed(2)}%.`);
    }
  }
  if (price && a.units) notes.push(`Price per unit: ${money(price / a.units)}.`);
  if (price && a.buildingSf) notes.push(`Price per building SF: ${money(price / a.buildingSf)}.`);
  if (price && a.acres) notes.push(`Price per acre: ${money(price / a.acres)}.`);
  if (!price) notes.push("No asking price stated, so price metrics can't be computed.");
  return notes;
}

export function screeningMemo(a: OmAnalysis, checks: string[], fileName: string): string {
  const list = (title: string, items: string[]) => items.length ? `\n\n${title}:\n${items.map(i => `- ${i}`).join("\n")}` : "";
  return `Screening from ${fileName}\n\n${a.summary}`
    + list("Key risks", a.keyRisks)
    + list("Math check", checks)
    + list("Missing from the package", a.missingInfo)
    + list("Questions for the broker", a.brokerQuestions);
}
