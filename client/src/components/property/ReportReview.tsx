// Review what Claude read from a manager's report before any month is saved. Every amount can be
// corrected; NOI is computed here from the lines and checked against the NOI printed on the report.
import { useMemo, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import type { Property } from "@shared/schema";
import { INCOME_LINES, EXPENSE_LINES, BELOW_NOI_LINES, totalIncome, totalExpenses, noi, noiMismatch, monthLabel, type Lines, type LineKey } from "@shared/properties";
import { AlertTriangle, CheckCircle2, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { useToast } from "@/hooks/use-toast";
import { errorText } from "./PropertyFormDialog";

export interface ReadResult {
  kind: "actual" | "budget"; propertyName: string | null; notes: string | null; fileId: number;
  months: { month: string; lines: Lines; reportedNoi: number | null; occupancy: number | null }[];
  existing: string[];
}

const money = (n: number) => (n < 0 ? `(${Math.round(-n).toLocaleString()})` : Math.round(n).toLocaleString());

export function ReportReview({ property, result, fileName, onClose, onSaved }: {
  property: Property; result: ReadResult; fileName: string; onClose: () => void; onSaved: () => void;
}) {
  const { toast } = useToast();
  const qc = useQueryClient();
  const [kind, setKind] = useState(result.kind);
  // Amounts as typed (strings), so a cell can be cleared or edited freely.
  const [cells, setCells] = useState<Record<string, Record<string, string>>>(() =>
    Object.fromEntries(result.months.map(m => [m.month, Object.fromEntries(Object.entries(m.lines).map(([k, v]) => [k, v == null ? "" : String(v)]))])));
  const [include, setInclude] = useState<Record<string, boolean>>(() => Object.fromEntries(result.months.map(m => [m.month, true])));
  const lines = useMemo(() => Object.fromEntries(result.months.map(m => [m.month, Object.fromEntries(
    Object.entries(cells[m.month] ?? {}).filter(([, v]) => v.trim() !== "" && isFinite(Number(v))).map(([k, v]) => [k, Number(v)]))])) as Record<string, Lines>,
  [cells, result.months]);
  const chosen = result.months.filter(m => include[m.month]);
  const replacing = chosen.filter(m => (kind === result.kind ? result.existing : []).includes(m.month));

  const save = useMutation({
    mutationFn: () => apiRequest("PUT", `/api/properties/${property.id}/months`, {
      kind, sourceFileId: result.fileId,
      months: chosen.map(m => ({ month: m.month, lines: lines[m.month], reportedNoi: m.reportedNoi, occupancy: m.occupancy })),
    }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["/api/properties", property.id, "months"] });
      qc.invalidateQueries({ queryKey: ["/api/property-months"] });
      toast({ title: `${chosen.length} month${chosen.length === 1 ? "" : "s"} saved`, description: `${kind === "budget" ? "Budget" : "Actuals"} from ${fileName}.` });
      onSaved();
    },
    onError: (e: Error) => toast({ title: "Could not save", description: errorText(e), variant: "destructive" }),
  });

  const row = (key: LineKey, label: string) => (
    <tr key={key}>
      <td className="sticky left-0 bg-background px-3 py-1 text-xs text-muted-foreground whitespace-nowrap">{label}</td>
      {result.months.map(m => (
        <td key={m.month} className="px-1 py-0.5">
          <input aria-label={`${label}, ${monthLabel(m.month)}`} inputMode="decimal"
            className="w-24 h-7 rounded border border-input bg-background px-1.5 text-right text-xs font-mono"
            value={cells[m.month]?.[key] ?? ""} onChange={e => setCells(c => ({ ...c, [m.month]: { ...c[m.month], [key]: e.target.value } }))} />
        </td>
      ))}
    </tr>
  );
  const totalRow = (label: string, f: (l: Lines) => number, bold = false) => (
    <tr className={bold ? "font-semibold" : ""}>
      <td className="sticky left-0 bg-background px-3 py-1 text-xs whitespace-nowrap">{label}</td>
      {result.months.map(m => <td key={m.month} className="px-2 py-1 text-right text-xs font-mono">{money(f(lines[m.month] ?? {}))}</td>)}
    </tr>
  );
  const mismatched = result.months.filter(m => noiMismatch(noi(lines[m.month] ?? {}), m.reportedNoi));

  return (
    <Dialog open onOpenChange={o => { if (!o) onClose(); }}>
      <DialogContent className="max-w-6xl max-h-[92vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Review {fileName}</DialogTitle>
          <DialogDescription>
            Claude read {result.months.length} month{result.months.length === 1 ? "" : "s"}{result.propertyName ? ` for "${result.propertyName}"` : ""}.
            Check the amounts against the report and correct any cell. Nothing is saved until you click Save.
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-wrap items-center gap-3">
          <span className="text-sm text-foreground">Save as</span>
          <Select value={kind} onValueChange={v => setKind(v as "actual" | "budget")}>
            <SelectTrigger className="w-[140px] h-8" aria-label="Save as actuals or budget"><SelectValue /></SelectTrigger>
            <SelectContent><SelectItem value="actual">Actuals</SelectItem><SelectItem value="budget">Budget</SelectItem></SelectContent>
          </Select>
          {result.notes && <p className="text-xs text-muted-foreground flex-1 min-w-[240px]">Claude's note: {result.notes}</p>}
        </div>
        {mismatched.length > 0
          ? <p role="alert" className="text-sm rounded-md bg-amber-50 dark:bg-amber-900/20 text-amber-900 dark:text-amber-200 px-3 py-2 flex gap-2"><AlertTriangle size={15} className="shrink-0 mt-0.5" />
              NOI doesn't match the report for {mismatched.map(m => monthLabel(m.month, true)).join(", ")}. A line is probably in the wrong category or missing; compare those months with the report.</p>
          : result.months.some(m => m.reportedNoi != null) && <p className="text-sm text-green-700 dark:text-green-400 flex gap-1.5 items-center"><CheckCircle2 size={15} /> NOI matches the report's own NOI line for every month that has one.</p>}

        <div className="overflow-x-auto rounded-md border border-border">
          <table className="text-sm">
            <thead>
              <tr className="border-b border-border bg-muted/30">
                <th className="sticky left-0 bg-muted px-3 py-2 text-left text-xs font-medium text-muted-foreground">Month</th>
                {result.months.map(m => (
                  <th key={m.month} className="px-2 py-2 text-xs font-medium text-muted-foreground whitespace-nowrap">
                    <label className="inline-flex items-center gap-1.5">
                      <Checkbox checked={include[m.month]} onCheckedChange={v => setInclude(s => ({ ...s, [m.month]: v === true }))} aria-label={`Save ${monthLabel(m.month)}`} />
                      {monthLabel(m.month, true)}
                    </label>
                    {(kind === result.kind ? result.existing : []).includes(m.month) && <div className="text-[10px] text-amber-700 dark:text-amber-400 font-normal">replaces saved</div>}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-border/60">
              {INCOME_LINES.map(l => row(l.key, l.label))}
              {totalRow("Total income", totalIncome, true)}
              {EXPENSE_LINES.map(l => row(l.key, l.label))}
              {totalRow("Total expenses", totalExpenses, true)}
              <tr className="font-semibold bg-muted/20">
                <td className="sticky left-0 bg-muted px-3 py-1.5 text-xs whitespace-nowrap">NOI (calculated)</td>
                {result.months.map(m => {
                  const n = noi(lines[m.month] ?? {});
                  const bad = noiMismatch(n, m.reportedNoi);
                  return <td key={m.month} className={`px-2 py-1.5 text-right text-xs font-mono ${bad ? "text-amber-700 dark:text-amber-400" : "text-green-700 dark:text-green-400"}`}>{money(n)}</td>;
                })}
              </tr>
              <tr>
                <td className="sticky left-0 bg-background px-3 py-1 text-xs text-muted-foreground whitespace-nowrap">NOI on the report</td>
                {result.months.map(m => <td key={m.month} className="px-2 py-1 text-right text-xs font-mono text-muted-foreground">{m.reportedNoi == null ? "—" : money(m.reportedNoi)}</td>)}
              </tr>
              {BELOW_NOI_LINES.map(l => row(l.key, l.label))}
              <tr>
                <td className="sticky left-0 bg-background px-3 py-1 text-xs text-muted-foreground whitespace-nowrap">Occupancy</td>
                {result.months.map(m => <td key={m.month} className="px-2 py-1 text-right text-xs font-mono text-muted-foreground">{m.occupancy == null ? "—" : `${m.occupancy}%`}</td>)}
              </tr>
            </tbody>
          </table>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <p className="text-xs text-muted-foreground flex-1">
            {chosen.length} of {result.months.length} months will be saved as {kind === "budget" ? "budget" : "actuals"}.
            {replacing.length > 0 && ` ${replacing.length} replace${replacing.length === 1 ? "s" : ""} months already saved.`}
          </p>
          <Button variant="outline" onClick={onClose} disabled={save.isPending}>Cancel</Button>
          <Button onClick={() => save.mutate()} disabled={!chosen.length || save.isPending}>
            {save.isPending && <Loader2 size={13} className="animate-spin mr-1" />} Save {chosen.length} month{chosen.length === 1 ? "" : "s"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
