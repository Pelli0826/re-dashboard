// Morning email digest: deadlines, overdue tasks and quiet deals, sent to the
// addresses in DIGEST_TO through Resend's HTTPS API (Railway Hobby blocks SMTP).
//
// Railway variables:
//   RESEND_API_KEY  required to send
//   DIGEST_TO       required: comma-separated recipients
//   DIGEST_FROM     optional, default "RE Dashboard <onboarding@resend.dev>"
//                   (the default can only send to your own Resend account email)
//   DIGEST_HOUR     optional, 0-23, default 7
//   DIGEST_TZ       optional, default America/New_York
//   DIGEST_DAYS     optional: "weekdays" (default) or "daily"
//   APP_URL         optional link target; defaults to the Railway public domain

import { storage, getState, setState } from "./storage";
import {
  ACTIVE_STAGES, STAGE_LABELS, dealAlerts, daysUntil, type Stage,
} from "@shared/pipeline";
import type { PipelineDeal, Task } from "@shared/schema";

const LAST_SENT_KEY = "digest:lastSentDate";
const LAST_ERROR_KEY = "digest:lastError";

export function digestConfig() {
  const to = (process.env.DIGEST_TO ?? "").split(",").map(s => s.trim()).filter(Boolean);
  const hour = Math.min(23, Math.max(0, parseInt(process.env.DIGEST_HOUR ?? "7", 10) || 7));
  return {
    configured: Boolean(process.env.RESEND_API_KEY && to.length),
    hasKey: Boolean(process.env.RESEND_API_KEY),
    to,
    from: process.env.DIGEST_FROM || "RE Dashboard <onboarding@resend.dev>",
    hour,
    tz: process.env.DIGEST_TZ || "America/New_York",
    days: process.env.DIGEST_DAYS === "daily" ? "daily" : "weekdays",
    appUrl: process.env.APP_URL || (process.env.RAILWAY_PUBLIC_DOMAIN ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}` : ""),
  };
}

// Current date/hour/weekday in the digest's timezone.
function localNow(tz: string, at = new Date()) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-US", {
    timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", hourCycle: "h23", weekday: "short",
  }).formatToParts(at).map(p => [p.type, p.value]));
  const ymd = `${parts.year}-${parts.month}-${parts.day}`;
  return { ymd, hour: Number(parts.hour), weekday: parts.weekday as string, noon: new Date(`${ymd}T12:00:00`) };
}

const esc = (s: string) => s.replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]!));
const money = (n: number | null | undefined) =>
  n == null ? "" : n >= 1e6 ? `$${(n / 1e6).toFixed(2)}M` : `$${Math.round(n / 1e3)}K`;
function longDate(ymd: string) {
  const [y, m, d] = ymd.split("-").map(Number);
  return new Date(y, m - 1, d).toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" });
}
function whenLabel(days: number) {
  return days < 0 ? `${-days} day${days === -1 ? "" : "s"} overdue` : days === 0 ? "today" : days === 1 ? "tomorrow" : `in ${days} days`;
}

export interface Digest { subject: string; html: string; text: string; urgentCount: number; date: string }

export function buildDigest(at = new Date()): Digest {
  const cfg = digestConfig();
  const { ymd, noon } = localNow(cfg.tz, at);
  const deals = storage.getPipeline();
  const active = deals.filter(d => ACTIVE_STAGES.includes(d.stage as Stage));
  const dealById = new Map(deals.map(d => [d.id, d]));
  const projectById = new Map(storage.getProjects().map(p => [p.id, p]));

  // Deal deadlines: overdue or within the next 3 days (Friday's email covers the weekend).
  const alerts = dealAlerts(active, noon);
  const deadlines = alerts.filter(a => a.kind === "deadline" && a.deadline!.days <= 3)
    .sort((a, b) => a.deadline!.days - b.deadline!.days);
  const followUps = alerts.filter(a => a.kind !== "deadline");

  // Tasks: overdue, due today, or with a reminder set for today.
  const open = storage.getTasks().filter(t => t.status !== "done");
  const taskRows = open
    .map(t => ({ t, due: daysUntil(t.dueDate, noon), remind: t.reminderDate === ymd }))
    .filter(x => (x.due != null && x.due <= 0) || x.remind)
    .sort((a, b) => (a.due ?? 99) - (b.due ?? 99));
  const upcoming = open.filter(t => { const d = daysUntil(t.dueDate, noon); return d != null && d > 0 && d <= 3; }).length;

  const newDeals = deals.filter(d => (Date.now() - new Date(d.createdAt).getTime()) < 86_400_000 * (localNow(cfg.tz, at).weekday === "Mon" ? 3 : 1));
  const byStage = ACTIVE_STAGES.map(s => ({ s, n: active.filter(d => d.stage === s).length })).filter(x => x.n);

  const urgentCount = deadlines.length + taskRows.filter(x => x.due != null && x.due <= 0).length;
  const subject = urgentCount
    ? `${urgentCount} item${urgentCount === 1 ? "" : "s"} need attention today: ${longDate(ymd)}`
    : `Nothing urgent today: ${longDate(ymd)}`;

  const taskContext = (t: Task) => {
    if (t.dealId && dealById.get(t.dealId)) return dealById.get(t.dealId)!.dealCode;
    if (t.projectId && projectById.get(t.projectId)) return projectById.get(t.projectId)!.name;
    return "";
  };
  const dealLine = (d: PipelineDeal) => `${d.name} (${d.dealCode}, ${STAGE_LABELS[d.stage as Stage]})`;

  // ── Plain text ──
  const lines: string[] = [subject, ""];
  const section = (title: string, rows: string[]) => { if (rows.length) lines.push(title.toUpperCase(), ...rows.map(r => `- ${r}`), ""); };
  section("Deal deadlines", deadlines.map(a => `${dealLine(a.deal)}: ${a.deadline!.label} ${whenLabel(a.deadline!.days)}`));
  section("Tasks", taskRows.map(({ t, due, remind }) =>
    `${t.title}${taskContext(t) ? ` [${taskContext(t)}]` : ""}: ${due != null && due <= 0 ? (due === 0 ? "due today" : `${-due} days overdue`) : remind ? "reminder today" : ""}`));
  section("Follow up", followUps.map(a => `${dealLine(a.deal)}: ${a.text}`));
  if (!deadlines.length && !taskRows.length && !followUps.length) lines.push("No deadlines, overdue tasks or quiet deals today.", "");
  lines.push(`Pipeline: ${active.length} active deal${active.length === 1 ? "" : "s"}${byStage.length ? ` (${byStage.map(x => `${x.n} ${STAGE_LABELS[x.s]}`).join(", ")})` : ""}.`);
  if (newDeals.length) lines.push(`New: ${newDeals.map(d => d.name).join(", ")}.`);
  if (upcoming) lines.push(`${upcoming} more task${upcoming === 1 ? "" : "s"} due in the next 3 days.`);
  if (cfg.appUrl) lines.push("", `Open the dashboard: ${cfg.appUrl}/#/pipeline`);

  // ── HTML (inline styles for email clients) ──
  const td = 'style="padding:8px 0;border-top:1px solid #e5e7eb;vertical-align:top;font-size:14px;color:#111827"';
  const tag = (text: string, tone: "red" | "amber" | "gray") => {
    const c = { red: "#b91c1c;background:#fee2e2", amber: "#92400e;background:#fef3c7", gray: "#374151;background:#f3f4f6" }[tone];
    return `<span style="display:inline-block;padding:1px 8px;border-radius:10px;font-size:12px;color:${c}">${esc(text)}</span>`;
  };
  const block = (title: string, rows: string[]) => rows.length
    ? `<h2 style="font-size:15px;margin:24px 0 4px;color:#111827">${esc(title)}</h2><table role="presentation" width="100%" cellspacing="0" cellpadding="0">${rows.join("")}</table>`
    : "";
  const link = (path: string, text: string) => cfg.appUrl ? `<a href="${esc(cfg.appUrl)}/#${path}" style="color:#155e75;text-decoration:none">${esc(text)}</a>` : esc(text);

  const html = `<!doctype html><html><body style="margin:0;background:#f9fafb;font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif">
<div style="max-width:600px;margin:0 auto;padding:24px;background:#ffffff">
  <p style="margin:0;font-size:12px;color:#6b7280">RE Dashboard morning email</p>
  <h1 style="font-size:20px;margin:4px 0 0;color:#111827">${esc(longDate(ymd))}</h1>
  <p style="margin:4px 0 0;font-size:14px;color:#374151">${urgentCount ? `${urgentCount} item${urgentCount === 1 ? "" : "s"} need attention today.` : "Nothing urgent today."}</p>
  ${block("Deal deadlines", deadlines.map(a => `<tr><td ${td}>${link("/pipeline", a.deal.name)}<br><span style="font-size:12px;color:#6b7280">${esc(a.deal.dealCode)}, ${esc(STAGE_LABELS[a.deal.stage as Stage])}${a.deal.offerPrice || a.deal.askingPrice ? `, ${money(a.deal.offerPrice ?? a.deal.askingPrice)}` : ""}</span></td><td ${td} align="right">${esc(a.deadline!.label)}<br>${tag(whenLabel(a.deadline!.days), a.deadline!.days <= 0 ? "red" : "amber")}</td></tr>`))}
  ${block("Tasks", taskRows.map(({ t, due, remind }) => `<tr><td ${td}>${link("/tasks", t.title)}${taskContext(t) ? `<br><span style="font-size:12px;color:#6b7280">${esc(taskContext(t))}</span>` : ""}</td><td ${td} align="right">${due != null && due <= 0 ? tag(due === 0 ? "due today" : `${-due}d overdue`, due < 0 ? "red" : "amber") : remind ? tag("reminder", "gray") : ""}</td></tr>`))}
  ${block("Follow up", followUps.map(a => `<tr><td ${td}>${link("/pipeline", a.deal.name)}<br><span style="font-size:12px;color:#6b7280">${esc(a.text)}</span></td><td ${td} align="right">${tag(STAGE_LABELS[a.deal.stage as Stage], "gray")}</td></tr>`))}
  ${!deadlines.length && !taskRows.length && !followUps.length ? `<p style="font-size:14px;color:#374151;margin:24px 0 0">No deadlines, overdue tasks or quiet deals today.</p>` : ""}
  <div style="margin-top:24px;padding:12px 16px;background:#f3f4f6;border-radius:8px;font-size:13px;color:#374151">
    <strong>Pipeline:</strong> ${active.length} active${byStage.length ? `: ${esc(byStage.map(x => `${x.n} ${STAGE_LABELS[x.s]}`).join(", "))}` : ""}
    ${newDeals.length ? `<br><strong>New:</strong> ${esc(newDeals.map(d => d.name).join(", "))}` : ""}
    ${upcoming ? `<br>${upcoming} more task${upcoming === 1 ? "" : "s"} due in the next 3 days.` : ""}
  </div>
  ${cfg.appUrl ? `<p style="margin:24px 0 0"><a href="${esc(cfg.appUrl)}/#/pipeline" style="display:inline-block;padding:10px 16px;background:#155e75;color:#ffffff;border-radius:6px;text-decoration:none;font-size:14px">Open the dashboard</a></p>` : ""}
</div></body></html>`;

  return { subject, html, text: lines.join("\n"), urgentCount, date: ymd };
}

export async function sendDigest(opts: { test?: boolean } = {}): Promise<{ id?: string; to: string[] }> {
  const cfg = digestConfig();
  if (!cfg.hasKey) throw new Error("Add RESEND_API_KEY in Railway to send email.");
  if (!cfg.to.length) throw new Error("Add DIGEST_TO in Railway (comma-separated email addresses).");
  const digest = buildDigest();
  const res = await fetch(`${process.env.RESEND_BASE_URL || "https://api.resend.com"}/emails`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
      "Content-Type": "application/json",
      // One scheduled send per day even if the server restarts mid-send.
      ...(opts.test ? {} : { "Idempotency-Key": `digest-${digest.date}` }),
    },
    body: JSON.stringify({
      from: cfg.from, to: cfg.to,
      subject: opts.test ? `[Test] ${digest.subject}` : digest.subject,
      html: digest.html, text: digest.text,
    }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = String(body?.message ?? `Resend error ${res.status}`);
    if (/only send testing emails/i.test(msg)) {
      throw new Error("Resend's test sender can only email the address you signed up with. Verify a domain in Resend (Domains page) and set DIGEST_FROM to an address on it to email your partner.");
    }
    throw new Error(msg);
  }
  return { id: body?.id, to: cfg.to };
}

export function digestStatus() {
  const cfg = digestConfig();
  return {
    configured: cfg.configured, hasKey: cfg.hasKey, to: cfg.to, from: cfg.from,
    hour: cfg.hour, tz: cfg.tz, days: cfg.days,
    lastSent: getState(LAST_SENT_KEY), lastError: getState(LAST_ERROR_KEY),
  };
}

// Check every few minutes; send once per day at or after DIGEST_HOUR.
// If the server was down at send time, it catches up until noon, then skips the day.
export function startDigestScheduler() {
  const tick = async () => {
    const cfg = digestConfig();
    if (!cfg.configured) return;
    const now = localNow(cfg.tz);
    if (cfg.days === "weekdays" && (now.weekday === "Sat" || now.weekday === "Sun")) return;
    if (now.hour < cfg.hour || now.hour >= Math.max(cfg.hour + 1, 12)) return;
    if (getState(LAST_SENT_KEY) === now.ymd) return;
    setState(LAST_SENT_KEY, now.ymd); // claim today first so a slow send can't double up
    try {
      const r = await sendDigest();
      setState(LAST_ERROR_KEY, "");
      console.log(`[digest] sent for ${now.ymd} to ${r.to.length} recipient(s)`);
    } catch (err: any) {
      setState(LAST_SENT_KEY, ""); // retry on the next check (the idempotency key prevents duplicates)
      setState(LAST_ERROR_KEY, `${now.ymd}: ${err.message}`);
      console.error(`[digest] failed for ${now.ymd}: ${err.message}`);
    }
  };
  setTimeout(tick, 30_000);
  setInterval(tick, 5 * 60_000);
}
