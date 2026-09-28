// Underwriting math shared by the Underwriting page and the Pipeline deal panel.
import type { UnderwritingDeal } from "./schema";


export function calcAnnualDebtService(loan: number, rate: number, amortYears: number, ioYears: number, year: number): number {
  if (loan <= 0 || rate <= 0) return 0;
  const r = rate / 100 / 12;
  // During I/O period
  if (ioYears > 0 && year <= ioYears) return loan * (rate / 100);
  // Amortizing — recalc balance after I/O years
  let balance = loan;
  if (ioYears > 0) {
    // balance doesn't change during I/O
    balance = loan;
  }
  const n = amortYears * 12;
  if (r === 0) return balance / amortYears;
  const monthly = balance * (r * Math.pow(1 + r, n)) / (Math.pow(1 + r, n) - 1);
  return monthly * 12;
}

// Loan balance still owed after `years`, given an interest-only period then amortization.
export function remainingLoanBalance(loan: number, rate: number, amortYears: number, ioYears: number, years: number): number {
  if (loan <= 0 || amortYears <= 0) return Math.max(loan, 0);
  const k = Math.max(0, years - Math.max(ioYears, 0)) * 12;
  if (k === 0) return loan;
  const r = rate / 100 / 12;
  const n = amortYears * 12;
  if (r === 0) return Math.max(loan * (1 - k / n), 0);
  const pmt = loan * (r * Math.pow(1 + r, n)) / (Math.pow(1 + r, n) - 1);
  return Math.max(loan * Math.pow(1 + r, k) - pmt * (Math.pow(1 + r, k) - 1) / r, 0);
}

function calcNPV(rate: number, cashFlows: number[]): number {
  return cashFlows.reduce((acc, cf, i) => acc + cf / Math.pow(1 + rate, i + 1), 0);
}

export function calcIRR(cashFlows: number[], guess = 0.1): number {
  const npvAt = (r: number) => cashFlows.reduce((acc, cf, t) => acc + cf / Math.pow(1 + r, t), 0);
  // Newton-Raphson first (fast)...
  let r = guess;
  for (let i = 0; i < 100; i++) {
    const npv = npvAt(r);
    const dnpv = cashFlows.reduce((acc, cf, t) => acc - t * cf / Math.pow(1 + r, t + 1), 0);
    if (Math.abs(dnpv) < 1e-10) break;
    const rNew = r - npv / dnpv;
    if (Math.abs(rNew - r) < 1e-8) { r = rNew; break; }
    r = rNew;
  }
  const scale = Math.max(1, Math.abs(cashFlows[0] ?? 1));
  if (isFinite(r) && r > -0.99 && Math.abs(npvAt(r)) < 1e-6 * scale) return r;
  // ...then bisection, which always converges when a root exists in range.
  let lo = -0.99, hi = 10;
  let fLo = npvAt(lo), fHi = npvAt(hi);
  if (!isFinite(fLo) || !isFinite(fHi) || fLo * fHi > 0) return 0;
  for (let i = 0; i < 200; i++) {
    const mid = (lo + hi) / 2, fMid = npvAt(mid);
    if (Math.abs(fMid) < 1e-9 * scale || hi - lo < 1e-10) return mid;
    if (fLo * fMid < 0) { hi = mid; fHi = fMid; } else { lo = mid; fLo = fMid; }
  }
  return (lo + hi) / 2;
}

export interface ProformaYear {
  year: number;
  gpr: number;
  vacancy: number;
  egi: number;
  otherIncome: number;
  opex: number;
  mgmtFee: number;
  capex: number;
  totalExpenses: number;
  noi: number;
  debtService: number;
  cashFlow: number;
  capRate: number;
  dscr: number;
}

export function buildProforma(d: UnderwritingDeal): ProformaYear[] {
  const rows: ProformaYear[] = [];
  const totalCost = d.purchasePrice * (1 + d.closingCosts / 100) + d.renovationBudget;

  for (let yr = 1; yr <= d.holdYears; yr++) {
    const g = Math.pow(1 + d.rentGrowthRate / 100, yr - 1);
    const eg = Math.pow(1 + d.expenseGrowthRate / 100, yr - 1);

    const gpr = d.grossPotentialRent * g;
    const vacancy = gpr * (d.vacancyRate / 100);
    const egi = gpr - vacancy;
    const otherIncome = d.otherIncome * g;
    const opex = d.operatingExpenses * eg;
    const mgmtFee = (egi + otherIncome) * (d.managementFeeRate / 100);
    const capex = d.capexReserve * eg;
    const totalExpenses = opex + mgmtFee + capex;
    const noi = egi + otherIncome - totalExpenses;
    const debtService = calcAnnualDebtService(d.loanAmount, d.interestRate, d.amortizationYears, d.ioYears, yr);
    const cashFlow = noi - debtService;
    const capRate = totalCost > 0 ? (noi / totalCost) * 100 : 0;
    const dscr = debtService > 0 ? noi / debtService : 0;

    rows.push({ year: yr, gpr, vacancy, egi, otherIncome, opex, mgmtFee, capex, totalExpenses, noi, debtService, cashFlow, capRate, dscr });
  }
  return rows;
}

