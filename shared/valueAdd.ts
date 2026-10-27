// Value-add / rehab underwriting: a month-by-month model for a partly vacant property where
// vacant units are renovated on a schedule and occupied units are renovated when tenants move out.
// Used by client and server. Reuses the model's price, closing costs, operating expenses,
// management fee, reserve, acquisition loan, growth rates, hold and exit assumptions.
import type { UnderwritingDeal } from "./schema";
import { calcIRR, atPrice, type LoanMode } from "./underwriting";

export interface ValueAddPlan {
  enabled: boolean;
  totalUnits: number;
  occupiedUnits: number;        // occupied at purchase
  inPlaceRent: number;          // $/unit/month for current tenants
  renovatedRent: number;        // $/unit/month after renovation, in today's dollars
  renoCostPerUnit: number;
  renoMonths: number;           // months a unit is offline while renovated
  vacantStartMonth: number;     // month the first vacant-unit renovations start (1 = first month owned)
  renoPace: number;             // most units that can start renovation in a month (crew capacity)
  leaseUpPace: number;          // renovated vacant units leased per month
  turnoverRate: number;         // % of occupied units that move out per year
  turnDowntime: number;         // months a renovated unit sits vacant when its tenant leaves
  otherIncomePerUnit: number;   // $/occupied unit/month (fees, parking, utility billing)
  collectionLoss: number;       // % of rent lost to concessions and bad debt
  commonAreaMonths: number;     // spread the model's renovation budget (exterior/common areas) over this many months
  holdbackPct: number;          // % of renovation spending funded by the lender (adds to the loan)
  stabilizedOccupancy: number;  // % physical occupancy that counts as stabilized
  refiMonth: number;            // 0 = no refinance
  refiLtv: number;              // % of value
  refiCapRate: number;          // % cap rate used to value the property at the refinance
  refiRate: number;             // % interest on the new loan
  refiAmortYears: number;
  refiCostPct: number;          // % of the new loan
}

export const DEFAULT_PLAN: ValueAddPlan = {
  enabled: false, totalUnits: 0, occupiedUnits: 0, inPlaceRent: 0, renovatedRent: 0,
  renoCostPerUnit: 0, renoMonths: 2, vacantStartMonth: 2, renoPace: 4, leaseUpPace: 4,
  turnoverRate: 40, turnDowntime: 1, otherIncomePerUnit: 0, collectionLoss: 2,
  commonAreaMonths: 12, holdbackPct: 0, stabilizedOccupancy: 93,
  refiMonth: 0, refiLtv: 70, refiCapRate: 6, refiRate: 6.5, refiAmortYears: 30, refiCostPct: 1.5,
};

export function parsePlan(json: string | null | undefined): ValueAddPlan {
  if (!json) return { ...DEFAULT_PLAN };
  try { return { ...DEFAULT_PLAN, ...JSON.parse(json) }; } catch { return { ...DEFAULT_PLAN }; }
}

export const planEnabled = (d: Pick<UnderwritingDeal, "valueAdd">) => {
  const p = parsePlan(d.valueAdd);
  return p.enabled && p.totalUnits > 0;
};

export interface VaMonth {
  month: number;
  occupiedUnreno: number; occupiedReno: number; inReno: number; vacantWaiting: number; vacantReady: number;
  occupancy: number;            // physical, % of units
  rentIncome: number; otherIncome: number; opex: number; mgmtFee: number; reserve: number; noi: number;
  renoSpend: number; draws: number; debtService: number; loanBalance: number;
  refiProceeds: number; saleProceeds: number;
  cashFlow: number;             // to equity (negative = equity contribution)
}

export interface VaYear {
  year: number; avgOccupancy: number; renovatedPct: number;
  rentIncome: number; otherIncome: number; opex: number; mgmtFee: number; reserve: number; noi: number;
  renoSpend: number; draws: number; debtService: number; refiProceeds: number; saleProceeds: number; cashFlow: number;
}

