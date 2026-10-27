import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import type { PipelineDeal, DealMilestone } from "@shared/schema";
import { daysUntil } from "@shared/pipeline";
import { Plus, Trash2, CheckCircle2, Circle, Flag } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useToast } from "@/hooks/use-toast";
import { useConfirm } from "@/components/ConfirmDialog";

// ── Milestones: contract deadlines and approvals ────────────────────────────
export function DealMilestones({ deal }: { deal: PipelineDeal }) {
  const { toast } = useToast();
  const qc = useQueryClient();
  const confirm = useConfirm();
  const { data: all = [] } = useQuery<DealMilestone[]>({ queryKey: ["/api/milestones"] });
  const items = all.filter(m => m.dealId === deal.id)
    .sort((a, b) => (a.status === b.status ? 0 : a.status === "done" ? 1 : -1) || (a.dueDate ?? "9999").localeCompare(b.dueDate ?? "9999"));
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState({ name: "", dueDate: "", notes: "" });
  const refresh = () => {
    qc.invalidateQueries({ queryKey: ["/api/milestones"] });
    qc.invalidateQueries({ queryKey: ["/api/pipeline", deal.id, "activity"] });
  };
  const onError = (e: Error) => toast({ title: "Could not save milestone", description: e.message, variant: "destructive" });
  const add = useMutation({
    mutationFn: () => apiRequest("POST", `/api/pipeline/${deal.id}/milestones`, {
      name: draft.name.trim(), dueDate: draft.dueDate || null, notes: draft.notes.trim() || null,
    }),
    onSuccess: () => { refresh(); setDraft({ name: "", dueDate: "", notes: "" }); setAdding(false); },
    onError,
  });
  const update = useMutation({
    mutationFn: ({ id, data }: { id: number; data: Record<string, unknown> }) => apiRequest("PATCH", `/api/milestones/${id}`, data),
    onSuccess: refresh, onError,
  });
  const remove = useMutation({ mutationFn: (id: number) => apiRequest("DELETE", `/api/milestones/${id}`), onSuccess: refresh });

  return (
    <section className="space-y-2">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold text-foreground flex items-center gap-1.5"><Flag size={14} /> Milestones</h3>
        {!adding && <Button size="sm" variant="ghost" className="gap-1 h-7" onClick={() => setAdding(true)}><Plus size={13} /> Add</Button>}
      </div>
      {items.length === 0 && !adding && (
        <p className="text-sm text-muted-foreground">Contract deadlines beyond DD and closing, such as a rezoning petition or final plan approval. Claude can propose these from the PSA.</p>
      )}
      {items.length > 0 && (
        <ul className="divide-y divide-border rounded-md border border-border">
          {items.map(m => {
            const days = daysUntil(m.dueDate);
            const done = m.status === "done";
            const tone = done ? "text-muted-foreground" : days == null ? "text-muted-foreground" : days < 0 ? "text-red-700 dark:text-red-300" : days <= 14 ? "text-orange-700 dark:text-orange-300" : "text-muted-foreground";
            return (
              <li key={m.id} className="flex items-start gap-2 px-3 py-2">
                <button aria-label={done ? `Reopen ${m.name}` : `Mark ${m.name} done`} className="mt-0.5 shrink-0"
                  onClick={() => update.mutate({ id: m.id, data: { status: done ? "open" : "done" } })}>
                  {done ? <CheckCircle2 size={15} className="text-green-600" /> : <Circle size={15} className="text-muted-foreground" />}
                </button>
                <div className="min-w-0 flex-1">
                  <div className={`text-sm ${done ? "line-through text-muted-foreground" : "text-foreground"}`}>{m.name}</div>
                  {m.notes && <div className="text-xs text-muted-foreground">{m.notes}</div>}
                </div>
                <div className="text-right shrink-0">
                  <Input type="date" defaultValue={m.dueDate ?? ""} aria-label={`Date for ${m.name}`} className="h-7 w-[140px] text-xs"
                    onBlur={e => { const v = e.target.value || null; if (v !== m.dueDate) update.mutate({ id: m.id, data: { dueDate: v } }); }} />
                  <div className={`text-[11px] mt-0.5 ${tone}`}>
                    {done ? "Done" : days == null ? "Date not set" : days < 0 ? `${-days}d overdue` : days === 0 ? "Today" : days > 90 ? `In ${Math.round(days / 30.4)} months` : `In ${days}d`}
                  </div>
                </div>
                <button aria-label={`Delete ${m.name}`} className="p-1 text-muted-foreground hover:text-destructive"
                  onClick={async () => { if (await confirm({ title: `Delete milestone "${m.name}"?` })) remove.mutate(m.id); }}>
                  <Trash2 size={13} />
                </button>
              </li>
            );
          })}
        </ul>
      )}
      {adding && (
        <form className="space-y-2 rounded-md border border-dashed border-border p-3" onSubmit={e => { e.preventDefault(); if (draft.name.trim()) add.mutate(); }}>
          <div className="grid grid-cols-1 sm:grid-cols-[1fr_150px] gap-2">
            <Input autoFocus value={draft.name} onChange={e => setDraft(d => ({ ...d, name: e.target.value }))} placeholder="e.g. Rezoning petition filed" aria-label="Milestone name" />
            <Input type="date" value={draft.dueDate} onChange={e => setDraft(d => ({ ...d, dueDate: e.target.value }))} aria-label="Milestone date" />
          </div>
          <Input value={draft.notes} onChange={e => setDraft(d => ({ ...d, notes: e.target.value }))} placeholder="Contract basis, e.g. PSA §4.1: within 120 days after Inspection Period" aria-label="Milestone notes" />
          <div className="flex justify-end gap-2">
            <Button type="button" size="sm" variant="outline" onClick={() => setAdding(false)}>Cancel</Button>
            <Button type="submit" size="sm" disabled={!draft.name.trim() || add.isPending}>Add milestone</Button>
          </div>
        </form>
      )}
    </section>
  );
}