export function calcReturns(d: UnderwritingDeal, proforma: ProformaYear[]) {
  const totalCost = d.purchasePrice * (1 + d.closingCosts / 100) + d.renovationBudget;
  const equity = d.equityIn > 0 ? d.equityIn : totalCost - d.loanAmount;

  // Exit value based on final year NOI / exit cap
  const finalNoi = proforma[proforma.length - 1]?.noi ?? 0;
  const exitValue = d.exitCapRate > 0 ? finalNoi / (d.exitCapRate / 100) : 0;
  // Repay the loan balance still owed at exit (not the original amount, which overstated the payoff).
  const loanPayoff = remainingLoanBalance(d.loanAmount, d.interestRate, d.amortizationYears, d.ioYears, d.holdYears);
  const netExitProceeds = exitValue * (1 - d.sellingCosts / 100) - loanPayoff;

  // Year 1 metrics
  const yr1 = proforma[0];
  const yr1CapRate = totalCost > 0 ? ((yr1?.noi ?? 0) / totalCost) * 100 : 0;
  const yr1CoC = equity > 0 ? ((yr1?.cashFlow ?? 0) / equity) * 100 : 0;
  const yr1Dscr = yr1?.dscr ?? 0;

  // IRR — cash flows: [-equity, cf1, cf2, ..., cfN + exitProceeds]
  const irr_cfs = [
    -equity,
    ...proforma.map((r, i) => i === proforma.length - 1 ? r.cashFlow + netExitProceeds : r.cashFlow),
  ];
  const irr = calcIRR(irr_cfs) * 100;

  // Equity multiple
  const totalDistributions = proforma.reduce((s, r) => s + r.cashFlow, 0) + netExitProceeds;
  // Distributions already include the return of capital at exit, so don't add equity back in.
  const equityMultiple = equity > 0 ? totalDistributions / equity : 0;

  return { totalCost, equity, exitValue, netExitProceeds, yr1CapRate, yr1CoC, yr1Dscr, irr, equityMultiple };
}


// ── Price solver ─────────────────────────────────────────────────────────
// Reprice a model. "ltv" keeps the loan at the same % of price (typical lender sizing);
// "fixed" keeps the dollar loan amount. Equity is always re-derived from cost minus loan.
export type LoanMode = "ltv" | "fixed";

export function atPrice(d: UnderwritingDeal, price: number, mode: LoanMode): UnderwritingDeal {
  const ltv = d.purchasePrice > 0 ? d.loanAmount / d.purchasePrice : 0;
  return { ...d, purchasePrice: price, loanAmount: mode === "ltv" ? price * ltv : d.loanAmount, equityIn: 0 };
}

export function returnsAtPrice(d: UnderwritingDeal, price: number, mode: LoanMode) {
  const m = atPrice(d, price, mode);
  return { price, loanAmount: m.loanAmount, ...calcReturns(m, buildProforma(m)) };
}

/** Highest price that still meets targetIrrPct (levered). null if even a very low price can't reach it. */
export function maxPriceForIrr(d: UnderwritingDeal, targetIrrPct: number, mode: LoanMode = "ltv"): number | null {
  if (d.purchasePrice <= 0 || d.grossPotentialRent <= 0) return null;
  const irrAt = (p: number) => {
    const r = returnsAtPrice(d, p, mode);
    return r.equity > 0 ? r.irr : Infinity; // no equity in = infinite return
  };
  let lo = d.purchasePrice * 0.05, hi = d.purchasePrice * 3;
  if (irrAt(lo) < targetIrrPct) return null;       // unreachable
  if (irrAt(hi) >= targetIrrPct) return hi;        // beats target even at 3x today's price
  for (let i = 0; i < 80; i++) {
    const mid = (lo + hi) / 2;
    if (irrAt(mid) >= targetIrrPct) lo = mid; else hi = mid;
    if (hi - lo < 500) break;
  }
  return Math.floor(lo / 1000) * 1000; // round down to the nearest $1,000
}

/** Returns at a range of prices around the model's current price. */
export function priceSensitivity(d: UnderwritingDeal, mode: LoanMode = "ltv", steps = [-15, -10, -5, 0, 5, 10]) {
  return steps.map(pct => ({ pct, ...returnsAtPrice(d, d.purchasePrice * (1 + pct / 100), mode) }));
}
