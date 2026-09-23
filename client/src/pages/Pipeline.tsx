import { useMemo, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import type { PipelineDeal, Contact, DealActivity, Task } from "@shared/schema";
import {
  STAGES, ACTIVE_STAGES, STAGE_LABELS, DEAL_TYPES, DEAL_TYPE_LABELS, SOURCES, SOURCE_LABELS,
  TEMPERATURES, COMPETITION_LEVELS, MOTIVATION_LEVELS, DEAD_REASONS, ACTIVITY_KINDS, ACTIVITY_LABELS,
  DEADLINE_FIELDS, STAGE_DEADLINES, STAGE_PROBABILITY,
  effectiveProbability, daysSince, daysUntil, parseScenarios,
  type Stage, type DevelopmentScenario,
} from "@shared/pipeline";
import {
  Plus, Pencil, Trash2, Loader2, Search, AlertTriangle, Clock, CalendarClock, X, Phone, Mail, CheckCircle2, Circle,
} from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription } from "@/components/ui/sheet";
import { useToast } from "@/hooks/use-toast";

// ── Display helpers ─────────────────────────────────────────────────────────
function fmtMoney(n: number | null | undefined): string {
  if (n == null) return "—";
  if (Math.abs(n) >= 1_000_000) return `$${(n / 1_000_000).toFixed(n >= 10_000_000 ? 1 : 2)}M`;
  if (Math.abs(n) >= 1_000) return `$${(n / 1_000).toFixed(0)}K`;
  return `$${n.toFixed(0)}`;
}
function fmtDate(ymd: string | null | undefined): string {
  if (!ymd) return "—";
  const [y, m, d] = ymd.slice(0, 10).split("-").map(Number);
  return new Date(y, m - 1, d).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}
function sizeLine(d: PipelineDeal): string {
  const parts: string[] = [];
  if (d.acres) parts.push(`${d.acres} ac`);
  if (d.sqft) parts.push(`${d.sqft.toLocaleString()} SF`);
  if (d.units) parts.push(`${d.units} units`);
  return parts.join(", ") || "—";
}
function priceLabel(d: PipelineDeal): string {
  if (d.offerPrice) return `${fmtMoney(d.offerPrice)} offer`;
  if (d.askingPrice) return fmtMoney(d.askingPrice);
  return "Price TBD";
}
function dealValue(d: PipelineDeal): number {
  return d.projectedValue ?? d.offerPrice ?? d.askingPrice ?? 0;
}
const today = () => new Date().toISOString().slice(0, 10);

interface Deadline { key: string; label: string; date: string; days: number }
function nextDeadline(d: PipelineDeal): Deadline | null {
  const keys = STAGE_DEADLINES[d.stage] ?? [];
  const list = DEADLINE_FIELDS
    .filter(f => keys.includes(f.key))
    .map(f => ({ key: f.key as string, label: f.label as string, date: ((d as any)[f.key] as string | null) ?? "" }))
    .filter(f => f.date !== "" && daysUntil(f.date) != null)
    .map(f => ({ ...f, days: daysUntil(f.date)! }))
    .sort((a, b) => a.days - b.days);
  return list[0] ?? null;
}

const stageAccent: Record<string, string> = {
  lead: "border-t-gray-400",
  screening: "border-t-slate-500",
  loi: "border-t-blue-500",
  "due-diligence": "border-t-yellow-500",
  closing: "border-t-orange-500",
  closed: "border-t-green-500",
  dead: "border-t-red-500",
};
const stagePill: Record<string, string> = {
  lead: "bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-300",
  screening: "bg-slate-200 text-slate-800 dark:bg-slate-800 dark:text-slate-200",
  loi: "bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-300",
  "due-diligence": "bg-yellow-100 text-yellow-800 dark:bg-yellow-900/30 dark:text-yellow-300",
  closing: "bg-orange-100 text-orange-800 dark:bg-orange-900/30 dark:text-orange-300",
  closed: "bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-300",
  dead: "bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-300",
};
const tempDot: Record<string, string> = { hot: "bg-red-500", warm: "bg-amber-500", cold: "bg-sky-500" };

function TempBadge({ t }: { t: string }) {
  return (
    <span className="inline-flex items-center gap-1 text-xs text-muted-foreground capitalize">
      <span className={`w-2 h-2 rounded-full ${tempDot[t] ?? "bg-gray-400"}`} aria-hidden /> {t}
    </span>
  );
}
function DeadlineChip({ dl }: { dl: Deadline }) {
  const tone = dl.days < 0 ? "text-red-700 bg-red-100 dark:text-red-300 dark:bg-red-900/30"
    : dl.days <= 3 ? "text-orange-800 bg-orange-100 dark:text-orange-300 dark:bg-orange-900/30"
    : "text-muted-foreground bg-muted";
  const when = dl.days < 0 ? `${-dl.days}d overdue` : dl.days === 0 ? "today" : `in ${dl.days}d`;
  return <span className={`inline-flex items-center gap-1 text-[11px] px-1.5 py-0.5 rounded whitespace-nowrap ${tone}`}><CalendarClock size={11} />{dl.label} {when}</span>;
}

// ── Alerts: what needs attention now ───────────────────────────────────────
interface Alert { deal: PipelineDeal; severity: "high" | "medium"; text: string }
function buildAlerts(deals: PipelineDeal[]): Alert[] {
  const out: Alert[] = [];
  for (const d of deals) {
    if (!ACTIVE_STAGES.includes(d.stage as Stage)) continue;
    const dl = nextDeadline(d);
    if (dl && dl.days < 0) out.push({ deal: d, severity: "high", text: `${dl.label} ${fmtDate(dl.date)}, ${-dl.days} days overdue` });
    else if (dl && dl.days <= 7) out.push({ deal: d, severity: dl.days <= 3 ? "high" : "medium", text: `${dl.label} ${dl.days === 0 ? "today" : `in ${dl.days} day${dl.days === 1 ? "" : "s"}`} (${fmtDate(dl.date)})` });

    const quiet = daysSince(d.lastActivityAt) ?? 0;
    const early = d.stage === "lead" || d.stage === "screening";
    const staleAfter = early ? 30 : 14;
    if (quiet >= staleAfter) out.push({ deal: d, severity: "medium", text: `No activity logged in ${quiet} days` });

    const inStage = daysSince(d.stageChangedAt) ?? 0;
    if (d.stage === "screening" && inStage > 30) out.push({ deal: d, severity: "medium", text: `In screening ${inStage} days: move to LOI or mark dead` });
    if (d.stage === "loi" && !d.loiExpiration) out.push({ deal: d, severity: "medium", text: "In LOI with no expiration date set" });
    if (d.stage === "due-diligence" && !d.ddEndDate) out.push({ deal: d, severity: "high", text: "In due diligence with no DD end date set" });
  }
  return out.sort((a, b) => (a.severity === b.severity ? 0 : a.severity === "high" ? -1 : 1));
}

