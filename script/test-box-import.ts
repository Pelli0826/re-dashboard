// End-to-end check of the nightly Box import against local mock servers (no real Box or Anthropic).
// Run after `npm run build`:   npx tsx script/test-box-import.ts
// Add --serve to leave the dev server and mocks running afterwards at http://127.0.0.1:5075, to look at the UI.
// It starts the built server on a throwaway database, imitates Box (token, folder, download) and
// Anthropic (/v1/messages), and exercises the API the way the Overview card and morning email do.

import http from "http";
import fs from "fs";
import os from "os";
import path from "path";
import { spawn, type ChildProcess } from "child_process";
import type { AddressInfo } from "net";

const serve = process.argv.includes("--serve");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "box-test-"));
const FOLDER = "111222333";
const ENTERPRISE = "999";
let failures = 0;
function check(label: string, ok: unknown, detail?: unknown) {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${!ok && detail !== undefined ? `\n      got: ${JSON.stringify(detail).slice(0, 400)}` : ""}`);
  if (!ok) failures++;
}

// ── Mock Box ──────────────────────────────────────────────────────────────
interface MockFile { id: string; name: string; size: number; created_at: string; content: Buffer }
const box = {
  files: new Map<string, MockFile>(),
  mode: "ok" as "ok" | "unauthorized" | "badsecret" | "nofolder",
  writes: 0,          // any request that would change Box
  tokenRequests: 0,
};
const pdf = (marker: string) => Buffer.from(`%PDF-1.4\nNAME:${marker}\n%%EOF\n`);
let clock = Date.parse("2026-10-01T12:00:00Z");
function addFile(id: string, name: string, content: Buffer, size = content.length) {
  clock += 60_000;
  box.files.set(id, { id, name, size, created_at: new Date(clock).toISOString(), content });
}
const boxError = (res: http.ServerResponse, status: number, code: string, message: string) => {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify({ type: "error", status, code, message, request_id: "test" }));
};
const readBody = (req: http.IncomingMessage) => new Promise<string>(r => { let b = ""; req.on("data", c => (b += c)); req.on("end", () => r(b)); });

const boxServer = http.createServer(async (req, res) => {
  const url = new URL(req.url!, "http://x");
  const body = await readBody(req);
  if (req.method === "POST" && url.pathname === "/oauth2/token") {
    box.tokenRequests++;
    const form = new URLSearchParams(body);
    res.setHeader("content-type", "application/json");
    if (box.mode === "unauthorized") { res.statusCode = 400; return res.end(JSON.stringify({ error: "unauthorized_client", error_description: "This app is not authorized by the enterprise admin" })); }
    if (box.mode === "badsecret") { res.statusCode = 400; return res.end(JSON.stringify({ error: "invalid_client", error_description: "The client credentials are invalid" })); }
    const ok = form.get("grant_type") === "client_credentials" && form.get("client_id") === "cid" && form.get("client_secret") === "secret"
      && form.get("box_subject_type") === "enterprise" && form.get("box_subject_id") === ENTERPRISE;
    if (!ok) { res.statusCode = 400; return res.end(JSON.stringify({ error: "invalid_request", error_description: `unexpected form ${body}` })); }
    return res.end(JSON.stringify({ access_token: "tok", expires_in: 3600, token_type: "bearer" }));
  }
  if (req.method !== "GET") { box.writes++; return boxError(res, 405, "method_not_allowed", "read-only test"); }
  if (url.pathname.startsWith("/dl/")) {           // the redirect target (dl.boxcloud.com in real life)
    const f = box.files.get(url.pathname.slice(4));
    if (!f) return boxError(res, 404, "not_found", "gone");
    res.writeHead(200, { "content-type": "application/octet-stream" });
    return res.end(f.content);
  }
  if (req.headers.authorization !== "Bearer tok") return boxError(res, 401, "unauthorized", "Unauthorized");
  const folder = url.pathname.match(/^\/2\.0\/folders\/([^/]+)(\/items)?$/);
  if (folder) {
    if (folder[1] !== FOLDER || box.mode === "nofolder") return boxError(res, 404, "not_found", "Not Found");
    if (!folder[2]) return res.end(JSON.stringify({ type: "folder", id: FOLDER, name: "Deals Inbox" }));
    const all = [{ type: "folder", id: "5", name: "Old deals" }, ...[...box.files.values()]
      .map(f => ({ type: "file", id: f.id, name: f.name, size: f.size, created_at: f.created_at }))];
    const offset = Number(url.searchParams.get("offset") ?? 0);
    const limit = Math.min(3, Number(url.searchParams.get("limit") ?? 100)); // small pages to exercise paging
    res.setHeader("content-type", "application/json");
    return res.end(JSON.stringify({ total_count: all.length, offset, limit, entries: all.slice(offset, offset + limit) }));
  }
  const content = url.pathname.match(/^\/2\.0\/files\/([^/]+)\/content$/);
  if (content) {
    if (!box.files.has(content[1])) return boxError(res, 404, "not_found", "Not Found");
    res.writeHead(302, { location: `http://127.0.0.1:${(boxServer.address() as AddressInfo).port}/dl/${content[1]}` });
    return res.end();
  }
  boxError(res, 404, "not_found", "Not Found");
});

