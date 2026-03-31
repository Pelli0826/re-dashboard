import { useState, useMemo } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import type { CashFlowEntry, InsertCashFlow, Project } from "@shared/schema";
import { insertCashFlowSchema } from "@shared/schema";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { Plus, Trash2, Loader2, TrendingUp, TrendingDown } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Form, FormField, FormItem, FormLabel, FormControl, FormMessage } from "@/components/ui/form";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useToast } from "@/hooks/use-toast";

function fmt(n: number): string {
  if (Math.abs(n) >= 1_000_000) return `$${(n / 1_000_000).toFixed(2)}M`;
  if (Math.abs(n) >= 1_000) return `$${(n / 1_000).toFixed(0)}K`;
  return `$${n.toFixed(0)}`;
}

const SUBCATEGORIES = {
  income: ["rent", "loan-proceeds", "other-income"],
  expense: ["construction-cost", "interest", "mgmt-fee", "soft-costs", "opex", "taxes", "insurance", "other-expense"],
};

const formSchema = insertCashFlowSchema.extend({
  projectId: z.coerce.number().positive("Select a project"),
  amount: z.coerce.number().positive("Must be positive"),
});
type FormValues = z.infer<typeof formSchema>;

export default function CashFlow() {
  const { toast } = useToast();
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [selectedProject, setSelectedProject] = useState<string>("all");

  const { data: allEntries = [], isLoading: cfLoading } = useQuery<CashFlowEntry[]>({ queryKey: ["/api/cashflow"] });
  const { data: projects = [] } = useQuery<Project[]>({ queryKey: ["/api/projects"] });

  const entries = selectedProject === "all" ? allEntries : allEntries.filter(e => e.projectId === Number(selectedProject));

  // Group by month → compute net
  const byMonth = useMemo(() => {
    const map: Record<string, { income: number; expense: number; net: number; entries: CashFlowEntry[] }> = {};
    entries.forEach(e => {
      if (!map[e.month]) map[e.month] = { income: 0, expense: 0, net: 0, entries: [] };
      if (e.category === "income") { map[e.month].income += e.amount; map[e.month].net += e.amount; }
      else { map[e.month].expense += e.amount; map[e.month].net -= e.amount; }
      map[e.month].entries.push(e);
    });
    return Object.entries(map).sort(([a], [b]) => b.localeCompare(a));
  }, [entries]);

  const totalIncome = entries.filter(e => e.category === "income").reduce((s, e) => s + e.amount, 0);
  const totalExpense = entries.filter(e => e.category === "expense").reduce((s, e) => s + e.amount, 0);
  const netCF = totalIncome - totalExpense;

  // Bar chart — last 6 months
  const chartMonths = byMonth.slice(0, 6).reverse();
  const maxAbs = Math.max(...chartMonths.map(([, d]) => Math.max(d.income, d.expense)), 1);

  const form = useForm<FormValues>({
    resolver: zodResolver(formSchema),
    defaultValues: { projectId: projects[0]?.id ?? 0, month: "", category: "expense", subcategory: "construction-cost", amount: 0 },
  });

  const catValue = form.watch("category");

  const save = useMutation({
    mutationFn: (data: FormValues) => apiRequest("POST", "/api/cashflow", data),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["/api/cashflow"] }); setOpen(false); toast({ title: "Entry added" }); },
  });

  const remove = useMutation({
    mutationFn: (id: number) => apiRequest("DELETE", `/api/cashflow/${id}`),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["/api/cashflow"] }); toast({ title: "Entry removed" }); },
  });

  if (cfLoading) return <div className="flex items-center gap-2 text-muted-foreground"><Loader2 className="animate-spin" size={16} /> Loading…</div>;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-lg font-bold text-foreground">Cash Flow</h1>
          <p className="text-sm text-muted-foreground">Track income and expenses by project</p>
        </div>
        <div className="flex items-center gap-2">
          <Select value={selectedProject} onValueChange={setSelectedProject}>
            <SelectTrigger className="w-48" data-testid="select-cf-project">
              <SelectValue placeholder="All Projects" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Projects</SelectItem>
              {projects.map(p => <SelectItem key={p.id} value={String(p.id)}>{p.name}</SelectItem>)}
            </SelectContent>
          </Select>
          <Button data-testid="button-add-cf" onClick={() => setOpen(true)} size="sm" className="gap-1.5">
            <Plus size={14} /> Add Entry
          </Button>
        </div>
      </div>

      {/* KPIs */}
      <div className="grid grid-cols-3 gap-4">
        <Card>
          <CardContent className="pt-4 pb-4">
            <div className="text-xs text-muted-foreground mb-1 flex items-center gap-1"><TrendingUp size={12} className="text-green-600 dark:text-green-400" /> Total Income</div>
            <div className="text-xl font-bold font-mono text-green-600 dark:text-green-400">{fmt(totalIncome)}</div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-4 pb-4">
            <div className="text-xs text-muted-foreground mb-1 flex items-center gap-1"><TrendingDown size={12} className="text-red-500" /> Total Expense</div>
            <div className="text-xl font-bold font-mono text-red-500">{fmt(totalExpense)}</div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-4 pb-4">
            <div className="text-xs text-muted-foreground mb-1">Net Cash Flow</div>
            <div className={`text-xl font-bold font-mono ${netCF >= 0 ? "text-green-600 dark:text-green-400" : "text-red-500"}`}>{netCF >= 0 ? "+" : ""}{fmt(netCF)}</div>
          </CardContent>
        </Card>
      </div>

      {/* Bar chart */}
      {chartMonths.length > 0 && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-semibold">Monthly Breakdown</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="flex items-end gap-4" style={{ height: 140 }}>
              {chartMonths.map(([month, data]) => {
                const BAR_H = 112;
                const incH = Math.max(data.income ? Math.round((data.income / maxAbs) * BAR_H) : 0, data.income ? 3 : 0);
                const expH = Math.max(data.expense ? Math.round((data.expense / maxAbs) * BAR_H) : 0, data.expense ? 3 : 0);
                return (
                  <div key={month} className="flex-1 flex flex-col items-center gap-1">
                    <div className="w-full flex gap-1 items-end" style={{ height: BAR_H }}>
                      {/* Income bar */}
                      <div
                        className="flex-1 bg-green-500/70 dark:bg-green-500/60 rounded-t transition-all"
                        style={{ height: incH }}
                        title={`Income: ${fmt(data.income)}`}
                      />
                      {/* Expense bar */}
                      <div
                        className="flex-1 bg-red-400/70 dark:bg-red-400/60 rounded-t transition-all"
                        style={{ height: expH }}
                        title={`Expense: ${fmt(data.expense)}`}
                      />
                    </div>
                    <div className="text-[10px] text-muted-foreground font-mono">{month.slice(2)}</div>
                  </div>
                );
              })}
            </div>
            <div className="flex gap-4 mt-2 text-xs text-muted-foreground">
              <div className="flex items-center gap-1.5"><span className="w-3 h-3 rounded bg-green-500/70 inline-block" /> Income</div>
              <div className="flex items-center gap-1.5"><span className="w-3 h-3 rounded bg-red-400/70 inline-block" /> Expense</div>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Monthly detail tables */}
      {byMonth.map(([month, data]) => (
        <Card key={month}>
          <CardHeader className="pb-2">
            <div className="flex items-center justify-between">
              <CardTitle className="text-sm font-semibold">{month}</CardTitle>
              <div className="flex gap-4 text-xs font-mono">
                <span className="text-green-600 dark:text-green-400">+{fmt(data.income)}</span>
                <span className="text-red-500">-{fmt(data.expense)}</span>
                <span className={`font-semibold ${data.net >= 0 ? "text-green-600 dark:text-green-400" : "text-red-500"}`}>
                  {data.net >= 0 ? "+" : ""}{fmt(data.net)} net
                </span>
              </div>
            </div>
          </CardHeader>
          <CardContent className="p-0">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border">
                  <th className="text-left px-4 py-1.5 text-xs text-muted-foreground font-medium">Category</th>
                  <th className="text-left px-4 py-1.5 text-xs text-muted-foreground font-medium">Subcategory</th>
                  <th className="text-left px-4 py-1.5 text-xs text-muted-foreground font-medium hidden md:table-cell">Project</th>
                  <th className="text-right px-4 py-1.5 text-xs text-muted-foreground font-medium">Amount</th>
                  <th className="text-left px-4 py-1.5 text-xs text-muted-foreground font-medium hidden lg:table-cell">Notes</th>
                  <th className="px-4 py-1.5" />
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {data.entries.map(e => (
                  <tr key={e.id} className="hover:bg-muted/40 transition-colors">
                    <td className="px-4 py-2">
                      <span className={`text-xs font-medium ${e.category === "income" ? "text-green-600 dark:text-green-400" : "text-red-500"}`}>
                        {e.category}
                      </span>
                    </td>
                    <td className="px-4 py-2 text-xs capitalize text-foreground">{e.subcategory.replace(/-/g, " ")}</td>
                    <td className="px-4 py-2 text-xs text-muted-foreground hidden md:table-cell">
                      {projects.find(p => p.id === e.projectId)?.name ?? "—"}
                    </td>
                    <td className={`px-4 py-2 text-right font-mono text-sm font-semibold ${e.category === "income" ? "text-green-600 dark:text-green-400" : "text-red-500"}`}>
                      {e.category === "income" ? "+" : "-"}{fmt(e.amount)}
                    </td>
                    <td className="px-4 py-2 text-xs text-muted-foreground hidden lg:table-cell">{e.notes ?? "—"}</td>
                    <td className="px-4 py-2">
                      <button onClick={() => remove.mutate(e.id)} className="p-1.5 hover:bg-destructive/10 rounded text-muted-foreground hover:text-destructive transition-colors">
                        <Trash2 size={12} />
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </CardContent>
        </Card>
      ))}

      {byMonth.length === 0 && (
        <div className="text-center py-16 text-muted-foreground">No entries yet. Add income or expense records above.</div>
      )}

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader><DialogTitle>Add Cash Flow Entry</DialogTitle></DialogHeader>
          <Form {...form}>
            <form onSubmit={form.handleSubmit(d => save.mutate(d))} className="space-y-4">
              <FormField control={form.control} name="projectId" render={({ field }) => (
                <FormItem>
                  <FormLabel>Project</FormLabel>
                  <Select value={String(field.value)} onValueChange={v => field.onChange(Number(v))}>
                    <FormControl><SelectTrigger data-testid="select-cf-project-form"><SelectValue /></SelectTrigger></FormControl>
                    <SelectContent>
                      {projects.map(p => <SelectItem key={p.id} value={String(p.id)}>{p.name}</SelectItem>)}
                    </SelectContent>
                  </Select>
                  <FormMessage />
                </FormItem>
              )} />
              <FormField control={form.control} name="month" render={({ field }) => (
                <FormItem>
                  <FormLabel>Month (YYYY-MM)</FormLabel>
                  <FormControl><Input data-testid="input-cf-month" type="month" {...field} /></FormControl>
                  <FormMessage />
                </FormItem>
              )} />
              <div className="grid grid-cols-2 gap-3">
                <FormField control={form.control} name="category" render={({ field }) => (
                  <FormItem>
                    <FormLabel>Category</FormLabel>
                    <Select value={field.value} onValueChange={v => { field.onChange(v); form.setValue("subcategory", SUBCATEGORIES[v as keyof typeof SUBCATEGORIES][0]); }}>
                      <FormControl><SelectTrigger data-testid="select-cf-category"><SelectValue /></SelectTrigger></FormControl>
                      <SelectContent>
                        <SelectItem value="income">Income</SelectItem>
                        <SelectItem value="expense">Expense</SelectItem>
                      </SelectContent>
                    </Select>
                    <FormMessage />
                  </FormItem>
                )} />
                <FormField control={form.control} name="subcategory" render={({ field }) => (
                  <FormItem>
                    <FormLabel>Subcategory</FormLabel>
                    <Select value={field.value} onValueChange={field.onChange}>
                      <FormControl><SelectTrigger data-testid="select-cf-subcategory"><SelectValue /></SelectTrigger></FormControl>
                      <SelectContent>
                        {SUBCATEGORIES[catValue as keyof typeof SUBCATEGORIES]?.map(s => (
                          <SelectItem key={s} value={s} className="capitalize">{s.replace(/-/g, " ")}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <FormMessage />
                  </FormItem>
                )} />
              </div>
              <FormField control={form.control} name="amount" render={({ field }) => (
                <FormItem>
                  <FormLabel>Amount ($)</FormLabel>
                  <FormControl><Input data-testid="input-cf-amount" type="number" {...field} /></FormControl>
                  <FormMessage />
                </FormItem>
              )} />
              <FormField control={form.control} name="notes" render={({ field }) => (
                <FormItem>
                  <FormLabel>Notes</FormLabel>
                  <FormControl><Input data-testid="input-cf-notes" placeholder="Optional" {...field} value={field.value ?? ""} /></FormControl>
                  <FormMessage />
                </FormItem>
              )} />
              <div className="flex justify-end gap-2 pt-1">
                <Button type="button" variant="outline" onClick={() => setOpen(false)}>Cancel</Button>
                <Button type="submit" data-testid="button-save-cf" disabled={save.isPending}>
                  {save.isPending ? <Loader2 className="animate-spin mr-1" size={14} /> : null} Add Entry
                </Button>
              </div>
            </form>
          </Form>
        </DialogContent>
      </Dialog>
    </div>
  );
}