export interface VaResult {
  months: VaMonth[];
  years: VaYear[];
  initialEquity: number;
  peakEquity: number;           // most equity ever in the deal (initial + later capital calls, net of distributions)
  totalContributions: number;
  totalDistributions: number;
  irr: number;                  // levered, annualized, %
  equityMultiple: number;
  stabilizedMonth: number | null;
  stabilizedNoi: number;        // annualized NOI in the stabilization month (or the last month if never)
  allInCost: number;            // price + closing + common area + renovation spent through stabilization
  yieldOnCost: number;          // %
  refiLoan: number; refiCashOut: number;
  exitValue: number; netSale: number;
  totalRenoSpend: number;
  unitsRenovated: number;
}

const monthlyPmt = (balance: number, r: number, n: number) =>
  n <= 0 ? balance : r === 0 ? balance / n : balance * r / (1 - Math.pow(1 + r, -n));

/**
 * Run the plan month by month. Within a month, in order: occupied tenants move out (unrenovated units
 * join the renovation queue), renovations finish, new renovations start (up to the crew pace; turned
 * units first, then originally vacant units once the vacant program has started), renovated vacant
 * units lease up, then income, costs and debt are booked on the resulting unit counts.
 */
export function runValueAdd(d: UnderwritingDeal, plan: ValueAddPlan): VaResult {
  const p = plan;
  const H = Math.max(1, Math.round(d.holdYears)) * 12;
  const units = Math.max(0, p.totalUnits);
  const turnM = Math.max(0, p.turnoverRate) / 100 / 12;
  const renoMonths = Math.max(0, Math.round(p.renoMonths));
  const holdback = Math.max(0, Math.min(100, p.holdbackPct)) / 100;
  const commonMonths = Math.max(1, Math.round(p.commonAreaMonths));
  // Renovated units that turn sit empty for turnDowntime months: an average frictional vacancy.
  const frictional = Math.min(1, turnM * Math.max(0, p.turnDowntime));

  let occU = Math.min(units, Math.max(0, p.occupiedUnits));  // occupied, not renovated
  let occR = 0;                                              // occupied, renovated
  let vacantQueue = units - occU;                            // originally vacant, waiting for renovation
  let turnQueue = 0;                                         // vacated by move-outs, waiting for renovation
  let ready = 0;                                             // renovated, vacant, being leased
  const pipeline: number[] = new Array(renoMonths).fill(0);  // pipeline[k] finishes k+1 months from now
  let renovated = 0;

  const closing = d.purchasePrice * (d.closingCosts / 100);
  let balance = Math.max(0, d.loanAmount);
  let rate = d.interestRate / 100 / 12;
  let amortN = Math.max(1, Math.round(d.amortizationYears)) * 12;
  let ioMonths = d.interestOnly ? Infinity : Math.max(0, Math.round(d.ioYears)) * 12;
  let loanAge = 0, amortized = 0;
  const initialEquity = d.purchasePrice + closing - balance;
  const flows: number[] = [-initialEquity];
  const months: VaMonth[] = [];
  let refiLoan = 0, refiCashOut = 0, stabilizedMonth: number | null = null, totalReno = 0, renoAtStab = 0;

  for (let m = 1; m <= H; m++) {
    const yearIdx = Math.floor((m - 1) / 12);
    const g = Math.pow(1 + d.rentGrowthRate / 100, yearIdx);
    const eg = Math.pow(1 + d.expenseGrowthRate / 100, yearIdx);

    const out = occU * turnM;
    occU -= out; turnQueue += out;

    const done = renoMonths > 0 ? pipeline.shift()! : 0;
    if (renoMonths > 0) pipeline.push(0);
    ready += done; renovated += done;

    let capacity = Math.max(0, p.renoPace);
    const fromTurn = Math.min(turnQueue, capacity); turnQueue -= fromTurn; capacity -= fromTurn;
    const fromVacant = m >= p.vacantStartMonth ? Math.min(vacantQueue, capacity) : 0; vacantQueue -= fromVacant;
    const starts = fromTurn + fromVacant;
    if (renoMonths > 0) pipeline[renoMonths - 1] += starts; else { ready += starts; renovated += starts; }

    const leased = Math.min(ready, Math.max(0, p.leaseUpPace));
    ready -= leased; occR += leased;

    const inReno = pipeline.reduce((a, b) => a + b, 0);
    const occRPaying = occR * (1 - frictional);
    const occupied = occU + occRPaying;
    const rentIncome = (occU * p.inPlaceRent + occRPaying * p.renovatedRent) * g * (1 - p.collectionLoss / 100);
    const otherIncome = occupied * p.otherIncomePerUnit * g;
    const opex = (d.operatingExpenses / 12) * eg;
    const mgmtFee = (rentIncome + otherIncome) * (d.managementFeeRate / 100);
    const reserve = (d.capexReserve / 12) * eg;
    const noi = rentIncome + otherIncome - opex - mgmtFee - reserve;
    const renoSpend = starts * p.renoCostPerUnit * eg + (m <= commonMonths ? d.renovationBudget / commonMonths : 0);
    totalReno += renoSpend;

    // Debt: the lender funds `holdback` of renovation spending (added to the loan). Interest-only
    // during the IO period, then a level payment on the balance over the remaining amortization.
    const draws = renoSpend * holdback;
    balance += draws;
    loanAge++;
    const interest = balance * rate;
    let debtService = interest;
    if (loanAge > ioMonths && amortized < amortN) {
      debtService = monthlyPmt(balance, rate, amortN - amortized);
      balance -= debtService - interest; amortized++;
    }

    // Refinance at the end of refiMonth on this month's NOI, annualized.
    let refiProceeds = 0;
    if (p.refiMonth > 0 && m === p.refiMonth) {
      const value = p.refiCapRate > 0 ? (noi * 12) / (p.refiCapRate / 100) : 0;
      refiLoan = value * p.refiLtv / 100;
      refiCashOut = refiLoan * (1 - p.refiCostPct / 100) - balance;
      refiProceeds = refiCashOut;
      balance = refiLoan; rate = p.refiRate / 100 / 12;
      amortN = Math.max(1, Math.round(p.refiAmortYears)) * 12; ioMonths = 0; loanAge = 0; amortized = 0;
    }

    const occupancy = units > 0 ? occupied / units * 100 : 0;
    if (stabilizedMonth == null && vacantQueue < 0.5 && occupancy >= p.stabilizedOccupancy) { stabilizedMonth = m; renoAtStab = totalReno; }

    months.push({
      month: m, occupiedUnreno: occU, occupiedReno: occR, inReno, vacantWaiting: vacantQueue + turnQueue, vacantReady: ready,
      occupancy, rentIncome, otherIncome, opex, mgmtFee, reserve, noi, renoSpend, draws, debtService,
      loanBalance: balance, refiProceeds, saleProceeds: 0, cashFlow: noi - debtService - renoSpend + draws + refiProceeds,
    });
  }

  // Sale at the end of the hold on the trailing 12 months' NOI (same convention as the stabilized model).
  const trailingNoi = months.slice(-12).reduce((a, x) => a + x.noi, 0);
  const exitValue = d.exitCapRate > 0 ? trailingNoi / (d.exitCapRate / 100) : 0;
  const netSale = exitValue * (1 - d.sellingCosts / 100) - balance;
  const last = months[months.length - 1];
  last.saleProceeds = netSale; last.cashFlow += netSale;

  for (const x of months) flows.push(x.cashFlow);
  let cum = 0, low = 0;
  for (const f of flows) { cum += f; low = Math.min(low, cum); }
  const totalContributions = -flows.filter(f => f < 0).reduce((a, b) => a + b, 0);
  const totalDistributions = flows.filter(f => f > 0).reduce((a, b) => a + b, 0);
  const irr = (Math.pow(1 + calcIRR(flows, 0.01), 12) - 1) * 100;

  const stabM = stabilizedMonth != null ? months[stabilizedMonth - 1] : last;
  const stabilizedNoi = stabM.noi * 12;
  const allInCost = d.purchasePrice + closing + (stabilizedMonth != null ? renoAtStab : totalReno);

  const years: VaYear[] = [];
  for (let y = 0; y < H / 12; y++) {
    const ms = months.slice(y * 12, y * 12 + 12);
    const sum = (k: keyof VaMonth) => ms.reduce((a, x) => a + (x[k] as number), 0);
    years.push({
      year: y + 1,
      avgOccupancy: sum("occupancy") / ms.length,
      renovatedPct: units > 0 ? (renovatedThrough(months, y) / units) * 100 : 0,
      rentIncome: sum("rentIncome"), otherIncome: sum("otherIncome"), opex: sum("opex"), mgmtFee: sum("mgmtFee"),
      reserve: sum("reserve"), noi: sum("noi"), renoSpend: sum("renoSpend"), draws: sum("draws"),
      debtService: sum("debtService"), refiProceeds: sum("refiProceeds"), saleProceeds: sum("saleProceeds"), cashFlow: sum("cashFlow"),
    });
  }

  return {
    months, years, initialEquity, peakEquity: -low, totalContributions, totalDistributions,
    irr, equityMultiple: totalContributions > 0 ? totalDistributions / totalContributions : 0,
    stabilizedMonth, stabilizedNoi, allInCost, yieldOnCost: allInCost > 0 ? stabilizedNoi / allInCost * 100 : 0,
    refiLoan, refiCashOut, exitValue, netSale, totalRenoSpend: totalReno, unitsRenovated: renovated,
  };
}

