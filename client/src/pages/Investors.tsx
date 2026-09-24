import { useState } from "react";
import { useConfirm } from "@/components/ConfirmDialog";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import type { Investor, InsertInvestor, Project } from "@shared/schema";
import { insertInvestorSchema } from "@shared/schema";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { Plus, Pencil, Trash2, Loader2, Users, DollarSign, TrendingUp } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Form, FormField, FormItem, FormLabel, FormControl, FormMessage } from "@/components/ui/form";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useToast } from "@/hooks/use-toast";

function fmt(n: number | null | undefined): string {
  if (n == null) return "—";
  if (Math.abs(n) >= 1_000_000) return `$${(n / 1_000_000).toFixed(2)}M`;
  if (Math.abs(n) >= 1_000) return `$${(n / 1_000).toFixed(0)}K`;
  return `$${n.toFixed(0)}`;
}

const statusColor: Record<string, string> = {
  active: "bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-300",
  exited: "bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-300",
  pending: "bg-yellow-100 text-yellow-800 dark:bg-yellow-900/30 dark:text-yellow-300",
};

const formSchema = insertInvestorSchema.extend({
  projectId: z.coerce.number().positive("Select a project"),
  commitment: z.coerce.number().positive(),
  funded: z.coerce.number().min(0),
  preferredReturn: z.coerce.number().min(0),
  equityShare: z.coerce.number().min(0).max(100),
  totalDistributed: z.coerce.number().min(0),
  contactId: z.coerce.number().optional(),
});
type FormValues = z.infer<typeof formSchema>;

