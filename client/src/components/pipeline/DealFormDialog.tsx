import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import type { PipelineDeal, Contact } from "@shared/schema";
import { STAGES, STAGE_LABELS, DEAL_TYPES, DEAL_TYPE_LABELS, SOURCES, SOURCE_LABELS, TEMPERATURES, COMPETITION_LEVELS, MOTIVATION_LEVELS, STAGE_PROBABILITY, parseScenarios, type Stage, type DevelopmentScenario } from "@shared/pipeline";
import { Plus, Loader2, X, Sparkles, Check } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import { Checkbox } from "@/components/ui/checkbox";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { useToast } from "@/hooks/use-toast";
import { today, type Intake } from "./shared";

// ── Add / edit form ─────────────────────────────────────────────────────────
type FormState = Record<string, string>;
const TEXT_FIELDS = ["name", "address", "municipality", "county", "state", "type", "stage", "source", "sellerName",
  "temperature", "competition", "sellerMotivation", "reasonForSale", "priceNotes", "zoning", "floodZone", "utilities",
  "keyRisks", "firstContactDate", "loiDate", "loiExpiration", "contractDate", "ddEndDate", "closingDate", "notes"] as const;
const MONEY_FIELDS = ["askingPrice", "offerPrice", "noi", "projectedValue"] as const;
const DECIMAL_FIELDS = ["capRate", "acres", "occupancy"] as const;
const INT_FIELDS = ["units", "sqft", "yearBuilt", "probabilityOverride"] as const;

// The server maps Claude's reading to deal fields (dealFromOm); the form only turns them into text.
function fromIntake(intake: Intake): FormState {
  const f = toForm(intake.deal as PipelineDeal);
  if (!intake.deal.brokerContactId && intake.analysis.broker?.name) f.brokerContactId = "new";
  return f;
}

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

export function DealFormDialog({ deal, intake, contacts, onClose, onSaved }: {
  deal: PipelineDeal | null; intake: Intake | null; contacts: Contact[]; onClose: () => void; onSaved: (d: PipelineDeal, isNew: boolean) => void;
}) {
  const { toast } = useToast();
  const a = intake?.analysis;
  const [f, setF] = useState<FormState>(() => intake ? fromIntake(intake) : toForm(deal));
  const [scenarios, setScenarios] = useState<DevelopmentScenario[]>(() => parseScenarios(intake ? intake.deal.scenarios : deal?.scenarios));
  const [newBroker, setNewBroker] = useState({
    name: a?.broker?.name ?? "", company: a?.broker?.company ?? "", phone: a?.broker?.phone ?? "", email: a?.broker?.email ?? "",
  });
  const [createUw, setCreateUw] = useState(!!intake?.hasIncome);
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
      const saved = (await res.json()) as PipelineDeal;

      if (!deal && intake) {
        // Attach the OM, keep Claude's screening, and optionally start an underwriting model (same steps as the Box import).
        await apiRequest("POST", `/api/pipeline/${saved.id}/intake`, { fileId: intake.fileId, createUnderwriting: createUw });
      }
      return saved;
    },
    onSuccess: saved => {
      toast({
        title: deal ? "Deal saved" : `Deal added as ${saved.dealCode}`,
        description: intake ? `Screening notes saved to the activity log${createUw ? "; underwriting model created" : ""}.` : undefined,
      });
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
          <DialogTitle>{deal ? `Edit ${deal.name}` : intake ? "Review deal from OM" : "Add deal"}</DialogTitle>
          {deal && <DialogDescription>{deal.dealCode}</DialogDescription>}
          {intake && <DialogDescription>Claude filled this in from {intake.fileName}. Check the figures against the OM before saving.</DialogDescription>}
        </DialogHeader>
        {intake && a && (
          <section className="rounded-md border border-border bg-muted/40 p-4 space-y-3 text-sm" aria-label="Screening">
            <h3 className="font-semibold text-foreground flex items-center gap-1.5"><Sparkles size={14} className="text-primary" /> Screening</h3>
            <p className="text-foreground">{a.summary}</p>
            {[["Key risks", a.keyRisks], ["Math check", intake.mathCheck], ["Missing from the package", a.missingInfo], ["Questions for the broker", a.brokerQuestions]]
              .filter(([, items]) => (items as string[]).length > 0)
              .map(([title, items]) => (
                <div key={title as string}>
                  <h4 className="font-medium text-foreground">{title as string}</h4>
                  <ul className="list-disc pl-5 text-muted-foreground space-y-0.5">{(items as string[]).map((t, i) => <li key={i}>{t}</li>)}</ul>
                </div>
              ))}
            <p className="text-xs text-muted-foreground">These notes are saved to the deal's activity log.</p>
            <label className="flex items-center gap-2 text-sm text-foreground">
              <Checkbox checked={createUw} onCheckedChange={c => setCreateUw(c === true)} />
              Also create an underwriting model from the OM's numbers
            </label>
          </section>
        )}
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
              {deal ? "Save deal" : intake ? "Save deal and notes" : "Add deal"}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
