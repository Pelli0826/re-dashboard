import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import type { Project, PipelineDeal, ArmLoan } from "@shared/schema";
import { Building2, TrendingUp, DollarSign, AlertTriangle, CheckCircle2, Clock, Loader2 } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";

function fmt(n: number | null | undefined, prefix = "$"): string {
  if (n == null) return "—";
  if (n >= 1_000_000) return `${prefix}${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${prefix}${(n / 1_000).toFixed(0)}K`;
  return `${prefix}${n.toFixed(0)}`;
}

function pct(spent: number, total: number): number {
  if (!total) return 0;
  return Math.min(100, Math.round((spent / total) * 100));
}

const statusColor: Record<string, string> = {
  planning: "bg-chart-5/20 text-purple-700 dark:text-purple-300",
  entitlement: "bg-yellow-100 text-yellow-800 dark:bg-yellow-900/30 dark:text-yellow-300",
  construction: "bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-300",
  "lease-up": "bg-orange-100 text-orange-800 dark:bg-orange-900/30 dark:text-orange-300",
  stabilized: "bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-300",
  disposition: "bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-300",
};

const pipelineStageColor: Record<string, string> = {
  prospecting: "bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-300",
  loi: "bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-300",
  "due-diligence": "bg-yellow-100 text-yellow-800 dark:bg-yellow-900/30 dark:text-yellow-300",
  "under-contract": "bg-orange-100 text-orange-800 dark:bg-orange-900/30 dark:text-orange-300",
  closed: "bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-300",
  dead: "bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-300",
};

