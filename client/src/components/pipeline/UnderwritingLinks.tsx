import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import type { PipelineDeal, UnderwritingDeal } from "@shared/schema";
import { buildProforma, calcReturns, maxPriceForIrr } from "@shared/underwriting";
import { Trash2, Calculator } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";
import { useConfirm } from "@/components/ConfirmDialog";
import { fmtMoney, Fact } from "./shared";

// ── Linked underwriting ─────────────────────────────────────────────────────
// Models made on the old Underwriting page without a deal. Underwriting lives in deals now,
// so offer to attach each one to a deal (or delete it). Nothing changes until the user clicks.
export function UnlinkedModels({ deals, onOpen }: { deals: PipelineDeal[]; onOpen: (dealId: number) => void }) {
  const { toast } = useToast();
  const qc = useQueryClient();
  const confirm = useConfirm();
  const { data: models = [] } = useQuery<UnderwritingDeal[]>({ queryKey: ["/api/underwriting"] });
  const loose = models.filter(m => !m.dealId);
  const [pick, setPick] = useState<Record<number, string>>({});
  const link = useMutation({
    mutationFn: ({ id, dealId }: { id: number; dealId: number }) => apiRequest("PATCH", `/api/underwriting/${id}`, { dealId }),
    onSuccess: (_r, v) => { qc.invalidateQueries({ queryKey: ["/api/underwriting"] }); toast({ title: "Model attached to the deal" }); onOpen(v.dealId); },
    onError: (e: Error) => toast({ title: "Could not attach", description: e.message.replace(/^\d+:\s*/, ""), variant: "destructive" }),
  });
  const remove = useMutation({
    mutationFn: (id: number) => apiRequest("DELETE", `/api/underwriting/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["/api/underwriting"] }),
  });
  if (!loose.length) return null;
  const choices = [...deals].sort((a, b) => a.name.localeCompare(b.name));
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm font-semibold flex items-center gap-2">
          <Calculator size={15} className="text-muted-foreground" /> {loose.length === 1 ? "1 underwriting model isn't" : `${loose.length} underwriting models aren't`} attached to a deal
        </CardTitle>
      </CardHeader>
      <CardContent className="pt-0 space-y-2">
        <p className="text-xs text-muted-foreground">Underwriting now lives in each deal. Attach these to a deal to keep working on them.</p>
        <ul className="divide-y divide-border rounded-md border border-border">
          {loose.map(m => (
            <li key={m.id} className="flex flex-wrap items-center gap-2 px-3 py-2">
              <span className="text-sm text-foreground flex-1 min-w-[160px] truncate">{m.name}</span>
              <Select value={pick[m.id] ?? ""} onValueChange={v => setPick(p => ({ ...p, [m.id]: v }))}>
                <SelectTrigger className="h-8 w-[220px] text-xs" aria-label={`Deal for ${m.name}`}><SelectValue placeholder="Choose a deal" /></SelectTrigger>
                <SelectContent>{choices.map(d => <SelectItem key={d.id} value={String(d.id)}>{d.dealCode} {d.name}</SelectItem>)}</SelectContent>
              </Select>
              <Button size="sm" variant="outline" className="h-8" disabled={!pick[m.id] || link.isPending}
                onClick={() => link.mutate({ id: m.id, dealId: Number(pick[m.id]) })}>Attach</Button>
              <button aria-label={`Delete ${m.name}`} className="p-1 text-muted-foreground hover:text-destructive"
                onClick={async () => { if (await confirm({ title: `Delete ${m.name}?`, description: "This underwriting model isn't attached to any deal.", confirmLabel: "Delete model" })) remove.mutate(m.id); }}>
                <Trash2 size={14} />
              </button>
            </li>
          ))}
        </ul>
        {!deals.length && <p className="text-xs text-muted-foreground">Add the deal first (Add deal or Upload OM), then attach the model to it.</p>}
      </CardContent>
    </Card>
  );
}

// Compact view on the Overview tab; the full model is on the deal's Underwriting tab.
export function UnderwritingSummary({ deal, onOpen }: { deal: PipelineDeal; onOpen: () => void }) {
  const { data: models = [] } = useQuery<UnderwritingDeal[]>({ queryKey: ["/api/underwriting"] });
  const linked = models.filter(m => m.dealId === deal.id);

  return (
    <section className="space-y-2">
      <h3 className="text-sm font-semibold text-foreground">Underwriting</h3>
      {linked.length === 0 ? (
        <div className="rounded-md border border-dashed border-border p-3 flex flex-wrap items-center justify-between gap-2">
          <p className="text-sm text-muted-foreground">Not underwritten yet.</p>
          <Button size="sm" variant="outline" className="gap-1" onClick={onOpen}>
            <Calculator size={13} /> Start underwriting
          </Button>
        </div>
      ) : linked.map(m => {
        const hasIncome = m.grossPotentialRent > 0 && m.purchasePrice > 0;
        const r = hasIncome ? calcReturns(m, buildProforma(m)) : null;
        return (
          <div key={m.id} className="rounded-md border border-border p-3 space-y-2">
            <div className="flex items-center justify-between gap-2">
              <span className="text-sm font-medium text-foreground">{m.name}</span>
              <Button size="sm" variant="ghost" className="gap-1 h-7" onClick={onOpen}><Calculator size={13} /> Open</Button>
            </div>
            <dl className="grid grid-cols-3 gap-x-4 gap-y-2">
              <Fact label="Purchase price" value={m.purchasePrice ? fmtMoney(m.purchasePrice) : "Not set"} />
              {r && <>
                <Fact label="Levered IRR" value={`${r.irr.toFixed(1)}%`} />
                <Fact label="Equity multiple" value={`${r.equityMultiple.toFixed(2)}x`} />
                <Fact label="Yr 1 yield on cost" value={`${r.yr1CapRate.toFixed(2)}%`} />
                <Fact label="Yr 1 cash-on-cash" value={`${r.yr1CoC.toFixed(1)}%`} />
                <Fact label="Yr 1 DSCR" value={m.loanAmount > 0 ? `${r.yr1Dscr.toFixed(2)}x` : "No loan"} />
                <Fact label="Max price for 15% IRR" value={(() => { const p = maxPriceForIrr(m, 15); return p ? fmtMoney(p) : "Not reachable"; })()} />
              </>}
            </dl>
            {!r && <p className="text-xs text-muted-foreground">Add rents, expenses and financing in the model to see returns.</p>}
            <p className="text-xs text-muted-foreground">Purchase price updates automatically when this deal's offer changes.</p>
          </div>
        );
      })}
    </section>
  );
}
