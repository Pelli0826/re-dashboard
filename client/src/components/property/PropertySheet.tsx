// The property workspace: Overview (results at a glance), Financials (monthly actual vs budget,
// filled from the manager's reports) and Files.
import { useMemo, useRef, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useLocation } from "wouter";
import { apiRequest } from "@/lib/queryClient";
import type { Property, PropertyMonth, PropertyFile } from "@shared/schema";
import {
  INCOME_LINES, EXPENSE_LINES, BELOW_NOI_LINES, PROPERTY_TYPE_LABELS, parseLines, totalIncome, totalExpenses, noi,
  summarize, variancePct, monthLabel, type Lines, type PropertySummary,
} from "@shared/properties";
import { AlertTriangle, Download, FileUp, Loader2, Paperclip, Pencil, Trash2, ExternalLink } from "lucide-react";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription } from "@/components/ui/sheet";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { useToast } from "@/hooks/use-toast";
import { useConfirm } from "@/components/ConfirmDialog";
import { fmtMoney, fmtDate, Fact } from "@/components/pipeline/shared";
import { OPEN_DEAL_KEY } from "@/components/pipeline/DealProject";
import { ReportReview, type ReadResult } from "./ReportReview";
import { errorText } from "./PropertyFormDialog";

export type PropertyTab = "overview" | "financials" | "files";

const pct = (n: number | null, digits = 1) => (n == null ? "—" : `${n > 0 ? "+" : ""}${n.toFixed(digits)}%`);
const whole = (n: number) => (n < 0 ? `(${Math.round(-n).toLocaleString()})` : Math.round(n).toLocaleString());

export function Metric({ label, value, sub, tone }: { label: string; value: string; sub?: string; tone?: "good" | "bad" }) {
  return (
    <div className={`rounded-lg border p-3 ${tone === "good" ? "border-green-300 bg-green-50 dark:border-green-800 dark:bg-green-950/20" : tone === "bad" ? "border-red-300 bg-red-50 dark:border-red-800 dark:bg-red-950/20" : "border-border bg-card"}`}>
      <div className="text-xs text-muted-foreground mb-1">{label}</div>
      <div className="text-lg font-bold font-mono text-foreground">{value}</div>
      {sub && <div className="text-[11px] text-muted-foreground mt-0.5">{sub}</div>}
    </div>
  );
}

export function SummaryMetrics({ s }: { s: PropertySummary }) {
  const lastVar = variancePct(s.lastNoi, s.lastBudgetNoi);
  const ytdVar = variancePct(s.ytdNoi, s.ytdBudgetNoi);
  return (
    <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
      <Metric label="T12 NOI" value={s.t12Noi != null ? fmtMoney(s.t12Noi) : "—"} sub={s.t12Noi != null ? `12 months to ${monthLabel(s.latestMonth!, true)}` : `${s.t12Months} of 12 months on file`} />
      <Metric label={s.latestMonth ? `${monthLabel(s.latestMonth, true)} NOI` : "Last month NOI"} value={fmtMoney(s.lastNoi)}
        sub={lastVar != null ? `${pct(lastVar)} vs budget ${fmtMoney(s.lastBudgetNoi)}` : "No budget for this month"}
        tone={lastVar == null ? undefined : lastVar >= 0 ? "good" : lastVar <= -10 ? "bad" : undefined} />
      <Metric label={s.latestMonth ? `${s.latestMonth.slice(0, 4)} year to date` : "Year to date"} value={fmtMoney(s.ytdNoi)}
        sub={ytdVar != null ? `${pct(ytdVar)} vs budget ${fmtMoney(s.ytdBudgetNoi)}` : s.ytdMonths ? "Budget missing for some months" : undefined}
        tone={ytdVar == null ? undefined : ytdVar >= 0 ? "good" : ytdVar <= -10 ? "bad" : undefined} />
      <Metric label="Occupancy" value={s.occupancy != null ? `${s.occupancy.toFixed(1)}%` : "—"} sub={s.occupancy != null ? "latest report" : "Not on the reports"} />
    </div>
  );
}