export default function Overview() {
  const qc = useQueryClient();
  const { data: projects = [], isLoading: pLoading } = useQuery<Project[]>({ queryKey: ["/api/projects"] });
  const { data: pipeline = [], isLoading: dLoading } = useQuery<PipelineDeal[]>({ queryKey: ["/api/pipeline"] });
  const { data: arm = [], isLoading: aLoading } = useQuery<ArmLoan[]>({ queryKey: ["/api/arm"] });

  const seed = useMutation({
    mutationFn: () => apiRequest("POST", "/api/seed"),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["/api/projects"] });
      qc.invalidateQueries({ queryKey: ["/api/pipeline"] });
      qc.invalidateQueries({ queryKey: ["/api/arm"] });
    },
  });

  const loading = pLoading || dLoading || aLoading;

  // KPIs
  const totalBudget = projects.reduce((s, p) => s + p.totalBudget, 0);
  const totalSpent = projects.reduce((s, p) => s + p.spentToDate, 0);
  const projectedNoi = projects.reduce((s, p) => s + (p.projectedNoi ?? 0), 0);
  const totalDebt = arm.filter(l => l.status === "active").reduce((s, l) => s + l.currentBalance, 0);
  const activeProjects = projects.filter(p => !["stabilized", "disposition"].includes(p.status)).length;
  const pipelineValue = pipeline.filter(d => d.stage !== "dead" && d.stage !== "closed").reduce((s, d) => s + (d.projectedValue ?? 0) * (d.probability / 100), 0);

  const nextResets = arm
    .filter(l => l.nextResetDate && l.status === "active")
    .sort((a, b) => (a.nextResetDate! > b.nextResetDate! ? 1 : -1))
    .slice(0, 3);

  const isEmpty = projects.length === 0 && pipeline.length === 0 && arm.length === 0;

  if (loading) return (
    <div className="flex items-center justify-center h-64 text-muted-foreground gap-2">
      <Loader2 className="animate-spin" size={20} />
      <span>Loading dashboard…</span>
    </div>
  );

  if (isEmpty) return (
    <div className="flex flex-col items-center justify-center h-80 gap-4 text-center">
      <Building2 size={48} className="text-muted-foreground opacity-40" />
      <p className="text-lg font-semibold text-foreground">No data yet</p>
      <p className="text-sm text-muted-foreground">Load sample data to see the dashboard in action, or add your own projects.</p>
      <Button
        data-testid="button-seed"
        onClick={() => seed.mutate()}
        disabled={seed.isPending}
        className="mt-2"
      >
        {seed.isPending ? <Loader2 className="animate-spin mr-2" size={14} /> : null}
        Load Sample Data
      </Button>
    </div>
  );

  return (
    <div className="space-y-6">
      {/* KPI Row */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <KpiCard icon={<Building2 size={18} />} label="Active Projects" value={String(activeProjects)} sub={`${projects.length} total`} color="text-primary" />
        <KpiCard icon={<DollarSign size={18} />} label="Total Budget" value={fmt(totalBudget)} sub={`${fmt(totalSpent)} spent (${pct(totalSpent, totalBudget)}%)`} color="text-chart-1" />
        <KpiCard icon={<TrendingUp size={18} />} label="Projected NOI" value={fmt(projectedNoi)} sub="at stabilization" color="text-green-600 dark:text-green-400" />
        <KpiCard icon={<DollarSign size={18} />} label="Weighted Pipeline" value={fmt(pipelineValue)} sub={`${pipeline.filter(d => d.stage !== "dead").length} active deals`} color="text-orange-500" />
      </div>

      {/* Projects + ARM grid */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        {/* Active Projects */}
        <div className="lg:col-span-2">
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-sm font-semibold text-foreground">All Projects</CardTitle>
            </CardHeader>
            <CardContent className="p-0">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border">
                    <th className="text-left px-4 py-2 text-xs text-muted-foreground font-medium">Project</th>
                    <th className="text-left px-4 py-2 text-xs text-muted-foreground font-medium hidden sm:table-cell">Status</th>
                    <th className="text-right px-4 py-2 text-xs text-muted-foreground font-medium">Budget</th>
                    <th className="text-right px-4 py-2 text-xs text-muted-foreground font-medium hidden md:table-cell">NOI</th>
                    <th className="px-4 py-2 text-xs text-muted-foreground font-medium hidden lg:table-cell">Progress</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {projects.map(p => (
                    <tr key={p.id} className="hover:bg-muted/40 transition-colors">
                      <td className="px-4 py-2.5 font-medium text-foreground leading-tight">
                        <div>{p.name}</div>
                        <div className="text-xs text-muted-foreground font-normal">{p.type}</div>
                      </td>
                      <td className="px-4 py-2.5 hidden sm:table-cell">
                        <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${statusColor[p.status] ?? "bg-muted text-muted-foreground"}`}>
                          {p.status}
                        </span>
                      </td>
                      <td className="px-4 py-2.5 text-right font-mono text-foreground">{fmt(p.totalBudget)}</td>
                      <td className="px-4 py-2.5 text-right font-mono text-green-600 dark:text-green-400 hidden md:table-cell">{fmt(p.projectedNoi)}</td>
                      <td className="px-4 py-2.5 hidden lg:table-cell">
                        <div className="flex items-center gap-2">
                          <div className="flex-1 bg-muted rounded-full h-1.5 overflow-hidden">
                            <div className="bg-primary h-1.5 rounded-full transition-all" style={{ width: `${pct(p.spentToDate, p.totalBudget)}%` }} />
                          </div>
                          <span className="text-xs text-muted-foreground w-8 text-right">{pct(p.spentToDate, p.totalBudget)}%</span>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </CardContent>
          </Card>
        </div>

        {/* ARM alerts */}
        <div className="space-y-4">
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-semibold text-foreground flex items-center gap-2">
                <AlertTriangle size={14} className="text-orange-500" /> Upcoming Rate Resets
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              {nextResets.length === 0 ? (
                <p className="text-xs text-muted-foreground">No upcoming resets</p>
              ) : nextResets.map(l => (
                <div key={l.id} className="flex justify-between items-start gap-2 text-sm">
                  <div>
                    <div className="font-medium text-foreground text-xs leading-snug">{l.loanName}</div>
                    <div className="text-xs text-muted-foreground">{l.lender}</div>
                  </div>
                  <div className="text-right shrink-0">
                    <div className="font-mono text-xs font-semibold text-orange-500">{l.currentRate.toFixed(2)}%</div>
                    <div className="text-xs text-muted-foreground">{l.nextResetDate}</div>
                  </div>
                </div>
              ))}
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-semibold text-foreground flex items-center gap-2">
                <DollarSign size={14} className="text-primary" /> Total Debt
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="text-xl font-bold font-mono text-foreground">{fmt(totalDebt)}</div>
              <div className="text-xs text-muted-foreground mt-0.5">{arm.filter(l => l.status === "active").length} active loans</div>
              <div className="mt-3 space-y-1.5">
                {["construction", "bridge", "permanent", "mezz"].map(type => {
                  const loans = arm.filter(l => l.loanType === type && l.status === "active");
                  const total = loans.reduce((s, l) => s + l.currentBalance, 0);
                  if (!total) return null;
                  return (
                    <div key={type} className="flex justify-between text-xs">
                      <span className="text-muted-foreground capitalize">{type}</span>
                      <span className="font-mono font-medium text-foreground">{fmt(total)}</span>
                    </div>
                  );
                })}
              </div>
            </CardContent>
          </Card>
        </div>
      </div>

      {/* Pipeline summary */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-sm font-semibold text-foreground">Pipeline Snapshot</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border">
                  <th className="text-left px-4 py-2 text-xs text-muted-foreground font-medium">Deal</th>
                  <th className="text-left px-4 py-2 text-xs text-muted-foreground font-medium">Stage</th>
                  <th className="text-right px-4 py-2 text-xs text-muted-foreground font-medium">Ask</th>
                  <th className="text-right px-4 py-2 text-xs text-muted-foreground font-medium hidden md:table-cell">Proj. Value</th>
                  <th className="text-right px-4 py-2 text-xs text-muted-foreground font-medium">Probability</th>
                  <th className="text-right px-4 py-2 text-xs text-muted-foreground font-medium hidden lg:table-cell">Close Target</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {pipeline.filter(d => d.stage !== "dead").map(d => (
                  <tr key={d.id} className="hover:bg-muted/40 transition-colors">
                    <td className="px-4 py-2.5 font-medium text-foreground leading-tight">
                      <div>{d.name}</div>
                      <div className="text-xs text-muted-foreground font-normal">{d.type}</div>
                    </td>
                    <td className="px-4 py-2.5">
                      <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${pipelineStageColor[d.stage] ?? "bg-muted text-muted-foreground"}`}>
                        {d.stage}
                      </span>
                    </td>
                    <td className="px-4 py-2.5 text-right font-mono">{fmt(d.askingPrice)}</td>
                    <td className="px-4 py-2.5 text-right font-mono text-green-600 dark:text-green-400 hidden md:table-cell">{fmt(d.projectedValue)}</td>
                    <td className="px-4 py-2.5 text-right">
                      <span className={`font-mono font-semibold text-xs ${d.probability >= 70 ? "text-green-600 dark:text-green-400" : d.probability >= 40 ? "text-yellow-600 dark:text-yellow-400" : "text-red-600 dark:text-red-400"}`}>
                        {d.probability}%
                      </span>
                    </td>
                    <td className="px-4 py-2.5 text-right text-xs text-muted-foreground hidden lg:table-cell">{d.targetCloseDate ?? "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

function KpiCard({ icon, label, value, sub, color }: { icon: React.ReactNode; label: string; value: string; sub?: string; color?: string }) {
  return (
    <Card>
      <CardContent className="pt-4 pb-4">
        <div className="flex items-start justify-between gap-2">
          <div>
            <div className="text-xs text-muted-foreground font-medium mb-1">{label}</div>
            <div className={`text-xl font-bold font-mono ${color ?? "text-foreground"}`}>{value}</div>
            {sub && <div className="text-xs text-muted-foreground mt-0.5">{sub}</div>}
          </div>
          <div className={`mt-0.5 ${color ?? "text-muted-foreground"} opacity-70`}>{icon}</div>
        </div>
      </CardContent>
    </Card>
  );
}
