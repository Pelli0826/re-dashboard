import { useMemo, useRef, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import type { PipelineDeal, Contact, DealMilestone } from "@shared/schema";
import { ACTIVE_STAGES, STAGE_LABELS, DEAL_TYPES, DEAL_TYPE_LABELS, TEMPERATURES, effectiveProbability, daysSince, dealAlerts, type Stage, milestoneAlerts, nextDeadlineWithMilestones } from "@shared/pipeline";
import { Plus, Loader2, Search, AlertTriangle, FileUp } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { useToast } from "@/hooks/use-toast";
import { useConfirm, plural } from "@/components/ConfirmDialog";
import { DeadReasonDialog } from "@/components/pipeline/DeadReasonDialog";
import { DealFormDialog } from "@/components/pipeline/DealFormDialog";
import { OPEN_DEAL_KEY } from "@/components/pipeline/DealProject";
import { fmtMoney, sizeLine, priceLabel, dealValue, stageAccent, stagePill, tempDot, TempBadge, ReviewBadge, DeadlineChip, type Intake } from "@/components/pipeline/shared";
import { DealDetailSheet, type DealTab } from "@/components/pipeline/DealDetailSheet";
import { UnlinkedModels } from "@/components/pipeline/UnderwritingLinks";
export { OPEN_DEAL_KEY } from "@/components/pipeline/DealProject";

// ── Page ────────────────────────────────────────────────────────────────────
export default function Pipeline() {
  const { toast } = useToast();
  const qc = useQueryClient();
  const [search, setSearch] = useState("");
  const [typeFilter, setTypeFilter] = useState("all");
  const [tempFilter, setTempFilter] = useState("all");
  const [showInactive, setShowInactive] = useState(false);
  const [reviewOnly, setReviewOnly] = useState(false);
  const [formDeal, setFormDeal] = useState<PipelineDeal | "new" | null>(null);
  // Opened from another tab (e.g. a project's "Open deal" button).
  const [detailId, setDetailId] = useState<number | null>(() => {
    try {
      const id = Number(sessionStorage.getItem(OPEN_DEAL_KEY));
      sessionStorage.removeItem(OPEN_DEAL_KEY);
      return id || null;
    } catch { return null; }
  });
  const [detailTab, setDetailTab] = useState<DealTab>("overview");
  // Open a deal on a given tab (new deals open on Underwriting: it's the first step).
  const openDeal = (id: number | null, tab: DealTab = "overview") => { setDetailTab(tab); setDetailId(id); };
  const [deadTarget, setDeadTarget] = useState<PipelineDeal | null>(null);
  const [intake, setIntake] = useState<Intake | null>(null);
  const [reading, setReading] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const { data: system } = useQuery<{ omIntake?: boolean }>({ queryKey: ["/api/system"] });

  async function uploadOm(file: File) {
    setReading(file.name);
    try {
      const body = new FormData();
      body.append("file", file);
      const res = await fetch("/api/intake/om", { method: "POST", body });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.message ?? `Upload failed (${res.status})`);
      setIntake({ ...data, fileName: file.name });
      setFormDeal("new");
    } catch (e: any) {
      toast({ title: "Could not read the OM", description: e.message, variant: "destructive" });
    } finally {
      setReading(null);
      if (fileInput.current) fileInput.current.value = "";
    }
  }

  const { data: deals = [], isLoading } = useQuery<PipelineDeal[]>({ queryKey: ["/api/pipeline"] });
  const { data: contacts = [] } = useQuery<Contact[]>({ queryKey: ["/api/contacts"] });
  const { data: milestones = [] } = useQuery<DealMilestone[]>({ queryKey: ["/api/milestones"] });
  const contactMap = useMemo(() => Object.fromEntries(contacts.map(c => [c.id, c])), [contacts]);

  const refresh = (id?: number) => {
    qc.invalidateQueries({ queryKey: ["/api/pipeline"] });
    qc.invalidateQueries({ queryKey: ["/api/tasks"] });
    qc.invalidateQueries({ queryKey: ["/api/projects"] }); // stage moves create or update the deal's project
    if (id) qc.invalidateQueries({ queryKey: ["/api/pipeline", id, "activity"] });
  };

  const moveStage = useMutation({
    mutationFn: ({ id, stage, deadReason }: { id: number; stage: string; deadReason?: string }) =>
      apiRequest("PATCH", `/api/pipeline/${id}`, { stage, ...(deadReason ? { deadReason } : {}) }),
    onSuccess: (_r, v) => {
      refresh(v.id);
      toast({
        title: `Moved to ${STAGE_LABELS[v.stage as Stage]}`,
        description: v.stage === "due-diligence" ? "Due diligence checklist added to Tasks; project set up on the Projects tab." : undefined,
      });
    },
    onError: (e: Error) => toast({ title: "Could not change stage", description: e.message, variant: "destructive" }),
  });

  function requestStage(deal: PipelineDeal, stage: string) {
    if (stage === deal.stage) return;
    if (stage === "dead") { setDeadTarget(deal); return; }
    moveStage.mutate({ id: deal.id, stage });
  }

  const confirm = useConfirm();
  const remove = useMutation({
    mutationFn: (id: number) => apiRequest("DELETE", `/api/pipeline/${id}`),
    onSuccess: () => {
      qc.invalidateQueries(); // tasks and underwriting on other tabs were deleted too
      setDetailId(null);
      toast({ title: "Deal deleted" });
    },
  });
  async function confirmDelete(d: PipelineDeal) {
    let c: Record<string, number> = {};
    try { c = await (await apiRequest("GET", `/api/pipeline/${d.id}/related`)).json(); } catch { /* show without counts */ }
    const ok = await confirm({
      title: `Delete ${d.name}?`,
      description: d.stage === "dead" || d.stage === "closed" ? undefined
        : "To keep the history, you can mark it Dead instead: it moves off the board but stays searchable.",
      alsoDeletes: [
        plural(c.tasks ?? 0, "task"),
        plural(c.underwriting ?? 0, "underwriting model"),
        plural(c.activity ?? 0, "activity log entry", "activity log entries"),
        plural(c.files ?? 0, "saved file"),
        plural(c.milestones ?? 0, "milestone"),
      ].filter((x): x is string => !!x),
      keeps: c.projects ? ["its project on the Projects tab (unlinked, not deleted)"] : [],
      confirmLabel: "Delete deal",
    });
    if (ok) remove.mutate(d.id);
  }

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return deals.filter(d => {
      if (typeFilter !== "all" && d.type !== typeFilter) return false;
      if (tempFilter !== "all" && d.temperature !== tempFilter) return false;
      if (reviewOnly && !d.needsReview) return false;
      if (!q) return true;
      const broker = d.brokerContactId ? contactMap[d.brokerContactId] : undefined;
      return [d.name, d.address, d.municipality, d.county, d.dealCode, d.sellerName, broker?.name, broker?.company, d.notes]
        .some(v => v?.toLowerCase().includes(q));
    });
  }, [deals, search, typeFilter, tempFilter, reviewOnly, contactMap]);
  const reviewCount = deals.filter(d => d.needsReview).length;

  const active = filtered.filter(d => ACTIVE_STAGES.includes(d.stage as Stage));
  const inactive = filtered.filter(d => !ACTIVE_STAGES.includes(d.stage as Stage));
  const alerts = useMemo(() => [...dealAlerts(deals), ...milestoneAlerts(milestones, deals)]
    .sort((a, b) => (a.severity === b.severity ? 0 : a.severity === "high" ? -1 : 1)), [deals, milestones]);

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
        <div className="flex gap-2">
          <input ref={fileInput} type="file" accept="application/pdf,.pdf" className="hidden" onChange={e => { const f = e.target.files?.[0]; if (f) uploadOm(f); }} />
          <Button
            size="sm" variant="outline" className="gap-1.5" data-testid="button-upload-om"
            onClick={() => system?.omIntake
              ? fileInput.current?.click()
              : toast({ title: "OM upload is not turned on", description: "Add an ANTHROPIC_API_KEY variable to the service in Railway." })}
          >
            <FileUp size={14} /> Upload OM
          </Button>
          <Button data-testid="button-add-deal" onClick={() => { setIntake(null); setFormDeal("new"); }} size="sm" className="gap-1.5">
            <Plus size={14} /> Add deal
          </Button>
        </div>
      </div>

      <Dialog open={!!reading}>
        <DialogContent className="max-w-sm [&>button]:hidden" onInteractOutside={e => e.preventDefault()}>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2"><Loader2 size={16} className="animate-spin" /> Reading the OM</DialogTitle>
            <DialogDescription>Claude is reading {reading}, including tables and site plans. This usually takes 30 to 90 seconds.</DialogDescription>
          </DialogHeader>
        </DialogContent>
      </Dialog>

      <UnlinkedModels deals={deals} onOpen={id => openDeal(id, "underwriting")} />

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
                  <button onClick={() => openDeal(a.deal.id)} className="w-full flex items-center gap-3 py-2 text-left hover:bg-muted/50 rounded px-1">
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
        {(reviewCount > 0 || reviewOnly) && (
          <label className="flex items-center gap-2 text-sm text-muted-foreground ml-1">
            <Switch checked={reviewOnly} onCheckedChange={setReviewOnly} aria-label="Show only deals that need review" />
            Needs review only ({reviewCount})
          </label>
        )}
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
                    const dl = nextDeadlineWithMilestones(d, milestones);
                    const inStage = daysSince(d.stageChangedAt) ?? 0;
                    return (
                      <button
                        key={d.id}
                        onClick={() => openDeal(d.id)}
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
                          {d.needsReview ? <ReviewBadge /> : null}
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
                    const dl = nextDeadlineWithMilestones(d, milestones);
                    return (
                      <tr key={d.id} className="hover:bg-muted/40 cursor-pointer" onClick={() => openDeal(d.id)}>
                        <td className="px-4 py-2.5 min-w-[220px]">
                          <div className="font-medium text-foreground leading-snug flex flex-wrap items-center gap-1.5">{d.name}{d.needsReview ? <ReviewBadge /> : null}</div>
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
          intake={formDeal === "new" ? intake : null}
          contacts={contacts}
          onClose={() => { setFormDeal(null); setIntake(null); }}
          onSaved={(saved, isNew) => {
            refresh(saved.id);
            qc.invalidateQueries({ queryKey: ["/api/contacts"] });
            qc.invalidateQueries({ queryKey: ["/api/underwriting"] });
            setFormDeal(null);
            setIntake(null);
            if (isNew) openDeal(saved.id, "underwriting");
          }}
        />
      )}

      <DealDetailSheet
        deal={detailDeal}
        broker={detailDeal?.brokerContactId ? contactMap[detailDeal.brokerContactId] : undefined}
        onClose={() => setDetailId(null)}
        onEdit={d => setFormDeal(d)}
        onDelete={confirmDelete}
        onStage={requestStage}
        stagePending={moveStage.isPending}
        tab={detailTab}
        onTab={setDetailTab}
      />

      <DeadReasonDialog
        deal={deadTarget}
        onClose={() => setDeadTarget(null)}
        onConfirm={reason => { if (deadTarget) moveStage.mutate({ id: deadTarget.id, stage: "dead", deadReason: reason }); setDeadTarget(null); }}
      />
    </div>
  );
}
