import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import type { PipelineDeal } from "@shared/schema";
import { Loader2, MessageSquare, Send, Check } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/hooks/use-toast";
import { fmtDate, today } from "./shared";

// ── Suggested changes from Claude ───────────────────────────────────────────
interface Proposal {
  type: string; reason: string; summary: string; ruleText?: string; problem?: string; date?: string | null;
  [key: string]: unknown;
}

function ProposalCards({ deal, proposals }: { deal: PipelineDeal; proposals: Proposal[] }) {
  const { toast } = useToast();
  const qc = useQueryClient();
  const [state, setState] = useState<Record<number, "applied" | "dismissed" | "busy">>({});
  async function apply(i: number) {
    setState(s => ({ ...s, [i]: "busy" }));
    try {
      await apiRequest("POST", `/api/pipeline/${deal.id}/apply`, proposals[i]);
      setState(s => ({ ...s, [i]: "applied" }));
      qc.invalidateQueries(); // dates, tasks, milestones and the activity log may all have changed
    } catch (e: any) {
      setState(s => { const n = { ...s }; delete n[i]; return n; });
      toast({ title: "Could not apply", description: String(e.message).replace(/^\d+:\s*/, "").replace(/^\{"message":"|"\}$/g, ""), variant: "destructive" });
    }
  }
  const pending = proposals.map((_, i) => i).filter(i => !state[i] && !proposals[i].problem);
  async function applyAll() { for (const i of pending) await apply(i); }

  return (
    <div className="space-y-2" aria-label="Suggested changes">
      <div className="flex items-center justify-between">
        <span className="text-xs font-semibold text-foreground">Suggested changes ({proposals.length})</span>
        {pending.length > 1 && <Button size="sm" variant="outline" className="h-7" onClick={applyAll}>Apply all {pending.length}</Button>}
      </div>
      {proposals.map((p, i) => {
        const st = state[i];
        return (
          <div key={i} className={`rounded-md border px-3 py-2 text-sm ${st === "applied" ? "border-green-300 bg-green-50 dark:bg-green-900/20 dark:border-green-800" : st === "dismissed" ? "border-border opacity-50" : "border-border"}`}>
            <div className="flex items-start gap-2">
              <div className="min-w-0 flex-1 space-y-0.5">
                <div className="font-medium text-foreground">{p.summary}</div>
                {p.ruleText && <div className="text-xs text-muted-foreground">Date: {p.ruleText}{p.date ? ` = ${fmtDate(p.date)}` : ""}</div>}
                {p.reason && <div className="text-xs text-muted-foreground">{p.reason}</div>}
                {p.problem && <div className="text-xs text-red-700 dark:text-red-300">{p.problem}</div>}
              </div>
              {st === "applied" ? (
                <span className="text-xs text-green-700 dark:text-green-300 flex items-center gap-1 shrink-0"><Check size={13} /> Applied</span>
              ) : st === "dismissed" ? (
                <span className="text-xs text-muted-foreground shrink-0">Dismissed</span>
              ) : (
                <div className="flex gap-1 shrink-0">
                  <Button size="sm" className="h-7" disabled={st === "busy" || !!p.problem} onClick={() => apply(i)}>
                    {st === "busy" ? <Loader2 size={13} className="animate-spin" /> : "Apply"}
                  </Button>
                  <Button size="sm" variant="ghost" className="h-7" onClick={() => setState(s => ({ ...s, [i]: "dismissed" }))}>Dismiss</Button>
                </div>
              )}
            </div>
          </div>
        );
      })}
      <p className="text-xs text-muted-foreground">Check each against the documents before applying. Applied changes are noted in the activity log.</p>
    </div>
  );
}

// ── Ask about this deal ─────────────────────────────────────────────────────
interface QA { question: string; answer: string; filesUsed: string[]; filesSkipped?: string[]; proposals?: Proposal[]; saved?: boolean }
const SUGGESTED = [
  "Summarize this deal for my partner",
  "What are the biggest risks, and what would resolve them?",
  "What has the broker told us so far?",
  "What should we ask for before submitting an LOI?",
  "Set up milestones and task dates from the PSA",
];

