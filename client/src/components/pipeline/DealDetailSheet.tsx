import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import type { PipelineDeal, Contact, DealActivity, Task, DealMilestone } from "@shared/schema";
import { STAGES, STAGE_LABELS, DEAL_TYPE_LABELS, SOURCE_LABELS, ACTIVITY_KINDS, ACTIVITY_LABELS, effectiveProbability, daysSince, parseScenarios, type Stage, nextDeadlineWithMilestones } from "@shared/pipeline";
import { Pencil, Trash2, Loader2, Phone, Mail, CheckCircle2, Circle, Check, FileText, Inbox } from "lucide-react";
import { LoiDialog } from "@/components/LoiDialog";
import { DealUnderwriting } from "@/components/ModelWorkspace";
import type { BoxFile } from "@shared/schema";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription } from "@/components/ui/sheet";
import { useToast } from "@/hooks/use-toast";
import { AskDeal } from "./AskDeal";
import { DealFiles } from "./DealFiles";
import { DealMilestones } from "./DealMilestones";
import { DealProject } from "./DealProject";
import { fmtMoney, fmtDate, today, TempBadge, DeadlineChip, Fact } from "./shared";
import { UnderwritingSummary } from "./UnderwritingLinks";

// ── Detail sheet ────────────────────────────────────────────────────────────
export type DealTab = "overview" | "underwriting" | "files" | "activity";