export default function Investors() {
  const { toast } = useToast();
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<Investor | null>(null);
  const [selectedProject, setSelectedProject] = useState<string>("all");

  const { data: investors = [], isLoading } = useQuery<Investor[]>({ queryKey: ["/api/investors"] });
  const { data: projects = [] } = useQuery<Project[]>({ queryKey: ["/api/projects"] });

  const form = useForm<FormValues>({
    resolver: zodResolver(formSchema),
    defaultValues: { name: "", projectId: 0, commitment: 0, funded: 0, preferredReturn: 8, equityShare: 0, totalDistributed: 0, status: "active" },
  });

  function openNew() {
    form.reset({ name: "", projectId: projects[0]?.id ?? 0, commitment: 0, funded: 0, preferredReturn: 8, equityShare: 0, totalDistributed: 0, status: "active" });
    setEditing(null); setOpen(true);
  }
  function openEdit(inv: Investor) {
    form.reset({ ...inv, entityName: inv.entityName ?? undefined, contactId: inv.contactId ?? undefined, closeDate: inv.closeDate ?? undefined, notes: inv.notes ?? undefined });
    setEditing(inv); setOpen(true);
  }

  const save = useMutation({
    mutationFn: (data: FormValues) => editing ? apiRequest("PATCH", `/api/investors/${editing.id}`, data) : apiRequest("POST", "/api/investors", data),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["/api/investors"] }); setOpen(false); toast({ title: editing ? "Investor updated" : "Investor added" }); },
  });

  const confirm = useConfirm();
  const remove = useMutation({
    mutationFn: (id: number) => apiRequest("DELETE", `/api/investors/${id}`),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["/api/investors"] }); toast({ title: "Investor removed" }); },
  });

  const filtered = selectedProject === "all" ? investors : investors.filter(i => i.projectId === Number(selectedProject));

  const totalCommitment = filtered.reduce((s, i) => s + i.commitment, 0);
  const totalFunded = filtered.reduce((s, i) => s + i.funded, 0);
  const totalDistributed = filtered.reduce((s, i) => s + i.totalDistributed, 0);

  // Group by project
  const byProject: Record<number, Investor[]> = {};
  filtered.forEach(i => { if (!byProject[i.projectId]) byProject[i.projectId] = []; byProject[i.projectId].push(i); });

  if (isLoading) return <div className="flex items-center gap-2 text-muted-foreground"><Loader2 className="animate-spin" size={16} /> Loading…</div>;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-lg font-bold text-foreground">Equity Investors</h1>
          <p className="text-sm text-muted-foreground">{investors.length} investor position{investors.length !== 1 ? "s" : ""}</p>
        </div>
        <div className="flex items-center gap-2">
          <Select value={selectedProject} onValueChange={setSelectedProject}>
            <SelectTrigger className="w-44" data-testid="select-inv-project">
              <SelectValue placeholder="All Projects" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Projects</SelectItem>
              {projects.map(p => <SelectItem key={p.id} value={String(p.id)}>{p.name}</SelectItem>)}
            </SelectContent>
          </Select>
          <Button data-testid="button-add-investor" onClick={openNew} size="sm" className="gap-1.5">
            <Plus size={14} /> Add Investor
          </Button>
        </div>
      </div>

      {/* KPIs */}
      <div className="grid grid-cols-3 gap-4">
        <Card>
          <CardContent className="pt-4 pb-4">
            <div className="text-xs text-muted-foreground mb-1 flex items-center gap-1"><Users size={12} /> Total Committed</div>
            <div className="text-xl font-bold font-mono text-foreground">{fmt(totalCommitment)}</div>
            <div className="text-xs text-muted-foreground mt-0.5">{fmt(totalFunded)} funded</div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-4 pb-4">
            <div className="text-xs text-muted-foreground mb-1 flex items-center gap-1"><DollarSign size={12} className="text-green-600 dark:text-green-400" /> Distributed</div>
            <div className="text-xl font-bold font-mono text-green-600 dark:text-green-400">{fmt(totalDistributed)}</div>
            <div className="text-xs text-muted-foreground mt-0.5">{totalCommitment > 0 ? ((totalDistributed / totalCommitment) * 100).toFixed(1) : 0}% of committed</div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-4 pb-4">
            <div className="text-xs text-muted-foreground mb-1 flex items-center gap-1"><TrendingUp size={12} className="text-primary" /> Unfunded Capital</div>
            <div className="text-xl font-bold font-mono text-orange-500">{fmt(totalCommitment - totalFunded)}</div>
            <div className="text-xs text-muted-foreground mt-0.5">remaining to call</div>
          </CardContent>
        </Card>
      </div>

      {/* Tables by project */}
      {Object.entries(byProject).map(([pid, invs]) => {
        const project = projects.find(p => p.id === Number(pid));
        const projCommit = invs.reduce((s, i) => s + i.commitment, 0);
        const projDistributed = invs.reduce((s, i) => s + i.totalDistributed, 0);
        return (
          <Card key={pid}>
            <CardHeader className="pb-2">
              <div className="flex items-center justify-between flex-wrap gap-2">
                <CardTitle className="text-sm font-semibold">{project?.name ?? `Project #${pid}`}</CardTitle>
                <div className="flex gap-4 text-xs font-mono text-muted-foreground">
                  <span>Committed: <span className="text-foreground font-semibold">{fmt(projCommit)}</span></span>
                  <span>Distributed: <span className="text-green-600 dark:text-green-400 font-semibold">{fmt(projDistributed)}</span></span>
                </div>
              </div>
            </CardHeader>
            <CardContent className="p-0">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border">
                    <th className="text-left px-4 py-2 text-xs text-muted-foreground font-medium">Investor</th>
                    <th className="text-right px-4 py-2 text-xs text-muted-foreground font-medium">Commitment</th>
                    <th className="text-right px-4 py-2 text-xs text-muted-foreground font-medium">Funded</th>
                    <th className="text-right px-4 py-2 text-xs text-muted-foreground font-medium hidden md:table-cell">Pref Return</th>
                    <th className="text-right px-4 py-2 text-xs text-muted-foreground font-medium">Equity %</th>
                    <th className="text-right px-4 py-2 text-xs text-muted-foreground font-medium hidden lg:table-cell">Distributed</th>
                    <th className="text-left px-4 py-2 text-xs text-muted-foreground font-medium">Status</th>
                    <th className="px-4 py-2" />
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {invs.map(inv => (
                    <tr key={inv.id} data-testid={`row-investor-${inv.id}`} className="hover:bg-muted/40 transition-colors">
                      <td className="px-4 py-2.5">
                        <div className="font-medium text-foreground leading-snug">{inv.name}</div>
                        {inv.entityName && <div className="text-xs text-muted-foreground">{inv.entityName}</div>}
                      </td>
                      <td className="px-4 py-2.5 text-right font-mono">{fmt(inv.commitment)}</td>
                      <td className="px-4 py-2.5 text-right font-mono">
                        <div>{fmt(inv.funded)}</div>
                        {inv.funded < inv.commitment && (
                          <div className="text-xs text-orange-500">{((inv.funded / inv.commitment) * 100).toFixed(0)}%</div>
                        )}
                      </td>
                      <td className="px-4 py-2.5 text-right font-mono hidden md:table-cell">{inv.preferredReturn}%</td>
                      <td className="px-4 py-2.5 text-right font-mono font-semibold text-primary">{inv.equityShare}%</td>
                      <td className="px-4 py-2.5 text-right font-mono text-green-600 dark:text-green-400 hidden lg:table-cell">{fmt(inv.totalDistributed)}</td>
                      <td className="px-4 py-2.5">
                        <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${statusColor[inv.status] ?? ""}`}>{inv.status}</span>
                      </td>
                      <td className="px-4 py-2.5">
                        <div className="flex gap-1 justify-end">
                          <button onClick={() => openEdit(inv)} className="p-1.5 hover:bg-muted rounded text-muted-foreground hover:text-foreground transition-colors" data-testid={`button-edit-investor-${inv.id}`}><Pencil size={12} /></button>
                          <button onClick={async () => { if (await confirm({ title: `Delete ${inv.name}?` })) remove.mutate(inv.id); }} className="p-1.5 hover:bg-destructive/10 rounded text-muted-foreground hover:text-destructive transition-colors" data-testid={`button-delete-investor-${inv.id}`}><Trash2 size={12} /></button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </CardContent>
          </Card>
        );
      })}
      {Object.keys(byProject).length === 0 && (
        <div className="text-center py-16 text-muted-foreground">No investors yet. Add LP commitments above.</div>
      )}

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-lg max-h-[90vh] overflow-y-auto">
          <DialogHeader><DialogTitle>{editing ? "Edit Investor" : "New Investor"}</DialogTitle></DialogHeader>
          <Form {...form}>
            <form onSubmit={form.handleSubmit(d => save.mutate(d))} className="space-y-4">
              <div className="grid grid-cols-2 gap-3">
                <FormField control={form.control} name="name" render={({ field }) => (
                  <FormItem className="col-span-2"><FormLabel>Investor Name</FormLabel>
                    <FormControl><Input data-testid="input-investor-name" placeholder="John Smith" {...field} /></FormControl><FormMessage />
                  </FormItem>
                )} />
                <FormField control={form.control} name="entityName" render={({ field }) => (
                  <FormItem className="col-span-2"><FormLabel>Entity Name</FormLabel>
                    <FormControl><Input data-testid="input-entity" placeholder="Smith Capital LLC" {...field} value={field.value ?? ""} /></FormControl><FormMessage />
                  </FormItem>
                )} />
                <FormField control={form.control} name="projectId" render={({ field }) => (
                  <FormItem className="col-span-2"><FormLabel>Project</FormLabel>
                    <Select value={String(field.value)} onValueChange={v => field.onChange(Number(v))}>
                      <FormControl><SelectTrigger data-testid="select-investor-project"><SelectValue /></SelectTrigger></FormControl>
                      <SelectContent>
                        {projects.map(p => <SelectItem key={p.id} value={String(p.id)}>{p.name}</SelectItem>)}
                      </SelectContent>
                    </Select><FormMessage />
                  </FormItem>
                )} />
                <FormField control={form.control} name="commitment" render={({ field }) => (
                  <FormItem><FormLabel>Commitment ($)</FormLabel>
                    <FormControl><Input data-testid="input-commitment" type="number" {...field} /></FormControl><FormMessage />
                  </FormItem>
                )} />
                <FormField control={form.control} name="funded" render={({ field }) => (
                  <FormItem><FormLabel>Funded ($)</FormLabel>
                    <FormControl><Input data-testid="input-funded" type="number" {...field} /></FormControl><FormMessage />
                  </FormItem>
                )} />
                <FormField control={form.control} name="preferredReturn" render={({ field }) => (
                  <FormItem><FormLabel>Pref Return (%)</FormLabel>
                    <FormControl><Input data-testid="input-pref" type="number" step="0.1" {...field} /></FormControl><FormMessage />
                  </FormItem>
                )} />
                <FormField control={form.control} name="equityShare" render={({ field }) => (
                  <FormItem><FormLabel>Equity Share (%)</FormLabel>
                    <FormControl><Input data-testid="input-equity-share" type="number" step="0.01" {...field} /></FormControl><FormMessage />
                  </FormItem>
                )} />
                <FormField control={form.control} name="totalDistributed" render={({ field }) => (
                  <FormItem><FormLabel>Total Distributed ($)</FormLabel>
                    <FormControl><Input data-testid="input-distributed" type="number" {...field} /></FormControl><FormMessage />
                  </FormItem>
                )} />
                <FormField control={form.control} name="status" render={({ field }) => (
                  <FormItem><FormLabel>Status</FormLabel>
                    <Select value={field.value} onValueChange={field.onChange}>
                      <FormControl><SelectTrigger data-testid="select-investor-status"><SelectValue /></SelectTrigger></FormControl>
                      <SelectContent>
                        <SelectItem value="active">Active</SelectItem>
                        <SelectItem value="pending">Pending</SelectItem>
                        <SelectItem value="exited">Exited</SelectItem>
                      </SelectContent>
                    </Select><FormMessage />
                  </FormItem>
                )} />
                <FormField control={form.control} name="closeDate" render={({ field }) => (
                  <FormItem className="col-span-2"><FormLabel>Close Date</FormLabel>
                    <FormControl><Input data-testid="input-close-date" type="date" {...field} value={field.value ?? ""} /></FormControl><FormMessage />
                  </FormItem>
                )} />
                <FormField control={form.control} name="notes" render={({ field }) => (
                  <FormItem className="col-span-2"><FormLabel>Notes</FormLabel>
                    <FormControl><Input data-testid="input-investor-notes" placeholder="Optional" {...field} value={field.value ?? ""} /></FormControl><FormMessage />
                  </FormItem>
                )} />
              </div>
              <div className="flex justify-end gap-2 pt-1">
                <Button type="button" variant="outline" onClick={() => setOpen(false)}>Cancel</Button>
                <Button type="submit" data-testid="button-save-investor" disabled={save.isPending}>
                  {save.isPending ? <Loader2 className="animate-spin mr-1" size={14} /> : null}
                  {editing ? "Update" : "Add"}
                </Button>
              </div>
            </form>
          </Form>
        </DialogContent>
      </Dialog>
    </div>
  );
}
