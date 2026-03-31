import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import type { PipelineDeal, InsertPipeline } from "@shared/schema";
import { insertPipelineSchema } from "@shared/schema";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { Plus, Pencil, Trash2, Loader2 } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Form, FormField, FormItem, FormLabel, FormControl, FormMessage } from "@/components/ui/form";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useToast } from "@/hooks/use-toast";

const STAGES = ["prospecting", "loi", "due-diligence", "under-contract", "closed", "dead"] as const;

const stageColor: Record<string, string> = {
  prospecting: "border-gray-300 bg-gray-50 dark:bg-gray-900/20 dark:border-gray-700",
  loi: "border-blue-300 bg-blue-50 dark:bg-blue-900/20 dark:border-blue-700",
  "due-diligence": "border-yellow-300 bg-yellow-50 dark:bg-yellow-900/20 dark:border-yellow-700",
  "under-contract": "border-orange-300 bg-orange-50 dark:bg-orange-900/20 dark:border-orange-700",
  closed: "border-green-300 bg-green-50 dark:bg-green-900/20 dark:border-green-700",
  dead: "border-red-300 bg-red-50 dark:bg-red-900/20 dark:border-red-700",
};

const stageLabelColor: Record<string, string> = {
  prospecting: "text-gray-600 dark:text-gray-400",
  loi: "text-blue-700 dark:text-blue-400",
  "due-diligence": "text-yellow-700 dark:text-yellow-400",
  "under-contract": "text-orange-700 dark:text-orange-400",
  closed: "text-green-700 dark:text-green-400",
  dead: "text-red-700 dark:text-red-400",
};

function fmt(n: number | null | undefined): string {
  if (n == null) return "—";
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `$${(n / 1_000).toFixed(0)}K`;
  return `$${n.toFixed(0)}`;
}

const formSchema = insertPipelineSchema.extend({
  askingPrice: z.coerce.number().optional(),
  projectedValue: z.coerce.number().optional(),
  capRate: z.coerce.number().optional(),
  units: z.coerce.number().optional(),
  sqft: z.coerce.number().optional(),
  probability: z.coerce.number().min(0).max(100),
});

type FormValues = z.infer<typeof formSchema>;

