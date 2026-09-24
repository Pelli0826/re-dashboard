import { useState } from "react";
import { useConfirm, plural } from "@/components/ConfirmDialog";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import type { Project, InsertProject } from "@shared/schema";
import { insertProjectSchema } from "@shared/schema";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { Plus, Pencil, Trash2, Loader2, X } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Form, FormField, FormItem, FormLabel, FormControl, FormMessage } from "@/components/ui/form";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useToast } from "@/hooks/use-toast";

function fmt(n: number | null | undefined): string {
  if (n == null) return "—";
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `$${(n / 1_000).toFixed(0)}K`;
  return `$${n.toFixed(0)}`;
}

const statusColor: Record<string, string> = {
  planning: "bg-purple-100 text-purple-700 dark:bg-purple-900/30 dark:text-purple-300",
  entitlement: "bg-yellow-100 text-yellow-800 dark:bg-yellow-900/30 dark:text-yellow-300",
  construction: "bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-300",
  "lease-up": "bg-orange-100 text-orange-800 dark:bg-orange-900/30 dark:text-orange-300",
  stabilized: "bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-300",
  disposition: "bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-300",
};

const formSchema = insertProjectSchema.extend({
  totalBudget: z.coerce.number().positive("Required"),
  spentToDate: z.coerce.number().min(0),
  projectedNoi: z.coerce.number().optional(),
  units: z.coerce.number().optional(),
  sqft: z.coerce.number().optional(),
  equity: z.coerce.number().optional(),
});

type FormValues = z.infer<typeof formSchema>;

