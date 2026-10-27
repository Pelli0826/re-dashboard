// Nightly Box import: reads new PDFs in one Box folder ("Deals Inbox"), runs the same OM intake as
// Upload OM on each, and creates deals in Lead flagged "Needs review". Read-only: it lists the
// folder and downloads files, and never moves, renames, deletes or uploads anything in Box.
//
// Box's REST API with Client Credentials Grant (server authentication, custom app), plain fetch.
// Railway variables:
//   BOX_CLIENT_ID, BOX_CLIENT_SECRET   from the Box Developer Console (app → Configuration)
//   BOX_ENTERPRISE_ID                  from the same app's General Settings tab
//   BOX_FOLDER_ID                      the number at the end of the folder's web address
//   BOX_SYNC_HOUR                      optional, 0-23, default 18, in DIGEST_TZ
//   BOX_DAILY_LIMIT                    optional, default 10 PDFs per run
//   BOX_BASE_URL                       test-only: point at a local mock server

import { storage, getState, setState } from "./storage";
import { analyzeOm, mathCheck, screeningMemo, claudeConfigured, MAX_PDF_BYTES } from "./claude";
import { findOrAddBroker, finishOmIntake } from "./intake";
import { localNow } from "./digest";
import { dealFromOm, omHasIncome } from "@shared/intake";
import type { PipelineDeal, BoxFile } from "@shared/schema";

const LAST_RUN_DATE_KEY = "box:lastRunDate"; // the day the scheduled run was claimed (YYYY-MM-DD)
const LAST_RUN_KEY = "box:lastRun";          // JSON BoxRun

const REQUIRED = ["BOX_CLIENT_ID", "BOX_CLIENT_SECRET", "BOX_ENTERPRISE_ID", "BOX_FOLDER_ID"] as const;

export function boxConfig() {
  const missing = REQUIRED.filter(k => !process.env[k]?.trim());
  const hourRaw = parseInt(process.env.BOX_SYNC_HOUR ?? "", 10);
  const limitRaw = parseInt(process.env.BOX_DAILY_LIMIT ?? "", 10);
  return {
    configured: missing.length === 0,
    missing: [...missing],
    folderId: process.env.BOX_FOLDER_ID?.trim() ?? "",
    hour: Number.isFinite(hourRaw) ? Math.min(23, Math.max(0, hourRaw)) : 18,
    limit: Number.isFinite(limitRaw) && limitRaw > 0 ? limitRaw : 10,
    tz: process.env.DIGEST_TZ || "America/New_York",
    base: (process.env.BOX_BASE_URL || "https://api.box.com").replace(/\/$/, ""),
  };
}

export interface BoxRun {
  trigger: "scheduled" | "manual";
  startedAt: string; finishedAt?: string;
  folderName?: string;
  processed: number; skipped: number; failed: number;
  waiting: number;          // new PDFs left for the next run (daily limit)
  error?: string;           // why the run stopped (Box sign-in, folder access, Anthropic account)
}

// ── Box API ───────────────────────────────────────────────────────────────

// An error that stops the whole run (as opposed to one file failing).
class RunError extends Error {}

async function boxFetch(url: string, init: RequestInit, what: string): Promise<Response> {
  try {
    return await fetch(url, { ...init, signal: AbortSignal.timeout(120_000) });
  } catch (err: any) {
    const reason = err?.name === "TimeoutError" ? "Box did not respond within 2 minutes" : (err?.cause?.message || err?.message || "network error");
    throw new RunError(`Could not reach Box to ${what}: ${reason}.`);
  }
}

async function getToken(cfg: ReturnType<typeof boxConfig>): Promise<string> {
  const res = await boxFetch(`${cfg.base}/oauth2/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "client_credentials",
      client_id: process.env.BOX_CLIENT_ID!.trim(),
      client_secret: process.env.BOX_CLIENT_SECRET!.trim(),
      box_subject_type: "enterprise",
      box_subject_id: process.env.BOX_ENTERPRISE_ID!.trim(),
    }),
  }, "sign in");
  const body: any = await res.json().catch(() => ({}));
  if (res.ok && body.access_token) return body.access_token;

  const code = String(body.error ?? "");
  const detail = String(body.error_description ?? "");
  const said = detail ? ` (Box said: "${detail}")` : "";
  if (code === "invalid_client") {
    throw new RunError(`Box sign-in failed: Box did not accept the client ID or secret${said}. Copy both again from the Box Developer Console (your app → Configuration → OAuth 2.0 Credentials) into BOX_CLIENT_ID and BOX_CLIENT_SECRET in Railway.`);
  }
  if (code === "unauthorized_client" || /not (yet )?authorized/i.test(detail)) {
    throw new RunError(`Box sign-in failed: the app has not been authorized by your Box admin${said}. In the Box Admin Console, go to Platform → Platform Apps and authorize (or reauthorize) the app.`);
  }
  if (/enterprise|subject/i.test(detail) || code === "invalid_grant") {
    throw new RunError(`Box sign-in failed${said}. Check that BOX_ENTERPRISE_ID in Railway matches the Enterprise ID on the app's General Settings tab, and that the app uses Client Credentials Grant.`);
  }
  throw new RunError(`Box sign-in failed with error ${res.status}${code ? ` ${code}` : ""}${said}.`);
}

