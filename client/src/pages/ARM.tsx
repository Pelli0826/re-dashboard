import { useState } from "react";
import { useConfirm } from "@/components/ConfirmDialog";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import type { ArmLoan, InsertArmLoan } from "@shared/schema";
import { insertArmLoanSchema } from "@shared/schema";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { Plus, Pencil, Trash2, Loader2, AlertTriangle, TrendingUp, Calendar } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
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

function daysUntil(dateStr: string | null | undefined): number | null {
  if (!dateStr) return null;
  const diff = new Date(dateStr).getTime() - Date.now();
  return Math.ceil(diff / (1000 * 60 * 60 * 24));
}

const loanTypeColor: Record<string, string> = {
  construction: "bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-300",
  bridge: "bg-orange-100 text-orange-800 dark:bg-orange-900/30 dark:text-orange-300",
  permanent: "bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-300",
  mezz: "bg-purple-100 text-purple-700 dark:bg-purple-900/30 dark:text-purple-300",
};

const formSchema = insertArmLoanSchema.extend({
  originalBalance: z.coerce.number().positive(),
  currentBalance: z.coerce.number().positive(),
  currentRate: z.coerce.number().positive(),
  margin: z.coerce.number().min(0),
  currentIndex: z.coerce.number().min(0),
  cap: z.coerce.number().optional(),
  floor: z.coerce.number().optional(),
  monthlyPayment: z.coerce.number().optional(),
  projectId: z.coerce.number().optional(),
});

type FormValues = z.infer<typeof formSchema>;

