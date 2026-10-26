// Project vocabulary and the deal → project hand-off. Used by client and server.
// A deal becomes a project when the PSA is signed (the deal enters Due Diligence).
import type { PipelineDeal, UnderwritingDeal, InsertProject } from "./schema";

export const PROJECT_STATUSES = ["under-contract", "planning", "entitlement", "construction", "lease-up", "stabilized", "disposition", "cancelled"] as const;
export type ProjectStatus = (typeof PROJECT_STATUSES)[number];
export const PROJECT_STATUS_LABELS: Record<string, string> = {
  "under-contract": "Under contract", planning: "Planning", entitlement: "Entitlement", construction: "Construction",
  "lease-up": "Lease-up", stabilized: "Stabilized", disposition: "Disposition", cancelled: "Cancelled",
};

export const PROJECT_TYPES = ["residential", "commercial", "mixed-use", "land"] as const;

// Deal stages at or after PSA signing.
export const PSA_STAGES = ["due-diligence", "closing", "closed"];

const TYPE_FROM_DEAL: Record<string, string> = {
  multifamily: "residential", "senior-living": "residential", land: "land", "mixed-use": "mixed-use",
};

/** Budget to start from: price plus closing costs plus renovation from the linked model, else the offer or asking price. */
export function startingBudget(deal: PipelineDeal, uw?: UnderwritingDeal | null): number {
  if (uw && uw.purchasePrice > 0) {
    return Math.round(uw.purchasePrice * (1 + (uw.closingCosts || 0) / 100) + (uw.renovationBudget || 0));
  }
  return Math.round(deal.offerPrice || deal.askingPrice || 0);
}

export function projectFromDeal(deal: PipelineDeal, uw: UnderwritingDeal | null | undefined, today: string): InsertProject {
  return {
    name: deal.name,
    address: [deal.address, deal.municipality, deal.state].filter(Boolean).join(", "),
    type: TYPE_FROM_DEAL[deal.type] ?? "commercial",
    status: deal.stage === "closed" ? "planning" : "under-contract",
    totalBudget: startingBudget(deal, uw),
    spentToDate: 0,
    projectedNoi: deal.noi ?? null,
    units: deal.units ?? null,
    sqft: deal.sqft ?? null,
    startDate: deal.contractDate || today,
    expectedCompletion: null,
    equity: uw?.equityIn || null,
    notes: null,
    dealId: deal.id,
  };
}