// Box API (2.0) errors come back as { type: "error", status, code, message, request_id }.
async function apiError(res: Response, what: string, folderId: string): Promise<Error> {
  const body: any = await res.json().catch(() => ({}));
  const code = String(body.code ?? "");
  const said = body.message ? ` (Box said: "${body.message}")` : "";
  if (res.status === 404) {
    return new RunError(`Box can't find folder ${folderId}, or the app's service account hasn't been invited to it${said}. In Box, share the Deals Inbox folder with the service account's email (Viewer is enough), and check that BOX_FOLDER_ID is the number at the end of the folder's web address.`);
  }
  if (res.status === 405 || res.status === 400) {
    return new RunError(`BOX_FOLDER_ID "${folderId}" isn't a valid Box folder ID${said}. Use the number at the end of the folder's web address (box.com/folder/123456789).`);
  }
  if (res.status === 401) return new RunError(`Box did not accept the app's access token while trying to ${what}${said}. Check the app is still authorized in the Box Admin Console.`);
  if (res.status === 403) {
    return new RunError(code === "insufficient_scope"
      ? `The Box app isn't allowed to ${what}${said}. In the Box Developer Console, open the app → Configuration → Application Scopes, tick "Read all files and folders stored in Box", save, then have your Box admin reauthorize the app.`
      : `Box denied access while trying to ${what}${said}. Make sure the Deals Inbox folder is shared with the app's service account.`);
  }
  if (res.status === 429) return new RunError(`Box's rate limit was reached while trying to ${what}. The next run will try again.`);
  return new RunError(`Box error ${res.status}${code ? ` ${code}` : ""} while trying to ${what}${said}.`);
}

interface BoxItem { id: string; type: string; name: string; size?: number; created_at?: string }

async function getFolderName(cfg: ReturnType<typeof boxConfig>, token: string): Promise<string> {
  const res = await boxFetch(`${cfg.base}/2.0/folders/${encodeURIComponent(cfg.folderId)}?fields=name`,
    { headers: { Authorization: `Bearer ${token}` } }, "open the folder");
  if (!res.ok) throw await apiError(res, "open the folder", cfg.folderId);
  return String((await res.json()).name ?? "");
}

async function listFolder(cfg: ReturnType<typeof boxConfig>, token: string): Promise<BoxItem[]> {
  const items: BoxItem[] = [];
  for (let offset = 0; ; ) {
    const url = `${cfg.base}/2.0/folders/${encodeURIComponent(cfg.folderId)}/items?fields=name,size,created_at&limit=1000&offset=${offset}`;
    const res = await boxFetch(url, { headers: { Authorization: `Bearer ${token}` } }, "list the folder");
    if (!res.ok) throw await apiError(res, "list the folder", cfg.folderId);
    const page: any = await res.json();
    const entries: BoxItem[] = Array.isArray(page.entries) ? page.entries : [];
    items.push(...entries);
    offset += entries.length;
    if (!entries.length || offset >= Number(page.total_count ?? 0)) return items;
  }
}