export default function Projects() {
  const { toast } = useToast();
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<Project | null>(null);

  const { data: projects = [], isLoading } = useQuery<Project[]>({ queryKey: ["/api/projects"] });

  const form = useForm<FormValues>({
    resolver: zodResolver(formSchema),
    defaultValues: { name: "", address: "", type: "residential", status: "planning", totalBudget: 0, spentToDate: 0, startDate: "" },
  });

  function openNew() {
    form.reset({ name: "", address: "", type: "residential", status: "planning", totalBudget: 0, spentToDate: 0, startDate: "" });
    setEditing(null);
    setOpen(true);
  }

  function openEdit(p: Project) {
    form.reset({
      name: p.name, address: p.address, type: p.type, status: p.status,
      totalBudget: p.totalBudget, spentToDate: p.spentToDate,
      projectedNoi: p.projectedNoi ?? undefined,
      units: p.units ?? undefined, sqft: p.sqft ?? undefined,
      equity: p.equity ?? undefined,
      startDate: p.startDate, expectedCompletion: p.expectedCompletion ?? undefined,
      notes: p.notes ?? undefined,
    });
    setEditing(p);
    setOpen(true);
  }

  const save = useMutation({
    mutationFn: (data: FormValues) => editing
      ? apiRequest("PATCH", `/api/projects/${editing.id}`, data)
      : apiRequest("POST", "/api/projects", data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["/api/projects"] });
      setOpen(false);
      toast({ title: editing ? "Project updated" : "Project created" });
    },
  });

  const confirm = useConfirm();
  async function confirmDelete(p: Project) {
    let c: Record<string, number> = {};
    try { c = await (await apiRequest("GET", `/api/projects/${p.id}/related`)).json(); } catch { /* show without counts */ }
    const ok = await confirm({
      title: `Delete ${p.name}?`,
      alsoDeletes: [
        plural(c.cashflow ?? 0, "cash flow entry", "cash flow entries"),
        plural(c.investors ?? 0, "investor record"),
        plural(c.documents ?? 0, "document link"),
        plural(c.tasks ?? 0, "task"),
        plural(c.loans ?? 0, "ARM loan"),
      ].filter((x): x is string => !!x),
      keeps: c.contacts ? [`${plural(c.contacts, "contact")} (removed from this project, not deleted)`] : [],
      confirmLabel: "Delete project",
    });
    if (ok) remove.mutate(p.id);
  }
  const remove = useMutation({
    mutationFn: (id: number) => apiRequest("DELETE", `/api/projects/${id}`),
    onSuccess: () => {
      qc.invalidateQueries(); // related records on other tabs were deleted too
      toast({ title: "Project deleted" });
    },
  });

  if (isLoading) return <div className="flex items-center gap-2 text-muted-foreground"><Loader2 className="animate-spin" size={16}/> Loading…</div>;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-lg font-bold text-foreground">Projects</h1>
          <p className="text-sm text-muted-foreground">{projects.length} project{projects.length !== 1 ? "s" : ""} tracked</p>
        </div>
        <Button data-testid="button-add-project" onClick={openNew} size="sm" className="gap-1.5">
          <Plus size={14} /> Add Project
        </Button>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
        {projects.map(p => {
          const progress = Math.min(100, Math.round((p.spentToDate / p.totalBudget) * 100));
          return (
            <Card key={p.id} data-testid={`card-project-${p.id}`} className="flex flex-col">
              <CardHeader className="pb-2">
                <div className="flex items-start justify-between gap-2">
                  <div className="flex-1 min-w-0">
                    <CardTitle className="text-sm font-semibold leading-snug">{p.name}</CardTitle>
                    <p className="text-xs text-muted-foreground mt-0.5 truncate">{p.address}</p>
                  </div>
                  <div className="flex gap-1 shrink-0">
                    <button onClick={() => openEdit(p)} className="p-1.5 hover:bg-muted rounded transition-colors text-muted-foreground hover:text-foreground" data-testid={`button-edit-project-${p.id}`}>
                      <Pencil size={12} />
                    </button>
                    <button onClick={() => confirmDelete(p)} className="p-1.5 hover:bg-destructive/10 rounded transition-colors text-muted-foreground hover:text-destructive" data-testid={`button-delete-project-${p.id}`}>
                      <Trash2 size={12} />
                    </button>
                  </div>
                </div>
                <div className="flex gap-1.5 mt-1 flex-wrap">
                  <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${statusColor[p.status]}`}>{p.status}</span>
                  <span className="text-xs px-2 py-0.5 rounded-full bg-muted text-muted-foreground font-medium capitalize">{p.type}</span>
                </div>
              </CardHeader>
              <CardContent className="space-y-3">
                <div className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
                  <div>
                    <div className="text-xs text-muted-foreground">Budget</div>
                    <div className="font-mono font-semibold text-foreground">{fmt(p.totalBudget)}</div>
                  </div>
                  <div>
                    <div className="text-xs text-muted-foreground">Proj. NOI</div>
                    <div className="font-mono font-semibold text-green-600 dark:text-green-400">{fmt(p.projectedNoi)}</div>
                  </div>
                  {p.units && (
                    <div>
                      <div className="text-xs text-muted-foreground">Units</div>
                      <div className="font-semibold text-foreground">{p.units}</div>
                    </div>
                  )}
                  {p.sqft && (
                    <div>
                      <div className="text-xs text-muted-foreground">Sq Ft</div>
                      <div className="font-semibold text-foreground">{p.sqft.toLocaleString()}</div>
                    </div>
                  )}
                  <div>
                    <div className="text-xs text-muted-foreground">Start Date</div>
                    <div className="font-semibold text-foreground text-sm">{p.startDate}</div>
                  </div>
                  {p.expectedCompletion && (
                    <div>
                      <div className="text-xs text-muted-foreground">Target Completion</div>
                      <div className="font-semibold text-foreground text-sm">{p.expectedCompletion}</div>
                    </div>
                  )}
                </div>
                <div>
                  <div className="flex justify-between text-xs mb-1">
                    <span className="text-muted-foreground">Budget Spent</span>
                    <span className="font-mono text-foreground">{fmt(p.spentToDate)} / {progress}%</span>
                  </div>
                  <div className="bg-muted rounded-full h-1.5 overflow-hidden">
                    <div className={`h-1.5 rounded-full transition-all ${progress > 90 ? "bg-destructive" : progress > 70 ? "bg-orange-500" : "bg-primary"}`} style={{ width: `${progress}%` }} />
                  </div>
                </div>
                {p.notes && <p className="text-xs text-muted-foreground italic">{p.notes}</p>}
              </CardContent>
            </Card>
          );
        })}
      </div>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{editing ? "Edit Project" : "New Project"}</DialogTitle>
          </DialogHeader>
          <Form {...form}>
            <form onSubmit={form.handleSubmit(d => save.mutate(d))} className="space-y-4">
              <div className="grid grid-cols-2 gap-4">
                <FormField control={form.control} name="name" render={({ field }) => (
                  <FormItem className="col-span-2">
                    <FormLabel>Project Name</FormLabel>
                    <FormControl><Input data-testid="input-project-name" placeholder="e.g. The Meridian Lofts" {...field} /></FormControl>
                    <FormMessage />
                  </FormItem>
                )} />
                <FormField control={form.control} name="address" render={({ field }) => (
                  <FormItem className="col-span-2">
                    <FormLabel>Address</FormLabel>
                    <FormControl><Input data-testid="input-project-address" placeholder="123 Main St, City, ST" {...field} /></FormControl>
                    <FormMessage />
                  </FormItem>
                )} />
                <FormField control={form.control} name="type" render={({ field }) => (
                  <FormItem>
                    <FormLabel>Type</FormLabel>
                    <Select value={field.value} onValueChange={field.onChange}>
                      <FormControl><SelectTrigger data-testid="select-project-type"><SelectValue /></SelectTrigger></FormControl>
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
                <FormField control={form.control} name="status" render={({ field }) => (
                  <FormItem>
                    <FormLabel>Status</FormLabel>
                    <Select value={field.value} onValueChange={field.onChange}>
                      <FormControl><SelectTrigger data-testid="select-project-status"><SelectValue /></SelectTrigger></FormControl>
                      <SelectContent>
                        <SelectItem value="planning">Planning</SelectItem>
                        <SelectItem value="entitlement">Entitlement</SelectItem>
                        <SelectItem value="construction">Construction</SelectItem>
                        <SelectItem value="lease-up">Lease-Up</SelectItem>
                        <SelectItem value="stabilized">Stabilized</SelectItem>
                        <SelectItem value="disposition">Disposition</SelectItem>
                      </SelectContent>
                    </Select>
                    <FormMessage />
                  </FormItem>
                )} />
                <FormField control={form.control} name="totalBudget" render={({ field }) => (
                  <FormItem>
                    <FormLabel>Total Budget ($)</FormLabel>
                    <FormControl><Input data-testid="input-total-budget" type="number" {...field} /></FormControl>
                    <FormMessage />
                  </FormItem>
                )} />
                <FormField control={form.control} name="spentToDate" render={({ field }) => (
                  <FormItem>
                    <FormLabel>Spent To Date ($)</FormLabel>
                    <FormControl><Input data-testid="input-spent" type="number" {...field} /></FormControl>
                    <FormMessage />
                  </FormItem>
                )} />
                <FormField control={form.control} name="projectedNoi" render={({ field }) => (
                  <FormItem>
                    <FormLabel>Projected NOI ($)</FormLabel>
                    <FormControl><Input data-testid="input-noi" type="number" {...field} value={field.value ?? ""} /></FormControl>
                    <FormMessage />
                  </FormItem>
                )} />
                <FormField control={form.control} name="equity" render={({ field }) => (
                  <FormItem>
                    <FormLabel>Equity Invested ($)</FormLabel>
                    <FormControl><Input data-testid="input-equity" type="number" {...field} value={field.value ?? ""} /></FormControl>
                    <FormMessage />
                  </FormItem>
                )} />
                <FormField control={form.control} name="units" render={({ field }) => (
                  <FormItem>
                    <FormLabel>Units</FormLabel>
                    <FormControl><Input data-testid="input-units" type="number" {...field} value={field.value ?? ""} /></FormControl>
                    <FormMessage />
                  </FormItem>
                )} />
                <FormField control={form.control} name="sqft" render={({ field }) => (
                  <FormItem>
                    <FormLabel>Square Feet</FormLabel>
                    <FormControl><Input data-testid="input-sqft" type="number" {...field} value={field.value ?? ""} /></FormControl>
                    <FormMessage />
                  </FormItem>
                )} />
                <FormField control={form.control} name="startDate" render={({ field }) => (
                  <FormItem>
                    <FormLabel>Start Date</FormLabel>
                    <FormControl><Input data-testid="input-start-date" type="date" {...field} /></FormControl>
                    <FormMessage />
                  </FormItem>
                )} />
                <FormField control={form.control} name="expectedCompletion" render={({ field }) => (
                  <FormItem>
                    <FormLabel>Expected Completion</FormLabel>
                    <FormControl><Input data-testid="input-completion" type="date" {...field} value={field.value ?? ""} /></FormControl>
                    <FormMessage />
                  </FormItem>
                )} />
                <FormField control={form.control} name="notes" render={({ field }) => (
                  <FormItem className="col-span-2">
                    <FormLabel>Notes</FormLabel>
                    <FormControl><Input data-testid="input-notes" placeholder="Optional notes" {...field} value={field.value ?? ""} /></FormControl>
                    <FormMessage />
                  </FormItem>
                )} />
              </div>
              <div className="flex justify-end gap-2 pt-2">
                <Button type="button" variant="outline" onClick={() => setOpen(false)}>Cancel</Button>
                <Button type="submit" data-testid="button-save-project" disabled={save.isPending}>
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