// Monthly NOI bars for the last 12 months, with the budget as a tick.
export function NoiTrend({ trend }: { trend: PropertySummary["trend"] }) {
  const vals = trend.flatMap(t => [t.noi, t.budget]).filter((v): v is number => v != null);
  if (!vals.length) return null;
  const max = Math.max(...vals, 0), min = Math.min(...vals, 0), span = max - min || 1;
  const H = 120, zero = (max / span) * H;
  return (
    <div>
      <div className="flex items-end gap-1.5 h-[140px] pt-2" role="img" aria-label="Monthly NOI, last 12 months">
        {trend.map(t => {
          const h = t.noi != null ? (Math.abs(t.noi) / span) * H : 0;
          const top = t.noi != null && t.noi >= 0 ? zero - h : zero;
          const btop = t.budget != null ? zero - (t.budget / span) * H : null;
          return (
            <div key={t.month} className="relative flex-1 h-[120px]" title={`${monthLabel(t.month)}: NOI ${t.noi != null ? fmtMoney(t.noi) : "not on file"}${t.budget != null ? `, budget ${fmtMoney(t.budget)}` : ""}`}>
              {t.noi != null && <div className={`absolute left-0 right-0 rounded-sm ${t.noi >= 0 ? "bg-primary/70" : "bg-red-500/70"}`} style={{ top, height: Math.max(h, 1) }} />}
              {btop != null && <div className="absolute -left-0.5 -right-0.5 h-0.5 bg-foreground/70" style={{ top: btop }} />}
            </div>
          );
        })}
      </div>
      <div className="flex gap-1.5 mt-1">{trend.map(t => <div key={t.month} className="flex-1 text-center text-[10px] text-muted-foreground">{monthLabel(t.month, true).split(" ")[0]}</div>)}</div>
      <p className="text-[11px] text-muted-foreground mt-1">Bars: NOI by month. Dark lines: budget.</p>
    </div>
  );
}

function Overview({ property, months, onTab }: { property: Property; months: PropertyMonth[]; onTab: (t: PropertyTab) => void }) {
  const [, navigate] = useLocation();
  const s = useMemo(() => summarize(months), [months]);
  return (
    <div className="space-y-6">
      <dl className="grid grid-cols-2 sm:grid-cols-4 gap-x-4 gap-y-3">
        <Fact label="Type" value={PROPERTY_TYPE_LABELS[property.type] ?? property.type} />
        <Fact label="Units" value={property.units} />
        <Fact label="Square feet" value={property.sqft?.toLocaleString()} />
        <Fact label="Owner entity" value={property.ownerEntity} />
        <Fact label="Manager" value={property.manager} />
        <Fact label="Acquired" value={property.acquiredDate ? fmtDate(property.acquiredDate) : null} />
        <Fact label="Purchase price" value={property.purchasePrice ? fmtMoney(property.purchasePrice) : null} />
        <Fact label="Status" value={property.status === "sold" ? "Sold" : "Owned"} />
      </dl>
      {property.dealId && (
        <button className="inline-flex items-center gap-1 text-sm text-primary hover:underline"
          onClick={() => { try { sessionStorage.setItem(OPEN_DEAL_KEY, String(property.dealId)); } catch { /* storage unavailable */ } navigate("/pipeline"); }}>
          <ExternalLink size={13} /> Open the original deal (underwriting, files, history)
        </button>
      )}
      {!s.latestMonth ? (
        <div className="rounded-md border border-dashed border-border p-4 flex flex-wrap items-center justify-between gap-3">
          <p className="text-sm text-muted-foreground">No monthly figures yet. Upload the manager's T12, monthly P&L or budget on the Financials tab.</p>
          <Button size="sm" variant="outline" className="gap-1" onClick={() => onTab("financials")}><FileUp size={13} /> Go to Financials</Button>
        </div>
      ) : (
        <>
          <SummaryMetrics s={s} />
          {s.mismatches.length > 0 && (
            <p className="text-sm rounded-md bg-amber-50 dark:bg-amber-900/20 text-amber-900 dark:text-amber-200 px-3 py-2 flex gap-2"><AlertTriangle size={15} className="shrink-0 mt-0.5" />
              Saved NOI differs from the report's own NOI for {s.mismatches.map(m => monthLabel(m, true)).join(", ")}. Check those months on the Financials tab.</p>
          )}
          <section className="space-y-2">
            <h3 className="text-sm font-semibold text-foreground">NOI, last 12 months</h3>
            <NoiTrend trend={s.trend} />
          </section>
        </>
      )}
      {property.notes && <section className="space-y-1"><h3 className="text-sm font-semibold text-foreground">Notes</h3><p className="text-sm whitespace-pre-line">{property.notes}</p></section>}
    </div>
  );
}

