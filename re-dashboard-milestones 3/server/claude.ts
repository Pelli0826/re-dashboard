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

// Low-level request with timeout and readable errors. Returns the API's JSON response.
async function postMessages(body: Record<string, unknown>): Promise<any> {
  if (!process.env.ANTHROPIC_API_KEY) throw new Error("ANTHROPIC_API_KEY is not set in Railway.");
  body.model = body.model ?? (process.env.ANTHROPIC_MODEL || DEFAULT_MODEL);

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
    throw new Error(err?.name === "AbortError" ? "Claude took too long to respond. Try again, or use a shorter file." : "Could not reach the Claude API.");
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) {
    // Show Anthropic's actual reason instead of guessing.
    const detail = await res.text().catch(() => "");
    let apiMessage = "";
    try { apiMessage = JSON.parse(detail)?.error?.message ?? ""; } catch { /* not JSON */ }
    console.error(`[claude] ${res.status}: ${detail.slice(0, 500)}`);
    const m = apiMessage.toLowerCase();
    if (m.includes("credit balance")) {
      throw new Error("Your Anthropic account has no API credits. Add credits at console.anthropic.com → Billing, then try again.");
    }
    if (m.includes("workspace")) {
      throw new Error("This Anthropic API key isn't assigned to a workspace. Create a new key inside a workspace at console.anthropic.com and replace ANTHROPIC_API_KEY in Railway.");
    }
    if (m.includes("model")) {
      throw new Error(`Anthropic did not accept the model name "${body.model}". Check the ANTHROPIC_MODEL variable in Railway, or delete it to use the default. (${apiMessage})`);
    }
    if (m.includes("page")) {
      throw new Error(`A PDF has too many pages for one request. Use the summary and financial sections only. (${apiMessage})`);
    }
    if (m.includes("password") || m.includes("encrypt")) {
      throw new Error("A PDF is password-protected. Open it, save an unprotected copy, and upload that.");
    }
    const byStatus: Record<number, string> = {
      401: "The ANTHROPIC_API_KEY in Railway is not valid. Copy the key again from console.anthropic.com.",
      403: "The Anthropic API key does not have access to this model.",
      413: "The files are too large for one request. Compress them or remove some.",
      429: "Claude API rate limit reached. Wait a minute and try again.",
      529: "Claude is temporarily overloaded. Try again in a minute.",
    };
    throw new Error(byStatus[res.status] ?? `Claude API error ${res.status}${apiMessage ? `: ${apiMessage}` : ""}`);
  }
  return res.json();
}

const pdfBlock = (pdf: Buffer, cache = false) => ({
  type: "document",
  source: { type: "base64", media_type: "application/pdf", data: pdf.toString("base64") },
  ...(cache ? { cache_control: { type: "ephemeral" } } : {}),
});

function checkSize(pdf: Buffer) {
  if (pdf.length > MAX_PDF_BYTES) {
    throw new Error(`This PDF is ${(pdf.length / 1048576).toFixed(0)} MB. The limit is 24 MB. Compress it (Preview: File → Export → Reduce File Size) or upload the financial section only.`);
  }
}

async function callClaude(pdf: Buffer, prompt: string, tool?: ToolDef, maxTokens = 4096): Promise<any> {
  checkSize(pdf);
  const body: Record<string, unknown> = {
    max_tokens: maxTokens,
    messages: [{ role: "user", content: [pdfBlock(pdf), { type: "text", text: prompt }] }],
  };
  if (tool) {
    body.tools = [tool];
    body.tool_choice = { type: "tool", name: tool.name };
  }
  const data = await postMessages(body);
  if (tool) {
    const block = (data.content ?? []).find((b: any) => b.type === "tool_use");
    if (!block) throw new Error("Claude did not return structured results. Try again.");
    return block.input;
  }
  const text = (data.content ?? []).filter((b: any) => b.type === "text").map((b: any) => b.text).join("\n");
  return JSON.parse(text.replace(/```json|```/g, "").trim() || "{}");
}

// ── Ask about a deal ──────────────────────────────────────────────────────
export interface AskTurn { role: "user" | "assistant"; content: string }

const ASK_SYSTEM = `You are an acquisitions analyst answering questions about one commercial real estate deal for its investors.

You are given the deal record, activity log, tasks and underwriting from the firm's dashboard, plus any PDFs saved to the deal (offering memoranda, rent rolls, P&Ls).

Rules:
- Answer only from the materials provided. If the answer isn't there, say so plainly and suggest who or what could answer it (e.g. ask the broker, order a survey).
- Say where each fact comes from: the OM (with page number when you can), the activity log (with date), the deal record, or the underwriting model.
- Use the underwriting figures exactly as given; they are calculated by the dashboard. Don't recompute returns with different assumptions unless asked, and label any of your own arithmetic as an estimate.
- Be concise and direct. Plain text, short paragraphs; use a short list only when listing several items.

Proposing changes:
- You can propose changes to this deal's dates and prices, its tasks, and its milestones with the propose_changes tool. Use it when the user asks you to change, add or schedule something, or when your answer recommends specific changes to dates, tasks or milestones.
- Proposals appear to the user as cards with Apply buttons. Nothing changes until they click. Never say you made a change; say you've proposed it.
- For any date defined relative to another date (e.g. "within 120 days after the Inspection Period ends"), give a dateRule with the anchor and offset instead of calculating the date yourself; the dashboard does the arithmetic. Anchors can be a literal date, a deal date such as "deal.ddEndDate", or a milestone name such as "milestone:Rezoning petition filed" (including one proposed earlier in the same call).
- If an anchor date isn't confirmed (e.g. the Effective Date), say so in the reason and use your best reading of the documents, or leave the date empty.
- Use milestones for contract deadlines and approvals (rezoning petition, zoning approval, plan approval, elections, deposit releases). Use tasks for work someone has to do. Refer to existing tasks and milestones by the ids shown in the dashboard data.`;

