import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import type { PipelineDeal } from "@shared/schema";
import { useLocation } from "wouter";
import { Loader2, Building2 } from "lucide-react";
import type { Project } from "@shared/schema";
import { PSA_STAGES, PROJECT_STATUS_LABELS } from "@shared/projects";
import { Button } from "@/components/ui/button";
import { useToast } from "@/hooks/use-toast";
import { fmtMoney } from "./shared";

// ── Project: the deal becomes a project when the PSA is signed ─────────────
export const OPEN_DEAL_KEY = "openDealId";

export function DealProject({ deal }: { deal: PipelineDeal }) {
  const { toast } = useToast();
  const qc = useQueryClient();
  const [, navigate] = useLocation();
  const { data: projects = [] } = useQuery<Project[]>({ queryKey: ["/api/projects"] });
  const project = projects.find(p => p.dealId === deal.id);
  const create = useMutation({
    mutationFn: () => apiRequest("POST", `/api/pipeline/${deal.id}/project`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["/api/projects"] });
      qc.invalidateQueries({ queryKey: ["/api/pipeline", deal.id, "activity"] });
      toast({ title: "Project created", description: "It's on the Projects tab, linked to this deal." });
    },
    onError: (e: Error) => toast({ title: "Could not create project", description: e.message.replace(/^\d+:\s*/, ""), variant: "destructive" }),
  });
  if (!project && !PSA_STAGES.includes(deal.stage)) return null;

  return (
    <section className="space-y-2">
      <h3 className="text-sm font-semibold text-foreground flex items-center gap-1.5"><Building2 size={14} /> Project</h3>
      {project ? (
        <div className="rounded-md border border-border p-3 flex flex-wrap items-center justify-between gap-2">
          <div className="text-sm">
            <span className="font-medium text-foreground">{project.name}</span>
            <span className="text-muted-foreground">: {PROJECT_STATUS_LABELS[project.status] ?? project.status}, budget {fmtMoney(project.totalBudget)}</span>
          </div>
          <Button size="sm" variant="ghost" className="gap-1 h-7" onClick={() => navigate("/projects")}><Building2 size={13} /> Open in Projects</Button>
        </div>
      ) : (
        <div className="rounded-md border border-dashed border-border p-3 flex flex-wrap items-center justify-between gap-2">
          <p className="text-sm text-muted-foreground">This deal is under contract but has no project yet.</p>
          <Button size="sm" variant="outline" className="gap-1" onClick={() => create.mutate()} disabled={create.isPending}>
            {create.isPending ? <Loader2 size={13} className="animate-spin" /> : <Building2 size={13} />} Create project
          </Button>
        </div>
      )}
    </section>
  );
}
