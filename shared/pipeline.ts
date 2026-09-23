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