// Box answers with a redirect to a short-lived download address, which fetch follows.
// 202 means the file was just uploaded and isn't ready yet.
async function downloadFile(cfg: ReturnType<typeof boxConfig>, token: string, file: BoxItem): Promise<Buffer> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const res = await boxFetch(`${cfg.base}/2.0/files/${encodeURIComponent(file.id)}/content`,
      { headers: { Authorization: `Bearer ${token}` } }, `download ${file.name}`);
    if (res.status === 202) {
      const wait = Math.min(30, Math.max(1, Number(res.headers.get("retry-after")) || 5));
      await new Promise(r => setTimeout(r, wait * 1000));
      continue;
    }
    if (!res.ok) {
      const body: any = await res.json().catch(() => ({}));
      const said = body.message ? ` (Box said: "${body.message}")` : "";
      if (res.status === 403) {
        throw new Error(`Box denied the download${said}. If folder listing works but downloads don't, the app may also need the "Read and write all files and folders stored in Box" scope (the dashboard still never changes anything in Box).`);
      }
      if (res.status === 404) throw new Error(`The file was removed from Box before it could be downloaded${said}.`);
      throw new Error(`Box download failed with error ${res.status}${body.code ? ` ${body.code}` : ""}${said}.`);
    }
    return Buffer.from(await res.arrayBuffer());
  }
  throw new Error("Box said the file still wasn't ready to download after three tries. The next run will try again.");
}

// ── The run ───────────────────────────────────────────────────────────────

type CreateDeal = (input: Record<string, unknown>, extra?: Partial<PipelineDeal>) => { deal?: PipelineDeal; error?: string };
let createDeal: CreateDeal | null = null;
// routes.ts hands over its deal-creation path so Box deals are created exactly like any other.
export function configureBoxImport(opts: { createDeal: CreateDeal }) { createDeal = opts.createDeal; }

let running: Promise<BoxRun> | null = null;
export const boxRunning = () => running !== null;

const mb = (n: number) => `${(n / 1048576).toFixed(n < 10 * 1048576 ? 1 : 0)} MB`;
const isPdfName = (name: string) => /\.pdf$/i.test(name.trim());

// Anthropic problems that would fail every file (key, credits, workspace): stop the run instead,
// and leave the remaining files for the next run.
const isAccountError = (msg: string) => /ANTHROPIC_API_KEY|API credits|workspace|does not have access to this model|did not accept the model name|Could not reach the Claude API/i.test(msg);

function record(file: BoxItem, status: BoxFile["status"], extra: { dealId?: number | null; error?: string | null } = {}) {
  return storage.recordBoxFile({
    boxId: file.id, name: file.name, size: file.size ?? null, status,
    dealId: extra.dealId ?? null, error: extra.error ?? null, processedAt: new Date().toISOString(),
  });
}

async function importPdf(cfg: ReturnType<typeof boxConfig>, token: string, file: BoxItem): Promise<"processed" | "skipped"> {
  const pdf = await downloadFile(cfg, token, file);
  if (pdf.subarray(0, 5).toString() !== "%PDF-") {
    record(file, "skipped", { error: "The file is named .pdf but isn't a PDF. Save it as a PDF and add it to the folder again." });
    return "skipped";
  }
  if (pdf.length > MAX_PDF_BYTES) {
    record(file, "skipped", { error: `This PDF is ${mb(pdf.length)}; the limit is 24 MB. Compress it (Preview: File → Export → Reduce File Size) and add the smaller copy to the folder.` });
    return "skipped";
  }
  const analysis = await analyzeOm(pdf);
  const checks = mathCheck(analysis);
  const memo = screeningMemo(analysis, checks, file.name);
  const { contact } = findOrAddBroker(analysis.broker);
  const fields = dealFromOm(analysis, {
    stage: "lead", brokerContactId: contact?.id ?? null, today: new Date().toISOString().slice(0, 10),
    fallbackName: file.name.replace(/\.pdf$/i, "").trim(),
  });
  const created = createDeal!(fields, { needsReview: 1 });
  if (!created.deal) throw new Error(`The deal could not be saved: ${created.error}`);
  const deal = created.deal;
  finishOmIntake(deal, { analysis, memo, fileName: file.name, pdf, createUnderwriting: omHasIncome(analysis) });
  storage.addDealActivity(deal.id, new Date().toISOString().slice(0, 10), "note", `Created from Box file ${file.name}. Needs review.`);
  record(file, "processed", { dealId: deal.id });
  return "processed";
}

