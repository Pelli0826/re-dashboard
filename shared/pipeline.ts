// Shared pipeline vocabulary — used by both the server (validation, automation)
// and the client (labels, colors, alerts). Change stages or options here only.

export const STAGES = ["lead", "screening", "loi", "due-diligence", "closing", "closed", "dead"] as const;
export type Stage = (typeof STAGES)[number];
export const ACTIVE_STAGES: Stage[] = ["lead", "screening", "loi", "due-diligence", "closing"];

export const STAGE_LABELS: Record<Stage, string> = {
  lead: "Lead",
  screening: "Screening",
  loi: "LOI / Offer",
  "due-diligence": "Due Diligence",
  closing: "Closing",
  closed: "Closed",
  dead: "Dead",
};

// Default close probability by stage, used unless a deal has its own override.
export const STAGE_PROBABILITY: Record<Stage, number> = {
  lead: 10,
  screening: 20,
  loi: 40,
  "due-diligence": 70,
  closing: 90,
  closed: 100,
  dead: 0,
};

export const DEAL_TYPES = [
  "multifamily", "retail", "industrial", "office", "land",
  "mixed-use", "self-storage", "senior-living", "hospitality", "other",
] as const;

export const DEAL_TYPE_LABELS: Record<string, string> = {
  multifamily: "Multifamily",
  retail: "Retail",
  industrial: "Industrial",
  office: "Office",
  land: "Land / Development",
  "mixed-use": "Mixed-Use",
  "self-storage": "Self Storage",
  "senior-living": "Senior Living / CCRC",
  hospitality: "Hospitality",
  other: "Other",
};

export const SOURCES = ["broker", "off-market", "direct-seller", "lender", "portfolio", "auction", "other"] as const;
export const SOURCE_LABELS: Record<string, string> = {
  broker: "Broker listing",
  "off-market": "Off-market",
  "direct-seller": "Direct from seller",
  lender: "Lender / loan maturity",
  portfolio: "Portfolio sale",
  auction: "Auction",
  other: "Other",
};

export const TEMPERATURES = ["hot", "warm", "cold"] as const;
export const COMPETITION_LEVELS = ["proprietary", "limited", "broad"] as const;
export const MOTIVATION_LEVELS = ["high", "medium", "low"] as const;

export const DEAD_REASONS = [
  "Pricing", "Location", "Competition", "Timing", "Entitlement risk",
  "Environmental", "Financing", "Seller withdrew", "Other",
] as const;

export const ACTIVITY_KINDS = ["call", "email", "meeting", "site-visit", "note"] as const;
export const ACTIVITY_LABELS: Record<string, string> = {
  call: "Call",
  email: "Email",
  meeting: "Meeting",
  "site-visit": "Site visit",
  note: "Note",
  "stage-change": "Stage change",
  created: "Created",
};

export interface DevelopmentScenario {
  label: string;      // e.g. "Option 1"
  use: string;        // e.g. "Warehouse"
  buildingSf?: number | null;
  units?: number | null;
  notes?: string | null;
}