function Financials({ property, months }: { property: Property; months: PropertyMonth[] }) {
  const { toast } = useToast();
  const qc = useQueryClient();
  const confirm = useConfirm();
  const input = useRef<HTMLInputElement>(null);
  const [reading, setReading] = useState<string | null>(null);
  const [review, setReview] = useState<{ result: ReadResult; fileName: string } | null>(null);
  const years = useMemo(() => Array.from(new Set(months.map(m => m.month.slice(0, 4)))).sort().reverse(), [months]);
  const [year, setYear] = useState<string | null>(null);
  const shownYear = year && years.includes(year) ? year : years[0] ?? String(new Date().getFullYear());
  const [view, setView] = useState<"actual" | "budget" | "variance">("actual");

  const byKey = useMemo(() => new Map(months.map(m => [`${m.kind}:${m.month}`, m])), [months]);
  const cols = Array.from({ length: 12 }, (_, i) => `${shownYear}-${String(i + 1).padStart(2, "0")}`);
  const get = (kind: string, month: string): Lines | null => { const r = byKey.get(`${kind}:${month}`); return r ? parseLines(r.lines) : null; };

  async function upload(file: File) {
    setReading(file.name);
    try {
      const body = new FormData();
      body.append("file", file);
      body.append("kind", "report");
      const up = await fetch(`/api/properties/${property.id}/files`, { method: "POST", body });
      const saved = await up.json().catch(() => ({}));
      if (!up.ok) throw new Error(saved.message ?? `Upload failed (${up.status})`);
      qc.invalidateQueries({ queryKey: ["/api/properties", property.id, "files"] });
      const rd = await fetch(`/api/properties/${property.id}/files/${saved.id}/read`, { method: "POST" });
      const result = await rd.json().catch(() => ({}));
      if (!rd.ok) throw new Error(result.message ?? `Could not read the report (${rd.status})`);
      setReview({ result, fileName: file.name });
    } catch (e: any) {
      toast({ title: `Could not read ${file.name}`, description: `${e.message} The file is saved on the Files tab.`, variant: "destructive" });
    } finally {
      setReading(null);
      if (input.current) input.current.value = "";
    }
  }

  const removeMonth = useMutation({
    mutationFn: ({ month, kind }: { month: string; kind: string }) => apiRequest("DELETE", `/api/properties/${property.id}/months/${month}?kind=${kind}`),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["/api/properties", property.id, "months"] }); qc.invalidateQueries({ queryKey: ["/api/property-months"] }); },
  });

  // Variance color: above budget is good for income and NOI, bad for expenses.
  const varianceCls = (d: number, expense?: boolean) => {
    const good = expense ? d < 0 : d > 0, bad = expense ? d > 0 : d < 0;
    return good ? "text-green-700 dark:text-green-400" : bad ? "text-red-600 dark:text-red-400" : "";
  };
  // One cell for a line in a month under the current view.
  const cell = (month: string, f: (l: Lines) => number, expense?: boolean): { text: string; cls: string } => {
    const a = get("actual", month), b = get("budget", month);
    if (view === "actual") return a ? { text: whole(f(a)), cls: "" } : { text: "", cls: "" };
    if (view === "budget") return b ? { text: whole(f(b)), cls: "" } : { text: "", cls: "" };
    if (!a || !b) return { text: "", cls: "" };
    const d = f(a) - f(b);
    return { text: d === 0 ? "0" : whole(d), cls: varianceCls(d, expense) };
  };
  const total = (f: (l: Lines) => number) => {
    const present = cols.filter(m => view === "budget" ? get("budget", m) : view === "actual" ? get("actual", m) : get("actual", m) && get("budget", m));
    if (!present.length) return "";
    const s = present.reduce((acc, m) => acc + (view === "budget" ? f(get("budget", m)!) : view === "actual" ? f(get("actual", m)!) : f(get("actual", m)!) - f(get("budget", m)!)), 0);
    return whole(s);
  };
  const lineRow = (key: string, label: string, f: (l: Lines) => number, o: { bold?: boolean; expense?: boolean } = {}) => (
    <tr key={key} className={o.bold ? "font-semibold bg-muted/20" : ""}>
      <td className="sticky left-0 bg-background px-3 py-1.5 text-xs whitespace-nowrap">{label}</td>
      {cols.map(m => {
        const c = cell(m, f, o.expense);
        return <td key={m} className={`px-2 py-1.5 text-right text-xs font-mono ${c.cls}`}>{c.text}</td>;
      })}
      <td className="px-3 py-1.5 text-right text-xs font-mono font-semibold">{total(f)}</td>
    </tr>
  );
  const has = (kind: string, m: string) => !!get(kind, m);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <Select value={shownYear} onValueChange={setYear}>
          <SelectTrigger className="w-[110px] h-8" aria-label="Year"><SelectValue /></SelectTrigger>
          <SelectContent>{(years.length ? years : [shownYear]).map(y => <SelectItem key={y} value={y}>{y}</SelectItem>)}</SelectContent>
        </Select>
        <Select value={view} onValueChange={v => setView(v as typeof view)}>
          <SelectTrigger className="w-[170px] h-8" aria-label="Show"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="actual">Actuals</SelectItem>
            <SelectItem value="budget">Budget</SelectItem>
            <SelectItem value="variance">Actual vs budget</SelectItem>
          </SelectContent>
        </Select>
        <input ref={input} type="file" className="hidden" accept=".pdf,.xlsx,.xlsm,.csv" onChange={e => { const f = e.target.files?.[0]; if (f) upload(f); }} />
        <Button size="sm" className="gap-1 ml-auto" disabled={!!reading} onClick={() => input.current?.click()}>
          {reading ? <Loader2 size={13} className="animate-spin" /> : <FileUp size={13} />} Upload report
        </Button>
      </div>
      <p className="text-xs text-muted-foreground">
        Upload the manager's T12, a monthly P&L or an annual budget (PDF or Excel). Claude sorts every account into the categories below, month by month;
        you review the numbers before they're saved. NOI is calculated by the dashboard.
      </p>

      <div className="overflow-x-auto rounded-md border border-border">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-border bg-muted/30">
              <th className="sticky left-0 bg-muted px-3 py-2 text-left text-xs font-medium text-muted-foreground w-48">{view === "variance" ? "Actual minus budget" : view === "budget" ? "Budget" : "Actuals"}</th>
              {cols.map(m => (
                <th key={m} className="px-2 py-2 text-right text-xs font-medium text-muted-foreground whitespace-nowrap">
                  {monthLabel(m, true).split(" ")[0]}
                  {view !== "variance" && has(view, m) && (
                    <button aria-label={`Delete ${view === "budget" ? "budget" : "actuals"} for ${monthLabel(m)}`} className="ml-1 align-middle text-muted-foreground/60 hover:text-destructive"
                      onClick={async () => { if (await confirm({ title: `Delete ${view === "budget" ? "budget" : "actuals"} for ${monthLabel(m)}?`, confirmLabel: "Delete month" })) removeMonth.mutate({ month: m, kind: view }); }}>
                      <Trash2 size={10} />
                    </button>
                  )}
                </th>
              ))}
              <th className="px-3 py-2 text-right text-xs font-medium text-muted-foreground">Total</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border/60">
            {INCOME_LINES.map(l => lineRow(l.key, l.label, x => Number(x[l.key]) || 0))}
            {lineRow("ti", "Total income", totalIncome, { bold: true })}
            {EXPENSE_LINES.map(l => lineRow(l.key, l.label, x => Number(x[l.key]) || 0, { expense: true }))}
            {lineRow("te", "Total expenses", totalExpenses, { bold: true, expense: true })}
            {lineRow("noi", "NOI", noi, { bold: true })}
            {BELOW_NOI_LINES.map(l => lineRow(l.key, l.label, x => Number(x[l.key]) || 0, { expense: true }))}
          </tbody>
        </table>
      </div>
      {!months.length && <p className="text-sm text-muted-foreground">Nothing saved yet for this property.</p>}

      <Dialog open={!!reading}>
        <DialogContent className="max-w-sm [&>button]:hidden" onInteractOutside={e => e.preventDefault()}>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2"><Loader2 size={16} className="animate-spin" /> Reading the report</DialogTitle>
            <DialogDescription>Claude is reading {reading} and sorting every account by month. This usually takes 30 to 90 seconds.</DialogDescription>
          </DialogHeader>
        </DialogContent>
      </Dialog>
      {review && <ReportReview property={property} result={review.result} fileName={review.fileName} onClose={() => setReview(null)} onSaved={() => setReview(null)} />}
    </div>
  );
}