// ── Page ────────────────────────────────────────────────────────────────────
export default function Pipeline() {
  const { toast } = useToast();
  const qc = useQueryClient();
  const [search, setSearch] = useState("");
  const [typeFilter, setTypeFilter] = useState("all");
  const [tempFilter, setTempFilter] = useState("all");
  const [showInactive, setShowInactive] = useState(false);
  const [formDeal, setFormDeal] = useState<PipelineDeal | "new" | null>(null);
  const [detailId, setDetailId] = useState<number | null>(null);
  const [deadTarget, setDeadTarget] = useState<PipelineDeal | null>(null);

  const { data: deals = [], isLoading } = useQuery<PipelineDeal[]>({ queryKey: ["/api/pipeline"] });
  const { data: contacts = [] } = useQuery<Contact[]>({ queryKey: ["/api/contacts"] });
  const contactMap = useMemo(() => Object.fromEntries(contacts.map(c => [c.id, c])), [contacts]);

  const refresh = (id?: number) => {
    qc.invalidateQueries({ queryKey: ["/api/pipeline"] });
    qc.invalidateQueries({ queryKey: ["/api/tasks"] });
    if (id) qc.invalidateQueries({ queryKey: ["/api/pipeline", id, "activity"] });
  };

  const moveStage = useMutation({
    mutationFn: ({ id, stage, deadReason }: { id: number; stage: string; deadReason?: string }) =>
      apiRequest("PATCH", `/api/pipeline/${id}`, { stage, ...(deadReason ? { deadReason } : {}) }),
    onSuccess: (_r, v) => {
      refresh(v.id);
      toast({
        title: `Moved to ${STAGE_LABELS[v.stage as Stage]}`,
        description: v.stage === "due-diligence" ? "Due diligence checklist added to Tasks." : undefined,
      });
    },
    onError: (e: Error) => toast({ title: "Could not change stage", description: e.message, variant: "destructive" }),
  });

  function requestStage(deal: PipelineDeal, stage: string) {
    if (stage === deal.stage) return;
    if (stage === "dead") { setDeadTarget(deal); return; }
    moveStage.mutate({ id: deal.id, stage });
  }

  const remove = useMutation({
    mutationFn: (id: number) => apiRequest("DELETE", `/api/pipeline/${id}`),
    onSuccess: () => { refresh(); setDetailId(null); toast({ title: "Deal deleted" }); },
  });

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return deals.filter(d => {
      if (typeFilter !== "all" && d.type !== typeFilter) return false;
      if (tempFilter !== "all" && d.temperature !== tempFilter) return false;
      if (!q) return true;
      const broker = d.brokerContactId ? contactMap[d.brokerContactId] : undefined;
      return [d.name, d.address, d.municipality, d.county, d.dealCode, d.sellerName, broker?.name, broker?.company, d.notes]
        .some(v => v?.toLowerCase().includes(q));
    });
  }, [deals, search, typeFilter, tempFilter, contactMap]);

  const active = filtered.filter(d => ACTIVE_STAGES.includes(d.stage as Stage));
  const inactive = filtered.filter(d => !ACTIVE_STAGES.includes(d.stage as Stage));
  const alerts = useMemo(() => buildAlerts(deals), [deals]);

  const allActive = deals.filter(d => ACTIVE_STAGES.includes(d.stage as Stage));
  const askingTotal = allActive.reduce((s, d) => s + (d.askingPrice ?? 0), 0);
  const weighted = allActive.reduce((s, d) => s + dealValue(d) * effectiveProbability(d) / 100, 0);
  const unpriced = allActive.filter(d => !dealValue(d)).length;

  const detailDeal = detailId != null ? deals.find(d => d.id === detailId) ?? null : null;

  if (isLoading) return <div className="flex items-center gap-2 text-muted-foreground"><Loader2 className="animate-spin" size={16} /> Loading pipeline…</div>;

  return (
    <div className="space-y-5">
      {/* Header */}
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-lg font-bold text-foreground">Pipeline</h1>
          <p className="text-sm text-muted-foreground">
            {allActive.length} active {allActive.length === 1 ? "deal" : "deals"}
            {askingTotal > 0 && <>, {fmtMoney(askingTotal)} asking</>}
            {weighted > 0 && <>, <span className="font-semibold text-foreground">{fmtMoney(weighted)}</span> probability-weighted</>}
            {unpriced > 0 && <> ({unpriced} not yet priced)</>}
          </p>
        </div>
        <Button data-testid="button-add-deal" onClick={() => setFormDeal("new")} size="sm" className="gap-1.5">
          <Plus size={14} /> Add deal
        </Button>
      </div>

      {/* Needs attention */}
      {alerts.length > 0 && (
        <Card className="border-orange-300 dark:border-orange-800">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-semibold flex items-center gap-2">
              <AlertTriangle size={15} className="text-orange-500" /> Needs attention ({alerts.length})
            </CardTitle>
          </CardHeader>
          <CardContent className="pt-0">
            <ul className="divide-y divide-border">
              {alerts.slice(0, 8).map((a, i) => (
                <li key={i}>
                  <button onClick={() => setDetailId(a.deal.id)} className="w-full flex items-center gap-3 py-2 text-left hover:bg-muted/50 rounded px-1">
                    <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${a.severity === "high" ? "bg-red-500" : "bg-amber-500"}`} aria-hidden />
                    <span className="text-sm font-medium text-foreground">{a.deal.name}</span>
                    <span className="text-sm text-muted-foreground">{a.text}</span>
                  </button>
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      )}

      {/* Filters */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative flex-1 min-w-[200px] max-w-sm">
          <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground" />
          <Input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search name, town, broker, deal ID" className="pl-8 h-9" aria-label="Search deals" />
        </div>
        <Select value={typeFilter} onValueChange={setTypeFilter}>
          <SelectTrigger className="w-[180px] h-9" aria-label="Filter by type"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All property types</SelectItem>
            {DEAL_TYPES.map(t => <SelectItem key={t} value={t}>{DEAL_TYPE_LABELS[t]}</SelectItem>)}
          </SelectContent>
        </Select>
        <Select value={tempFilter} onValueChange={setTempFilter}>
          <SelectTrigger className="w-[150px] h-9" aria-label="Filter by temperature"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">Any temperature</SelectItem>
            {TEMPERATURES.map(t => <SelectItem key={t} value={t} className="capitalize">{t}</SelectItem>)}
          </SelectContent>
        </Select>
        <label className="flex items-center gap-2 text-sm text-muted-foreground ml-1">
          <Switch checked={showInactive} onCheckedChange={setShowInactive} aria-label="Show closed and dead deals" />
          Show closed and dead
        </label>
      </div>

      {/* Empty state */}
      {deals.length === 0 && (
        <Card>
          <CardContent className="py-12 text-center space-y-3">
            <p className="font-semibold text-foreground">No deals yet</p>
            <p className="text-sm text-muted-foreground max-w-md mx-auto">Log an opportunity when a broker package, off-market lead or lender call comes in. It gets a deal ID and moves across the board from lead to closing.</p>
            <Button size="sm" onClick={() => setFormDeal("new")} className="gap-1.5"><Plus size={14} /> Add deal</Button>
          </CardContent>
        </Card>
      )}

      {/* Board */}
      {deals.length > 0 && (
        <div className="overflow-x-auto pb-2 -mx-1 px-1">
          <div className="grid grid-cols-5 gap-3 min-w-[900px]">
            {ACTIVE_STAGES.map(stage => {
              const col = active.filter(d => d.stage === stage);
              return (
                <section key={stage} aria-label={STAGE_LABELS[stage]} className="space-y-2">
                  <div className="flex items-baseline justify-between px-1">
                    <h2 className="text-sm font-semibold text-foreground">{STAGE_LABELS[stage]}</h2>
                    <span className="text-xs text-muted-foreground">{col.length}</span>
                  </div>
                  {col.length === 0 && <div className="rounded-lg border border-dashed border-border h-16" />}
                  {col.map(d => {
                    const dl = nextDeadline(d);
                    const inStage = daysSince(d.stageChangedAt) ?? 0;
                    return (
                      <button
                        key={d.id}
                        onClick={() => setDetailId(d.id)}
                        data-testid={`card-deal-${d.id}`}
                        className={`w-full text-left rounded-lg border border-border border-t-4 ${stageAccent[stage]} bg-card p-3 space-y-1.5 hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring`}
                      >
                        <div className="flex items-start justify-between gap-2">
                          <span className="text-sm font-semibold text-foreground leading-snug">{d.name}</span>
                          <span className={`mt-1 w-2 h-2 rounded-full shrink-0 ${tempDot[d.temperature] ?? "bg-gray-400"}`} title={`${d.temperature}`} />
                        </div>
                        <div className="text-xs text-muted-foreground">{[d.municipality, DEAL_TYPE_LABELS[d.type] ?? d.type].filter(Boolean).join(", ")}</div>
                        <div className="flex justify-between text-xs">
                          <span className="font-medium text-foreground">{priceLabel(d)}</span>
                          <span className="text-muted-foreground">{sizeLine(d)}</span>
                        </div>
                        <div className="flex flex-wrap items-center gap-1.5 pt-0.5">
                          <span className="text-[11px] text-muted-foreground">{d.dealCode}</span>
                          <span className="text-[11px] text-muted-foreground">{inStage}d in stage</span>
                          {dl && dl.days <= 14 && <DeadlineChip dl={dl} />}
                        </div>
                      </button>
                    );
                  })}
                </section>
              );
            })}
          </div>
        </div>
      )}

      {/* Table */}
      {deals.length > 0 && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-semibold">{showInactive ? "All deals" : "Active deals"}</CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border text-xs text-muted-foreground whitespace-nowrap">
                    <th className="text-left px-4 py-2 font-medium">Deal</th>
                    <th className="text-left px-4 py-2 font-medium">Stage</th>
                    <th className="text-right px-4 py-2 font-medium">Days in stage</th>
                    <th className="text-right px-4 py-2 font-medium">Price</th>
                    <th className="text-right px-4 py-2 font-medium">Size</th>
                    <th className="text-left px-4 py-2 font-medium">Temp</th>
                    <th className="text-left px-4 py-2 font-medium">Broker</th>
                    <th className="text-left px-4 py-2 font-medium">Next deadline</th>
                    <th className="text-right px-4 py-2 font-medium">Last activity</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {[...active, ...(showInactive ? inactive : [])].map(d => {
                    const broker = d.brokerContactId ? contactMap[d.brokerContactId] : undefined;
                    const dl = nextDeadline(d);
                    return (
                      <tr key={d.id} className="hover:bg-muted/40 cursor-pointer" onClick={() => setDetailId(d.id)}>
                        <td className="px-4 py-2.5 min-w-[220px]">
                          <div className="font-medium text-foreground leading-snug">{d.name}</div>
                          <div className="text-xs text-muted-foreground">{d.dealCode}, {DEAL_TYPE_LABELS[d.type] ?? d.type}{d.municipality ? `, ${d.municipality}` : ""}</div>
                        </td>
                        <td className="px-4 py-2.5"><span className={`text-xs px-2 py-0.5 rounded-full font-medium whitespace-nowrap ${stagePill[d.stage]}`}>{STAGE_LABELS[d.stage as Stage] ?? d.stage}</span></td>
                        <td className="px-4 py-2.5 text-right tabular-nums">{daysSince(d.stageChangedAt) ?? "—"}</td>
                        <td className="px-4 py-2.5 text-right tabular-nums whitespace-nowrap">{priceLabel(d)}</td>
                        <td className="px-4 py-2.5 text-right text-muted-foreground whitespace-nowrap">{sizeLine(d)}</td>
                        <td className="px-4 py-2.5"><TempBadge t={d.temperature} /></td>
                        <td className="px-4 py-2.5 text-muted-foreground whitespace-nowrap">{broker ? `${broker.name}${broker.company ? `, ${broker.company}` : ""}` : "—"}</td>
                        <td className="px-4 py-2.5">{dl ? <DeadlineChip dl={dl} /> : <span className="text-muted-foreground">—</span>}</td>
                        <td className="px-4 py-2.5 text-right text-muted-foreground whitespace-nowrap">{daysSince(d.lastActivityAt) === 0 ? "Today" : `${daysSince(d.lastActivityAt)}d ago`}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </CardContent>
        </Card>
      )}

      {formDeal && (
        <DealFormDialog
          deal={formDeal === "new" ? null : formDeal}
          contacts={contacts}
          onClose={() => setFormDeal(null)}
          onSaved={(saved, isNew) => {
            refresh(saved.id);
            qc.invalidateQueries({ queryKey: ["/api/contacts"] });
            setFormDeal(null);
            if (isNew) setDetailId(saved.id);
          }}
        />
      )}

      <DealDetailSheet
        deal={detailDeal}
        broker={detailDeal?.brokerContactId ? contactMap[detailDeal.brokerContactId] : undefined}
        onClose={() => setDetailId(null)}
        onEdit={d => setFormDeal(d)}
        onDelete={d => { if (confirm(`Delete ${d.name}? Its activity log is deleted too; its tasks are kept.`)) remove.mutate(d.id); }}
        onStage={requestStage}
        stagePending={moveStage.isPending}
      />

      <DeadReasonDialog
        deal={deadTarget}
        onClose={() => setDeadTarget(null)}
        onConfirm={reason => { if (deadTarget) moveStage.mutate({ id: deadTarget.id, stage: "dead", deadReason: reason }); setDeadTarget(null); }}
      />
    </div>
  );
}

// ── Mark dead ───────────────────────────────────────────────────────────────
function DeadReasonDialog({ deal, onClose, onConfirm }: { deal: PipelineDeal | null; onClose: () => void; onConfirm: (reason: string) => void }) {
  const [reason, setReason] = useState<string>("Pricing");
  const [detail, setDetail] = useState("");
  return (
    <Dialog open={!!deal} onOpenChange={o => { if (!o) onClose(); }}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Mark {deal?.name} dead</DialogTitle>
          <DialogDescription>The reason is kept with the deal so you can see later why deals fell out.</DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label>Reason</Label>
            <Select value={reason} onValueChange={setReason}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>{DEAD_REASONS.map(r => <SelectItem key={r} value={r}>{r}</SelectItem>)}</SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="dead-detail">Details (optional)</Label>
            <Textarea id="dead-detail" rows={3} value={detail} onChange={e => setDetail(e.target.value)} placeholder="e.g. Seller would not go below $4.2M" />
          </div>
        </div>
        <div className="flex justify-end gap-2 pt-2">
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button variant="destructive" onClick={() => { onConfirm(detail.trim() ? `${reason}: ${detail.trim()}` : reason); setDetail(""); }}>Mark dead</Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

// ── Detail sheet ────────────────────────────────────────────────────────────
function Fact({ label, value }: { label: string; value: React.ReactNode }) {
  if (value == null || value === "" || value === "—") return null;
  return (
    <div>
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="text-sm text-foreground">{value}</dd>
    </div>
  );
}

function DealDetailSheet({ deal, broker, onClose, onEdit, onDelete, onStage, stagePending }: {
  deal: PipelineDeal | null; broker?: Contact; onClose: () => void;
  onEdit: (d: PipelineDeal) => void; onDelete: (d: PipelineDeal) => void;
  onStage: (d: PipelineDeal, stage: string) => void; stagePending: boolean;
}) {
  const { toast } = useToast();
  const qc = useQueryClient();
  const [kind, setKind] = useState<string>("call");
  const [date, setDate] = useState(today());
  const [summary, setSummary] = useState("");

  const { data: activity = [] } = useQuery<DealActivity[]>({
    queryKey: ["/api/pipeline", deal?.id ?? 0, "activity"],
    enabled: !!deal,
  });
  const { data: tasks = [] } = useQuery<Task[]>({ queryKey: ["/api/tasks"], enabled: !!deal });
  const dealTasks = deal ? tasks.filter(t => t.dealId === deal.id).sort((a, b) => (a.dueDate ?? "").localeCompare(b.dueDate ?? "")) : [];

  const log = useMutation({
    mutationFn: () => apiRequest("POST", `/api/pipeline/${deal!.id}/activity`, { kind, date, summary }),
    onSuccess: () => {
      setSummary("");
      qc.invalidateQueries({ queryKey: ["/api/pipeline", deal!.id, "activity"] });
      qc.invalidateQueries({ queryKey: ["/api/pipeline"] });
      toast({ title: "Activity logged" });
    },
    onError: (e: Error) => toast({ title: "Could not log activity", description: e.message, variant: "destructive" }),
  });
  const toggleTask = useMutation({
    mutationFn: (t: Task) => apiRequest("PATCH", `/api/tasks/${t.id}`, t.status === "done"
      ? { status: "open", completedAt: null }
      : { status: "done", completedAt: new Date().toISOString() }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["/api/tasks"] }),
  });

  const scenarios = deal ? parseScenarios(deal.scenarios) : [];
  const dl = deal ? nextDeadline(deal) : null;

  return (
    <Sheet open={!!deal} onOpenChange={o => { if (!o) onClose(); }}>
      <SheetContent className="w-full sm:max-w-xl overflow-y-auto">
        {deal && (
          <div className="space-y-6">
            <SheetHeader className="space-y-1 text-left">
              <SheetTitle className="pr-6">{deal.name}</SheetTitle>
              <SheetDescription>
                {deal.dealCode}, {DEAL_TYPE_LABELS[deal.type] ?? deal.type}
                {deal.address ? `, ${deal.address}` : ""}{deal.municipality ? `, ${deal.municipality}` : ""}
              </SheetDescription>
            </SheetHeader>

            <div className="flex flex-wrap items-center gap-2">
              <Select value={deal.stage} onValueChange={s => onStage(deal, s)} disabled={stagePending}>
                <SelectTrigger className="w-[170px] h-9" aria-label="Stage"><SelectValue /></SelectTrigger>
                <SelectContent>{STAGES.map(s => <SelectItem key={s} value={s}>{STAGE_LABELS[s]}</SelectItem>)}</SelectContent>
              </Select>
              <span className="text-xs text-muted-foreground">{daysSince(deal.stageChangedAt)} days in stage, {effectiveProbability(deal)}% probability</span>
              <div className="ml-auto flex gap-1">
                <Button size="sm" variant="outline" className="gap-1" onClick={() => onEdit(deal)}><Pencil size={13} /> Edit</Button>
                <Button size="sm" variant="ghost" className="text-muted-foreground hover:text-destructive" onClick={() => onDelete(deal)} aria-label="Delete deal"><Trash2 size={14} /></Button>
              </div>
            </div>

            {deal.stage === "dead" && deal.deadReason && (
              <p className="text-sm rounded-md bg-red-50 dark:bg-red-900/20 text-red-800 dark:text-red-300 px-3 py-2">Dead: {deal.deadReason}</p>
            )}
            {dl && <DeadlineChip dl={dl} />}

            <section className="space-y-2">
              <h3 className="text-sm font-semibold text-foreground">Pricing</h3>
              <dl className="grid grid-cols-2 sm:grid-cols-3 gap-x-4 gap-y-3">
                <Fact label="Asking" value={deal.askingPrice ? fmtMoney(deal.askingPrice) : "Not set"} />
                <Fact label="Our offer" value={deal.offerPrice ? fmtMoney(deal.offerPrice) : null} />
                <Fact label="Projected value" value={deal.projectedValue ? fmtMoney(deal.projectedValue) : null} />
                <Fact label="NOI" value={deal.noi ? fmtMoney(deal.noi) : null} />
                <Fact label="Cap rate" value={deal.capRate ? `${deal.capRate}%` : null} />
                <Fact label="Price per SF" value={deal.askingPrice && deal.sqft ? `$${Math.round(deal.askingPrice / deal.sqft)}` : null} />
                <Fact label="Price per acre" value={deal.askingPrice && deal.acres ? fmtMoney(deal.askingPrice / deal.acres) : null} />
                <Fact label="Price per unit" value={deal.askingPrice && deal.units ? fmtMoney(deal.askingPrice / deal.units) : null} />
              </dl>
              {deal.priceNotes && <p className="text-sm text-muted-foreground">{deal.priceNotes}</p>}
            </section>

            <section className="space-y-2">
              <h3 className="text-sm font-semibold text-foreground">Property</h3>
              <dl className="grid grid-cols-2 sm:grid-cols-3 gap-x-4 gap-y-3">
                <Fact label="Land" value={deal.acres ? `${deal.acres} acres` : null} />
                <Fact label="Building" value={deal.sqft ? `${deal.sqft.toLocaleString()} SF` : null} />
                <Fact label="Units" value={deal.units} />
                <Fact label="Year built" value={deal.yearBuilt} />
                <Fact label="Occupancy" value={deal.occupancy != null ? `${deal.occupancy}%` : null} />
                <Fact label="County" value={deal.county} />
                <Fact label="Zoning" value={deal.zoning} />
                <Fact label="Flood" value={deal.floodZone} />
                <Fact label="Ground lease" value={deal.groundLease ? "Yes" : null} />
              </dl>
              {deal.utilities && <p className="text-sm text-muted-foreground">Utilities: {deal.utilities}</p>}
            </section>

            {scenarios.length > 0 && (
              <section className="space-y-2">
                <h3 className="text-sm font-semibold text-foreground">Development scenarios</h3>
                <ul className="space-y-2">
                  {scenarios.map((sc, i) => (
                    <li key={i} className="rounded-md border border-border px-3 py-2">
                      <div className="text-sm font-medium text-foreground">{sc.label || `Option ${i + 1}`}: {sc.use}</div>
                      <div className="text-xs text-muted-foreground">
                        {[sc.buildingSf ? `${sc.buildingSf.toLocaleString()} SF` : null, sc.units ? `${sc.units} units` : null].filter(Boolean).join(", ")}
                        {sc.notes ? `${sc.buildingSf || sc.units ? ". " : ""}${sc.notes}` : ""}
                      </div>
                    </li>
                  ))}
                </ul>
              </section>
            )}

            <section className="space-y-2">
              <h3 className="text-sm font-semibold text-foreground">Deal context</h3>
              <dl className="grid grid-cols-2 sm:grid-cols-3 gap-x-4 gap-y-3">
                <Fact label="Source" value={deal.source ? SOURCE_LABELS[deal.source] : null} />
                <Fact label="Temperature" value={<TempBadge t={deal.temperature} />} />
                <Fact label="Competition" value={deal.competition ? <span className="capitalize">{deal.competition}</span> : null} />
                <Fact label="Seller motivation" value={deal.sellerMotivation ? <span className="capitalize">{deal.sellerMotivation}</span> : null} />
                <Fact label="Seller" value={deal.sellerName} />
              </dl>
              {broker && (
                <div className="rounded-md border border-border px-3 py-2 text-sm">
                  <div className="font-medium text-foreground">{broker.name}{broker.company ? `, ${broker.company}` : ""}</div>
                  <div className="flex flex-wrap gap-x-4 text-muted-foreground">
                    {broker.phone && <a className="inline-flex items-center gap-1 hover:text-foreground" href={`tel:${broker.phone}`}><Phone size={12} />{broker.phone}</a>}
                    {broker.email && <a className="inline-flex items-center gap-1 hover:text-foreground" href={`mailto:${broker.email}`}><Mail size={12} />{broker.email}</a>}
                  </div>
                </div>
              )}
              {deal.reasonForSale && <p className="text-sm text-muted-foreground">Reason for sale: {deal.reasonForSale}</p>}
            </section>

            <section className="space-y-2">
              <h3 className="text-sm font-semibold text-foreground">Key dates</h3>
              <dl className="grid grid-cols-2 sm:grid-cols-3 gap-x-4 gap-y-3">
                <Fact label="First contact" value={deal.firstContactDate ? fmtDate(deal.firstContactDate) : null} />
                <Fact label="LOI sent" value={deal.loiDate ? fmtDate(deal.loiDate) : null} />
                <Fact label="LOI expires" value={deal.loiExpiration ? fmtDate(deal.loiExpiration) : null} />
                <Fact label="Contract signed" value={deal.contractDate ? fmtDate(deal.contractDate) : null} />
                <Fact label="DD ends" value={deal.ddEndDate ? fmtDate(deal.ddEndDate) : null} />
                <Fact label="Closing" value={deal.closingDate ? fmtDate(deal.closingDate) : null} />
              </dl>
            </section>

            {(deal.keyRisks || deal.notes) && (
              <section className="space-y-2">
                {deal.keyRisks && <><h3 className="text-sm font-semibold text-foreground">Key risks</h3><p className="text-sm text-foreground whitespace-pre-line">{deal.keyRisks}</p></>}
                {deal.notes && <><h3 className="text-sm font-semibold text-foreground pt-2">Notes</h3><p className="text-sm text-foreground whitespace-pre-line">{deal.notes}</p></>}
              </section>
            )}

            {dealTasks.length > 0 && (
              <section className="space-y-2">
                <h3 className="text-sm font-semibold text-foreground">Tasks ({dealTasks.filter(t => t.status === "done").length} of {dealTasks.length} done)</h3>
                <ul className="space-y-1">
                  {dealTasks.map(t => (
                    <li key={t.id}>
                      <button onClick={() => toggleTask.mutate(t)} className="w-full flex items-start gap-2 text-left text-sm py-1 hover:bg-muted/50 rounded px-1">
                        {t.status === "done" ? <CheckCircle2 size={15} className="text-green-600 mt-0.5 shrink-0" /> : <Circle size={15} className="text-muted-foreground mt-0.5 shrink-0" />}
                        <span className={t.status === "done" ? "line-through text-muted-foreground" : "text-foreground"}>{t.title.replace(`${deal.name}: `, "")}</span>
                        {t.dueDate && <span className="ml-auto text-xs text-muted-foreground whitespace-nowrap">{fmtDate(t.dueDate)}</span>}
                      </button>
                    </li>
                  ))}
                </ul>
              </section>
            )}

            <section className="space-y-3">
              <h3 className="text-sm font-semibold text-foreground">Activity</h3>
              <form
                className="space-y-2 rounded-md border border-border p-3"
                onSubmit={e => { e.preventDefault(); if (summary.trim()) log.mutate(); }}
              >
                <div className="flex gap-2">
                  <Select value={kind} onValueChange={setKind}>
                    <SelectTrigger className="w-[130px] h-9" aria-label="Activity type"><SelectValue /></SelectTrigger>
                    <SelectContent>{ACTIVITY_KINDS.map(k => <SelectItem key={k} value={k}>{ACTIVITY_LABELS[k]}</SelectItem>)}</SelectContent>
                  </Select>
                  <Input type="date" value={date} onChange={e => setDate(e.target.value)} className="w-[150px] h-9" aria-label="Date" />
                </div>
                <Textarea rows={2} value={summary} onChange={e => setSummary(e.target.value)} placeholder="What happened? e.g. Called Jon, seller open to a subject-to-approvals structure" aria-label="Summary" />
                <div className="flex justify-end">
                  <Button size="sm" type="submit" disabled={!summary.trim() || log.isPending}>
                    {log.isPending && <Loader2 size={13} className="animate-spin mr-1" />} Log activity
                  </Button>
                </div>
              </form>
              <ol className="space-y-3">
                {activity.map(a => (
                  <li key={a.id} className="flex gap-3">
                    <div className="text-xs text-muted-foreground w-20 shrink-0 pt-0.5">{fmtDate(a.date)}</div>
                    <div className="text-sm">
                      <span className="font-medium text-foreground">{ACTIVITY_LABELS[a.kind] ?? a.kind}.</span>{" "}
                      <span className="text-foreground whitespace-pre-line">{a.summary}</span>
                    </div>
                  </li>
                ))}
              </ol>
            </section>
          </div>
        )}
      </SheetContent>
    </Sheet>
  );
}

// ── Add / edit form ─────────────────────────────────────────────────────────
type FormState = Record<string, string>;
const TEXT_FIELDS = ["name", "address", "municipality", "county", "state", "type", "stage", "source", "sellerName",
  "temperature", "competition", "sellerMotivation", "reasonForSale", "priceNotes", "zoning", "floodZone", "utilities",
  "keyRisks", "firstContactDate", "loiDate", "loiExpiration", "contractDate", "ddEndDate", "closingDate", "notes"] as const;
const MONEY_FIELDS = ["askingPrice", "offerPrice", "noi", "projectedValue"] as const;
const DECIMAL_FIELDS = ["capRate", "acres", "occupancy"] as const;
const INT_FIELDS = ["units", "sqft", "yearBuilt", "probabilityOverride"] as const;

function toForm(d: PipelineDeal | null): FormState {
  const f: FormState = {};
  for (const k of [...TEXT_FIELDS, ...MONEY_FIELDS, ...DECIMAL_FIELDS, ...INT_FIELDS]) {
    const v = d ? (d as any)[k] : null;
    f[k] = v == null ? "" : String(v);
  }
  if (!d) Object.assign(f, { type: "multifamily", stage: "lead", temperature: "warm", state: "PA", firstContactDate: today() });
  f.brokerContactId = d?.brokerContactId ? String(d.brokerContactId) : "none";
  f.groundLease = d?.groundLease ? "1" : "0";
  return f;
}
function num(v: string): number | null {
  const n = parseFloat(v.replace(/[$,\s%]/g, ""));
  return isFinite(n) ? n : null;
}

// Defined at module level so React keeps the same component between renders
// (a component defined inside another would remount its inputs on every keystroke).
function Group({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <fieldset className="space-y-3">
      <legend className="text-sm font-semibold text-foreground pb-1">{title}</legend>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">{children}</div>
    </fieldset>
  );
}

function DealFormDialog({ deal, contacts, onClose, onSaved }: {
  deal: PipelineDeal | null; contacts: Contact[]; onClose: () => void; onSaved: (d: PipelineDeal, isNew: boolean) => void;
}) {
  const { toast } = useToast();
  const [f, setF] = useState<FormState>(() => toForm(deal));
  const [scenarios, setScenarios] = useState<DevelopmentScenario[]>(() => parseScenarios(deal?.scenarios));
  const [newBroker, setNewBroker] = useState({ name: "", company: "", phone: "", email: "" });
  const [deadReason, setDeadReason] = useState(deal?.deadReason ?? "");
  const set = (k: string) => (v: string) => setF(prev => ({ ...prev, [k]: v }));
  const brokers = contacts.filter(c => c.role === "broker");

  const save = useMutation({
    mutationFn: async () => {
      let brokerContactId: number | null = f.brokerContactId === "none" ? null : Number(f.brokerContactId);
      if (f.brokerContactId === "new") {
        const res = await apiRequest("POST", "/api/contacts", {
          name: newBroker.name.trim(), company: newBroker.company.trim() || null, role: "broker",
          email: newBroker.email.trim() || null, phone: newBroker.phone.trim() || null, projectIds: null, notes: null,
        });
        brokerContactId = (await res.json()).id;
      }
      const payload: Record<string, unknown> = {};
      for (const k of TEXT_FIELDS) payload[k] = f[k].trim() || null;
      payload.address = f.address.trim();
      for (const k of MONEY_FIELDS) payload[k] = num(f[k]);
      for (const k of DECIMAL_FIELDS) payload[k] = num(f[k]);
      for (const k of INT_FIELDS) { const n = num(f[k]); payload[k] = n == null ? null : Math.round(n); }
      payload.temperature = f.temperature || "warm";
      payload.brokerContactId = brokerContactId;
      payload.groundLease = f.groundLease === "1" ? 1 : 0;
      const cleanScen = scenarios.filter(s => s.use.trim() || s.label.trim());
      payload.scenarios = cleanScen.length ? JSON.stringify(cleanScen) : null;
      payload.deadReason = f.stage === "dead" ? (deadReason.trim() || null) : null;
      const res = deal
        ? await apiRequest("PATCH", `/api/pipeline/${deal.id}`, payload)
        : await apiRequest("POST", "/api/pipeline", payload);
      return (await res.json()) as PipelineDeal;
    },
    onSuccess: saved => {
      toast({ title: deal ? "Deal saved" : `Deal added as ${saved.dealCode}` });
      onSaved(saved, !deal);
    },
    onError: (e: Error) => toast({ title: "Could not save deal", description: e.message.replace(/^\d+:\s*/, ""), variant: "destructive" }),
  });

  const canSave = f.name.trim() && (f.brokerContactId !== "new" || newBroker.name.trim()) && (f.stage !== "dead" || deadReason.trim());
  const stageDefault = STAGE_PROBABILITY[(f.stage || "lead") as Stage];

  const T = ({ k, label, placeholder, span }: { k: string; label: string; placeholder?: string; span?: boolean }) => (
    <div className={`space-y-1.5 ${span ? "sm:col-span-2" : ""}`}>
      <Label htmlFor={`f-${k}`}>{label}</Label>
      <Input id={`f-${k}`} value={f[k]} onChange={e => set(k)(e.target.value)} placeholder={placeholder} />
    </div>
  );
  const D = ({ k, label }: { k: string; label: string }) => (
    <div className="space-y-1.5">
      <Label htmlFor={`f-${k}`}>{label}</Label>
      <Input id={`f-${k}`} type="date" value={f[k]} onChange={e => set(k)(e.target.value)} />
    </div>
  );
  const S = ({ k, label, options, labels, allowNone }: { k: string; label: string; options: readonly string[]; labels?: Record<string, string>; allowNone?: boolean }) => (
    <div className="space-y-1.5">
      <Label>{label}</Label>
      <Select value={f[k] || "none"} onValueChange={v => set(k)(v === "none" ? "" : v)}>
        <SelectTrigger aria-label={label}><SelectValue /></SelectTrigger>
        <SelectContent>
          {allowNone && <SelectItem value="none">Not set</SelectItem>}
          {options.map(o => <SelectItem key={o} value={o} className={labels ? "" : "capitalize"}>{labels?.[o] ?? o}</SelectItem>)}
        </SelectContent>
      </Select>
    </div>
  );
  return (
    <Dialog open onOpenChange={o => { if (!o) onClose(); }}>
      <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{deal ? `Edit ${deal.name}` : "Add deal"}</DialogTitle>
          {deal && <DialogDescription>{deal.dealCode}</DialogDescription>}
        </DialogHeader>
        <form className="space-y-6" onSubmit={e => { e.preventDefault(); if (canSave) save.mutate(); }}>
          {/* Field helpers are called as functions (not <T />) so inputs keep focus while typing */}
          <Group title="Property">
            {T({ k: "name", label: "Deal name", placeholder: "e.g. 501 Washington Street", span: true })}
            {T({ k: "address", label: "Street address", span: true })}
            {T({ k: "municipality", label: "Municipality", placeholder: "e.g. Whitemarsh Township" })}
            {T({ k: "county", label: "County", placeholder: "e.g. Montgomery" })}
            {S({ k: "type", label: "Property type", options: DEAL_TYPES, labels: DEAL_TYPE_LABELS })}
            {T({ k: "state", label: "State" })}
            {T({ k: "acres", label: "Land (acres)" })}
            {T({ k: "sqft", label: "Building SF" })}
            {T({ k: "units", label: "Units" })}
            {T({ k: "yearBuilt", label: "Year built" })}
            {T({ k: "occupancy", label: "Occupancy (%)" })}
            {T({ k: "zoning", label: "Zoning", placeholder: "e.g. HVY Industrial, riverfront overlay" })}
            {T({ k: "floodZone", label: "Floodplain", placeholder: "e.g. 100-year floodplain; flooded in Ida" })}
            {T({ k: "utilities", label: "Utilities", placeholder: "e.g. Public water (Aqua), public sewer" })}
          </Group>

          <Group title="Stage and pricing">
            {S({ k: "stage", label: "Stage", options: STAGES, labels: STAGE_LABELS })}
            <div className="space-y-1.5">
              <Label htmlFor="f-probabilityOverride">Close probability (%)</Label>
              <Input id="f-probabilityOverride" value={f.probabilityOverride} onChange={e => set("probabilityOverride")(e.target.value)} placeholder={`${stageDefault} (stage default)`} />
            </div>
            {f.stage === "dead" && (
              <div className="space-y-1.5 sm:col-span-2">
                <Label htmlFor="f-dead">Why is it dead?</Label>
                <Input id="f-dead" value={deadReason} onChange={e => setDeadReason(e.target.value)} placeholder="e.g. Pricing: seller holding at $6M" />
              </div>
            )}
            {T({ k: "askingPrice", label: "Asking price ($)", placeholder: "Leave blank if unpriced" })}
            {T({ k: "offerPrice", label: "Our offer ($)" })}
            {T({ k: "priceNotes", label: "Pricing notes", placeholder: "e.g. Price determined by use and density", span: true })}
            {T({ k: "noi", label: "NOI ($/yr)" })}
            {T({ k: "capRate", label: "Cap rate (%)" })}
            {T({ k: "projectedValue", label: "Projected value ($)", placeholder: "Stabilized or exit value" })}
          </Group>

          <Group title="Source and context">
            {S({ k: "source", label: "Source", options: SOURCES, labels: SOURCE_LABELS, allowNone: true })}
            <div className="space-y-1.5">
              <Label>Broker</Label>
              <Select value={f.brokerContactId} onValueChange={set("brokerContactId")}>
                <SelectTrigger aria-label="Broker"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">No broker</SelectItem>
                  {brokers.map(b => <SelectItem key={b.id} value={String(b.id)}>{b.name}{b.company ? `, ${b.company}` : ""}</SelectItem>)}
                  <SelectItem value="new">Add a new broker…</SelectItem>
                </SelectContent>
              </Select>
            </div>
            {f.brokerContactId === "new" && (
              <div className="sm:col-span-2 grid grid-cols-1 sm:grid-cols-2 gap-3 rounded-md border border-dashed border-border p-3">
                <p className="sm:col-span-2 text-xs text-muted-foreground">Saved to Contacts as a broker.</p>
                {(["name", "company", "phone", "email"] as const).map(k => (
                  <div key={k} className="space-y-1.5">
                    <Label htmlFor={`nb-${k}`} className="capitalize">{k === "name" ? "Broker name" : k}</Label>
                    <Input id={`nb-${k}`} value={newBroker[k]} onChange={e => setNewBroker(p => ({ ...p, [k]: e.target.value }))} />
                  </div>
                ))}
              </div>
            )}
            {T({ k: "sellerName", label: "Seller" })}
            {S({ k: "temperature", label: "Temperature", options: TEMPERATURES })}
            {S({ k: "competition", label: "Competition", options: COMPETITION_LEVELS, allowNone: true })}
            {S({ k: "sellerMotivation", label: "Seller motivation", options: MOTIVATION_LEVELS, allowNone: true })}
            {T({ k: "reasonForSale", label: "Reason for sale", span: true })}
            <label className="flex items-center gap-2 text-sm sm:col-span-2">
              <Switch checked={f.groundLease === "1"} onCheckedChange={c => set("groundLease")(c ? "1" : "0")} /> Ground lease opportunity
            </label>
          </Group>

          <Group title="Key dates">
            {D({ k: "firstContactDate", label: "First contact" })}
            {D({ k: "loiDate", label: "LOI sent" })}
            {D({ k: "loiExpiration", label: "LOI expires" })}
            {D({ k: "contractDate", label: "Contract signed" })}
            {D({ k: "ddEndDate", label: "Due diligence ends" })}
            {D({ k: "closingDate", label: "Closing" })}
          </Group>

          <fieldset className="space-y-3">
            <legend className="text-sm font-semibold text-foreground pb-1">Development scenarios</legend>
            <p className="text-xs text-muted-foreground -mt-2">For land and redevelopment deals priced by use, list each option being considered.</p>
            {scenarios.map((sc, i) => (
              <div key={i} className="grid grid-cols-2 sm:grid-cols-12 gap-2 items-end rounded-md border border-border p-2">
                <div className="sm:col-span-2 space-y-1"><Label className="text-xs">Label</Label><Input value={sc.label} onChange={e => setScenarios(s => s.map((x, j) => j === i ? { ...x, label: e.target.value } : x))} /></div>
                <div className="sm:col-span-3 space-y-1"><Label className="text-xs">Use</Label><Input value={sc.use} onChange={e => setScenarios(s => s.map((x, j) => j === i ? { ...x, use: e.target.value } : x))} placeholder="e.g. Warehouse" /></div>
                <div className="sm:col-span-2 space-y-1"><Label className="text-xs">Building SF</Label><Input value={sc.buildingSf ?? ""} onChange={e => setScenarios(s => s.map((x, j) => j === i ? { ...x, buildingSf: num(e.target.value) } : x))} /></div>
                <div className="sm:col-span-1 space-y-1"><Label className="text-xs">Units</Label><Input value={sc.units ?? ""} onChange={e => setScenarios(s => s.map((x, j) => j === i ? { ...x, units: num(e.target.value) } : x))} /></div>
                <div className="col-span-2 sm:col-span-3 space-y-1"><Label className="text-xs">Notes</Label><Input value={sc.notes ?? ""} onChange={e => setScenarios(s => s.map((x, j) => j === i ? { ...x, notes: e.target.value } : x))} /></div>
                <Button type="button" variant="ghost" size="icon" className="sm:col-span-1 justify-self-end" onClick={() => setScenarios(s => s.filter((_, j) => j !== i))} aria-label="Remove scenario"><X size={14} /></Button>
              </div>
            ))}
            <Button type="button" variant="outline" size="sm" className="gap-1" onClick={() => setScenarios(s => [...s, { label: `Option ${s.length + 1}`, use: "" }])}><Plus size={13} /> Add scenario</Button>
          </fieldset>

          <fieldset className="space-y-3">
            <legend className="text-sm font-semibold text-foreground pb-1">Risks and notes</legend>
            <div className="space-y-1.5"><Label htmlFor="f-keyRisks">Key risks</Label><Textarea id="f-keyRisks" rows={3} value={f.keyRisks} onChange={e => set("keyRisks")(e.target.value)} /></div>
            <div className="space-y-1.5"><Label htmlFor="f-notes">Notes</Label><Textarea id="f-notes" rows={3} value={f.notes} onChange={e => set("notes")(e.target.value)} /></div>
          </fieldset>

          <div className="flex justify-end gap-2 pt-2 sticky bottom-0 bg-background py-2">
            <Button type="button" variant="outline" onClick={onClose}>Cancel</Button>
            <Button type="submit" disabled={!canSave || save.isPending} data-testid="button-save-deal">
              {save.isPending && <Loader2 className="animate-spin mr-1" size={14} />}
              {deal ? "Save deal" : "Add deal"}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
