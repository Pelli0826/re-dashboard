// Small display helpers and badges used across the Pipeline page and the deal workspace.
import type { PipelineDeal } from "@shared/schema";
import { type Deadline } from "@shared/pipeline";
import { CalendarClock, Inbox } from "lucide-react";
import type { OmAnalysis } from "@shared/intake";

// ── Display helpers ─────────────────────────────────────────────────────────
export function fmtMoney(n: number | null | undefined): string {
  if (n == null) return "—";
  if (Math.abs(n) >= 1_000_000) return `$${(n / 1_000_000).toFixed(n >= 10_000_000 ? 1 : 2)}M`;
  if (Math.abs(n) >= 1_000) return `$${(n / 1_000).toFixed(0)}K`;
  return `$${n.toFixed(0)}`;
}
export function fmtDate(ymd: string | null | undefined): string {
  if (!ymd) return "—";
  const [y, m, d] = ymd.slice(0, 10).split("-").map(Number);
  return new Date(y, m - 1, d).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}
export function sizeLine(d: PipelineDeal): string {
  const parts: string[] = [];
  if (d.acres) parts.push(`${d.acres} ac`);
  if (d.sqft) parts.push(`${d.sqft.toLocaleString()} SF`);
  if (d.units) parts.push(`${d.units} units`);
  return parts.join(", ") || "—";
}
export function priceLabel(d: PipelineDeal): string {
  if (d.offerPrice) return `${fmtMoney(d.offerPrice)} offer`;
  if (d.askingPrice) return fmtMoney(d.askingPrice);
  return "Price TBD";
}
export function dealValue(d: PipelineDeal): number {
  return d.projectedValue ?? d.offerPrice ?? d.askingPrice ?? 0;
}
export const today = () => new Date().toISOString().slice(0, 10);

export const stageAccent: Record<string, string> = {
  lead: "border-t-gray-400",
  screening: "border-t-slate-500",
  loi: "border-t-blue-500",
  "due-diligence": "border-t-yellow-500",
  closing: "border-t-orange-500",
  closed: "border-t-green-500",
  dead: "border-t-red-500",
};
export const stagePill: Record<string, string> = {
  lead: "bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-300",
  screening: "bg-slate-200 text-slate-800 dark:bg-slate-800 dark:text-slate-200",
  loi: "bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-300",
  "due-diligence": "bg-yellow-100 text-yellow-800 dark:bg-yellow-900/30 dark:text-yellow-300",
  closing: "bg-orange-100 text-orange-800 dark:bg-orange-900/30 dark:text-orange-300",
  closed: "bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-300",
  dead: "bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-300",
};
export const tempDot: Record<string, string> = { hot: "bg-red-500", warm: "bg-amber-500", cold: "bg-sky-500" };

// What the server returns from /api/intake/om
export interface Intake {
  analysis: OmAnalysis; mathCheck: string[]; memo: string; brokerContactId: number | null; fileName: string; fileId: number;
  deal: Partial<PipelineDeal>;  // starting values, mapped on the server by dealFromOm (same as the Box import)
  hasIncome: boolean;
}

export function TempBadge({ t }: { t: string }) {
  return (
    <span className="inline-flex items-center gap-1 text-xs text-muted-foreground capitalize">
      <span className={`w-2 h-2 rounded-full ${tempDot[t] ?? "bg-gray-400"}`} aria-hidden /> {t}
    </span>
  );
}
export function ReviewBadge() {
  return <span className="inline-flex items-center gap-1 text-[11px] px-1.5 py-0.5 rounded whitespace-nowrap text-amber-800 bg-amber-100 dark:text-amber-300 dark:bg-amber-900/30"><Inbox size={11} />Needs review</span>;
}
export function DeadlineChip({ dl }: { dl: Deadline }) {
  const tone = dl.days < 0 ? "text-red-700 bg-red-100 dark:text-red-300 dark:bg-red-900/30"
    : dl.days <= 3 ? "text-orange-800 bg-orange-100 dark:text-orange-300 dark:bg-orange-900/30"
    : "text-muted-foreground bg-muted";
  const when = dl.days < 0 ? `${-dl.days}d overdue` : dl.days === 0 ? "today" : `in ${dl.days}d`;
  return <span className={`inline-flex items-center gap-1 text-[11px] px-1.5 py-0.5 rounded whitespace-nowrap ${tone}`}><CalendarClock size={11} />{dl.label} {when}</span>;
}

export function Fact({ label, value }: { label: string; value: React.ReactNode }) {
  if (value == null || value === "" || value === "—") return null;
  return (
    <div>
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="text-sm text-foreground">{value}</dd>
    </div>
  );
}