function fmtSize(n: number) { return n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`; }
const KIND_LABEL: Record<string, string> = { report: "Report", budget: "Budget" };

function Files({ property }: { property: Property }) {
  const { toast } = useToast();
  const qc = useQueryClient();
  const confirm = useConfirm();
  const input = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  const key = ["/api/properties", property.id, "files"];
  const { data: files = [] } = useQuery<PropertyFile[]>({ queryKey: key });
  async function upload(file: File) {
    setUploading(true);
    try {
      const body = new FormData();
      body.append("file", file);
      const res = await fetch(`/api/properties/${property.id}/files`, { method: "POST", body });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.message ?? `Upload failed (${res.status})`);
      qc.invalidateQueries({ queryKey: key });
      toast({ title: "File saved to the property" });
    } catch (e: any) {
      toast({ title: "Could not upload", description: e.message, variant: "destructive" });
    } finally { setUploading(false); if (input.current) input.current.value = ""; }
  }
  const remove = useMutation({ mutationFn: (id: number) => apiRequest("DELETE", `/api/property-files/${id}`), onSuccess: () => qc.invalidateQueries({ queryKey: key }) });
  return (
    <section className="space-y-2">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold text-foreground">Files</h3>
        <input ref={input} type="file" className="hidden" accept=".pdf,.xlsx,.xlsm,.xls,.csv,.docx,.png,.jpg,.jpeg" onChange={e => { const f = e.target.files?.[0]; if (f) upload(f); }} />
        <Button size="sm" variant="ghost" className="gap-1 h-7" disabled={uploading} onClick={() => input.current?.click()}>
          {uploading ? <Loader2 size={13} className="animate-spin" /> : <Paperclip size={13} />} Add file
        </Button>
      </div>
      {files.length === 0
        ? <p className="text-sm text-muted-foreground">No files yet. Reports uploaded on the Financials tab are kept here, along with leases, insurance and tax bills you add.</p>
        : (
          <ul className="divide-y divide-border rounded-md border border-border">
            {files.map(f => (
              <li key={f.id} className="flex items-center gap-2 px-3 py-2 text-sm">
                <a href={`/api/property-files/${f.id}/download${f.mime === "application/pdf" ? "?inline=1" : ""}`} target="_blank" rel="noopener" className="text-foreground hover:underline truncate">{f.name}</a>
                {KIND_LABEL[f.kind] && <span className="text-[11px] px-1.5 rounded bg-muted text-muted-foreground">{KIND_LABEL[f.kind]}</span>}
                <span className="ml-auto text-xs text-muted-foreground whitespace-nowrap">{fmtDate(f.createdAt)} · {fmtSize(f.size)}</span>
                <a href={`/api/property-files/${f.id}/download`} aria-label={`Download ${f.name}`} className="p-1 text-muted-foreground hover:text-foreground"><Download size={13} /></a>
                <button aria-label={`Delete ${f.name}`} className="p-1 text-muted-foreground hover:text-destructive"
                  onClick={async () => { if (await confirm({ title: `Delete ${f.name}?`, description: "Months already saved from it are kept." })) remove.mutate(f.id); }}>
                  <Trash2 size={13} />
                </button>
              </li>
            ))}
          </ul>
        )}
    </section>
  );
}

export function PropertySheet({ property, tab, onTab, onClose, onEdit, onDelete }: {
  property: Property | null; tab: PropertyTab; onTab: (t: PropertyTab) => void; onClose: () => void;
  onEdit: (p: Property) => void; onDelete: (p: Property) => void;
}) {
  const { data: months = [] } = useQuery<PropertyMonth[]>({ queryKey: ["/api/properties", property?.id ?? 0, "months"], enabled: !!property });
  return (
    <Sheet open={!!property} onOpenChange={o => { if (!o) onClose(); }}>
      <SheetContent className="w-full sm:max-w-5xl overflow-y-auto">
        {property && (
          <div className="space-y-5">
            <SheetHeader className="space-y-1 text-left">
              <SheetTitle className="pr-6">{property.name}</SheetTitle>
              <SheetDescription>{[PROPERTY_TYPE_LABELS[property.type], property.address].filter(Boolean).join(", ")}</SheetDescription>
            </SheetHeader>
            <div className="flex justify-end gap-1">
              <Button size="sm" variant="outline" className="gap-1" onClick={() => onEdit(property)}><Pencil size={13} /> Edit</Button>
              <Button size="sm" variant="ghost" className="text-muted-foreground hover:text-destructive" onClick={() => onDelete(property)} aria-label="Delete property"><Trash2 size={14} /></Button>
            </div>
            <Tabs value={tab} onValueChange={v => onTab(v as PropertyTab)} className="space-y-5">
              <TabsList>
                <TabsTrigger value="overview">Overview</TabsTrigger>
                <TabsTrigger value="financials">Financials</TabsTrigger>
                <TabsTrigger value="files">Files</TabsTrigger>
              </TabsList>
              <TabsContent value="overview" className="mt-0"><Overview property={property} months={months} onTab={onTab} /></TabsContent>
              <TabsContent value="financials" className="mt-0"><Financials property={property} months={months} /></TabsContent>
              <TabsContent value="files" className="mt-0"><Files property={property} /></TabsContent>
            </Tabs>
          </div>
        )}
      </SheetContent>
    </Sheet>
  );
}