export function DealDetailSheet({ deal, broker, onClose, onEdit, onDelete, onStage, stagePending, tab, onTab }: {
  deal: PipelineDeal | null; broker?: Contact; onClose: () => void; tab: DealTab; onTab: (t: DealTab) => void;
  onEdit: (d: PipelineDeal) => void; onDelete: (d: PipelineDeal) => void;
  onStage: (d: PipelineDeal, stage: string) => void; stagePending: boolean;
}) {
  const { toast } = useToast();
  const qc = useQueryClient();
  const [kind, setKind] = useState<string>("call");
  const [date, setDate] = useState(today());
  const [summary, setSummary] = useState("");
  const [loiOpen, setLoiOpen] = useState(false);

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

  const { data: boxFiles = [] } = useQuery<BoxFile[]>({ queryKey: ["/api/box/files"], enabled: !!deal?.needsReview });
  const boxFile = deal ? boxFiles.find(f => f.dealId === deal.id) : undefined;
  const markReviewed = useMutation({
    mutationFn: () => apiRequest("POST", `/api/pipeline/${deal!.id}/reviewed`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["/api/pipeline"] });
      qc.invalidateQueries({ queryKey: ["/api/pipeline", deal!.id, "activity"] });
      qc.invalidateQueries({ queryKey: ["/api/box/status"] });
      toast({ title: "Marked reviewed" });
    },
    onError: (e: Error) => toast({ title: "Could not mark reviewed", description: e.message.replace(/^\d+:\s*/, ""), variant: "destructive" }),
  });

  const scenarios = deal ? parseScenarios(deal.scenarios) : [];
  const { data: dealMs = [] } = useQuery<DealMilestone[]>({ queryKey: ["/api/milestones"], enabled: !!deal });
  const dl = deal ? nextDeadlineWithMilestones(deal, dealMs) : null;

  return (
    <Sheet open={!!deal} onOpenChange={o => { if (!o) onClose(); }}>
      <SheetContent className="w-full sm:max-w-5xl overflow-y-auto">
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
                <Button size="sm" variant="outline" className="gap-1" onClick={() => setLoiOpen(true)}><FileText size={13} /> Draft LOI</Button>
                <Button size="sm" variant="outline" className="gap-1" onClick={() => onEdit(deal)}><Pencil size={13} /> Edit</Button>
                <Button size="sm" variant="ghost" className="text-muted-foreground hover:text-destructive" onClick={() => onDelete(deal)} aria-label="Delete deal"><Trash2 size={14} /></Button>
              </div>
            </div>

            {deal.needsReview ? (
              <div role="status" className="flex flex-wrap items-center gap-3 rounded-md border border-amber-300 dark:border-amber-800 bg-amber-50 dark:bg-amber-900/20 px-3 py-2 text-sm text-amber-900 dark:text-amber-200">
                <Inbox size={15} className="shrink-0" />
                <span className="flex-1 min-w-[200px]">
                  {boxFile ? <>Created from Box file <span className="font-medium">{boxFile.name}</span>; check the figures against the OM.</> : "Created automatically from an OM; check the figures against the OM."}
                </span>
                <Button size="sm" variant="outline" className="gap-1 bg-background" disabled={markReviewed.isPending} onClick={() => markReviewed.mutate()}>
                  {markReviewed.isPending ? <Loader2 size={13} className="animate-spin" /> : <Check size={13} />} Mark reviewed
                </Button>
              </div>
            ) : null}
            {deal.stage === "dead" && deal.deadReason && (
              <p className="text-sm rounded-md bg-red-50 dark:bg-red-900/20 text-red-800 dark:text-red-300 px-3 py-2">Dead: {deal.deadReason}</p>
            )}
            {dl && <DeadlineChip dl={dl} />}

            <Tabs value={tab} onValueChange={v => onTab(v as DealTab)} className="space-y-5">
              <TabsList>
                <TabsTrigger value="overview">Overview</TabsTrigger>
                <TabsTrigger value="underwriting">Underwriting</TabsTrigger>
                <TabsTrigger value="files">Files</TabsTrigger>
                <TabsTrigger value="activity">Activity</TabsTrigger>
              </TabsList>

              <TabsContent value="overview" className="space-y-6 mt-0">
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

                {[deal.acres, deal.sqft, deal.units, deal.yearBuilt, deal.occupancy, deal.county, deal.zoning, deal.floodZone, deal.groundLease || null, deal.utilities].some(v => v != null && v !== "") && <section className="space-y-2">
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
                </section>}

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

                {[deal.firstContactDate, deal.loiDate, deal.loiExpiration, deal.contractDate, deal.ddEndDate, deal.closingDate].some(Boolean) && <section className="space-y-2">
                  <h3 className="text-sm font-semibold text-foreground">Key dates</h3>
                  <dl className="grid grid-cols-2 sm:grid-cols-3 gap-x-4 gap-y-3">
                    <Fact label="First contact" value={deal.firstContactDate ? fmtDate(deal.firstContactDate) : null} />
                    <Fact label="LOI sent" value={deal.loiDate ? fmtDate(deal.loiDate) : null} />
                    <Fact label="LOI expires" value={deal.loiExpiration ? fmtDate(deal.loiExpiration) : null} />
                    <Fact label="Contract signed" value={deal.contractDate ? fmtDate(deal.contractDate) : null} />
                    <Fact label="DD ends" value={deal.ddEndDate ? fmtDate(deal.ddEndDate) : null} />
                    <Fact label="Closing" value={deal.closingDate ? fmtDate(deal.closingDate) : null} />
                  </dl>
                </section>}

                <UnderwritingSummary deal={deal} onOpen={() => onTab("underwriting")} />

                <DealProject deal={deal} />

                <DealMilestones deal={deal} />

                {(deal.keyRisks || deal.notes) && (
                  <section className="space-y-2">
                    {deal.keyRisks && <><h3 className="text-sm font-semibold text-foreground">Key risks</h3><p className="text-sm text-foreground whitespace-pre-line">{deal.keyRisks}</p></>}
                    {deal.notes && <><h3 className="text-sm font-semibold text-foreground pt-2">Notes</h3><p className="text-sm text-foreground whitespace-pre-line">{deal.notes}</p></>}
                  </section>
                )}

              </TabsContent>

              <TabsContent value="underwriting" className="mt-0">
                <DealUnderwriting deal={deal} />
              </TabsContent>

              <TabsContent value="files" className="space-y-6 mt-0">
                <DealFiles deal={deal} />

                <AskDeal key={deal.id} deal={deal} />
              </TabsContent>

              <TabsContent value="activity" className="space-y-6 mt-0">
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
              </TabsContent>
            </Tabs>

            <LoiDialog deal={deal} open={loiOpen} onClose={() => setLoiOpen(false)} />
          </div>
        )}
      </SheetContent>
    </Sheet>
  );
}
