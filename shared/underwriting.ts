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
  // Newton-Raphson with initial equity outflow at t=0
  let r = guess;
  for (let i = 0; i < 100; i++) {
    const npv = cashFlows.reduce((acc, cf, t) => acc + cf / Math.pow(1 + r, t), 0);
    const dnpv = cashFlows.reduce((acc, cf, t) => acc - t * cf / Math.pow(1 + r, t + 1), 0);
    if (Math.abs(dnpv) < 1e-10) break;
    const rNew = r - npv / dnpv;
    if (Math.abs(rNew - r) < 1e-8) { r = rNew; break; }
    r = rNew;
  }
  return isFinite(r) ? r : 0;
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