// ── Mock Anthropic ────────────────────────────────────────────────────────
let claudeCalls = 0;
const claudeServer = http.createServer(async (req, res) => {
  const body = JSON.parse(await readBody(req) || "{}");
  claudeCalls++;
  const doc = body.messages?.[0]?.content?.find((c: any) => c.type === "document");
  const text = doc ? Buffer.from(doc.source.data, "base64").toString() : "";
  const marker = text.match(/NAME:(.*)/)?.[1]?.trim() ?? "Unknown";
  res.setHeader("content-type", "application/json");
  if (marker === "FAIL") { res.statusCode = 529; return res.end(JSON.stringify({ type: "error", error: { type: "overloaded_error", message: "Overloaded" } })); }
  if (marker === "NOCREDIT") { res.statusCode = 400; return res.end(JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: "Your credit balance is too low to access the Anthropic API." } })); }
  const income = marker !== "NOINCOME";
  res.end(JSON.stringify({
    stop_reason: "tool_use",
    content: [{ type: "tool_use", id: "t1", name: "record_offering", input: {
      dealName: marker, address: "1 Main St", municipality: "Ambler", county: "Montgomery", state: "PA",
      propertyType: "multifamily", askingPrice: 2_000_000, units: 10, buildingSf: 9000.4, yearBuilt: 1965,
      noi: income ? 120_000 : null, capRatePct: income ? 6 : null,
      grossPotentialRent: income ? 200_000 : null, vacancyPct: income ? 5 : null, operatingExpenses: income ? 70_000 : null,
      groundLease: false, offersDue: "2026-11-15",
      broker: { name: "Pat Broker", company: "Acme Realty", email: "Pat@Acme.test", phone: "555-0100" },
      scenarios: [], summary: `Summary of ${marker}.`, keyRisks: ["Old roof", "Flood history"], missingInfo: ["Rent roll"], brokerQuestions: ["Why selling?"],
    } }],
  }));
});

// ── Server under test ─────────────────────────────────────────────────────
const listen = (s: http.Server) => new Promise<number>(r => s.listen(0, "127.0.0.1", () => r((s.address() as AddressInfo).port)));
// A timezone where it's currently between 5 and 11 in the morning, so the 11 PM scheduled run
// can't fire during the test.
const utcHour = new Date().getUTCHours();
const n = Math.max(-14, Math.min(12, utcHour - 5));
const testTz = n === 0 ? "Etc/GMT" : n > 0 ? `Etc/GMT+${n}` : `Etc/GMT-${-n}`;