async function doRun(trigger: BoxRun["trigger"]): Promise<BoxRun> {
  const cfg = boxConfig();
  const run: BoxRun = { trigger, startedAt: new Date().toISOString(), processed: 0, skipped: 0, failed: 0, waiting: 0 };
  const save = () => setState(LAST_RUN_KEY, JSON.stringify(run));
  save();
  try {
    if (!cfg.configured) throw new RunError(`Box import isn't set up. Add ${cfg.missing.join(", ")} in Railway.`);
    if (!claudeConfigured()) throw new RunError("ANTHROPIC_API_KEY is not set in Railway, so OMs can't be read.");
    const token = await getToken(cfg);
    run.folderName = await getFolderName(cfg, token);
    const items = await listFolder(cfg, token);

    // New files only, oldest first. Folders and web links in the folder are ignored.
    const fresh = items
      .filter(i => i.type === "file" && !storage.getBoxFileByBoxId(i.id))
      .sort((a, b) => (a.created_at ?? "").localeCompare(b.created_at ?? "") || Number(a.id) - Number(b.id));

    const pdfs: BoxItem[] = [];
    for (const f of fresh) {
      if (!isPdfName(f.name)) {
        const ext = f.name.match(/\.[^.]+$/)?.[0] ?? "no extension";
        record(f, "skipped", { error: `Not a PDF (${ext}). Only PDF offering memoranda are imported.` });
        run.skipped++;
      } else if ((f.size ?? 0) > MAX_PDF_BYTES) {
        record(f, "skipped", { error: `This PDF is ${mb(f.size!)}; the limit is 24 MB. Compress it (Preview: File → Export → Reduce File Size) and add the smaller copy to the folder.` });
        run.skipped++;
      } else {
        pdfs.push(f);
      }
    }
    run.waiting = Math.max(0, pdfs.length - cfg.limit);
    save();

    const batch = pdfs.slice(0, cfg.limit);
    for (let i = 0; i < batch.length; i++) {
      const f = batch[i];
      try {
        const outcome = await importPdf(cfg, token, f);
        run[outcome]++;
      } catch (err: any) {
        const msg = String(err?.message ?? err);
        if (err instanceof RunError || isAccountError(msg)) {
          // Not this file's fault: leave it and the rest for the next run.
          run.waiting += batch.length - i;
          throw err instanceof RunError ? err : new RunError(`Claude could not read the OMs: ${msg}`);
        }
        record(f, "failed", { error: msg });
        run.failed++;
        console.error(`[box] ${f.id} failed: ${msg}`);
      }
      save();
    }
  } catch (err: any) {
    run.error = String(err?.message ?? err);
    console.error(`[box] run stopped: ${run.error}`);
  }
  run.finishedAt = new Date().toISOString();
  save();
  console.log(`[box] ${trigger} run: ${run.processed} imported, ${run.skipped} skipped, ${run.failed} failed, ${run.waiting} waiting`);
  return run;
}

// One run at a time; "Check Box now" while a run is going joins that run.
export function runBoxImport(trigger: BoxRun["trigger"]): Promise<BoxRun> {
  if (!running) running = doRun(trigger).finally(() => { running = null; });
  return running;
}

export function lastBoxRun(): BoxRun | null {
  try { return JSON.parse(getState(LAST_RUN_KEY) ?? "null"); } catch { return null; }
}

export function boxStatus() {
  const cfg = boxConfig();
  const deals = new Map(storage.getPipeline().map(d => [d.id, d]));
  const recent = storage.getBoxFiles().slice(0, 15).map(f => {
    const d = f.dealId ? deals.get(f.dealId) : undefined;
    return { ...f, dealCode: d?.dealCode ?? null, dealName: d?.name ?? null, needsReview: d ? d.needsReview === 1 : false };
  });
  return {
    configured: cfg.configured, missing: cfg.missing, folderId: cfg.folderId,
    hour: cfg.hour, tz: cfg.tz, limit: cfg.limit,
    running: boxRunning(), lastRun: lastBoxRun(), lastRunDate: getState(LAST_RUN_DATE_KEY), recent,
  };
}

// The scheduled run is due at or after BOX_SYNC_HOUR, once per day. If the server was down at
// that hour it catches up later the same evening; the day is claimed before the run starts, so
// a restart or a failed run never runs twice in a day.
export function boxRunDue(now: { ymd: string; hour: number }, hour: number, lastRunDate: string | null): boolean {
  return now.hour >= hour && lastRunDate !== now.ymd;
}

export function startBoxScheduler() {
  const tick = async () => {
    const cfg = boxConfig();
    if (!cfg.configured || boxRunning()) return;
    const now = localNow(cfg.tz);
    if (!boxRunDue(now, cfg.hour, getState(LAST_RUN_DATE_KEY))) return;
    setState(LAST_RUN_DATE_KEY, now.ymd);
    await runBoxImport("scheduled");
  };
  setTimeout(tick, 45_000);
  setInterval(tick, 5 * 60_000);
}
