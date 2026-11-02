// Property vocabulary and operating math. Used by client and server so the Properties page,
// the report review and any later email always agree. NOI is computed here, never by the model.
import type { PropertyMonth } from "./schema";

export const PROPERTY_TYPES = ["apartments", "retail", "mixed"] as const;
export const PROPERTY_TYPE_LABELS: Record<string, string> = { apartments: "Apartments", retail: "Retail / commercial", mixed: "Mixed-use" };

// Standard categories every manager's chart of accounts is mapped into, so actual and budget
// compare line by line. Income is positive; expenses are positive amounts that reduce NOI.
export const INCOME_LINES = [
  { key: "rentalIncome", label: "Rental income", help: "After vacancy, concessions and bad debt" },
  { key: "otherIncome", label: "Other income", help: "Fees, parking, laundry, utility billing" },
  { key: "reimbursements", label: "Tenant reimbursements", help: "CAM, tax and insurance recoveries" },
] as const;
export const EXPENSE_LINES = [
  { key: "payroll", label: "Payroll", help: "On-site staff and benefits" },
  { key: "repairs", label: "Repairs and maintenance", help: "Including make-ready and contract services" },
  { key: "utilities", label: "Utilities", help: "" },
  { key: "insurance", label: "Insurance", help: "" },
  { key: "taxes", label: "Real estate taxes", help: "" },
  { key: "management", label: "Management fee", help: "" },
  { key: "admin", label: "Administrative and marketing", help: "Office, legal, professional fees, advertising" },
  { key: "otherExpense", label: "Other expenses", help: "" },
] as const;
export const BELOW_NOI_LINES = [
  { key: "capex", label: "Capital expenditures", help: "Not included in NOI" },
  { key: "debtService", label: "Debt service", help: "Not included in NOI" },
] as const;
export const ALL_LINES = [...INCOME_LINES, ...EXPENSE_LINES, ...BELOW_NOI_LINES];
export type LineKey = (typeof ALL_LINES)[number]["key"];
export type Lines = Partial<Record<LineKey, number>>;

export function parseLines(json: string | null | undefined): Lines {
  if (!json) return {};
  try { const v = JSON.parse(json); return v && typeof v === "object" ? v : {}; } catch { return {}; }
}

const sum = (l: Lines, keys: readonly { key: LineKey }[]) => keys.reduce((a, k) => a + (Number(l[k.key]) || 0), 0);
export const totalIncome = (l: Lines) => sum(l, INCOME_LINES);
export const totalExpenses = (l: Lines) => sum(l, EXPENSE_LINES);
export const noi = (l: Lines) => totalIncome(l) - totalExpenses(l);
export const cashFlowAfterDebt = (l: Lines) => noi(l) - (Number(l.capex) || 0) - (Number(l.debtService) || 0);

/** A computed NOI that differs from the report's own NOI by more than $100 and 0.5% is flagged. */
export function noiMismatch(computed: number, reported: number | null | undefined): boolean {
  if (reported == null || !isFinite(reported)) return false;
  const diff = Math.abs(computed - reported);
  return diff > 100 && diff > Math.abs(reported) * 0.005;
}

export const isMonth = (s: unknown): s is string => typeof s === "string" && /^\d{4}-(0[1-9]|1[0-2])$/.test(s);
export function addMonths(month: string, n: number): string {
  const [y, m] = month.split("-").map(Number);
  const d = new Date(Date.UTC(y, m - 1 + n, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}
export function monthLabel(month: string, short = false): string {
  const [y, m] = month.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, 1)).toLocaleDateString("en-US", { month: short ? "short" : "long", year: short ? "2-digit" : "numeric", timeZone: "UTC" });
}

export interface PropertySummary {
  latestMonth: string | null;                // latest month with actuals
  monthsOfActuals: number;
  t12Noi: number | null;                     // NOI over the 12 months ending latestMonth (needs all 12)
  t12Months: number;                         // how many of those 12 months have actuals
  lastNoi: number | null; lastBudgetNoi: number | null;
  ytdNoi: number | null; ytdBudgetNoi: number | null; ytdMonths: number;
  occupancy: number | null;                  // latest reported
  trend: { month: string; noi: number | null; budget: number | null }[];  // 12 months ending latestMonth
  mismatches: string[];                      // months whose computed NOI doesn't match the report
}

export function summarize(rows: PropertyMonth[]): PropertySummary {
  const actual = new Map<string, PropertyMonth>(), budget = new Map<string, PropertyMonth>();
  for (const r of rows) (r.kind === "budget" ? budget : actual).set(r.month, r);
  const months = Array.from(actual.keys()).sort();
  const latestMonth = months.length ? months[months.length - 1] : null;
  const n = (r?: PropertyMonth) => (r ? noi(parseLines(r.lines)) : null);
  const empty: PropertySummary = { latestMonth: null, monthsOfActuals: 0, t12Noi: null, t12Months: 0, lastNoi: null, lastBudgetNoi: null,
    ytdNoi: null, ytdBudgetNoi: null, ytdMonths: 0, occupancy: null, trend: [], mismatches: [] };
  if (!latestMonth) return empty;

  const window = Array.from({ length: 12 }, (_, i) => addMonths(latestMonth, i - 11));
  const t12 = window.filter(m => actual.has(m));
  const ytd = months.filter(m => m.slice(0, 4) === latestMonth.slice(0, 4));
  const ytdBudget = ytd.filter(m => budget.has(m));
  const latestOcc = [...months].reverse().map(m => actual.get(m)!.occupancy).find(o => o != null) ?? null;
  return {
    latestMonth,
    monthsOfActuals: months.length,
    t12Noi: t12.length === 12 ? t12.reduce((a, m) => a + n(actual.get(m))!, 0) : null,
    t12Months: t12.length,
    lastNoi: n(actual.get(latestMonth)),
    lastBudgetNoi: n(budget.get(latestMonth)),
    ytdNoi: ytd.reduce((a, m) => a + n(actual.get(m))!, 0),
    // Year-to-date budget only counts if every actual month this year has a budget to compare with.
    ytdBudgetNoi: ytdBudget.length === ytd.length ? ytd.reduce((a, m) => a + n(budget.get(m))!, 0) : null,
    ytdMonths: ytd.length,
    occupancy: latestOcc,
    trend: window.map(m => ({ month: m, noi: n(actual.get(m)), budget: n(budget.get(m)) })),
    mismatches: months.filter(m => { const r = actual.get(m)!; return noiMismatch(noi(parseLines(r.lines)), r.reportedNoi); }),
  };
}

/** Actual vs budget, as a % of budget (positive = better than budget). null when there's no budget. */
export function variancePct(actual: number | null, budget: number | null): number | null {
  if (actual == null || budget == null || budget === 0) return null;
  return ((actual - budget) / Math.abs(budget)) * 100;
}
