// OM intake: how Claude's reading of an offering memorandum becomes a deal and an underwriting
// model. Used by the server for both the Upload OM review form and the nightly Box import,
// so the two always fill in the same fields the same way.

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

// Pipeline deal type → underwriting model type.
export const UW_TYPE: Record<string, string> = { multifamily: "multifamily", land: "development" };

// The review form's "Also create an underwriting model" box starts ticked when this is true.
export const omHasIncome = (a: OmAnalysis) => Boolean(a.grossPotentialRent || a.noi);

const text = (v: string | null | undefined) => (v ?? "").trim() || null;
const int = (v: number | null | undefined) => (v == null ? null : Math.round(v));

// Deal fields from an OM. The caller picks the stage (the review form starts in Screening,
// the Box import in Lead) and the broker contact (matched or added before this is called).
export function dealFromOm(a: OmAnalysis, opts: { stage: string; brokerContactId: number | null; today: string; fallbackName?: string }) {
  const scenarios = (a.scenarios ?? []).filter(s => s.use?.trim() || s.label?.trim());
  return {
    name: (a.dealName ?? "").trim() || opts.fallbackName || "",
    address: (a.address ?? "").trim(),
    municipality: text(a.municipality), county: text(a.county), state: text(a.state) ?? "PA",
    type: a.propertyType, stage: opts.stage,
    source: a.broker?.name || opts.brokerContactId ? "broker" : null,
    brokerContactId: opts.brokerContactId,
    sellerName: text(a.sellerName), reasonForSale: text(a.reasonForSale),
    temperature: "warm",
    askingPrice: a.askingPrice ?? null, priceNotes: text(a.priceNotes),
    noi: a.noi ?? null, capRate: a.capRatePct ?? null,
    units: int(a.units), sqft: int(a.buildingSf), acres: a.acres ?? null, yearBuilt: int(a.yearBuilt),
    occupancy: a.occupancyPct ?? null,
    zoning: text(a.zoning), floodZone: text(a.floodZone), utilities: text(a.utilities),
    groundLease: a.groundLease ? 1 : 0,
    keyRisks: a.keyRisks.join("\n").trim() || null,
    scenarios: scenarios.length ? JSON.stringify(scenarios) : null,
    firstContactDate: opts.today,
    notes: a.offersDue ? `Offers due ${a.offersDue}.` : null,
  };
}

// The linked underwriting model, priced at the deal's asking price as saved.
export function underwritingFromOm(a: OmAnalysis, deal: {
  id: number; dealCode: string; name: string; type: string; address: string; municipality: string | null; askingPrice: number | null;
}, fileName: string, nowIso: string) {
  return {
    name: `${deal.dealCode} ${deal.name}`,
    dealId: deal.id,
    dealType: UW_TYPE[deal.type] ?? "commercial",
    address: [deal.address, deal.municipality].filter(Boolean).join(", "),
    createdAt: nowIso,
    purchasePrice: deal.askingPrice ?? 0,
    grossPotentialRent: a.grossPotentialRent ?? 0,
    vacancyRate: a.vacancyPct ?? 5,
    otherIncome: a.otherIncome ?? 0,
    operatingExpenses: a.operatingExpenses ?? 0,
    notes: `Created from ${fileName}. Check all figures against the OM.`,
  };
}