let server: ChildProcess;
let base = "";
let cookie = "";
async function api(method: string, p: string, body?: unknown, raw = false): Promise<any> {
  const init: RequestInit = { method, headers: { "x-forwarded-proto": "https", cookie } };
  if (body instanceof FormData) init.body = body;
  else if (body !== undefined) { init.body = JSON.stringify(body); (init.headers as any)["content-type"] = "application/json"; }
  const res = await fetch(base + p, init);
  const setCookie = res.headers.get("set-cookie");
  if (setCookie) cookie = setCookie.split(";")[0];
  const out = raw ? await res.text() : await res.json().catch(() => ({}));
  if (!raw && res.status >= 400) (out as any).__status = res.status;
  return out;
}
async function runAndWait() {
  const before = (await api("GET", "/api/box/status")).lastRun?.startedAt ?? "";
  const r = await api("POST", "/api/box/run");
  if (r.__status) return { error: r.message };
  for (let i = 0; i < 100; i++) {
    const st = await api("GET", "/api/box/status");
    if (!st.running && st.lastRun?.finishedAt && st.lastRun.startedAt !== before) return st;
    await new Promise(r => setTimeout(r, 100));
  }
  throw new Error("run did not finish");
}

async function main() {
  const boxPort = await listen(boxServer);
  const claudePort = await listen(claudeServer);
  // --serve runs the dev server (no password, so a browser can sign in over plain http);
  // otherwise the production build, with a password, the way Railway runs it.
  const port = serve ? 5075 : 5090 + Math.floor(Math.random() * 400);
  base = `http://127.0.0.1:${port}`;
  server = spawn(process.execPath, serve ? ["node_modules/.bin/tsx", "server/index.ts"] : ["dist/index.cjs"], {
    env: {
      ...process.env, NODE_ENV: serve ? "development" : "production", PORT: String(port), DASHBOARD_PASSWORD: serve ? "" : "pw",
      DB_PATH: path.join(tmp, "data.db"), RAILWAY_VOLUME_MOUNT_PATH: "",
      ANTHROPIC_API_KEY: "test-key", ANTHROPIC_BASE_URL: `http://127.0.0.1:${claudePort}`,
      BOX_CLIENT_ID: "cid", BOX_CLIENT_SECRET: "secret", BOX_ENTERPRISE_ID: ENTERPRISE, BOX_FOLDER_ID: FOLDER,
      BOX_BASE_URL: `http://127.0.0.1:${boxPort}`, BOX_DAILY_LIMIT: "2", BOX_SYNC_HOUR: "23", DIGEST_TZ: testTz,
      RESEND_API_KEY: "", APP_URL: "https://dash.test",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let log = "";
  server.stdout!.on("data", d => (log += d));
  server.stderr!.on("data", d => (log += d));
  for (let i = 0; i < 300 && !(await fetch(`${base}/api/health`).then(r => r.ok, () => false)); i++) await new Promise(r => setTimeout(r, 100));
  await api("POST", "/api/auth/login", { password: "pw" });

  // 1. First run: two PDFs imported (daily limit 2), a spreadsheet and an oversized PDF skipped, one PDF left over.
  addFile("1001", "Elm Street OM.pdf", pdf("Elm Street Apartments"));
  addFile("1002", "rent roll.xlsx", Buffer.from("PK..."));
  addFile("1003", "Huge OM.pdf", pdf("Huge"), 30 * 1024 * 1024);
  addFile("1004", "Oak Plaza.pdf", pdf("Oak Plaza"));
  addFile("1005", "Pine Lot.pdf", pdf("NOINCOME"));
  let st = await runAndWait();
  check("run 1: no error", !st.lastRun.error, st.lastRun);
  check("run 1: folder name read from Box", st.lastRun.folderName === "Deals Inbox", st.lastRun.folderName);
  check("run 1: 2 imported, 2 skipped, 1 waiting", st.lastRun.processed === 2 && st.lastRun.skipped === 2 && st.lastRun.waiting === 1 && st.lastRun.failed === 0, st.lastRun);
  let deals: any[] = await api("GET", "/api/pipeline");
  check("run 1: oldest PDFs first (Elm, Oak)", deals.map(d => d.name).sort().join() === "Elm Street Apartments,Oak Plaza", deals.map(d => d.name));
  const elm = deals.find(d => d.name === "Elm Street Apartments");
  check("deal is in Lead and needs review", elm.stage === "lead" && elm.needsReview === 1, elm);
  check("deal fields mapped (price, units, rounded SF, offers due note, broker source)",
    elm.askingPrice === 2_000_000 && elm.units === 10 && elm.sqft === 9000 && elm.notes === "Offers due 2026-11-15." && elm.source === "broker" && elm.keyRisks === "Old roof\nFlood history", elm);
  const files = await api("GET", `/api/pipeline/${elm.id}/files`);
  check("PDF saved as the deal's OM file", files.length === 1 && files[0].kind === "om" && files[0].name === "Elm Street OM.pdf", files);
  const dl = await fetch(`${base}/api/files/${files[0].id}/download`, { headers: { cookie, "x-forwarded-proto": "https" } }).then(r => r.text());
  check("saved file is the PDF from Box", dl.includes("NAME:Elm Street Apartments"));
  const act = await api("GET", `/api/pipeline/${elm.id}/activity`);
  check("activity: created-from-Box note", act.some((a: any) => a.summary === "Created from Box file Elm Street OM.pdf. Needs review."), act.map((a: any) => a.summary));
  check("activity: screening memo", act.some((a: any) => a.summary.startsWith("Screening from Elm Street OM.pdf") && a.summary.includes("Math check")), act.map((a: any) => a.summary.slice(0, 40)));
  check("activity: deal added in Lead", act.some((a: any) => a.kind === "created" && a.summary === "Deal added in Lead"));
  const models = await api("GET", "/api/underwriting");
  const m = models.find((x: any) => x.dealId === elm.id);
  check("linked underwriting model with the OM's income", m && m.purchasePrice === 2_000_000 && m.grossPotentialRent === 200_000 && m.vacancyRate === 5 && m.operatingExpenses === 70_000 && m.name === `${elm.dealCode} Elm Street Apartments`, m);
  const contacts = await api("GET", "/api/contacts");
  check("broker added to Contacts once, matched for the second deal", contacts.length === 1 && deals.every(d => d.brokerContactId === contacts[0].id), { contacts, b: deals.map(d => d.brokerContactId) });
  const rows: any[] = await api("GET", "/api/box/files");
  const byBox = (id: string) => rows.find(r => r.boxId === id);
  check("spreadsheet skipped with the reason", byBox("1002")?.status === "skipped" && /Not a PDF \(\.xlsx\)/.test(byBox("1002").error), byBox("1002"));
  check("oversized PDF skipped with the reason", byBox("1003")?.status === "skipped" && /30 MB; the limit is 24 MB/.test(byBox("1003").error), byBox("1003"));
  check("oversized PDF never downloaded or sent to Claude", claudeCalls === 2, claudeCalls);
  check("leftover PDF not recorded yet", !byBox("1005"));

  // 2. Next run picks up the leftover file; no income figures → no model.
  st = await runAndWait();
  deals = await api("GET", "/api/pipeline");
  check("run 2: leftover PDF imported", st.lastRun.processed === 1 && st.lastRun.waiting === 0 && deals.length === 3, st.lastRun);
  const pine = deals.find(d => d.name === "NOINCOME");
  check("no income figures → no underwriting model", !(await api("GET", "/api/underwriting")).some((x: any) => x.dealId === pine.id));

  // 3. Same files again: nothing happens.
  const callsBefore = claudeCalls;
  st = await runAndWait();
  check("run 3: same files do nothing", st.lastRun.processed + st.lastRun.skipped + st.lastRun.failed === 0 && (await api("GET", "/api/pipeline")).length === 3 && claudeCalls === callsBefore, st.lastRun);

  // 4. A renamed file (same Box id) does nothing.
  box.files.get("1001")!.name = "Elm Street OM (final).pdf";
  st = await runAndWait();
  check("run 4: renamed file does nothing", st.lastRun.processed === 0 && (await api("GET", "/api/pipeline")).length === 3 && claudeCalls === callsBefore, st.lastRun);

  // 5. A file Claude can't read fails with Anthropic's reason; Try again re-queues it.
  addFile("1006", "Broken.pdf", pdf("FAIL"));
  st = await runAndWait();
  const broken = (await api("GET", "/api/box/files")).find((r: any) => r.boxId === "1006");
  check("Anthropic error recorded with the real reason", st.lastRun.failed === 1 && broken?.status === "failed" && /temporarily overloaded/.test(broken.error), broken);
  check("failed file listed on the card", st.recent.some((r: any) => r.boxId === "1006" && r.status === "failed"));
  const retry = await api("POST", `/api/box/files/${broken.id}/retry`);
  check("Try again clears the failed record", retry.ok && !(await api("GET", "/api/box/files")).some((r: any) => r.boxId === "1006"));
  box.files.delete("1006");

  // 6. Anthropic account problem stops the run and leaves the file for next time.
  addFile("1007", "Later.pdf", pdf("NOCREDIT"));
  st = await runAndWait();
  check("Anthropic account error stops the run with the reason", /no API credits/.test(st.lastRun.error ?? "") && st.lastRun.waiting === 1, st.lastRun);
  check("…and the file is left for the next run", !(await api("GET", "/api/box/files")).some((r: any) => r.boxId === "1007"));
  box.files.delete("1007");

  // 7. Box authentication failures show the real reason on the card and in the email.
  box.mode = "unauthorized";
  st = await runAndWait();
  check("Box auth failure shown on the card", /not been authorized by your Box admin/.test(st.lastRun.error ?? "") && /Platform Apps/.test(st.lastRun.error), st.lastRun.error);
  let email = await api("GET", "/api/digest/preview", undefined, true);
  check("Box auth failure shown in the morning email", email.includes("The last Box check failed") && email.includes("not been authorized by your Box admin"));
  box.mode = "badsecret";
  st = await runAndWait();
  check("wrong client secret explained", /did not accept the client ID or secret/.test(st.lastRun.error ?? ""), st.lastRun.error);
  box.mode = "nofolder";
  st = await runAndWait();
  check("folder not found / not shared explained", /can't find folder 111222333/.test(st.lastRun.error ?? "") && /service account/.test(st.lastRun.error), st.lastRun.error);
  box.mode = "ok";

  // 8. Morning email lists the new deals and the skipped files.
  email = await api("GET", "/api/digest/preview", undefined, true);
  check("email: New from Box section with deals", email.includes("New from Box") && email.includes("Elm Street Apartments") && email.includes("Oak Plaza") && email.includes("needs review"));
  check("email: skipped files with reasons", email.includes("rent roll.xlsx") && email.includes("Not a PDF (.xlsx)") && email.includes("Huge OM.pdf"));

  // 9. Mark reviewed clears the flag and logs it.
  const reviewed = await api("POST", `/api/pipeline/${elm.id}/reviewed`);
  const act2 = await api("GET", `/api/pipeline/${elm.id}/activity`);
  check("Mark reviewed clears the flag and logs it", reviewed.needsReview === 0 && act2.some((a: any) => a.summary.startsWith("Marked reviewed")), reviewed);
  const patched = await api("PATCH", `/api/pipeline/${pine.id}`, { needsReview: 0, notes: "x" });
  check("the flag can't be cleared by a normal edit (only Mark reviewed, which logs it)", patched.needsReview === 1, patched);

  // 10. Upload OM uses the same mapping and the same finishing steps.
  const fd = new FormData();
  fd.append("file", new Blob([pdf("Elm Street Apartments")], { type: "application/pdf" }), "Elm copy.pdf");
  const intake = await api("POST", "/api/intake/om", fd);
  check("Upload OM returns the server-mapped deal (Screening)", intake.deal?.stage === "screening" && intake.hasIncome === true && intake.brokerContactId === contacts[0].id, intake);
  const same = ["name", "address", "municipality", "county", "state", "type", "askingPrice", "units", "sqft", "noi", "capRate", "keyRisks", "notes", "source", "brokerContactId", "groundLease"]
    .filter(k => intake.deal[k] !== elm[k]);
  check("Upload OM and Box import fill in the same fields", same.length === 0, same);
  const saved = await api("POST", "/api/pipeline", intake.deal);
  const fin = await api("POST", `/api/pipeline/${saved.id}/intake`, { fileId: intake.fileId, createUnderwriting: true });
  const f2 = await api("GET", `/api/pipeline/${saved.id}/files`);
  const a2 = await api("GET", `/api/pipeline/${saved.id}/activity`);
  check("Upload OM: file attached, memo saved, model created", fin.underwritingId && f2.length === 1 && a2.some((a: any) => a.summary.startsWith("Screening from Elm copy.pdf")), { fin, f2, a2 });
  check("Upload OM deal isn't flagged for review", saved.needsReview === 0);
  const again = await api("POST", `/api/pipeline/${saved.id}/intake`, { fileId: intake.fileId, createUnderwriting: true });
  check("Upload OM finishing can't run twice", again.__status === 410, again);

  // 11. Backup includes the Box records; deleting a deal keeps its Box record (so it isn't re-imported).
  const backup = await api("GET", "/api/backup");
  check("backup export includes box_files", Array.isArray(backup.tables?.box_files) && backup.tables.box_files.length === 5, backup.tables?.box_files?.length);
  await api("DELETE", `/api/pipeline/${pine.id}`);
  st = await runAndWait();
  const pineRow = (await api("GET", "/api/box/files")).find((r: any) => r.boxId === "1005");
  check("deleted deal's file is not imported again", st.lastRun.processed === 0 && pineRow?.dealId === null && pineRow?.status === "processed", pineRow);

  // 12. Read-only: nothing but GETs (and the token request) reached Box.
  check("never wrote to Box", box.writes === 0, box.writes);

  // 13. "Check Box now" when Box isn't set up says what's missing (checked via the status shape).
  check("status lists the settings", st.configured === true && st.limit === 2 && st.hour === 23 && st.folderId === FOLDER, st);

  if (failures) console.log(`\nServer log:\n${log.split("\n").filter(l => /\[box\]|error/i.test(l)).slice(-30).join("\n")}`);
}

// The scheduling rule, without waiting for a real evening.
async function scheduleRules() {
  process.env.DB_PATH = path.join(tmp, "unit.db");
  const { boxRunDue } = await import("../server/box");
  check("schedule: not before the hour", !boxRunDue({ ymd: "2026-10-27", hour: 17 }, 18, null));
  check("schedule: runs at the hour", boxRunDue({ ymd: "2026-10-27", hour: 18 }, 18, "2026-10-26"));
  check("schedule: catches up later the same evening", boxRunDue({ ymd: "2026-10-27", hour: 22 }, 18, "2026-10-26"));
  check("schedule: never twice in a day", !boxRunDue({ ymd: "2026-10-27", hour: 21 }, 18, "2026-10-27"));
  check("schedule: runs again the next day", boxRunDue({ ymd: "2026-10-28", hour: 18 }, 18, "2026-10-27"));
}

main()
  .then(scheduleRules)
  .then(async () => {
    if (!serve) return;
    console.log(`\nServing at ${base}. Press Ctrl+C to stop.`);
    await new Promise<void>(r => process.on("SIGINT", () => r()));
  })
  .catch(err => { console.error(err); failures++; })
  .finally(() => {
    server?.kill();
    boxServer.close(); claudeServer.close();
    fs.rmSync(tmp, { recursive: true, force: true });
    console.log(failures ? `\n${failures} check(s) failed` : "\nAll checks passed");
    process.exit(failures ? 1 : 0);
  });
