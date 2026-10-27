import { useState, useMemo, useCallback, useRef, useEffect } from "react";
import { useConfirm } from "@/components/ConfirmDialog";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import type { UnderwritingDeal, PipelineDeal, DealFile } from "@shared/schema";
import { buildProforma, calcReturns, maxPriceForIrr, priceSensitivity, type LoanMode } from "@shared/underwriting";
import { parsePlan, runValueAdd, vaMaxPriceForIrr, vaPriceSensitivity, type ValueAddPlan, type VaResult } from "@shared/valueAdd";
import { Switch } from "@/components/ui/switch";
import { insertUnderwritingSchema } from "@shared/schema";
import { z } from "zod";
import {
  Calculator, Plus, Trash2, Loader2, BarChart3, CheckCircle2,
  Upload, FileText, Sparkles,
} from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/hooks/use-toast";

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

// ─── One underwriting model, shown inside its deal's Underwriting tab ──────
const fromModel = (m: UnderwritingDeal): FormValues => ({ ...DEFAULT_VALUES, ...m, notes: m.notes ?? "" });

export function ModelWorkspace({ model }: { model: UnderwritingDeal }) {
  const { toast } = useToast();
  const qc = useQueryClient();
  const selected = model;
  const [editMode, setEditMode] = useState(false);
  const [extracting, setExtracting] = useState<string | null>(null); // docType or file being read
  const [extractResults, setExtractResults] = useState<Record<string, any>[]>([]);
  const omRef = useRef<HTMLInputElement>(null);
  const rrRef = useRef<HTMLInputElement>(null);
  const plRef = useRef<HTMLInputElement>(null);

  // Live calculator state: mirrors the saved model, plus unsaved edits while editing.
  const [calc, setCalc] = useState<FormValues>(() => fromModel(model));
  // Follow the saved model (e.g. "Set as our offer" changed its price) unless edits are in progress.
  useEffect(() => { if (!editMode) setCalc(fromModel(model)); }, [model]);

  const proforma = useMemo(() => buildProforma(calc as any), [calc]);
  const returns = useMemo(() => proforma.length > 0 ? calcReturns(calc as any, proforma) : null, [calc, proforma]);

  const saveDeal = useMutation({
    mutationFn: (data: FormValues) => apiRequest("PATCH", `/api/underwriting/${model.id}`, data),
    onSuccess: async () => {
      setEditMode(false);
      setExtractResults([]);
      await qc.invalidateQueries({ queryKey: ["/api/underwriting"] });
      toast({ title: "Underwriting saved" });
    },
    onError: (e: Error) => toast({ title: "Could not save", description: e.message.replace(/^\d+:\s*/, ""), variant: "destructive" }),
  });

  const confirm = useConfirm();
  const deleteDeal = useMutation({
    mutationFn: (id: number) => apiRequest("DELETE", `/api/underwriting/${id}`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["/api/underwriting"] });
      toast({ title: "Model deleted" });
    },
  });

  const updateCalc = useCallback((field: keyof FormValues, value: any) => {
    setCalc(prev => ({ ...prev, [field]: value }));
  }, []);

  // Value-add / rehab plan (stored as JSON on the model). When on, it replaces the stabilized proforma.
  const plan = useMemo(() => parsePlan(calc.valueAdd), [calc.valueAdd]);
  const va = useMemo(() => plan.enabled && plan.totalUnits > 0 ? runValueAdd(calc as UnderwritingDeal, plan) : null, [calc, plan]);
  const setPlan = (k: keyof ValueAddPlan, v: number | boolean) =>
    setCalc(prev => ({ ...prev, valueAdd: JSON.stringify({ ...parsePlan(prev.valueAdd), [k]: v }) }));

  // Merge figures read from a document into the inputs. Nothing is saved until the user clicks Save.
  function applyExtracted(data: Record<string, any>, docType: string) {
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
        ...(data.managementFeeRate != null ? { managementFeeRate: data.managementFeeRate } : {}),
        ...(docType === "rentroll" && data.raw ? { valueAdd: JSON.stringify({
          ...parsePlan(prev.valueAdd),
          ...(data.raw.totalUnits > 0 ? { totalUnits: Math.round(data.raw.totalUnits) } : {}),
          ...(data.raw.occupiedUnits >= 0 && data.raw.occupiedUnits != null ? { occupiedUnits: Math.round(data.raw.occupiedUnits) } : {}),
          ...(data.raw.averageRentPerUnit > 0 ? { inPlaceRent: Math.round(data.raw.averageRentPerUnit) } : {}),
        }) } : {}),
      }));
      setExtractResults(prev => [...prev, { docType, ...data }]);
  }

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
      applyExtracted(await res.json(), docType);
      toast({ title: `✓ ${docTypeLabel(docType)} extracted`, description: "Fields updated below. Review and adjust." });
    } catch (err: any) {
      toast({ title: "Extraction failed", description: err.message, variant: "destructive" });
    } finally {
      setExtracting(null);
    }
  }

  function docTypeLabel(dt: string) {
    return dt === "om" ? "Offering Memorandum" : dt === "rentroll" ? "Rent Roll" : "Operating statement";
  }

  async function readDealFile(f: DealFile, docType: string) {
    setExtracting(`file:${f.id}`);
    try {
      const res = await fetch(`/api/underwriting/${selected!.id}/from-file`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ fileId: f.id, docType }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.message ?? `Could not read the file (${res.status})`);
      setEditMode(true);
      applyExtracted(data, docType);
      toast({ title: `Read ${f.name}`, description: "Figures filled in below. Check them against the document, then click Save." });
    } catch (err: any) {
      toast({ title: `Could not read ${f.name}`, description: err.message, variant: "destructive" });
    } finally {
      setExtracting(null);
    }
  }

  return (
            <div className="space-y-4">
              {/* Deal header */}
              <div className="flex items-center justify-between gap-3 flex-wrap">
                <div>
                  <div className="flex items-center gap-2">
                    <h2 className="text-base font-bold text-foreground">{calc.name || "Untitled Deal"}</h2>
                    <span className={`text-[11px] px-2 py-0.5 rounded font-medium capitalize ${dealTypeColor[calc.dealType] ?? ""}`}>{calc.dealType}</span>
                  </div>
                  {calc.address && <p className="text-xs text-muted-foreground">{calc.address}</p>}
                  {selected?.dealId && <p className="text-xs text-muted-foreground">Linked to a Pipeline deal. Purchase price updates when the deal's offer changes.</p>}
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
                      <Button size="sm" variant="outline" className="text-destructive hover:text-destructive" onClick={async () => {
                        if (!selected) return;
                        if (await confirm({ title: `Delete ${selected.name}?`, description: selected.dealId ? "Its Pipeline deal is kept; you can create a new model from the deal later." : undefined })) deleteDeal.mutate(selected.id);
                      }}>
                        <Trash2 size={13} />
                      </Button>
                    </>
                  )}
                </div>
              </div>

              {/* Output metrics */}
              {va && <VaMetrics r={va} plan={plan} />}
              {!va && returns && (
                <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-2">
                  <MetricCard label="Year 1 Cap Rate" value={fmtPct(returns.yr1CapRate)} good={returns.yr1CapRate >= 5} warn={returns.yr1CapRate < 4} />
                  <MetricCard label="Cash-on-Cash" value={fmtPct(returns.yr1CoC)} good={returns.yr1CoC >= 8} warn={returns.yr1CoC < 5} />
                  <MetricCard label="IRR" value={fmtPct(returns.irr)} good={returns.irr >= 15} warn={returns.irr < 10} sub={`${calc.holdYears}yr hold`} />
                  <MetricCard label="Equity Multiple" value={fmtX(returns.equityMultiple)} good={returns.equityMultiple >= 2} warn={returns.equityMultiple < 1.5} />
                  <MetricCard label="DSCR (Yr 1)" value={returns.yr1Dscr.toFixed(2) + "x"} good={returns.yr1Dscr >= 1.25} warn={returns.yr1Dscr < 1.1} />
                  <MetricCard label="Exit Value" value={fmt$(returns.exitValue)} sub={`${fmtPct(calc.exitCapRate)} cap`} />
                </div>
              )}

              {(calc.purchasePrice ?? 0) > 0 && (va || (returns && (calc.grossPotentialRent ?? 0) > 0)) && (
                <MaxPriceCard model={calc as UnderwritingDeal} plan={va ? plan : null} dealId={selected?.dealId ?? null} editing={editMode} />
              )}

              {selected?.dealId && (
                <DealFilesPanel dealId={selected.dealId} busy={extracting} onRead={readDealFile}
                  done={extractResults.map(r => r.fileName).filter(Boolean)} />
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
                    <p className="text-xs text-muted-foreground mb-3">Upload any combination of documents (PDF, Excel, Word or CSV). Claude reads them and fills in the fields below for you to check.</p>
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
                            accept=".pdf,.xlsx,.xlsm,.docx,.csv"
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
              {editMode && <ValueAddInputs plan={plan} setPlan={setPlan} />}
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
                      <NumInput label={plan.enabled ? "Exterior / Common Area Budget" : "Renovation / CapEx Budget"} value={calc.renovationBudget} onChange={v => updateCalc("renovationBudget", v)} prefix="$" />
                      <NumInput label="Total Equity Invested" value={calc.equityIn} onChange={v => updateCalc("equityIn", v)} prefix="$" help="Leave 0 to auto-calc (price + costs − loan)" />
                    </CardContent>
                  </Card>

                  {/* Income (not used by a value-add plan: income comes from units and rents) */}
                  {!plan.enabled && (
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
                  )}

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

              {va && <VaTable r={va} />}

              {/* Proforma table */}
              {!va && proforma.length > 0 && (
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
                      {va ? <>
                      <SummaryRow label="Initial equity" value={fmt$(va.initialEquity)} />
                      <SummaryRow label="Peak equity" value={fmt$(va.peakEquity)} />
                      <SummaryRow label="Renovation spend" value={fmt$(va.totalRenoSpend)} />
                      <SummaryRow label="Units renovated" value={Math.round(va.unitsRenovated).toLocaleString()} />
                      <SummaryRow label="Refinance loan" value={va.refiLoan ? fmt$(va.refiLoan) : "None"} />
                      <SummaryRow label="Exit value" value={fmt$(va.exitValue)} />
                      <SummaryRow label="Net sale proceeds" value={fmt$(va.netSale)} />
                      <SummaryRow label="Total distributions" value={fmt$(va.totalDistributions)} />
                      </> : <>
                      <SummaryRow label="Total Project Cost" value={fmt$(returns.totalCost)} />
                      <SummaryRow label="Total Equity" value={fmt$(returns.equity)} />
                      <SummaryRow label="Loan Amount" value={fmt$(calc.loanAmount)} />
                      <SummaryRow label="LTV" value={returns.totalCost > 0 ? fmtPct((calc.loanAmount / returns.totalCost) * 100) : "—"} />
                      <SummaryRow label="Exit Value" value={fmt$(returns.exitValue)} />
                      <SummaryRow label="Net Exit Proceeds" value={fmt$(returns.netExitProceeds)} />
                      <SummaryRow label="Total Distributions" value={fmt$(proforma.reduce((s, r) => s + r.cashFlow, 0))} />
                      <SummaryRow label="Preferred Return" value={fmtPct(calc.preferredReturn)} />
                      </>}
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
            </div>
  );
}

// ─── Value-add / rehab plan ────────────────────────────────────────────────
function ValueAddInputs({ plan, setPlan }: { plan: ValueAddPlan; setPlan: (k: keyof ValueAddPlan, v: number | boolean) => void }) {
  const N = (k: keyof ValueAddPlan, label: string, o: { prefix?: string; suffix?: string; help?: string; int?: boolean } = {}) => (
    <NumInput label={label} value={plan[k] as number} prefix={o.prefix} suffix={o.suffix} help={o.help}
      onChange={v => setPlan(k, o.int ? Math.max(0, Math.round(v)) : v)} />
  );
  const vacant = Math.max(0, plan.totalUnits - plan.occupiedUnits);
  return (
    <Card>
      <CardHeader className="pb-2 pt-3 px-4">
        <label className="flex items-center gap-3">
          <Switch checked={plan.enabled} onCheckedChange={v => setPlan("enabled", v)} aria-label="Use a value-add plan" />
          <span>
            <span className="text-sm font-semibold text-foreground block">Value-add / rehab plan</span>
            <span className="text-xs text-muted-foreground">For partly vacant properties: renovate vacant units on a schedule and occupied units as tenants move out. Runs month by month.</span>
          </span>
        </label>
      </CardHeader>
      {plan.enabled && (
        <CardContent className="px-4 pb-4 space-y-4">
          <p className="text-xs text-muted-foreground">
            Income comes from the units and rents here (the Income inputs below are hidden). The loan below is the acquisition loan;
            the lender can fund part of the renovation, and you can refinance once rents are up.
          </p>
          <div>
            <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-2">Units and rents</div>
            <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
              {N("totalUnits", "Total units", { int: true })}
              {N("occupiedUnits", "Occupied at purchase", { int: true, help: plan.totalUnits > 0 ? `${Math.round(plan.occupiedUnits / plan.totalUnits * 100)}% occupied, ${vacant} vacant` : "From the rent roll" })}
              {N("inPlaceRent", "In-place rent", { prefix: "$", help: "Per unit per month, current tenants" })}
              {N("renovatedRent", "Renovated rent", { prefix: "$", help: "Per unit per month, today's dollars" })}
              {N("otherIncomePerUnit", "Other income", { prefix: "$", help: "Per occupied unit per month" })}
              {N("collectionLoss", "Collection loss", { suffix: "%", help: "Concessions and bad debt" })}
            </div>
          </div>
          <div>
            <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-2">Renovation program</div>
            <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3">
              {N("renoCostPerUnit", "Cost per unit", { prefix: "$" })}
              {N("renoMonths", "Months offline", { int: true, help: "Per unit while renovated" })}
              {N("vacantStartMonth", "Vacant units start", { int: true, help: "Month 1 = first month owned" })}
              {N("renoPace", "Units started / month", { help: "Crew capacity" })}
              {N("leaseUpPace", "Units leased / month", { help: "Renovated vacant units" })}
              {N("turnoverRate", "Turnover", { suffix: "%/yr", help: "Occupied units moving out; each is renovated" })}
              {N("turnDowntime", "Vacant on turn", { suffix: "mo", help: "When a renovated unit's tenant leaves" })}
              {N("commonAreaMonths", "Common areas over", { suffix: "mo", int: true, help: "Spreads the exterior / common area budget" })}
              {N("holdbackPct", "Lender funds", { suffix: "%", help: "Of renovation spending, added to the loan" })}
              {N("stabilizedOccupancy", "Stabilized at", { suffix: "%", help: "Occupancy, once vacant units are done" })}
            </div>
          </div>
          <div>
            <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-2">Refinance (optional)</div>
            <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
              {N("refiMonth", "In month", { int: true, help: "0 = no refinance" })}
              {N("refiLtv", "Loan to value", { suffix: "%" })}
              {N("refiCapRate", "Valued at cap rate", { suffix: "%", help: "On that month's NOI, annualized" })}
              {N("refiRate", "Interest rate", { suffix: "%" })}
              {N("refiAmortYears", "Amortization", { suffix: "yrs", int: true })}
              {N("refiCostPct", "Costs", { suffix: "%", help: "Of the new loan" })}
            </div>
          </div>
        </CardContent>
      )}
    </Card>
  );
}

function VaMetrics({ r, plan }: { r: VaResult; plan: ValueAddPlan }) {
  return (
    <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-2">
      <MetricCard label="IRR" value={fmtPct(r.irr)} good={r.irr >= 15} warn={r.irr < 10} sub="levered, monthly cash flows" />
      <MetricCard label="Equity Multiple" value={fmtX(r.equityMultiple)} good={r.equityMultiple >= 2} warn={r.equityMultiple < 1.5} />
      <MetricCard label="Peak Equity" value={fmt$(r.peakEquity)} sub={`${fmt$(r.initialEquity)} at closing`} />
      <MetricCard label="Stabilized" value={r.stabilizedMonth ? `Month ${r.stabilizedMonth}` : "Not reached"} sub={`${plan.stabilizedOccupancy}% occupied, vacant units done`} warn={!r.stabilizedMonth} />
      <MetricCard label="Yield on Cost" value={fmtPct(r.yieldOnCost)} sub="stabilized NOI / all-in cost" />
      {plan.refiMonth > 0
        ? <MetricCard label="Refi Cash-Out" value={fmt$(r.refiCashOut)} sub={`month ${plan.refiMonth}, loan ${fmt$(r.refiLoan)}`} warn={r.refiCashOut < 0} />
        : <MetricCard label="Exit Value" value={fmt$(r.exitValue)} sub="trailing 12 months' NOI" />}
    </div>
  );
}

function VaTable({ r }: { r: VaResult }) {
  const paren = (v: number) => v ? `(${fmt$(v)})` : "—";
  const rows: { label: string; get: (y: VaResult["years"][number]) => string; bold?: boolean; cls?: string }[] = [
    { label: "Avg. occupancy", get: y => fmtPct(y.avgOccupancy, 0), cls: "text-muted-foreground" },
    { label: "Renovated (year end)", get: y => fmtPct(y.renovatedPct, 0), cls: "text-muted-foreground" },
    { label: "Rental income", get: y => fmt$(y.rentIncome) },
    { label: "Other income", get: y => fmt$(y.otherIncome) },
    { label: "Operating expenses", get: y => paren(y.opex), cls: "text-red-500" },
    { label: "Management fee", get: y => paren(y.mgmtFee), cls: "text-red-500" },
    { label: "CapEx reserve", get: y => paren(y.reserve), cls: "text-red-500" },
    { label: "NOI", get: y => fmt$(y.noi), bold: true, cls: "text-green-600 dark:text-green-400" },
    { label: "Renovation spend", get: y => paren(y.renoSpend), cls: "text-orange-500" },
    { label: "Lender draws", get: y => y.draws ? fmt$(y.draws) : "—" },
    { label: "Debt service", get: y => paren(y.debtService), cls: "text-orange-500" },
    { label: "Refinance proceeds", get: y => y.refiProceeds ? fmt$(y.refiProceeds) : "—" },
    { label: "Sale proceeds", get: y => y.saleProceeds ? fmt$(y.saleProceeds) : "—" },
    { label: "Cash flow to equity", get: y => y.cashFlow < 0 ? `(${fmt$(-y.cashFlow)})` : fmt$(y.cashFlow), bold: true },
  ];
  return (
    <Card>
      <CardHeader className="pb-2 pt-3 px-4">
        <CardTitle className="text-sm font-semibold flex items-center gap-2"><BarChart3 size={15} /> Value-add plan by year</CardTitle>
      </CardHeader>
      <CardContent className="p-0 overflow-x-auto">
        <table className="w-full text-xs">
          <thead>
            <tr className="border-b border-border bg-muted/30">
              <th className="text-left px-4 py-2 font-medium text-muted-foreground w-40">Line item</th>
              {r.years.map(y => <th key={y.year} className="text-right px-3 py-2 font-medium text-muted-foreground">Year {y.year}</th>)}
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {rows.map(row => (
              <tr key={row.label} className="hover:bg-muted/20">
                <td className={`px-4 py-1.5 ${row.bold ? "font-semibold text-foreground" : "text-muted-foreground"}`}>{row.label}</td>
                {r.years.map(y => <td key={y.year} className={`px-3 py-1.5 text-right font-mono ${row.cls ?? (row.bold ? "font-semibold text-foreground" : "text-foreground")}`}>{row.get(y)}</td>)}
              </tr>
            ))}
          </tbody>
        </table>
        <p className="text-xs text-muted-foreground px-4 py-2">Negative cash flow to equity means money you put in (renovation not funded by the lender, carrying costs). The sale is valued on the last 12 months' NOI at the exit cap rate.</p>
      </CardContent>
    </Card>
  );
}

// ─── A deal's Underwriting tab: its model(s), or a button to start one ────
export const UW_TYPE: Record<string, string> = { multifamily: "multifamily", land: "development" };

export function DealUnderwriting({ deal }: { deal: PipelineDeal }) {
  const { toast } = useToast();
  const qc = useQueryClient();
  const { data: all = [], isLoading } = useQuery<UnderwritingDeal[]>({ queryKey: ["/api/underwriting"] });
  const models = all.filter(m => m.dealId === deal.id).sort((a, b) => a.id - b.id);
  const [chosen, setChosen] = useState<number | null>(null);
  const model = models.find(m => m.id === chosen) ?? models[0];

  const create = useMutation({
    mutationFn: async (scenario: boolean) => {
      const res = await apiRequest("POST", "/api/underwriting", {
        name: scenario ? `${deal.dealCode} ${deal.name} (scenario ${models.length + 1})` : `${deal.dealCode} ${deal.name}`,
        dealId: deal.id,
        dealType: UW_TYPE[deal.type] ?? "commercial",
        address: [deal.address, deal.municipality].filter(Boolean).join(", "),
        createdAt: new Date().toISOString(),
        purchasePrice: deal.offerPrice ?? deal.askingPrice ?? 0,
        // A scenario starts as a copy of the current model's assumptions.
        ...(scenario && model ? Object.fromEntries(Object.entries(model).filter(([k]) => !["id", "name", "dealId", "createdAt"].includes(k))) : {}),
        notes: scenario ? `Scenario copied from "${model?.name}".` : `Created from pipeline deal ${deal.dealCode}.`,
      });
      return (await res.json()) as UnderwritingDeal;
    },
    onSuccess: m => { qc.invalidateQueries({ queryKey: ["/api/underwriting"] }); setChosen(m.id); },
    onError: (e: Error) => toast({ title: "Could not create the model", description: e.message.replace(/^\d+:\s*/, ""), variant: "destructive" }),
  });

  if (isLoading) return <div className="flex items-center gap-2 text-muted-foreground py-8"><Loader2 className="animate-spin" size={16} /> Loading…</div>;

  if (!model) return (
    <div className="flex flex-col items-center justify-center gap-3 text-center border border-dashed rounded-xl py-12 px-6">
      <Calculator size={36} className="text-muted-foreground opacity-40" />
      <div className="space-y-1">
        <p className="text-sm font-medium text-foreground">Start underwriting this deal</p>
        <p className="text-sm text-muted-foreground max-w-md">
          Creates a model priced at {deal.offerPrice ? "your offer" : deal.askingPrice ? "the asking price" : "$0 until you set a price"}.
          Then fill it in from the deal's files (OM, rent roll, operating statements) or type the numbers in.
        </p>
      </div>
      <Button onClick={() => create.mutate(false)} disabled={create.isPending} className="gap-1.5">
        {create.isPending ? <Loader2 size={14} className="animate-spin" /> : <Calculator size={14} />} Start underwriting
      </Button>
    </div>
  );

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        {models.length > 1 && (
          <Select value={String(model.id)} onValueChange={v => setChosen(Number(v))}>
            <SelectTrigger className="h-8 w-auto min-w-[220px] text-sm" aria-label="Model"><SelectValue /></SelectTrigger>
            <SelectContent>{models.map(m => <SelectItem key={m.id} value={String(m.id)}>{m.name}</SelectItem>)}</SelectContent>
          </Select>
        )}
        <Button size="sm" variant="ghost" className="gap-1 h-8 ml-auto" onClick={() => create.mutate(true)} disabled={create.isPending}>
          <Plus size={13} /> Add scenario
        </Button>
      </div>
      <ModelWorkspace key={model.id} model={model} />
    </div>
  );
}

// ── Files saved to the linked Pipeline deal ─────────────────────────────────
const READABLE = /\.(pdf|xlsx|xlsm|docx|csv)$/i;
function guessDocType(f: DealFile): string {
  if (f.kind === "om" || /\b(om|offering|memorandum|brochure|package)\b/i.test(f.name)) return "om";
  if (/rent\s*roll|\brr\b/i.test(f.name)) return "rentroll";
  return "pl";
}

function DealFilesPanel({ dealId, busy, onRead, done }: {
  dealId: number; busy: string | null; done: string[];
  onRead: (f: DealFile, docType: string) => void;
}) {
  const { data: files = [] } = useQuery<DealFile[]>({ queryKey: ["/api/pipeline", dealId, "files"] });
  const usable = files.filter(f => f.kind !== "loi" && READABLE.test(f.name));
  const [types, setTypes] = useState<Record<number, string>>({});
  const other = files.filter(f => f.kind !== "loi" && !READABLE.test(f.name));

  return (
    <Card>
      <CardHeader className="pb-2 pt-3 px-4">
        <CardTitle className="text-sm font-semibold flex items-center gap-2"><FileText size={14} /> From the deal's files</CardTitle>
      </CardHeader>
      <CardContent className="px-4 pb-4 space-y-2">
        {usable.length === 0 ? (
          <p className="text-xs text-muted-foreground">No readable files on this deal yet. Add operating statements, rent rolls or the OM in the deal's Files section on the Pipeline tab (PDF, Excel, Word or CSV).</p>
        ) : (
          <>
            <p className="text-xs text-muted-foreground">Pick what each file is, then Fill in. Claude reads it and fills in the inputs below for you to check; nothing is saved until you click Save.</p>
            <ul className="divide-y divide-border rounded-md border border-border">
              {usable.map(f => {
                const type = types[f.id] ?? guessDocType(f);
                const reading = busy === `file:${f.id}`;
                return (
                  <li key={f.id} className="flex flex-wrap items-center gap-2 px-3 py-2">
                    <span className="text-sm text-foreground truncate flex-1 min-w-[160px]">
                      {done.includes(f.name) && <CheckCircle2 size={12} className="inline text-green-600 mr-1 -mt-0.5" />}{f.name}
                    </span>
                    <Select value={type} onValueChange={v => setTypes(t => ({ ...t, [f.id]: v }))}>
                      <SelectTrigger className="h-8 w-[170px] text-xs" aria-label={`What ${f.name} is`}><SelectValue /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="pl">Operating statement / T12</SelectItem>
                        <SelectItem value="rentroll">Rent roll</SelectItem>
                        <SelectItem value="om">Offering memorandum</SelectItem>
                      </SelectContent>
                    </Select>
                    <Button size="sm" variant="outline" className="h-8 gap-1" disabled={busy !== null} onClick={() => onRead(f, type)}>
                      {reading ? <Loader2 size={13} className="animate-spin" /> : <Sparkles size={13} />} {reading ? "Reading…" : "Fill in"}
                    </Button>
                  </li>
                );
              })}
            </ul>
          </>
        )}
        {other.length > 0 && (
          <p className="text-xs text-muted-foreground">
            Can't read: {other.map(f => f.name).join(", ")}.{other.some(f => /\.xls$/i.test(f.name)) ? " For .xls files, open in Excel and Save As .xlsx, then add that to the deal." : ""}
          </p>
        )}
      </CardContent>
    </Card>
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

// ── Maximum price for a target IRR ──────────────────────────────────────────
function MaxPriceCard({ model, plan, dealId, editing }: { model: UnderwritingDeal; plan: ValueAddPlan | null; dealId: number | null; editing: boolean }) {
  const { toast } = useToast();
  const qc = useQueryClient();
  const [target, setTarget] = useState("15");
  const [mode, setMode] = useState<LoanMode>("ltv");
  const t = parseFloat(target);
  const maxPrice = useMemo(() => (!isFinite(t) ? null : plan ? vaMaxPriceForIrr(model, plan, t, mode) : maxPriceForIrr(model, t, mode)), [model, plan, t, mode]);
  const rows = useMemo(() => plan ? vaPriceSensitivity(model, plan, mode) : priceSensitivity(model, mode), [model, plan, mode]);
  const ltv = model.purchasePrice > 0 ? (model.loanAmount / model.purchasePrice) * 100 : 0;
  const { data: deal } = useQuery<PipelineDeal>({ queryKey: ["/api/pipeline", dealId ?? 0], enabled: !!dealId });

  const setOffer = useMutation({
    mutationFn: (price: number) => apiRequest("PATCH", `/api/pipeline/${dealId}`, { offerPrice: price }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["/api/pipeline"] });
      qc.invalidateQueries({ queryKey: ["/api/underwriting"] });
      toast({ title: "Offer updated", description: "The deal's offer and this model's purchase price now match." });
    },
    onError: (e: Error) => toast({ title: "Could not update offer", description: e.message, variant: "destructive" }),
  });

  return (
    <Card>
      <CardHeader className="pb-2 pt-3 px-4">
        <CardTitle className="text-sm font-semibold">Maximum price</CardTitle>
      </CardHeader>
      <CardContent className="px-4 pb-4 space-y-4">
        <div className="flex flex-wrap items-end gap-3">
          <div className="space-y-1">
            <Label htmlFor="target-irr" className="text-xs">Target levered IRR (%)</Label>
            <Input id="target-irr" value={target} onChange={e => setTarget(e.target.value)} className="w-28 h-9" inputMode="decimal" />
          </div>
          <div className="space-y-1">
            <Label className="text-xs">Loan as price changes</Label>
            <Select value={mode} onValueChange={v => setMode(v as LoanMode)}>
              <SelectTrigger className="w-[220px] h-9"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="ltv">Same LTV ({ltv.toFixed(0)}%)</SelectItem>
                <SelectItem value="fixed">Same loan amount ({fmt$(model.loanAmount)})</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="ml-auto text-right">
            <div className="text-xs text-muted-foreground">Most you can pay for {isFinite(t) ? `${t}%` : "—"}</div>
            <div className="text-2xl font-bold font-mono text-foreground">{maxPrice ? `$${maxPrice.toLocaleString()}` : "Not reachable"}</div>
            {maxPrice && model.purchasePrice > 0 && (
              <div className="text-xs text-muted-foreground">
                {maxPrice >= model.purchasePrice ? `${fmt$(maxPrice - model.purchasePrice)} above` : `${fmt$(model.purchasePrice - maxPrice)} below`} the current price
              </div>
            )}
          </div>
        </div>
        {!maxPrice && isFinite(t) && (
          <p className="text-xs text-muted-foreground">Even at a small fraction of the current price, the model's income, costs and exit assumptions don't reach {t}%.</p>
        )}
        {dealId && maxPrice && !editing && (
          <div className="flex flex-wrap items-center gap-2">
            <Button size="sm" variant="outline" disabled={setOffer.isPending} onClick={() => setOffer.mutate(maxPrice)}>
              Set as our offer{deal ? ` on ${deal.dealCode}` : ""}
            </Button>
            <span className="text-xs text-muted-foreground">Updates the Pipeline deal; this model's purchase price follows it.</span>
          </div>
        )}
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-xs text-muted-foreground border-b border-border whitespace-nowrap">
                <th className="text-left py-1.5 font-medium">Price</th>
                <th className="text-right py-1.5 font-medium">vs. current</th>
                <th className="text-right py-1.5 font-medium">IRR</th>
                <th className="text-right py-1.5 font-medium">Equity multiple</th>
                <th className="text-right py-1.5 font-medium">{plan ? "Peak equity" : "Yr 1 cash-on-cash"}</th>
                <th className="text-right py-1.5 font-medium">{plan ? "Yield on cost" : "Yr 1 DSCR"}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {rows.map(r => (
                <tr key={r.pct} className={r.pct === 0 ? "font-semibold" : ""}>
                  <td className="py-1.5 font-mono">{fmt$(r.price)}</td>
                  <td className="py-1.5 text-right text-muted-foreground">{r.pct === 0 ? "current" : `${r.pct > 0 ? "+" : ""}${r.pct}%`}</td>
                  <td className={`py-1.5 text-right font-mono ${isFinite(t) && r.irr >= t ? "text-green-700 dark:text-green-400" : ""}`}>{fmtPct(r.irr, 1)}</td>
                  <td className="py-1.5 text-right font-mono">{fmtX(r.equityMultiple)}</td>
                  {"peakEquity" in r ? <>
                    <td className="py-1.5 text-right font-mono">{fmt$(r.peakEquity)}</td>
                    <td className="py-1.5 text-right font-mono">{fmtPct(r.yieldOnCost, 1)}</td>
                  </> : <>
                    <td className="py-1.5 text-right font-mono">{fmtPct(r.yr1CoC, 1)}</td>
                    <td className="py-1.5 text-right font-mono">{r.loanAmount > 0 ? `${r.yr1Dscr.toFixed(2)}x` : "—"}</td>
                  </>}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="text-xs text-muted-foreground">Equity is recalculated at each price as total cost minus the loan. {plan ? "The renovation plan, rents, expenses and exit cap rate" : "Rents, expenses and exit cap rate"} stay as entered.</p>
      </CardContent>
    </Card>
  );
}
