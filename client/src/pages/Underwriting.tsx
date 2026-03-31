import { useState, useMemo, useCallback, useRef } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import type { UnderwritingDeal, InsertUnderwriting } from "@shared/schema";
import { insertUnderwritingSchema } from "@shared/schema";
import { useForm, Controller } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import {
  Calculator, Plus, Trash2, Loader2, TrendingUp, DollarSign,
  ChevronDown, ChevronUp, BarChart3, Building2, AlertTriangle, CheckCircle2,
  Upload, FileText, Sparkles, X,
} from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useToast } from "@/hooks/use-toast";

// ─── Financial math helpers ────────────────────────────────────────────────

function calcAnnualDebtService(loan: number, rate: number, amortYears: number, ioYears: number, year: number): number {
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

function calcNPV(rate: number, cashFlows: number[]): number {
  return cashFlows.reduce((acc, cf, i) => acc + cf / Math.pow(1 + rate, i + 1), 0);
}

function calcIRR(cashFlows: number[], guess = 0.1): number {
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

interface ProformaYear {
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

function buildProforma(d: UnderwritingDeal): ProformaYear[] {
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

function calcReturns(d: UnderwritingDeal, proforma: ProformaYear[]) {
  const totalCost = d.purchasePrice * (1 + d.closingCosts / 100) + d.renovationBudget;
  const equity = d.equityIn > 0 ? d.equityIn : totalCost - d.loanAmount;

  // Exit value based on final year NOI / exit cap
  const finalNoi = proforma[proforma.length - 1]?.noi ?? 0;
  const exitValue = d.exitCapRate > 0 ? finalNoi / (d.exitCapRate / 100) : 0;
  const netExitProceeds = exitValue * (1 - d.sellingCosts / 100) - d.loanAmount;

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
  const equityMultiple = equity > 0 ? (totalDistributions + equity) / equity : 0;

  return { totalCost, equity, exitValue, netExitProceeds, yr1CapRate, yr1CoC, yr1Dscr, irr, equityMultiple };
}

// ─── Formatting ────────────────────────────────────────────────────────────
function fmt$(n: number): string {
  if (Math.abs(n) >= 1_000_000) return `$${(n / 1_000_000).toFixed(2)}M`;
  if (Math.abs(n) >= 1_000) return `$${(n / 1_000).toFixed(0)}K`;
  return `$${n.toFixed(0)}`;
}
function fmtPct(n: number, dec = 2): string { return `${n.toFixed(dec)}%`; }
function fmtX(n: number): string { return `${n.toFixed(2)}x`; }

// ─── Deal type badge ───────────────────────────────────────────────────────
const dealTypeColor: Record<string, string> = {
  multifamily: "bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-300",
  commercial: "bg-purple-100 text-purple-700 dark:bg-purple-900/30 dark:text-purple-300",
  development: "bg-orange-100 text-orange-700 dark:bg-orange-900/30 dark:text-orange-300",
  "value-add": "bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-300",
};

// ─── Metric card ───────────────────────────────────────────────────────────
function MetricCard({ label, value, sub, good, warn }: { label: string; value: string; sub?: string; good?: boolean; warn?: boolean }) {
  return (
    <div className={`rounded-lg border p-3 ${good ? "border-green-300 bg-green-50 dark:border-green-800 dark:bg-green-950/20" : warn ? "border-red-300 bg-red-50 dark:border-red-800 dark:bg-red-950/20" : "border-border bg-card"}`}>
      <div className="text-xs text-muted-foreground mb-1">{label}</div>
      <div className={`text-xl font-bold font-mono ${good ? "text-green-600 dark:text-green-400" : warn ? "text-red-500" : "text-foreground"}`}>{value}</div>
      {sub && <div className="text-[11px] text-muted-foreground mt-0.5">{sub}</div>}
    </div>
  );
}

// ─── Number input ──────────────────────────────────────────────────────────
function NumInput({ label, value, onChange, prefix, suffix, step = "any", help }: {
  label: string; value: number; onChange: (v: number) => void;
  prefix?: string; suffix?: string; step?: string; help?: string;
}) {
  return (
    <div>
      <Label className="text-xs text-muted-foreground mb-1 block">{label}</Label>
      <div className="relative">
        {prefix && <span className="absolute left-2.5 top-1/2 -translate-y-1/2 text-xs text-muted-foreground">{prefix}</span>}
        <Input
          type="number"
          step={step}
          value={value || ""}
          onChange={e => onChange(parseFloat(e.target.value) || 0)}
          className={`h-8 text-sm ${prefix ? "pl-6" : ""} ${suffix ? "pr-8" : ""}`}
        />
        {suffix && <span className="absolute right-2.5 top-1/2 -translate-y-1/2 text-xs text-muted-foreground">{suffix}</span>}
      </div>
      {help && <p className="text-[10px] text-muted-foreground mt-0.5">{help}</p>}
    </div>
  );
}

// ─── Form schema ───────────────────────────────────────────────────────────
const formSchema = insertUnderwritingSchema.extend({
  name: z.string().min(1, "Deal name required"),
});
type FormValues = z.infer<typeof formSchema>;

const DEFAULT_VALUES: FormValues = {
  name: "", dealType: "multifamily", address: "", createdAt: new Date().toISOString(),
  purchasePrice: 0, closingCosts: 2, renovationBudget: 0, equityIn: 0,
  grossPotentialRent: 0, vacancyRate: 5, otherIncome: 0,
  operatingExpenses: 0, managementFeeRate: 8, capexReserve: 0,
  loanAmount: 0, interestRate: 7, amortizationYears: 30, interestOnly: 0, ioYears: 0,
  holdYears: 5, rentGrowthRate: 3, expenseGrowthRate: 2,
  exitCapRate: 5.5, sellingCosts: 2, preferredReturn: 8, notes: "",
};

// ─── Main component ────────────────────────────────────────────────────────
export default function Underwriting() {
  const { toast } = useToast();
  const qc = useQueryClient();
  const [selected, setSelected] = useState<UnderwritingDeal | null>(null);
  const [newOpen, setNewOpen] = useState(false);
  const [editMode, setEditMode] = useState(false);
  const [extracting, setExtracting] = useState<string | null>(null); // docType being extracted
  const [extractResults, setExtractResults] = useState<Record<string, any>[]>([]);
  const omRef = useRef<HTMLInputElement>(null);
  const rrRef = useRef<HTMLInputElement>(null);
  const plRef = useRef<HTMLInputElement>(null);

  const { data: deals = [], isLoading } = useQuery<UnderwritingDeal[]>({ queryKey: ["/api/underwriting"] });

  // Live calculator state (local, mirrors selected deal + edits)
  const [calc, setCalc] = useState<FormValues>(DEFAULT_VALUES);

  const proforma = useMemo(() => selected || editMode ? buildProforma(calc as any) : [], [calc, selected, editMode]);
  const returns = useMemo(() => proforma.length > 0 ? calcReturns(calc as any, proforma) : null, [calc, proforma]);

  function selectDeal(d: UnderwritingDeal) {
    setSelected(d);
    setEditMode(false);
    setCalc({ ...DEFAULT_VALUES, ...d, notes: d.notes ?? "" });
  }

  // New deal form
  const form = useForm<FormValues>({ resolver: zodResolver(formSchema), defaultValues: DEFAULT_VALUES });

  const createDeal = useMutation({
    mutationFn: (data: FormValues) => apiRequest("POST", "/api/underwriting", { ...data, createdAt: new Date().toISOString() }),
    onSuccess: async (res) => {
      const created = await res.json();
      await qc.invalidateQueries({ queryKey: ["/api/underwriting"] });
      setNewOpen(false);
      selectDeal(created);
      toast({ title: "Deal created" });
    },
  });

  const saveDeal = useMutation({
    mutationFn: (data: FormValues) => apiRequest("PATCH", `/api/underwriting/${selected!.id}`, data),
    onSuccess: async (res) => {
      const updated = await res.json();
      await qc.invalidateQueries({ queryKey: ["/api/underwriting"] });
      setSelected(updated);
      setEditMode(false);
      toast({ title: "Deal saved" });
    },
  });

  const deleteDeal = useMutation({
    mutationFn: (id: number) => apiRequest("DELETE", `/api/underwriting/${id}`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["/api/underwriting"] });
      setSelected(null);
      setEditMode(false);
      setCalc(DEFAULT_VALUES);
      toast({ title: "Deal deleted" });
    },
  });

  const updateCalc = useCallback((field: keyof FormValues, value: any) => {
    setCalc(prev => ({ ...prev, [field]: value }));
  }, []);

  async function handleDocUpload(file: File, docType: string) {
    setExtracting(docType);
    try {
      const formData = new FormData();
      formData.append("file", file);
      formData.append("docType", docType);
      const res = await fetch("/api/underwriting/extract", { method: "POST", body: formData });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.message ?? "Extraction failed");
      }
      const data = await res.json();
      // Merge extracted data into calc
      setCalc(prev => ({
        ...prev,
        ...(data.dealName && !prev.name ? { name: data.dealName } : {}),
        ...(data.address && !prev.address ? { address: data.address } : {}),
        ...(data.dealType ? { dealType: data.dealType } : {}),
        ...(data.purchasePrice != null ? { purchasePrice: data.purchasePrice } : {}),
        ...(data.grossPotentialRent != null ? { grossPotentialRent: data.grossPotentialRent } : {}),
        ...(data.vacancyRate != null ? { vacancyRate: data.vacancyRate } : {}),
        ...(data.otherIncome != null ? { otherIncome: data.otherIncome } : {}),
        ...(data.operatingExpenses != null ? { operatingExpenses: data.operatingExpenses } : {}),
      }));
      setExtractResults(prev => [...prev, { docType, ...data }]);
      toast({ title: `✓ ${docTypeLabel(docType)} extracted`, description: "Fields updated below. Review and adjust." });
    } catch (err: any) {
      toast({ title: "Extraction failed", description: err.message, variant: "destructive" });
    } finally {
      setExtracting(null);
    }
  }

  function docTypeLabel(dt: string) {
    return dt === "om" ? "Offering Memorandum" : dt === "rentroll" ? "Rent Roll" : "P&L";
  }

  if (isLoading) return <div className="flex items-center gap-2 text-muted-foreground h-32"><Loader2 className="animate-spin" size={16} /> Loading…</div>;

  return (
    <div className="space-y-5">
      {/* Header */}
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-lg font-bold text-foreground">Deal Underwriting</h1>
          <p className="text-sm text-muted-foreground">Evaluate and underwrite real estate acquisitions</p>
        </div>
        <Button onClick={() => { form.reset(DEFAULT_VALUES); setNewOpen(true); }} size="sm" className="gap-1.5" data-testid="button-new-deal">
          <Plus size={14} /> New Deal
        </Button>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-4 gap-5">
        {/* Deal list sidebar */}
        <div className="lg:col-span-1 space-y-2">
          <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">Saved Deals ({deals.length})</p>
          {deals.length === 0 && (
            <div className="text-center py-8 text-sm text-muted-foreground border border-dashed rounded-lg">
              <Calculator size={24} className="mx-auto mb-2 opacity-30" />
              No deals yet.<br />Click New Deal to start.
            </div>
          )}
          {deals.map(d => (
            <div
              key={d.id}
              onClick={() => selectDeal(d)}
              data-testid={`deal-card-${d.id}`}
              className={`p-3 rounded-lg border cursor-pointer transition-colors ${selected?.id === d.id ? "border-primary bg-primary/5" : "border-border hover:border-primary/40 hover:bg-muted/40"}`}
            >
              <div className="font-medium text-sm text-foreground truncate">{d.name}</div>
              <div className="flex items-center gap-1.5 mt-1">
                <span className={`text-[10px] px-1.5 py-0.5 rounded font-medium capitalize ${dealTypeColor[d.dealType] ?? ""}`}>{d.dealType}</span>
              </div>
              {d.address && <div className="text-[10px] text-muted-foreground mt-0.5 truncate">{d.address}</div>}
            </div>
          ))}
        </div>

        {/* Main panel */}
        <div className="lg:col-span-3 space-y-4">
          {!selected && !editMode ? (
            <div className="flex flex-col items-center justify-center h-64 gap-3 text-center border border-dashed rounded-xl">
              <BarChart3 size={40} className="text-muted-foreground opacity-30" />
              <p className="text-sm text-muted-foreground">Select a deal from the list or create a new one to start underwriting.</p>
              <Button size="sm" onClick={() => { form.reset(DEFAULT_VALUES); setNewOpen(true); }}>
                <Plus size={14} className="mr-1" /> New Deal
              </Button>
            </div>
          ) : (
            <>
              {/* Deal header */}
              <div className="flex items-center justify-between gap-3 flex-wrap">
                <div>
                  <div className="flex items-center gap-2">
                    <h2 className="text-base font-bold text-foreground">{calc.name || "Untitled Deal"}</h2>
                    <span className={`text-[11px] px-2 py-0.5 rounded font-medium capitalize ${dealTypeColor[calc.dealType] ?? ""}`}>{calc.dealType}</span>
                  </div>
                  {calc.address && <p className="text-xs text-muted-foreground">{calc.address}</p>}
                </div>
                <div className="flex gap-2">
                  {editMode ? (
                    <>
                      <Button size="sm" variant="outline" onClick={() => { setEditMode(false); if (selected) setCalc({ ...DEFAULT_VALUES, ...selected, notes: selected.notes ?? "" }); }}>Cancel</Button>
                      <Button size="sm" onClick={() => saveDeal.mutate(calc)} disabled={saveDeal.isPending}>
                        {saveDeal.isPending && <Loader2 className="animate-spin mr-1" size={13} />} Save
                      </Button>
                    </>
                  ) : (
                    <>
                      <Button size="sm" variant="outline" onClick={() => setEditMode(true)}>Edit Inputs</Button>
                      <Button size="sm" variant="outline" className="text-destructive hover:text-destructive" onClick={() => selected && deleteDeal.mutate(selected.id)}>
                        <Trash2 size={13} />
                      </Button>
                    </>
                  )}
                </div>
              </div>

              {/* Output metrics */}
              {returns && (
                <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-2">
                  <MetricCard label="Year 1 Cap Rate" value={fmtPct(returns.yr1CapRate)} good={returns.yr1CapRate >= 5} warn={returns.yr1CapRate < 4} />
                  <MetricCard label="Cash-on-Cash" value={fmtPct(returns.yr1CoC)} good={returns.yr1CoC >= 8} warn={returns.yr1CoC < 5} />
                  <MetricCard label="IRR" value={fmtPct(returns.irr)} good={returns.irr >= 15} warn={returns.irr < 10} sub={`${calc.holdYears}yr hold`} />
                  <MetricCard label="Equity Multiple" value={fmtX(returns.equityMultiple)} good={returns.equityMultiple >= 2} warn={returns.equityMultiple < 1.5} />
                  <MetricCard label="DSCR (Yr 1)" value={returns.yr1Dscr.toFixed(2) + "x"} good={returns.yr1Dscr >= 1.25} warn={returns.yr1Dscr < 1.1} />
                  <MetricCard label="Exit Value" value={fmt$(returns.exitValue)} sub={`${fmtPct(calc.exitCapRate)} cap`} />
                </div>
              )}

              {/* AI Document Upload Panel */}
              {editMode && (
                <Card className="border-primary/30 bg-primary/5 dark:bg-primary/10">
                  <CardHeader className="pb-2 pt-3 px-4">
                    <CardTitle className="text-sm font-semibold flex items-center gap-2 text-primary">
                      <Sparkles size={14} /> Auto-Fill from Documents
                    </CardTitle>
                  </CardHeader>
                  <CardContent className="px-4 pb-4">
                    <p className="text-xs text-muted-foreground mb-3">Upload any combination of documents — AI will extract the numbers and fill the fields below automatically.</p>
                    <div className="grid grid-cols-3 gap-3">
                      {([
                        { key: "om", label: "Offering Memo", ref: omRef },
                        { key: "rentroll", label: "Rent Roll", ref: rrRef },
                        { key: "pl", label: "P&L / Op Statement", ref: plRef },
                      ] as const).map(({ key, label, ref }) => (
                        <div key={key}>
                          <input
                            ref={ref}
                            type="file"
                            accept=".pdf"
                            className="hidden"
                            onChange={e => {
                              const f = e.target.files?.[0];
                              if (f) handleDocUpload(f, key);
                              e.target.value = "";
                            }}
                          />
                          <button
                            type="button"
                            onClick={() => ref.current?.click()}
                            disabled={extracting !== null}
                            className="w-full flex flex-col items-center gap-1.5 p-3 rounded-lg border-2 border-dashed border-border hover:border-primary/50 hover:bg-muted/40 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                          >
                            {extracting === key
                              ? <Loader2 size={18} className="animate-spin text-primary" />
                              : extractResults.find(r => r.docType === key)
                              ? <CheckCircle2 size={18} className="text-green-500" />
                              : <Upload size={18} className="text-muted-foreground" />
                            }
                            <span className="text-[11px] font-medium text-center leading-tight text-muted-foreground">
                              {extracting === key ? "Reading…" : label}
                            </span>
                          </button>
                        </div>
                      ))}
                    </div>
                    {extractResults.length > 0 && (
                      <div className="mt-3 flex items-center justify-between">
                        <p className="text-xs text-green-600 dark:text-green-400 flex items-center gap-1">
                          <CheckCircle2 size={11} /> {extractResults.length} document{extractResults.length > 1 ? "s" : ""} processed — fields updated
                        </p>
                        <button onClick={() => setExtractResults([])} className="text-[10px] text-muted-foreground hover:text-foreground">
                          Clear
                        </button>
                      </div>
                    )}
                  </CardContent>
                </Card>
              )}

              {/* Inputs */}
              {editMode && (
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  {/* Acquisition */}
                  <Card>
                    <CardHeader className="pb-2 pt-3 px-4">
                      <CardTitle className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Acquisition</CardTitle>
                    </CardHeader>
                    <CardContent className="px-4 pb-4 space-y-3">
                      <div className="grid grid-cols-2 gap-2">
                        <div className="col-span-2">
                          <Label className="text-xs text-muted-foreground mb-1 block">Deal Name</Label>
                          <Input value={calc.name} onChange={e => updateCalc("name", e.target.value)} className="h-8 text-sm" />
                        </div>
                        <div className="col-span-2">
                          <Label className="text-xs text-muted-foreground mb-1 block">Deal Type</Label>
                          <Select value={calc.dealType} onValueChange={v => updateCalc("dealType", v)}>
                            <SelectTrigger className="h-8 text-sm"><SelectValue /></SelectTrigger>
                            <SelectContent>
                              <SelectItem value="multifamily">Multifamily</SelectItem>
                              <SelectItem value="commercial">Commercial</SelectItem>
                              <SelectItem value="development">Development</SelectItem>
                              <SelectItem value="value-add">Value-Add</SelectItem>
                            </SelectContent>
                          </Select>
                        </div>
                        <div className="col-span-2">
                          <Label className="text-xs text-muted-foreground mb-1 block">Address</Label>
                          <Input value={calc.address ?? ""} onChange={e => updateCalc("address", e.target.value)} className="h-8 text-sm" placeholder="Optional" />
                        </div>
                      </div>
                      <NumInput label="Purchase Price" value={calc.purchasePrice} onChange={v => updateCalc("purchasePrice", v)} prefix="$" />
                      <NumInput label="Closing Costs" value={calc.closingCosts} onChange={v => updateCalc("closingCosts", v)} suffix="%" help="% of purchase price" />
                      <NumInput label="Renovation / CapEx Budget" value={calc.renovationBudget} onChange={v => updateCalc("renovationBudget", v)} prefix="$" />
                      <NumInput label="Total Equity Invested" value={calc.equityIn} onChange={v => updateCalc("equityIn", v)} prefix="$" help="Leave 0 to auto-calc (price + costs − loan)" />
                    </CardContent>
                  </Card>

                  {/* Income */}
                  <Card>
                    <CardHeader className="pb-2 pt-3 px-4">
                      <CardTitle className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Income (Year 1 Annual)</CardTitle>
                    </CardHeader>
                    <CardContent className="px-4 pb-4 space-y-3">
                      <NumInput label="Gross Potential Rent" value={calc.grossPotentialRent} onChange={v => updateCalc("grossPotentialRent", v)} prefix="$" help="100% occupancy, annual" />
                      <NumInput label="Vacancy Rate" value={calc.vacancyRate} onChange={v => updateCalc("vacancyRate", v)} suffix="%" />
                      <NumInput label="Other Income" value={calc.otherIncome} onChange={v => updateCalc("otherIncome", v)} prefix="$" help="Parking, laundry, fees" />
                    </CardContent>
                  </Card>

                  {/* Expenses */}
                  <Card>
                    <CardHeader className="pb-2 pt-3 px-4">
                      <CardTitle className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Expenses (Year 1 Annual)</CardTitle>
                    </CardHeader>
                    <CardContent className="px-4 pb-4 space-y-3">
                      <NumInput label="Operating Expenses" value={calc.operatingExpenses} onChange={v => updateCalc("operatingExpenses", v)} prefix="$" help="Taxes, insurance, utilities, maintenance" />
                      <NumInput label="Management Fee" value={calc.managementFeeRate} onChange={v => updateCalc("managementFeeRate", v)} suffix="%" help="% of Effective Gross Income" />
                      <NumInput label="CapEx Reserve" value={calc.capexReserve} onChange={v => updateCalc("capexReserve", v)} prefix="$" help="Annual capital reserve" />
                    </CardContent>
                  </Card>

                  {/* Debt */}
                  <Card>
                    <CardHeader className="pb-2 pt-3 px-4">
                      <CardTitle className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Debt</CardTitle>
                    </CardHeader>
                    <CardContent className="px-4 pb-4 space-y-3">
                      <NumInput label="Loan Amount" value={calc.loanAmount} onChange={v => updateCalc("loanAmount", v)} prefix="$" />
                      <NumInput label="Interest Rate" value={calc.interestRate} onChange={v => updateCalc("interestRate", v)} suffix="%" step="0.01" />
                      <NumInput label="Amortization" value={calc.amortizationYears} onChange={v => updateCalc("amortizationYears", Math.round(v))} suffix="yrs" />
                      <div className="grid grid-cols-2 gap-2">
                        <div>
                          <Label className="text-xs text-muted-foreground mb-1 block">Interest Only?</Label>
                          <Select value={String(calc.interestOnly)} onValueChange={v => updateCalc("interestOnly", Number(v))}>
                            <SelectTrigger className="h-8 text-sm"><SelectValue /></SelectTrigger>
                            <SelectContent>
                              <SelectItem value="0">No</SelectItem>
                              <SelectItem value="1">Yes</SelectItem>
                            </SelectContent>
                          </Select>
                        </div>
                        <NumInput label="I/O Years" value={calc.ioYears} onChange={v => updateCalc("ioYears", Math.round(v))} suffix="yrs" />
                      </div>
                    </CardContent>
                  </Card>

                  {/* Proforma assumptions */}
                  <Card className="md:col-span-2">
                    <CardHeader className="pb-2 pt-3 px-4">
                      <CardTitle className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Proforma Assumptions</CardTitle>
                    </CardHeader>
                    <CardContent className="px-4 pb-4">
                      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
                        <NumInput label="Hold Period" value={calc.holdYears} onChange={v => updateCalc("holdYears", Math.min(20, Math.max(1, Math.round(v))))} suffix="yrs" />
                        <NumInput label="Rent Growth" value={calc.rentGrowthRate} onChange={v => updateCalc("rentGrowthRate", v)} suffix="%" step="0.1" />
                        <NumInput label="Expense Growth" value={calc.expenseGrowthRate} onChange={v => updateCalc("expenseGrowthRate", v)} suffix="%" step="0.1" />
                        <NumInput label="Exit Cap Rate" value={calc.exitCapRate} onChange={v => updateCalc("exitCapRate", v)} suffix="%" step="0.1" />
                        <NumInput label="Selling Costs" value={calc.sellingCosts} onChange={v => updateCalc("sellingCosts", v)} suffix="%" step="0.1" />
                        <NumInput label="Pref Return" value={calc.preferredReturn} onChange={v => updateCalc("preferredReturn", v)} suffix="%" step="0.1" />
                      </div>
                    </CardContent>
                  </Card>
                </div>
              )}

              {/* Proforma table */}
              {proforma.length > 0 && (
                <Card>
                  <CardHeader className="pb-2 pt-3 px-4">
                    <CardTitle className="text-sm font-semibold flex items-center gap-2">
                      <BarChart3 size={15} /> {calc.holdYears}-Year Proforma
                    </CardTitle>
                  </CardHeader>
                  <CardContent className="p-0 overflow-x-auto">
                    <table className="w-full text-xs">
                      <thead>
                        <tr className="border-b border-border bg-muted/30">
                          <th className="text-left px-4 py-2 font-medium text-muted-foreground w-36">Line Item</th>
                          {proforma.map(r => (
                            <th key={r.year} className="text-right px-3 py-2 font-medium text-muted-foreground">Year {r.year}</th>
                          ))}
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-border">
                        {[
                          { label: "Gross Potential Rent", key: "gpr", fmt: fmt$ },
                          { label: "Vacancy Loss", key: "vacancy", fmt: (v: number) => `(${fmt$(v)})`, cls: "text-muted-foreground" },
                          { label: "Other Income", key: "otherIncome", fmt: fmt$ },
                          { label: "Effective Gross Income", key: "egi", fmt: fmt$, bold: true },
                          { label: "Operating Expenses", key: "opex", fmt: (v: number) => `(${fmt$(v)})`, cls: "text-red-500" },
                          { label: "Management Fee", key: "mgmtFee", fmt: (v: number) => `(${fmt$(v)})`, cls: "text-red-500" },
                          { label: "CapEx Reserve", key: "capex", fmt: (v: number) => `(${fmt$(v)})`, cls: "text-red-500" },
                          { label: "NOI", key: "noi", fmt: fmt$, bold: true, cls: "text-green-600 dark:text-green-400" },
                          { label: "Debt Service", key: "debtService", fmt: (v: number) => `(${fmt$(v)})`, cls: "text-orange-500" },
                          { label: "Cash Flow", key: "cashFlow", fmt: fmt$, bold: true },
                          { label: "Cap Rate", key: "capRate", fmt: fmtPct, cls: "text-muted-foreground" },
                          { label: "DSCR", key: "dscr", fmt: (v: number) => v.toFixed(2) + "x", cls: "text-muted-foreground" },
                        ].map(row => (
                          <tr key={row.key} className="hover:bg-muted/20">
                            <td className={`px-4 py-1.5 ${row.bold ? "font-semibold text-foreground" : "text-muted-foreground"}`}>{row.label}</td>
                            {proforma.map(r => (
                              <td key={r.year} className={`px-3 py-1.5 text-right font-mono ${row.cls ?? (row.bold ? "font-semibold text-foreground" : "text-foreground")} ${row.key === "cashFlow" ? (r.cashFlow >= 0 ? "text-green-600 dark:text-green-400" : "text-red-500") : ""}`}>
                                {(row.fmt as any)((r as any)[row.key])}
                              </td>
                            ))}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </CardContent>
                </Card>
              )}

              {/* Summary card */}
              {returns && (
                <Card>
                  <CardHeader className="pb-2 pt-3 px-4">
                    <CardTitle className="text-sm font-semibold">Deal Summary</CardTitle>
                  </CardHeader>
                  <CardContent className="px-4 pb-4">
                    <div className="grid grid-cols-2 sm:grid-cols-4 gap-x-8 gap-y-2 text-sm">
                      <SummaryRow label="Total Project Cost" value={fmt$(returns.totalCost)} />
                      <SummaryRow label="Total Equity" value={fmt$(returns.equity)} />
                      <SummaryRow label="Loan Amount" value={fmt$(calc.loanAmount)} />
                      <SummaryRow label="LTV" value={returns.totalCost > 0 ? fmtPct((calc.loanAmount / returns.totalCost) * 100) : "—"} />
                      <SummaryRow label="Exit Value" value={fmt$(returns.exitValue)} />
                      <SummaryRow label="Net Exit Proceeds" value={fmt$(returns.netExitProceeds)} />
                      <SummaryRow label="Total Distributions" value={fmt$(proforma.reduce((s, r) => s + r.cashFlow, 0))} />
                      <SummaryRow label="Preferred Return" value={fmtPct(calc.preferredReturn)} />
                    </div>
                    {calc.notes !== undefined && (
                      <div className="mt-3">
                        <Label className="text-xs text-muted-foreground">Notes</Label>
                        {editMode
                          ? <Textarea value={calc.notes ?? ""} onChange={e => updateCalc("notes", e.target.value)} className="mt-1 text-sm resize-none" rows={2} />
                          : calc.notes ? <p className="text-sm text-foreground mt-1">{calc.notes}</p> : null
                        }
                      </div>
                    )}
                  </CardContent>
                </Card>
              )}
            </>
          )}
        </div>
      </div>

      {/* New Deal Dialog */}
      <Dialog open={newOpen} onOpenChange={setNewOpen}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>New Deal</DialogTitle>
          </DialogHeader>
          <form onSubmit={form.handleSubmit(d => createDeal.mutate(d))} className="space-y-3">
            <div>
              <Label className="text-xs text-muted-foreground mb-1 block">Deal Name</Label>
              <Input {...form.register("name")} placeholder="e.g. Wicker Park Apartment" className="h-9" />
              {form.formState.errors.name && <p className="text-xs text-red-500 mt-1">{form.formState.errors.name.message}</p>}
            </div>
            <div>
              <Label className="text-xs text-muted-foreground mb-1 block">Deal Type</Label>
              <Controller control={form.control} name="dealType" render={({ field }) => (
                <Select value={field.value} onValueChange={field.onChange}>
                  <SelectTrigger className="h-9"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="multifamily">Multifamily</SelectItem>
                    <SelectItem value="commercial">Commercial</SelectItem>
                    <SelectItem value="development">Development</SelectItem>
                    <SelectItem value="value-add">Value-Add</SelectItem>
                  </SelectContent>
                </Select>
              )} />
            </div>
            <div>
              <Label className="text-xs text-muted-foreground mb-1 block">Address (optional)</Label>
              <Input {...form.register("address")} placeholder="Property address" className="h-9" />
            </div>
            <div className="flex justify-end gap-2 pt-1">
              <Button type="button" variant="outline" onClick={() => setNewOpen(false)}>Cancel</Button>
              <Button type="submit" disabled={createDeal.isPending}>
                {createDeal.isPending && <Loader2 className="animate-spin mr-1" size={13} />}
                Create & Underwrite
              </Button>
            </div>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function SummaryRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between gap-2 py-1 border-b border-border/50">
      <span className="text-muted-foreground text-xs">{label}</span>
      <span className="font-mono font-medium text-foreground text-xs">{value}</span>
    </div>
  );
}