export default function ARM() {
  const { toast } = useToast();
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<ArmLoan | null>(null);

  const { data: loans = [], isLoading } = useQuery<ArmLoan[]>({ queryKey: ["/api/arm"] });

  const form = useForm<FormValues>({
    resolver: zodResolver(formSchema),
    defaultValues: { loanName: "", lender: "", originalBalance: 0, currentBalance: 0, currentRate: 0, indexType: "SOFR", margin: 0, currentIndex: 0, loanType: "bridge", status: "active", maturityDate: "" },
  });

  function openNew() {
    form.reset({ loanName: "", lender: "", originalBalance: 0, currentBalance: 0, currentRate: 0, indexType: "SOFR", margin: 0, currentIndex: 0, loanType: "bridge", status: "active", maturityDate: "" });
    setEditing(null);
    setOpen(true);
  }

  function openEdit(l: ArmLoan) {
    form.reset({
      ...l,
      projectId: l.projectId ?? undefined,
      cap: l.cap ?? undefined,
      floor: l.floor ?? undefined,
      monthlyPayment: l.monthlyPayment ?? undefined,
      nextResetDate: l.nextResetDate ?? undefined,
      notes: l.notes ?? undefined,
    });
    setEditing(l);
    setOpen(true);
  }

  const save = useMutation({
    mutationFn: (data: FormValues) => editing
      ? apiRequest("PATCH", `/api/arm/${editing.id}`, data)
      : apiRequest("POST", "/api/arm", data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["/api/arm"] });
      setOpen(false);
      toast({ title: editing ? "Loan updated" : "Loan added" });
    },
  });

  const confirm = useConfirm();
  const remove = useMutation({
    mutationFn: (id: number) => apiRequest("DELETE", `/api/arm/${id}`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["/api/arm"] });
      toast({ title: "Loan removed" });
    },
  });

  if (isLoading) return <div className="flex items-center gap-2 text-muted-foreground"><Loader2 className="animate-spin" size={16}/> Loading…</div>;

  const activeLoans = loans.filter(l => l.status === "active");
  const totalDebt = activeLoans.reduce((s, l) => s + l.currentBalance, 0);
  const totalMonthly = activeLoans.reduce((s, l) => s + (l.monthlyPayment ?? 0), 0);
  const avgRate = activeLoans.length ? activeLoans.reduce((s, l) => s + l.currentRate, 0) / activeLoans.length : 0;
  const nextReset = activeLoans.filter(l => l.nextResetDate).sort((a, b) => a.nextResetDate! > b.nextResetDate! ? 1 : -1)[0];

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-lg font-bold text-foreground">ARM Loans</h1>
          <p className="text-sm text-muted-foreground">{activeLoans.length} active loan{activeLoans.length !== 1 ? "s" : ""}</p>
        </div>
        <Button data-testid="button-add-loan" onClick={openNew} size="sm" className="gap-1.5">
          <Plus size={14} /> Add Loan
        </Button>
      </div>

      {/* KPIs */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <Card>
          <CardContent className="pt-4 pb-4">
            <div className="text-xs text-muted-foreground mb-1">Total Active Debt</div>
            <div className="text-xl font-bold font-mono text-foreground">{fmt(totalDebt)}</div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-4 pb-4">
            <div className="text-xs text-muted-foreground mb-1">Avg Interest Rate</div>
            <div className="text-xl font-bold font-mono text-orange-500">{avgRate.toFixed(2)}%</div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-4 pb-4">
            <div className="text-xs text-muted-foreground mb-1">Monthly Debt Service</div>
            <div className="text-xl font-bold font-mono text-foreground">{fmt(totalMonthly)}</div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-4 pb-4">
            <div className="flex items-center gap-1.5 mb-1">
              <AlertTriangle size={12} className="text-orange-500" />
              <div className="text-xs text-muted-foreground">Next Rate Reset</div>
            </div>
            {nextReset ? (
              <>
                <div className="text-sm font-semibold text-foreground leading-snug">{nextReset.loanName}</div>
                <div className="text-xs text-orange-500 font-mono mt-0.5">{nextReset.nextResetDate} ({daysUntil(nextReset.nextResetDate)}d)</div>
              </>
            ) : <div className="text-sm text-muted-foreground">None upcoming</div>}
          </CardContent>
        </Card>
      </div>

      {/* Loans table */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm font-semibold">Loan Portfolio</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border">
                  <th className="text-left px-4 py-2 text-xs text-muted-foreground font-medium">Loan</th>
                  <th className="text-left px-4 py-2 text-xs text-muted-foreground font-medium">Type</th>
                  <th className="text-right px-4 py-2 text-xs text-muted-foreground font-medium">Balance</th>
                  <th className="text-right px-4 py-2 text-xs text-muted-foreground font-medium">Rate</th>
                  <th className="text-right px-4 py-2 text-xs text-muted-foreground font-medium hidden md:table-cell">Index</th>
                  <th className="text-right px-4 py-2 text-xs text-muted-foreground font-medium hidden lg:table-cell">Cap / Floor</th>
                  <th className="text-right px-4 py-2 text-xs text-muted-foreground font-medium hidden md:table-cell">Monthly</th>
                  <th className="text-right px-4 py-2 text-xs text-muted-foreground font-medium">Next Reset</th>
                  <th className="text-right px-4 py-2 text-xs text-muted-foreground font-medium">Maturity</th>
                  <th className="px-4 py-2" />
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {loans.map(l => {
                  const resetDays = daysUntil(l.nextResetDate);
                  const maturityDays = daysUntil(l.maturityDate);
                  return (
                    <tr key={l.id} data-testid={`row-loan-${l.id}`} className="hover:bg-muted/40 transition-colors">
                      <td className="px-4 py-2.5 font-medium text-foreground">
                        <div className="leading-snug">{l.loanName}</div>
                        <div className="text-xs text-muted-foreground font-normal">{l.lender}</div>
                      </td>
                      <td className="px-4 py-2.5">
                        <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${loanTypeColor[l.loanType] ?? "bg-muted text-muted-foreground"}`}>
                          {l.loanType}
                        </span>
                      </td>
                      <td className="px-4 py-2.5 text-right font-mono">{fmt(l.currentBalance)}</td>
                      <td className="px-4 py-2.5 text-right">
                        <span className={`font-mono font-semibold ${l.currentRate >= 8 ? "text-red-600 dark:text-red-400" : l.currentRate >= 6 ? "text-orange-500" : "text-foreground"}`}>
                          {l.currentRate.toFixed(2)}%
                        </span>
                      </td>
                      <td className="px-4 py-2.5 text-right text-xs hidden md:table-cell">
                        <div className="font-mono text-muted-foreground">{l.indexType}</div>
                        {l.indexType !== "fixed" && <div className="text-muted-foreground">{l.currentIndex.toFixed(2)}% + {l.margin.toFixed(2)}%</div>}
                      </td>
                      <td className="px-4 py-2.5 text-right text-xs font-mono hidden lg:table-cell">
                        {l.cap != null ? <span className="text-red-500">{l.cap}%</span> : "—"} / {l.floor != null ? <span className="text-green-500">{l.floor}%</span> : "—"}
                      </td>
                      <td className="px-4 py-2.5 text-right font-mono text-sm hidden md:table-cell">{fmt(l.monthlyPayment)}</td>
                      <td className="px-4 py-2.5 text-right text-xs">
                        {l.nextResetDate ? (
                          <div>
                            <div className={resetDays != null && resetDays <= 90 ? "text-orange-500 font-semibold" : "text-muted-foreground"}>{l.nextResetDate}</div>
                            {resetDays != null && <div className="text-muted-foreground">{resetDays}d</div>}
                          </div>
                        ) : <span className="text-muted-foreground">—</span>}
                      </td>
                      <td className="px-4 py-2.5 text-right text-xs">
                        {l.maturityDate ? (
                          <div>
                            <div className={maturityDays != null && maturityDays <= 180 ? "text-red-500 font-semibold" : "text-muted-foreground"}>{l.maturityDate}</div>
                            {maturityDays != null && <div className="text-muted-foreground">{maturityDays}d</div>}
                          </div>
                        ) : "—"}
                      </td>
                      <td className="px-4 py-2.5">
                        <div className="flex gap-1 justify-end">
                          <button onClick={() => openEdit(l)} className="p-1.5 hover:bg-muted rounded text-muted-foreground hover:text-foreground transition-colors" data-testid={`button-edit-loan-${l.id}`}><Pencil size={12} /></button>
                          <button onClick={async () => { if (await confirm({ title: `Delete ${l.loanName}?` })) remove.mutate(l.id); }} className="p-1.5 hover:bg-destructive/10 rounded text-muted-foreground hover:text-destructive transition-colors" data-testid={`button-delete-loan-${l.id}`}><Trash2 size={12} /></button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>

      {/* Rate Stress Analysis */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm font-semibold flex items-center gap-2">
            <TrendingUp size={14} className="text-orange-500" /> Rate Stress Analysis
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border">
                  <th className="text-left px-3 py-2 text-xs text-muted-foreground font-medium">Loan</th>
                  <th className="text-right px-3 py-2 text-xs text-muted-foreground font-medium">Current Rate</th>
                  <th className="text-right px-3 py-2 text-xs text-muted-foreground font-medium">+100bps</th>
                  <th className="text-right px-3 py-2 text-xs text-muted-foreground font-medium">+200bps</th>
                  <th className="text-right px-3 py-2 text-xs text-muted-foreground font-medium">Rate Cap</th>
                  <th className="text-right px-3 py-2 text-xs text-muted-foreground font-medium">Balance</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {activeLoans.filter(l => l.indexType !== "fixed").map(l => {
                  const monthly = l.currentBalance * (l.currentRate / 100) / 12;
                  const monthly100 = l.currentBalance * ((l.currentRate + 1) / 100) / 12;
                  const monthly200 = l.currentBalance * (Math.min(l.currentRate + 2, l.cap ?? 99) / 100) / 12;
                  return (
                    <tr key={l.id} className="hover:bg-muted/40 transition-colors">
                      <td className="px-3 py-2 font-medium text-foreground text-xs">{l.loanName}</td>
                      <td className="px-3 py-2 text-right font-mono text-xs">
                        <div className="text-foreground">{l.currentRate.toFixed(2)}%</div>
                        <div className="text-muted-foreground">{fmt(monthly)}/mo</div>
                      </td>
                      <td className="px-3 py-2 text-right font-mono text-xs">
                        <div className="text-yellow-600 dark:text-yellow-400">{(l.currentRate + 1).toFixed(2)}%</div>
                        <div className="text-muted-foreground">{fmt(monthly100)}/mo</div>
                      </td>
                      <td className="px-3 py-2 text-right font-mono text-xs">
                        <div className="text-red-500">{Math.min(l.currentRate + 2, l.cap ?? 99).toFixed(2)}%{l.cap && l.currentRate + 2 >= l.cap ? " (capped)" : ""}</div>
                        <div className="text-muted-foreground">{fmt(monthly200)}/mo</div>
                      </td>
                      <td className="px-3 py-2 text-right font-mono text-xs text-red-400">{l.cap ? `${l.cap}%` : "No cap"}</td>
                      <td className="px-3 py-2 text-right font-mono text-xs">{fmt(l.currentBalance)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{editing ? "Edit Loan" : "New ARM Loan"}</DialogTitle>
          </DialogHeader>
          <Form {...form}>
            <form onSubmit={form.handleSubmit(d => save.mutate(d))} className="space-y-4">
              <div className="grid grid-cols-2 gap-4">
                <FormField control={form.control} name="loanName" render={({ field }) => (
                  <FormItem className="col-span-2">
                    <FormLabel>Loan Name</FormLabel>
                    <FormControl><Input data-testid="input-loan-name" placeholder="e.g. Meridian Construction Loan" {...field} /></FormControl>
                    <FormMessage />
                  </FormItem>
                )} />
                <FormField control={form.control} name="lender" render={({ field }) => (
                  <FormItem>
                    <FormLabel>Lender</FormLabel>
                    <FormControl><Input data-testid="input-lender" placeholder="e.g. Inland Bank" {...field} /></FormControl>
                    <FormMessage />
                  </FormItem>
                )} />
                <FormField control={form.control} name="loanType" render={({ field }) => (
                  <FormItem>
                    <FormLabel>Loan Type</FormLabel>
                    <Select value={field.value} onValueChange={field.onChange}>
                      <FormControl><SelectTrigger data-testid="select-loan-type"><SelectValue /></SelectTrigger></FormControl>
                      <SelectContent>
                        <SelectItem value="construction">Construction</SelectItem>
                        <SelectItem value="bridge">Bridge</SelectItem>
                        <SelectItem value="permanent">Permanent</SelectItem>
                        <SelectItem value="mezz">Mezz</SelectItem>
                      </SelectContent>
                    </Select>
                    <FormMessage />
                  </FormItem>
                )} />
                <FormField control={form.control} name="originalBalance" render={({ field }) => (
                  <FormItem>
                    <FormLabel>Original Balance ($)</FormLabel>
                    <FormControl><Input data-testid="input-orig-balance" type="number" {...field} /></FormControl>
                    <FormMessage />
                  </FormItem>
                )} />
                <FormField control={form.control} name="currentBalance" render={({ field }) => (
                  <FormItem>
                    <FormLabel>Current Balance ($)</FormLabel>
                    <FormControl><Input data-testid="input-cur-balance" type="number" {...field} /></FormControl>
                    <FormMessage />
                  </FormItem>
                )} />
                <FormField control={form.control} name="currentRate" render={({ field }) => (
                  <FormItem>
                    <FormLabel>Current Rate (%)</FormLabel>
                    <FormControl><Input data-testid="input-rate" type="number" step="0.01" {...field} /></FormControl>
                    <FormMessage />
                  </FormItem>
                )} />
                <FormField control={form.control} name="indexType" render={({ field }) => (
                  <FormItem>
                    <FormLabel>Index Type</FormLabel>
                    <Select value={field.value} onValueChange={field.onChange}>
                      <FormControl><SelectTrigger data-testid="select-index"><SelectValue /></SelectTrigger></FormControl>
                      <SelectContent>
                        <SelectItem value="SOFR">SOFR</SelectItem>
                        <SelectItem value="Prime">Prime</SelectItem>
                        <SelectItem value="LIBOR">LIBOR</SelectItem>
                        <SelectItem value="fixed">Fixed</SelectItem>
                      </SelectContent>
                    </Select>
                    <FormMessage />
                  </FormItem>
                )} />
                <FormField control={form.control} name="currentIndex" render={({ field }) => (
                  <FormItem>
                    <FormLabel>Current Index (%)</FormLabel>
                    <FormControl><Input data-testid="input-index-value" type="number" step="0.01" {...field} /></FormControl>
                    <FormMessage />
                  </FormItem>
                )} />
                <FormField control={form.control} name="margin" render={({ field }) => (
                  <FormItem>
                    <FormLabel>Margin (%)</FormLabel>
                    <FormControl><Input data-testid="input-margin" type="number" step="0.01" {...field} /></FormControl>
                    <FormMessage />
                  </FormItem>
                )} />
                <FormField control={form.control} name="cap" render={({ field }) => (
                  <FormItem>
                    <FormLabel>Rate Cap (%)</FormLabel>
                    <FormControl><Input data-testid="input-cap" type="number" step="0.01" {...field} value={field.value ?? ""} /></FormControl>
                    <FormMessage />
                  </FormItem>
                )} />
                <FormField control={form.control} name="floor" render={({ field }) => (
                  <FormItem>
                    <FormLabel>Rate Floor (%)</FormLabel>
                    <FormControl><Input data-testid="input-floor" type="number" step="0.01" {...field} value={field.value ?? ""} /></FormControl>
                    <FormMessage />
                  </FormItem>
                )} />
                <FormField control={form.control} name="monthlyPayment" render={({ field }) => (
                  <FormItem>
                    <FormLabel>Monthly Payment ($)</FormLabel>
                    <FormControl><Input data-testid="input-monthly" type="number" {...field} value={field.value ?? ""} /></FormControl>
                    <FormMessage />
                  </FormItem>
                )} />
                <FormField control={form.control} name="status" render={({ field }) => (
                  <FormItem>
                    <FormLabel>Status</FormLabel>
                    <Select value={field.value} onValueChange={field.onChange}>
                      <FormControl><SelectTrigger data-testid="select-loan-status"><SelectValue /></SelectTrigger></FormControl>
                      <SelectContent>
                        <SelectItem value="active">Active</SelectItem>
                        <SelectItem value="paid-off">Paid Off</SelectItem>
                        <SelectItem value="refinanced">Refinanced</SelectItem>
                      </SelectContent>
                    </Select>
                    <FormMessage />
                  </FormItem>
                )} />
                <FormField control={form.control} name="nextResetDate" render={({ field }) => (
                  <FormItem>
                    <FormLabel>Next Reset Date</FormLabel>
                    <FormControl><Input data-testid="input-reset-date" type="date" {...field} value={field.value ?? ""} /></FormControl>
                    <FormMessage />
                  </FormItem>
                )} />
                <FormField control={form.control} name="maturityDate" render={({ field }) => (
                  <FormItem>
                    <FormLabel>Maturity Date</FormLabel>
                    <FormControl><Input data-testid="input-maturity" type="date" {...field} /></FormControl>
                    <FormMessage />
                  </FormItem>
                )} />
                <FormField control={form.control} name="notes" render={({ field }) => (
                  <FormItem className="col-span-2">
                    <FormLabel>Notes</FormLabel>
                    <FormControl><Input data-testid="input-loan-notes" placeholder="Optional notes" {...field} value={field.value ?? ""} /></FormControl>
                    <FormMessage />
                  </FormItem>
                )} />
              </div>
              <div className="flex justify-end gap-2 pt-2">
                <Button type="button" variant="outline" onClick={() => setOpen(false)}>Cancel</Button>
                <Button type="submit" data-testid="button-save-loan" disabled={save.isPending}>
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