export function parseScenarios(raw: string | null | undefined): DevelopmentScenario[] {
  if (!raw) return [];
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

export function effectiveProbability(deal: { stage: string; probabilityOverride?: number | null }): number {
  if (deal.probabilityOverride != null) return deal.probabilityOverride;
  return STAGE_PROBABILITY[deal.stage as Stage] ?? 0;
}

export function daysSince(iso: string | null | undefined, now = new Date()): number | null {
  if (!iso) return null;
  const t = new Date(iso).getTime();
  if (isNaN(t)) return null;
  return Math.floor((now.getTime() - t) / 86_400_000);
}

// Days until a YYYY-MM-DD date (negative = overdue), comparing calendar days.
export function daysUntil(ymd: string | null | undefined, now = new Date()): number | null {
  if (!ymd) return null;
  const [y, m, d] = ymd.split("-").map(Number);
  if (!y || !m || !d) return null;
  const target = Date.UTC(y, m - 1, d);
  const today = Date.UTC(now.getFullYear(), now.getMonth(), now.getDate());
  return Math.round((target - today) / 86_400_000);
}

export const DEADLINE_FIELDS = [
  { key: "loiExpiration", label: "LOI expires" },
  { key: "ddEndDate", label: "Due diligence ends" },
  { key: "closingDate", label: "Closing" },
] as const;

// Which deadlines matter in which stage.
export const STAGE_DEADLINES: Record<string, string[]> = {
  lead: [],
  screening: [],
  loi: ["loiExpiration"],
  "due-diligence": ["ddEndDate", "closingDate"],
  closing: ["closingDate"],
  closed: [],
  dead: [],
};

// ── Deadlines and "needs attention" rules ────────────────────────────────
// Shared by the Pipeline page and the morning email so they always agree.
type DealLike = {
  id: number; name: string; stage: string;
  loiExpiration?: string | null; ddEndDate?: string | null; closingDate?: string | null;
  stageChangedAt: string; lastActivityAt: string;
};

export interface Deadline { key: string; label: string; date: string; days: number }

export function nextDeadline(d: DealLike, now = new Date()): Deadline | null {
  const keys = STAGE_DEADLINES[d.stage] ?? [];
  const list: Deadline[] = [];
  for (const f of DEADLINE_FIELDS) {
    if (!keys.includes(f.key)) continue;
    const date = (d as any)[f.key] as string | null | undefined;
    const days = daysUntil(date, now);
    if (date && days != null) list.push({ key: f.key, label: f.label, date, days });
  }
  return list.sort((a, b) => a.days - b.days)[0] ?? null;
}

export type AlertKind = "deadline" | "stale" | "stuck" | "missing-date";
export interface DealAlert<T extends DealLike = DealLike> {
  deal: T; kind: AlertKind; severity: "high" | "medium"; text: string; deadline?: Deadline;
}

function fmtShortDate(ymd: string): string {
  const [y, m, d] = ymd.split("-").map(Number);
  return new Date(y, m - 1, d).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

export const STALE_DAYS_EARLY = 30;  // lead, screening
export const STALE_DAYS_ACTIVE = 14; // loi, due diligence, closing
export const DEADLINE_WINDOW_DAYS = 7;

export function dealAlerts<T extends DealLike>(deals: T[], now = new Date()): DealAlert<T>[] {
  const out: DealAlert<T>[] = [];
  for (const d of deals) {
    if (!ACTIVE_STAGES.includes(d.stage as Stage)) continue;
    const dl = nextDeadline(d, now);
    if (dl && dl.days < 0) {
      out.push({ deal: d, kind: "deadline", severity: "high", deadline: dl, text: `${dl.label} ${fmtShortDate(dl.date)}, ${-dl.days} day${dl.days === -1 ? "" : "s"} overdue` });
    } else if (dl && dl.days <= DEADLINE_WINDOW_DAYS) {
      const when = dl.days === 0 ? "today" : dl.days === 1 ? "tomorrow" : `in ${dl.days} days`;
      out.push({ deal: d, kind: "deadline", severity: dl.days <= 3 ? "high" : "medium", deadline: dl, text: `${dl.label} ${when} (${fmtShortDate(dl.date)})` });
    }
    const quiet = daysSince(d.lastActivityAt, now) ?? 0;
    const early = d.stage === "lead" || d.stage === "screening";
    if (quiet >= (early ? STALE_DAYS_EARLY : STALE_DAYS_ACTIVE)) {
      out.push({ deal: d, kind: "stale", severity: "medium", text: `No activity logged in ${quiet} days` });
    }
    const inStage = daysSince(d.stageChangedAt, now) ?? 0;
    if (d.stage === "screening" && inStage > 30) out.push({ deal: d, kind: "stuck", severity: "medium", text: `In screening ${inStage} days: move to LOI or mark dead` });
    if (d.stage === "loi" && !d.loiExpiration) out.push({ deal: d, kind: "missing-date", severity: "medium", text: "In LOI with no expiration date set" });
    if (d.stage === "due-diligence" && !d.ddEndDate) out.push({ deal: d, kind: "missing-date", severity: "high", text: "In due diligence with no DD end date set" });
  }
  return out.sort((a, b) => (a.severity === b.severity ? 0 : a.severity === "high" ? -1 : 1));
}