export function AskDeal({ deal }: { deal: PipelineDeal }) {
  const { toast } = useToast();
  const qc = useQueryClient();
  const [question, setQuestion] = useState("");
  const [thread, setThread] = useState<QA[]>([]);
  const { data: system } = useQuery<{ omIntake?: boolean }>({ queryKey: ["/api/system"] });

  const ask = useMutation({
    mutationFn: async (q: string) => {
      const history = thread.flatMap(t => [{ role: "user", content: t.question }, { role: "assistant", content: t.answer }]);
      const res = await apiRequest("POST", `/api/pipeline/${deal.id}/ask`, { question: q, history });
      return { question: q, ...(await res.json()) } as QA;
    },
    onSuccess: qa => { setThread(t => [...t, qa]); setQuestion(""); },
    onError: (e: Error) => toast({ title: "Could not get an answer", description: e.message.replace(/^\d+:\s*/, "").replace(/^\{"message":"|"\}$/g, ""), variant: "destructive" }),
  });
  const save = useMutation({
    mutationFn: (i: number) => apiRequest("POST", `/api/pipeline/${deal.id}/activity`, {
      kind: "note", date: today(), summary: `Q: ${thread[i].question}\n\n${thread[i].answer}`,
    }),
    onSuccess: (_r, i) => {
      setThread(t => t.map((x, j) => j === i ? { ...x, saved: true } : x));
      qc.invalidateQueries({ queryKey: ["/api/pipeline", deal.id, "activity"] });
      qc.invalidateQueries({ queryKey: ["/api/pipeline"] });
    },
  });
  const submit = (q: string) => { if (q.trim() && !ask.isPending) ask.mutate(q.trim()); };

  return (
    <section className="space-y-3">
      <h3 className="text-sm font-semibold text-foreground flex items-center gap-1.5"><MessageSquare size={14} /> Ask about this deal</h3>
      {!system?.omIntake ? (
        <p className="text-sm text-muted-foreground">Add ANTHROPIC_API_KEY in Railway to turn this on.</p>
      ) : (
        <>
          <p className="text-xs text-muted-foreground">Claude answers from this deal's saved PDF, Excel and Word files, notes, activity log, tasks, milestones and underwriting, and says where each answer comes from. It can also suggest changes for you to apply.</p>
          {thread.map((t, i) => (
            <div key={i} className="space-y-1.5">
              <p className="text-sm font-medium text-foreground">{t.question}</p>
              <div className="rounded-md bg-muted/50 px-3 py-2 text-sm text-foreground whitespace-pre-line">{t.answer}</div>
              {!!t.proposals?.length && <ProposalCards deal={deal} proposals={t.proposals} />}
              <div className="flex items-center gap-3 text-xs text-muted-foreground">
                <span>
                  {t.filesUsed.length ? `Read: ${t.filesUsed.join(", ")}` : "No readable files on this deal; answered from dashboard data"}
                  {t.filesSkipped?.length ? `. Couldn't read: ${t.filesSkipped.join(", ")}` : ""}
                </span>
                <button className="ml-auto hover:text-foreground disabled:opacity-60" disabled={t.saved || save.isPending} onClick={() => save.mutate(i)}>
                  {t.saved ? "Saved to activity" : "Save to activity log"}
                </button>
              </div>
            </div>
          ))}
          {thread.length === 0 && (
            <div className="flex flex-wrap gap-1.5">
              {SUGGESTED.map(q => (
                <button key={q} onClick={() => submit(q)} disabled={ask.isPending}
                  className="text-xs rounded-full border border-border px-2.5 py-1 text-muted-foreground hover:text-foreground hover:bg-muted/50">{q}</button>
              ))}
            </div>
          )}
          <form className="flex gap-2 items-end" onSubmit={e => { e.preventDefault(); submit(question); }}>
            <Textarea rows={2} value={question} onChange={e => setQuestion(e.target.value)} aria-label="Question about this deal"
              placeholder={thread.length ? "Ask a follow-up" : "e.g. What did the OM say about sewer capacity?"}
              onKeyDown={e => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); submit(question); } }} />
            <Button type="submit" size="icon" disabled={!question.trim() || ask.isPending} aria-label="Ask">
              {ask.isPending ? <Loader2 size={15} className="animate-spin" /> : <Send size={15} />}
            </Button>
          </form>
          {ask.isPending && <p className="text-xs text-muted-foreground">Reading the deal materials. Usually 10 to 40 seconds.</p>}
        </>
      )}
    </section>
  );
}