export default function Pipeline() {
  const { toast } = useToast();
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<PipelineDeal | null>(null);

  const { data: deals = [], isLoading } = useQuery<PipelineDeal[]>({ queryKey: ["/api/pipeline"] });

  const form = useForm<FormValues>({
    resolver: zodResolver(formSchema),
    defaultValues: { name: "", address: "", type: "residential", stage: "prospecting", probability: 50 },
  });

  function openNew() {
    form.reset({ name: "", address: "", type: "residential", stage: "prospecting", probability: 50 });
    setEditing(null);
    setOpen(true);
  }

  function openEdit(d: PipelineDeal) {
    form.reset({ ...d, askingPrice: d.askingPrice ?? undefined, projectedValue: d.projectedValue ?? undefined, capRate: d.capRate ?? undefined, units: d.units ?? undefined, sqft: d.sqft ?? undefined, targetCloseDate: d.targetCloseDate ?? undefined, broker: d.broker ?? undefined, notes: d.notes ?? undefined });
    setEditing(d);
    setOpen(true);
  }

  const save = useMutation({
    mutationFn: (data: FormValues) => editing
      ? apiRequest("PATCH", `/api/pipeline/${editing.id}`, data)
      : apiRequest("POST", "/api/pipeline", data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["/api/pipeline"] });
      setOpen(false);
      toast({ title: editing ? "Deal updated" : "Deal added" });
    },
  });

  const remove = useMutation({
    mutationFn: (id: number) => apiRequest("DELETE", `/api/pipeline/${id}`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["/api/pipeline"] });
      toast({ title: "Deal removed" });
    },
  });

  if (isLoading) return <div className="flex items-center gap-2 text-muted-foreground"><Loader2 className="animate-spin" size={16}/> Loading…</div>;

  // Group by stage
  const byStage = STAGES.reduce((acc, s) => {
    acc[s] = deals.filter(d => d.stage === s);
    return acc;
  }, {} as Record<string, PipelineDeal[]>);

  const activeValue = deals.filter(d => !["dead", "closed"].includes(d.stage)).reduce((s, d) => s + (d.projectedValue ?? 0) * d.probability / 100, 0);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-lg font-bold text-foreground">Pipeline</h1>
          <p className="text-sm text-muted-foreground">Weighted active value: <span className="font-mono font-semibold text-green-600 dark:text-green-400">{fmt(activeValue)}</span></p>
        </div>
        <Button data-testid="button-add-deal" onClick={openNew} size="sm" className="gap-1.5">
          <Plus size={14} /> Add Deal
        </Button>
      </div>

      {/* Kanban-style columns */}
      <div className="grid grid-cols-2 lg:grid-cols-3 xl:grid-cols-6 gap-3">
        {STAGES.map(stage => (
          <div key={stage} className="space-y-2">
            <div className={`text-xs font-semibold uppercase tracking-wide px-1 ${stageLabelColor[stage]}`}>
              {stage.replace("-", " ")} <span className="opacity-60">({byStage[stage].length})</span>
            </div>
            {byStage[stage].map(d => (
              <div key={d.id} data-testid={`card-deal-${d.id}`} className={`rounded-lg border p-3 space-y-2 ${stageColor[stage]}`}>
                <div className="flex items-start justify-between gap-1">
                  <div className="text-xs font-semibold text-foreground leading-snug">{d.name}</div>
                  <div className="flex gap-0.5 shrink-0">
                    <button onClick={() => openEdit(d)} className="p-1 hover:bg-black/10 dark:hover:bg-white/10 rounded text-muted-foreground hover:text-foreground transition-colors" data-testid={`button-edit-deal-${d.id}`}>
                      <Pencil size={10} />
                    </button>
                    <button onClick={() => remove.mutate(d.id)} className="p-1 hover:bg-red-100 dark:hover:bg-red-900/20 rounded text-muted-foreground hover:text-destructive transition-colors" data-testid={`button-delete-deal-${d.id}`}>
                      <Trash2 size={10} />
                    </button>
                  </div>
                </div>
                <div className="text-xs text-muted-foreground capitalize">{d.type}</div>
                {d.askingPrice && <div className="text-xs font-mono text-foreground">{fmt(d.askingPrice)}</div>}
                {d.capRate && <div className="text-xs text-muted-foreground">Cap: {d.capRate}%</div>}
                <div className="flex items-center gap-1.5">
                  <div className="flex-1 bg-black/10 dark:bg-white/10 rounded-full h-1 overflow-hidden">
                    <div className={`h-1 rounded-full ${d.probability >= 70 ? "bg-green-500" : d.probability >= 40 ? "bg-yellow-500" : "bg-red-400"}`} style={{ width: `${d.probability}%` }} />
                  </div>
                  <span className="text-xs font-mono text-muted-foreground">{d.probability}%</span>
                </div>
                {d.targetCloseDate && <div className="text-[10px] text-muted-foreground">{d.targetCloseDate}</div>}
              </div>
            ))}
          </div>
        ))}
      </div>

      {/* Table view */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm font-semibold">All Deals</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border">
                  <th className="text-left px-4 py-2 text-xs text-muted-foreground font-medium">Deal</th>
                  <th className="text-left px-4 py-2 text-xs text-muted-foreground font-medium">Stage</th>
                  <th className="text-right px-4 py-2 text-xs text-muted-foreground font-medium">Ask Price</th>
                  <th className="text-right px-4 py-2 text-xs text-muted-foreground font-medium">Proj. Value</th>
                  <th className="text-right px-4 py-2 text-xs text-muted-foreground font-medium">Cap Rate</th>
                  <th className="text-right px-4 py-2 text-xs text-muted-foreground font-medium">Prob.</th>
                  <th className="text-left px-4 py-2 text-xs text-muted-foreground font-medium">Broker</th>
                  <th className="text-right px-4 py-2 text-xs text-muted-foreground font-medium">Close Target</th>
                  <th className="px-4 py-2" />
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {deals.map(d => (
                  <tr key={d.id} className="hover:bg-muted/40 transition-colors">
                    <td className="px-4 py-2.5 font-medium text-foreground">
                      <div className="leading-snug">{d.name}</div>
                      <div className="text-xs text-muted-foreground font-normal capitalize">{d.type}</div>
                    </td>
                    <td className="px-4 py-2.5">
                      <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${stageLabelColor[d.stage]} bg-black/5 dark:bg-white/5`}>{d.stage}</span>
                    </td>
                    <td className="px-4 py-2.5 text-right font-mono">{fmt(d.askingPrice)}</td>
                    <td className="px-4 py-2.5 text-right font-mono text-green-600 dark:text-green-400">{fmt(d.projectedValue)}</td>
                    <td className="px-4 py-2.5 text-right font-mono">{d.capRate ? `${d.capRate}%` : "—"}</td>
                    <td className="px-4 py-2.5 text-right">
                      <span className={`font-mono font-semibold text-xs ${d.probability >= 70 ? "text-green-600 dark:text-green-400" : d.probability >= 40 ? "text-yellow-600 dark:text-yellow-400" : "text-red-600 dark:text-red-400"}`}>
                        {d.probability}%
                      </span>
                    </td>
                    <td className="px-4 py-2.5 text-sm text-muted-foreground">{d.broker ?? "—"}</td>
                    <td className="px-4 py-2.5 text-right text-xs text-muted-foreground">{d.targetCloseDate ?? "—"}</td>
                    <td className="px-4 py-2.5">
                      <div className="flex gap-1 justify-end">
                        <button onClick={() => openEdit(d)} className="p-1.5 hover:bg-muted rounded text-muted-foreground hover:text-foreground transition-colors"><Pencil size={12} /></button>
                        <button onClick={() => remove.mutate(d.id)} className="p-1.5 hover:bg-destructive/10 rounded text-muted-foreground hover:text-destructive transition-colors"><Trash2 size={12} /></button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{editing ? "Edit Deal" : "New Pipeline Deal"}</DialogTitle>
          </DialogHeader>
          <Form {...form}>
            <form onSubmit={form.handleSubmit(d => save.mutate(d))} className="space-y-4">
              <div className="grid grid-cols-2 gap-4">
                <FormField control={form.control} name="name" render={({ field }) => (
                  <FormItem className="col-span-2">
                    <FormLabel>Deal Name</FormLabel>
                    <FormControl><Input data-testid="input-deal-name" placeholder="e.g. Wicker Park Apartments" {...field} /></FormControl>
                    <FormMessage />
                  </FormItem>
                )} />
                <FormField control={form.control} name="address" render={({ field }) => (
                  <FormItem className="col-span-2">
                    <FormLabel>Address</FormLabel>
                    <FormControl><Input data-testid="input-deal-address" placeholder="123 Main St, City, ST" {...field} /></FormControl>
                    <FormMessage />
                  </FormItem>
                )} />
                <FormField control={form.control} name="type" render={({ field }) => (
                  <FormItem>
                    <FormLabel>Type</FormLabel>
                    <Select value={field.value} onValueChange={field.onChange}>
                      <FormControl><SelectTrigger data-testid="select-deal-type"><SelectValue /></SelectTrigger></FormControl>
                      <SelectContent>
                        <SelectItem value="residential">Residential</SelectItem>
                        <SelectItem value="commercial">Commercial</SelectItem>
                        <SelectItem value="mixed-use">Mixed-Use</SelectItem>
                        <SelectItem value="land">Land</SelectItem>
                      </SelectContent>
                    </Select>
                    <FormMessage />
                  </FormItem>
                )} />
                <FormField control={form.control} name="stage" render={({ field }) => (
                  <FormItem>
                    <FormLabel>Stage</FormLabel>
                    <Select value={field.value} onValueChange={field.onChange}>
                      <FormControl><SelectTrigger data-testid="select-deal-stage"><SelectValue /></SelectTrigger></FormControl>
                      <SelectContent>
                        {STAGES.map(s => <SelectItem key={s} value={s} className="capitalize">{s}</SelectItem>)}
                      </SelectContent>
                    </Select>
                    <FormMessage />
                  </FormItem>
                )} />
                <FormField control={form.control} name="askingPrice" render={({ field }) => (
                  <FormItem>
                    <FormLabel>Asking Price ($)</FormLabel>
                    <FormControl><Input data-testid="input-asking-price" type="number" {...field} value={field.value ?? ""} /></FormControl>
                    <FormMessage />
                  </FormItem>
                )} />
                <FormField control={form.control} name="projectedValue" render={({ field }) => (
                  <FormItem>
                    <FormLabel>Projected Value ($)</FormLabel>
                    <FormControl><Input data-testid="input-proj-value" type="number" {...field} value={field.value ?? ""} /></FormControl>
                    <FormMessage />
                  </FormItem>
                )} />
                <FormField control={form.control} name="capRate" render={({ field }) => (
                  <FormItem>
                    <FormLabel>Cap Rate (%)</FormLabel>
                    <FormControl><Input data-testid="input-cap-rate" type="number" step="0.01" {...field} value={field.value ?? ""} /></FormControl>
                    <FormMessage />
                  </FormItem>
                )} />
                <FormField control={form.control} name="probability" render={({ field }) => (
                  <FormItem>
                    <FormLabel>Probability (%)</FormLabel>
                    <FormControl><Input data-testid="input-probability" type="number" min={0} max={100} {...field} /></FormControl>
                    <FormMessage />
                  </FormItem>
                )} />
                <FormField control={form.control} name="units" render={({ field }) => (
                  <FormItem>
                    <FormLabel>Units</FormLabel>
                    <FormControl><Input data-testid="input-deal-units" type="number" {...field} value={field.value ?? ""} /></FormControl>
                    <FormMessage />
                  </FormItem>
                )} />
                <FormField control={form.control} name="sqft" render={({ field }) => (
                  <FormItem>
                    <FormLabel>Sq Ft</FormLabel>
                    <FormControl><Input data-testid="input-deal-sqft" type="number" {...field} value={field.value ?? ""} /></FormControl>
                    <FormMessage />
                  </FormItem>
                )} />
                <FormField control={form.control} name="broker" render={({ field }) => (
                  <FormItem>
                    <FormLabel>Broker</FormLabel>
                    <FormControl><Input data-testid="input-broker" placeholder="e.g. CBRE" {...field} value={field.value ?? ""} /></FormControl>
                    <FormMessage />
                  </FormItem>
                )} />
                <FormField control={form.control} name="targetCloseDate" render={({ field }) => (
                  <FormItem>
                    <FormLabel>Target Close Date</FormLabel>
                    <FormControl><Input data-testid="input-close-date" type="date" {...field} value={field.value ?? ""} /></FormControl>
                    <FormMessage />
                  </FormItem>
                )} />
                <FormField control={form.control} name="notes" render={({ field }) => (
                  <FormItem className="col-span-2">
                    <FormLabel>Notes</FormLabel>
                    <FormControl><Input data-testid="input-deal-notes" placeholder="Optional notes" {...field} value={field.value ?? ""} /></FormControl>
                    <FormMessage />
                  </FormItem>
                )} />
              </div>
              <div className="flex justify-end gap-2 pt-2">
                <Button type="button" variant="outline" onClick={() => setOpen(false)}>Cancel</Button>
                <Button type="submit" data-testid="button-save-deal" disabled={save.isPending}>
                  {save.isPending ? <Loader2 className="animate-spin mr-1" size={14} /> : null}
                  {editing ? "Update" : "Create"}
                </Button>
              </div>
            </form>
          </Form>
        </DialogContent>
      </Dialog>
    </div>
  );
}
