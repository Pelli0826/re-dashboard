// Owned, operating properties: one card each with results at a glance; click for the workspace.
import { useMemo, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import type { Property, PropertyMonth } from "@shared/schema";
import { PROPERTY_TYPE_LABELS, summarize, variancePct, monthLabel } from "@shared/properties";
import { Plus, Loader2, Building, AlertTriangle } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { useToast } from "@/hooks/use-toast";
import { useConfirm, plural } from "@/components/ConfirmDialog";
import { fmtMoney } from "@/components/pipeline/shared";
import { PropertyFormDialog } from "@/components/property/PropertyFormDialog";
import { PropertySheet, type PropertyTab } from "@/components/property/PropertySheet";

// Set by "Move to Properties" on the Projects page so the new property opens here.
export const OPEN_PROPERTY_KEY = "openPropertyId";

export default function Properties() {
  const { toast } = useToast();
  const qc = useQueryClient();
  const confirm = useConfirm();
  const { data: properties = [], isLoading } = useQuery<Property[]>({ queryKey: ["/api/properties"] });
  const { data: allMonths = [] } = useQuery<PropertyMonth[]>({ queryKey: ["/api/property-months"] });
  const [openId, setOpenId] = useState<number | null>(() => {
    try { const id = Number(sessionStorage.getItem(OPEN_PROPERTY_KEY)); sessionStorage.removeItem(OPEN_PROPERTY_KEY); return id || null; } catch { return null; }
  });
  const [tab, setTab] = useState<PropertyTab>("overview");
  const [form, setForm] = useState<Property | "new" | null>(null);
  const [showSold, setShowSold] = useState(false);

  const summaries = useMemo(() => new Map(properties.map(p => [p.id, summarize(allMonths.filter(m => m.propertyId === p.id))])), [properties, allMonths]);
  const shown = properties.filter(p => showSold || p.status !== "sold").sort((a, b) => a.name.localeCompare(b.name));
  const open = properties.find(p => p.id === openId) ?? null;
  const portfolioT12 = shown.reduce((a, p) => a + (summaries.get(p.id)?.t12Noi ?? 0), 0);

  const remove = useMutation({
    mutationFn: (id: number) => apiRequest("DELETE", `/api/properties/${id}`),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["/api/properties"] }); qc.invalidateQueries({ queryKey: ["/api/property-months"] }); setOpenId(null); toast({ title: "Property deleted" }); },
  });
  async function confirmDelete(p: Property) {
    let c: Record<string, number> = {};
    try { c = await (await apiRequest("GET", `/api/properties/${p.id}/related`)).json(); } catch { /* show without counts */ }
    const ok = await confirm({
      title: `Delete ${p.name}?`,
      description: p.status === "sold" ? undefined : "To keep its history, you can mark it Sold instead (Edit → Status).",
      alsoDeletes: [plural(c.months ?? 0, "month of figures", "months of figures"), plural(c.files ?? 0, "saved file")].filter((x): x is string => !!x),
      keeps: p.dealId || p.projectId ? ["its original deal and project"] : [],
      confirmLabel: "Delete property",
    });
    if (ok) remove.mutate(p.id);
  }

  if (isLoading) return <div className="flex items-center gap-2 text-muted-foreground"><Loader2 className="animate-spin" size={16} /> Loading…</div>;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-lg font-bold text-foreground">Properties</h1>
          <p className="text-sm text-muted-foreground">
            {shown.length} {showSold ? "" : "owned "}propert{shown.length === 1 ? "y" : "ies"}{portfolioT12 ? `, ${fmtMoney(portfolioT12)} T12 NOI` : ""}
          </p>
        </div>
        <div className="flex items-center gap-3">
          <label className="flex items-center gap-2 text-sm text-muted-foreground"><Switch checked={showSold} onCheckedChange={setShowSold} aria-label="Show sold properties" /> Show sold</label>
          <Button size="sm" className="gap-1.5" onClick={() => setForm("new")}><Plus size={14} /> Add property</Button>
        </div>
      </div>

      {shown.length === 0 ? (
        <Card>
          <CardContent className="py-12 text-center space-y-3">
            <Building size={28} className="mx-auto text-muted-foreground opacity-40" />
            <p className="text-sm text-muted-foreground max-w-md mx-auto">
              Add the properties you own and manage. Then upload each manager's T12 or monthly report to track NOI against budget.
              Stabilized projects can also be moved here from the Projects page.
            </p>
            <Button size="sm" onClick={() => setForm("new")}><Plus size={14} className="mr-1" /> Add property</Button>
          </CardContent>
        </Card>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
          {shown.map(p => {
            const s = summaries.get(p.id)!;
            const v = variancePct(s.lastNoi, s.lastBudgetNoi);
            return (
              <button key={p.id} onClick={() => { setTab("overview"); setOpenId(p.id); }}
                className="text-left rounded-xl border border-border bg-card p-4 space-y-3 hover:border-primary/40 hover:bg-muted/30 transition-colors">
                <div>
                  <div className="flex items-center gap-2">
                    <span className="font-semibold text-sm text-foreground">{p.name}</span>
                    {p.status === "sold" && <span className="text-[11px] px-1.5 rounded bg-muted text-muted-foreground">Sold</span>}
                  </div>
                  <div className="text-xs text-muted-foreground truncate">
                    {[PROPERTY_TYPE_LABELS[p.type], p.units ? `${p.units} units` : null, p.sqft ? `${p.sqft.toLocaleString()} SF` : null, p.manager].filter(Boolean).join(" · ")}
                  </div>
                </div>
                {s.latestMonth ? (
                  <dl className="grid grid-cols-3 gap-2 text-sm">
                    <div><dt className="text-[11px] text-muted-foreground">T12 NOI</dt><dd className="font-mono font-semibold">{s.t12Noi != null ? fmtMoney(s.t12Noi) : "—"}</dd></div>
                    <div>
                      <dt className="text-[11px] text-muted-foreground">{monthLabel(s.latestMonth, true)} vs budget</dt>
                      <dd className={`font-mono font-semibold ${v == null ? "" : v >= 0 ? "text-green-700 dark:text-green-400" : v <= -10 ? "text-red-600 dark:text-red-400" : ""}`}>{v == null ? "—" : `${v > 0 ? "+" : ""}${v.toFixed(1)}%`}</dd>
                    </div>
                    <div><dt className="text-[11px] text-muted-foreground">Occupancy</dt><dd className="font-mono font-semibold">{s.occupancy != null ? `${s.occupancy.toFixed(0)}%` : "—"}</dd></div>
                  </dl>
                ) : <p className="text-xs text-muted-foreground">No monthly figures yet.</p>}
                {s.mismatches.length > 0 && <p className="text-[11px] text-amber-700 dark:text-amber-400 flex items-center gap-1"><AlertTriangle size={11} /> NOI check needed for {s.mismatches.length} month{s.mismatches.length === 1 ? "" : "s"}</p>}
              </button>
            );
          })}
        </div>
      )}

      {form && (
        <PropertyFormDialog key={form === "new" ? "new" : form.id} property={form === "new" ? null : form} open onClose={() => setForm(null)}
          onSaved={p => { const isNew = form === "new"; setForm(null); if (isNew) { setTab("financials"); setOpenId(p.id); } }} />
      )}
      <PropertySheet property={open} tab={tab} onTab={setTab} onClose={() => setOpenId(null)} onEdit={p => setForm(p)} onDelete={confirmDelete} />
    </div>
  );
}