const DATE_FIELDS = ["firstContactDate", "loiDate", "loiExpiration", "contractDate", "ddEndDate", "closingDate"] as const;

const PROPOSE_TOOL: ToolDef = {
  name: "propose_changes",
  description: "Propose changes to this deal for the user to review and apply. Nothing changes until the user clicks Apply.",
  input_schema: {
    type: "object",
    properties: {
      actions: {
        type: "array",
        items: {
          type: "object",
          properties: {
            type: { type: "string", enum: ["set_deal_date", "set_deal_price", "add_task", "update_task", "add_milestone", "update_milestone"] },
            reason: { type: "string", description: "One sentence: why, citing the source (e.g. 'PSA §2.2: 60-day Inspection Period from the Effective Date')." },
            field: { type: "string", enum: [...DATE_FIELDS], description: "set_deal_date: which deal date" },
            priceField: { type: "string", enum: ["askingPrice", "offerPrice"], description: "set_deal_price" },
            amount: { type: "number", description: "set_deal_price: dollars" },
            taskId: { type: "integer", description: "update_task: id from the dashboard data" },
            milestoneId: { type: "integer", description: "update_milestone: id from the dashboard data" },
            title: { type: "string", description: "add_task / update_task" },
            priority: { type: "string", enum: ["low", "medium", "high", "urgent"] },
            name: { type: "string", description: "add_milestone / update_milestone: short name, e.g. 'Rezoning petition filed'" },
            notes: { type: "string", description: "add_milestone: the contract requirement, e.g. 'PSA §4.1: within 120 days after Inspection Period ends'" },
            status: { type: "string", enum: ["open", "done"], description: "update_task / update_milestone" },
            date: { type: "string", description: "YYYY-MM-DD when the date is stated directly in the documents" },
            dateRule: {
              type: "object",
              description: "Use instead of date when the date is relative to another date; the dashboard computes it.",
              properties: {
                from: { type: "string", description: "YYYY-MM-DD, or deal.<dateField>, or milestone:<name>" },
                addDays: { type: "integer" },
                addMonths: { type: "integer" },
              },
              required: ["from"],
            },
          },
          required: ["type", "reason"],
        },
      },
    },
    required: ["actions"],
  },
};

export async function askAboutDeal(opts: {
  context: string;
  pdfs: { name: string; data: Buffer }[];
  texts?: { name: string; text: string }[];   // Word / CSV / text files, already converted to text
  history: AskTurn[];
  question: string;
}): Promise<{ text: string; proposals: any[] }> {
  const docs = [
    ...opts.pdfs.flatMap((p, i) => [
      { type: "text", text: `File: ${p.name}` },
      pdfBlock(p.data, i === opts.pdfs.length - 1 && !opts.texts?.length), // cache files so follow-ups are cheaper
    ]),
    ...(opts.texts ?? []).map((t, i, all) => ({
      type: "text",
      text: `File: ${t.name}\n\n${t.text}`,
      ...(i === all.length - 1 ? { cache_control: { type: "ephemeral" } } : {}),
    })),
  ];
  const messages: any[] = [
    { role: "user", content: [...docs, { type: "text", text: `Dashboard data for this deal:\n\n${opts.context}` }] },
    { role: "assistant", content: "I have the deal materials. What would you like to know?" },
    ...opts.history.slice(-8).map(t => ({ role: t.role, content: t.content })),
    { role: "user", content: opts.question },
  ];
  const data = await postMessages({ system: ASK_SYSTEM, max_tokens: 4096, messages, tools: [PROPOSE_TOOL] });
  let text = (data.content ?? []).filter((b: any) => b.type === "text").map((b: any) => b.text).join("\n").trim();
  const proposals = (data.content ?? [])
    .filter((b: any) => b.type === "tool_use" && b.name === "propose_changes")
    .flatMap((b: any) => (Array.isArray(b.input?.actions) ? b.input.actions : []));
  const stop = data.stop_reason as string | undefined;

  if (!text && proposals.length) text = "I've proposed the changes below. Review each one and click Apply to make it.";
  if (!text) {
    // Record exactly what came back so the cause shows in Railway's logs.
    console.error(`[claude] empty answer: stop_reason=${stop} blocks=${JSON.stringify((data.content ?? []).map((b: any) => b.type))} usage=${JSON.stringify(data.usage ?? {})}`);
    if (stop === "refusal") {
      throw new Error("Claude declined to answer this question as worded. Try asking about specific terms, e.g. \"What are the deposit and due diligence terms in the agreement?\"");
    }
    if (stop === "max_tokens") {
      throw new Error("Claude ran out of room before writing an answer. Ask a narrower question, e.g. one section of the agreement at a time.");
    }
    throw new Error(`Claude returned no text (reason: ${stop ?? "unknown"}). Try again; if it repeats, send this message to whoever maintains the dashboard.`);
  }
  if (stop === "max_tokens") {
    text += `\n\n(The answer was cut off because it was long. Ask "continue" to get the rest.)`;
  }
  return { text, proposals };
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