// Units with finished renovations (leased or ready) at the end of year y (0-based).
function renovatedThrough(months: VaMonth[], y: number): number {
  const end = months[Math.min(months.length, (y + 1) * 12) - 1];
  return end ? end.occupiedReno + end.vacantReady : 0;
}

// ── Price solver for value-add plans (same approach as the stabilized model's) ──
export function vaReturnsAtPrice(d: UnderwritingDeal, plan: ValueAddPlan, price: number, mode: LoanMode) {
  const m = atPrice(d, price, mode);
  const r = runValueAdd(m, plan);
  return { price, loanAmount: m.loanAmount, irr: r.irr, equityMultiple: r.equityMultiple, peakEquity: r.peakEquity, yieldOnCost: r.yieldOnCost, initialEquity: r.initialEquity };
}

/** Highest price that still meets targetIrrPct (levered). null if even a very low price can't reach it. */
export function vaMaxPriceForIrr(d: UnderwritingDeal, plan: ValueAddPlan, targetIrrPct: number, mode: LoanMode = "ltv"): number | null {
  if (d.purchasePrice <= 0 || plan.totalUnits <= 0) return null;
  const irrAt = (price: number) => {
    const r = vaReturnsAtPrice(d, plan, price, mode);
    return r.initialEquity > 0 ? r.irr : Infinity;
  };
  let lo = d.purchasePrice * 0.05, hi = d.purchasePrice * 3;
  if (irrAt(lo) < targetIrrPct) return null;
  if (irrAt(hi) >= targetIrrPct) return hi;
  for (let i = 0; i < 80; i++) {
    const mid = (lo + hi) / 2;
    if (irrAt(mid) >= targetIrrPct) lo = mid; else hi = mid;
    if (hi - lo < 500) break;
  }
  return Math.floor(lo / 1000) * 1000;
}

export function vaPriceSensitivity(d: UnderwritingDeal, plan: ValueAddPlan, mode: LoanMode = "ltv", steps = [-15, -10, -5, 0, 5, 10]) {
  return steps.map(pct => ({ pct, ...vaReturnsAtPrice(d, plan, d.purchasePrice * (1 + pct / 100), mode) }));
}
