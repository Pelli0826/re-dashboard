import type { Express } from "express";
import { createServer, type Server } from "http";
import multer from "multer";
import crypto from "crypto";
import mammoth from "mammoth";
import { z } from "zod";
import { extractFromPdf, type DocType } from "./extract";
import { buildDigest, sendDigest, digestStatus, clearDigestError } from "./digest";
import { analyzeOm, mathCheck, screeningMemo, claudeConfigured, MAX_PDF_BYTES, askAboutDeal, type AskTurn } from "./claude";
import { buildProforma, calcReturns, maxPriceForIrr } from "@shared/underwriting";
import { storage, DB_IS_PERSISTENT, getState, setState, deleteState } from "./storage";
import { buildLoiDocx } from "./loi";
import { defaultLoiTerms, type LoiTerms } from "@shared/loi";
import { projectFromDeal, PSA_STAGES, PROJECT_STATUS_LABELS } from "@shared/projects";
import {
  STAGES, DEAL_TYPES, ACTIVITY_KINDS, STAGE_LABELS, daysSince, type Stage,
  isYmd, addDaysYmd, addMonthsYmd, diffDaysYmd,
} from "@shared/pipeline";
import type { PipelineDeal } from "@shared/schema";
import {
  insertProjectSchema, insertPipelineSchema, insertDealActivitySchema, insertArmLoanSchema,
  insertCashFlowSchema, insertContactSchema, insertInvestorSchema, insertDocumentSchema,
  insertTaskSchema, insertUnderwritingSchema
} from "@shared/schema";

const isProduction = process.env.NODE_ENV === "production";

// In production a password is mandatory. Without one the dashboard stays locked
// rather than falling open to anyone who finds the URL.
function passwordStatus(): "set" | "missing-dev" | "missing-prod" {
  if (process.env.DASHBOARD_PASSWORD) return "set";
  return isProduction ? "missing-prod" : "missing-dev";
}

function passwordMatches(input: unknown): boolean {
  const correct = process.env.DASHBOARD_PASSWORD;
  if (!correct || typeof input !== "string") return false;
  const a = crypto.createHash("sha256").update(input).digest();
  const b = crypto.createHash("sha256").update(correct).digest();
  return crypto.timingSafeEqual(a, b);
}

// Simple in-memory login throttle: 10 attempts per 15 minutes per IP.
const loginAttempts = new Map<string, { count: number; first: number }>();
function tooManyAttempts(ip: string): boolean {
  const now = Date.now();
  const entry = loginAttempts.get(ip);
  if (!entry || now - entry.first > 15 * 60_000) {
    loginAttempts.set(ip, { count: 1, first: now });
    return false;
  }
  entry.count++;
  return entry.count > 10;
}

function requireAuth(req: any, res: any, next: any) {
  const status = passwordStatus();
  if (status === "missing-dev") return next();
  if (status === "missing-prod") {
    return res.status(503).json({ message: "Dashboard is locked: set DASHBOARD_PASSWORD in Railway to enable sign-in." });
  }
  if (req.session?.authenticated) return next();
  return res.status(401).json({ message: "Unauthorized" });
}

const todayYmd = () => new Date().toISOString().slice(0, 10);
const maxYmd = (a: string, b: string) => (a > b ? a : b);

// Turn zod errors into one readable line, e.g. "stage: Invalid option".
function readable(err: z.ZodError): string {
  return err.issues.map(i => `${i.path.join(".") || "input"}: ${i.message}`).join("; ");
}

export async function registerRoutes(httpServer: Server, app: Express): Promise<Server> {

  // ── Health check (public, used by Railway) ──────────────────────────────
  app.get("/api/health", (_req, res) => res.json({ ok: true }));

  // ── Auth routes (public — no middleware) ────────────────────────────────
  app.post("/api/auth/login", (req, res) => {
    const status = passwordStatus();
    if (status === "missing-dev") {
      req.session.authenticated = true;
      return res.json({ ok: true });
    }
    if (status === "missing-prod") {
      return res.status(503).json({ message: "Sign-in is disabled until DASHBOARD_PASSWORD is set in Railway." });
    }
    if (tooManyAttempts(req.ip ?? "unknown")) {
      return res.status(429).json({ message: "Too many attempts. Wait 15 minutes and try again." });
    }
    if (!passwordMatches(req.body?.password)) {
      return res.status(401).json({ message: "Incorrect password" });
    }
    loginAttempts.delete(req.ip ?? "unknown");
    // New session ID on login prevents session fixation.
    req.session.regenerate(err => {
      if (err) return res.status(500).json({ message: "Could not start session" });
      req.session.authenticated = true;
      res.json({ ok: true });
    });
  });

  app.post("/api/auth/logout", (req, res) => {
    req.session.destroy(() => {});
    res.json({ ok: true });
  });

  app.get("/api/auth/check", (req, res) => {
    const status = passwordStatus();
    if (status === "missing-dev") return res.json({ authenticated: true, passwordRequired: false });
    res.json({
      authenticated: status === "set" && !!req.session?.authenticated,
      passwordRequired: true,
      locked: status === "missing-prod",
    });
  });

  // Apply auth middleware to all remaining /api routes
  app.use("/api", requireAuth);

  // ── Projects ──────────────────────────────────────────────────────────
  app.get("/api/projects", (_req, res) => res.json(storage.getProjects()));
  app.get("/api/projects/:id", (req, res) => {
    const p = storage.getProject(Number(req.params.id));
    if (!p) return res.status(404).json({ message: "Not found" });
    res.json(p);
  });
  app.post("/api/projects", (req, res) => {
    const parsed = insertProjectSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ message: parsed.error.message });
    res.status(201).json(storage.createProject(parsed.data));
  });
  app.patch("/api/projects/:id", (req, res) => {
    const parsed = insertProjectSchema.partial().safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ message: parsed.error.message });
    const u = storage.updateProject(Number(req.params.id), parsed.data);
    if (!u) return res.status(404).json({ message: "Not found" });
    res.json(u);
  });
  app.get("/api/projects/:id/related", (req, res) => res.json(storage.projectRelatedCounts(Number(req.params.id))));
  app.delete("/api/projects/:id", (req, res) => { storage.deleteProject(Number(req.params.id)); res.status(204).send(); });

  // ── System status & backup ─────────────────────────────────────────
  app.get("/api/system", (_req, res) => res.json({ persistentStorage: DB_IS_PERSISTENT, omIntake: claudeConfigured() }));
  app.get("/api/backup", (_req, res) => {
    const stamp = new Date().toISOString().slice(0, 10);
    res.setHeader("Content-Disposition", `attachment; filename="re-dashboard-backup-${stamp}.json"`);
    res.json({ exportedAt: new Date().toISOString(), version: 2, tables: storage.exportAll() });
  });

  // ── Pipeline ──────────────────────────────────────────────────────────
  const dealInput = insertPipelineSchema.extend({
    stage: z.enum(STAGES),
    type: z.enum(DEAL_TYPES),
    probabilityOverride: z.number().int().min(0).max(100).nullable().optional(),
  });

  app.get("/api/pipeline", (_req, res) => res.json(storage.getPipeline()));
  app.get("/api/pipeline/:id", (req, res) => {
    const d = storage.getPipelineDeal(Number(req.params.id));
    if (!d) return res.status(404).json({ message: "Not found" });
    res.json(d);
  });

  app.post("/api/pipeline", (req, res) => {
    const parsed = dealInput.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ message: readable(parsed.error) });
    if (parsed.data.stage === "dead" && !parsed.data.deadReason) {
      return res.status(400).json({ message: "A reason is required when marking a deal dead." });
    }
    const deal = storage.createPipelineDeal(parsed.data);
    const today = new Date().toISOString().slice(0, 10);
    storage.addDealActivity(deal.id, deal.firstContactDate || today, "created", `Deal added in ${STAGE_LABELS[deal.stage as Stage]}`);
    if (deal.stage === "due-diligence") createDueDiligenceTasks(deal);
    if (PSA_STAGES.includes(deal.stage)) createProjectForDeal(deal);
    res.status(201).json(storage.getPipelineDeal(deal.id));
  });

  // One update path for the edit form, stage moves and applied suggestions.
  function updateDeal(id: number, body: unknown): { status: number; body: unknown } {
    const existing = storage.getPipelineDeal(id);
    if (!existing) return { status: 404, body: { message: "Not found" } };
    const parsed = dealInput.partial().safeParse(body);
    if (!parsed.success) return { status: 400, body: { message: readable(parsed.error) } };

    const data: Partial<PipelineDeal> = { ...parsed.data };
    const newStage = data.stage ?? existing.stage;
    const stageChanged = newStage !== existing.stage;

    if (newStage === "dead" && !(data.deadReason ?? existing.deadReason)) {
      return { status: 400, body: { message: "A reason is required when marking a deal dead." } };
    }
    if (stageChanged) {
      data.stageChangedAt = new Date().toISOString();
      if (newStage !== "dead") data.deadReason = null;
    }

    const updated = storage.updatePipelineDeal(id, data)!;

    // Keep linked underwriting models priced at our offer (or the asking price if no offer yet).
    // Only when the price actually changed, so editing other fields never overwrites a hand-set model price.
    const priceTouched = updated.offerPrice !== existing.offerPrice || updated.askingPrice !== existing.askingPrice;
    const newPrice = updated.offerPrice ?? updated.askingPrice;
    if (priceTouched && newPrice && newPrice > 0) {
      for (const m of storage.getUnderwritingDeals().filter(u => u.dealId === id && u.purchasePrice !== newPrice)) {
        storage.updateUnderwritingDeal(m.id, { purchasePrice: newPrice });
        storage.addDealActivity(id, todayYmd(), "note",
          `Underwriting "${m.name}" purchase price updated from $${Math.round(m.purchasePrice).toLocaleString()} to $${Math.round(newPrice).toLocaleString()} to match the ${updated.offerPrice ? "offer" : "asking price"}.`);
      }
    }

    if (updated.ddEndDate && updated.ddEndDate !== existing.ddEndDate) redateChecklist(existing, updated);

    if (stageChanged) {
      const days = daysSince(existing.stageChangedAt) ?? 0;
      let summary = `${STAGE_LABELS[existing.stage as Stage] ?? existing.stage} → ${STAGE_LABELS[newStage as Stage] ?? newStage} after ${days} day${days === 1 ? "" : "s"}`;
      if (newStage === "dead" && updated.deadReason) summary += `. Reason: ${updated.deadReason}`;
      storage.addDealActivity(id, todayYmd(), "stage-change", summary);
      if (newStage === "due-diligence") createDueDiligenceTasks(updated);
      syncProject(updated);
    }
    return { status: 200, body: storage.getPipelineDeal(id) };
  }

  // A deal becomes a project when the PSA is signed (Due Diligence or later). The project then
  // follows the deal: Closed moves it to planning, Dead cancels it (kept, not deleted), reviving reopens it.
  function createProjectForDeal(deal: PipelineDeal) {
    const uw = storage.getUnderwritingDeals().find(u => u.dealId === deal.id);
    const p = storage.createProject(projectFromDeal(deal, uw, todayYmd()));
    storage.addDealActivity(deal.id, todayYmd(), "note",
      `Project created on the Projects tab (${PROJECT_STATUS_LABELS[p.status]}, budget $${Math.round(p.totalBudget).toLocaleString("en-US")}${uw ? ` from "${uw.name}"` : ""}).`);
    return p;
  }
  function syncProject(deal: PipelineDeal) {
    const p = storage.getProjectForDeal(deal.id);
    const setStatus = (status: string) => {
      storage.updateProject(p!.id, { status });
      storage.addDealActivity(deal.id, todayYmd(), "note", `Project status: ${PROJECT_STATUS_LABELS[p!.status] ?? p!.status} → ${PROJECT_STATUS_LABELS[status]}.`);
    };
    if (PSA_STAGES.includes(deal.stage)) {
      if (!p) { createProjectForDeal(deal); return; }
      if (p.status === "cancelled") setStatus(deal.stage === "closed" ? "planning" : "under-contract");
      else if (deal.stage === "closed" && p.status === "under-contract") setStatus("planning");
    } else if (p && p.status === "under-contract") {
      // Dead, or moved back before the PSA (e.g. the contract fell through and talks continue).
      setStatus("cancelled");
    }
  }
  app.post("/api/pipeline/:id/project", (req, res) => {
    const deal = storage.getPipelineDeal(Number(req.params.id));
    if (!deal) return res.status(404).json({ message: "Deal not found" });
    if (storage.getProjectForDeal(deal.id)) return res.status(409).json({ message: "This deal already has a project." });
    res.status(201).json(createProjectForDeal(deal));
  });

  app.patch("/api/pipeline/:id", (req, res) => {
    const r = updateDeal(Number(req.params.id), req.body);
    res.status(r.status).json(r.body);
  });

  // When the DD end date changes, shift the open checklist tasks by the same number of days.
  function redateChecklist(before: PipelineDeal, after: PipelineDeal) {
    const open = storage.getTasks().filter(t => t.dealId === after.id && t.category === "due-diligence" && t.status !== "done");
    if (!open.length || !after.ddEndDate) return;
    // The date the checklist was built from: the old DD end, the remembered base, or (for
    // checklists made before this was tracked) two days after the go/no-go task.
    const goNoGo = open.find(t => /go \/ no-go decision/i.test(t.title) && isYmd(t.dueDate));
    const base = before.ddEndDate ?? getState(`ddBase:${after.id}`) ?? (goNoGo ? addDaysYmd(goNoGo.dueDate!, 2) : null);
    setState(`ddBase:${after.id}`, after.ddEndDate);
    if (!base) return;
    const delta = diffDaysYmd(base, after.ddEndDate);
    if (delta === 0) return;
    const today = todayYmd();
    let moved = 0;
    for (const t of open) {
      if (!isYmd(t.dueDate)) continue;
      const due = maxYmd(addDaysYmd(t.dueDate!, delta), today);
      storage.updateTask(t.id, { dueDate: due, reminderDate: maxYmd(addDaysYmd(due, -3), today) });
      moved++;
    }
    if (moved) storage.addDealActivity(after.id, today, "note",
      `Moved ${moved} due diligence checklist task${moved === 1 ? "" : "s"} ${delta > 0 ? "later" : "earlier"} by ${Math.abs(delta)} day${Math.abs(delta) === 1 ? "" : "s"} to follow the new DD end date (${after.ddEndDate}).`);
  }

  // ── Milestones ─────────────────────────────────────────────────────
  const milestoneInput = z.object({
    name: z.string().trim().min(1).max(200),
    dueDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
    notes: z.string().max(2000).nullable().optional(),
    status: z.enum(["open", "done"]).optional(),
  });
  app.get("/api/milestones", (_req, res) => res.json(storage.getAllMilestones()));
  app.get("/api/pipeline/:id/milestones", (req, res) => res.json(storage.getDealMilestones(Number(req.params.id))));
  app.post("/api/pipeline/:id/milestones", (req, res) => {
    const dealId = Number(req.params.id);
    if (!storage.getPipelineDeal(dealId)) return res.status(404).json({ message: "Deal not found" });
    const parsed = milestoneInput.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ message: readable(parsed.error) });
    const m = storage.createMilestone({ dealId, name: parsed.data.name, dueDate: parsed.data.dueDate ?? null, notes: parsed.data.notes ?? null });
    res.status(201).json(m);
  });
  app.patch("/api/milestones/:id", (req, res) => {
    const m = storage.getMilestone(Number(req.params.id));
    if (!m) return res.status(404).json({ message: "Not found" });
    const parsed = milestoneInput.partial().safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ message: readable(parsed.error) });
    const data: Record<string, unknown> = { ...parsed.data };
    if (parsed.data.status && parsed.data.status !== m.status) {
      data.completedAt = parsed.data.status === "done" ? new Date().toISOString() : null;
      if (parsed.data.status === "done") storage.addDealActivity(m.dealId, todayYmd(), "note", `Milestone completed: ${m.name}`);
    }
    res.json(storage.updateMilestone(m.id, data));
  });
  app.delete("/api/milestones/:id", (req, res) => { storage.deleteMilestone(Number(req.params.id)); res.status(204).send(); });

  app.get("/api/pipeline/:id/related", (req, res) => res.json(storage.dealRelatedCounts(Number(req.params.id))));
  app.delete("/api/pipeline/:id", (req, res) => { storage.deletePipelineDeal(Number(req.params.id)); res.status(204).send(); });

  app.get("/api/pipeline/:id/activity", (req, res) => res.json(storage.getDealActivity(Number(req.params.id))));
  app.post("/api/pipeline/:id/activity", (req, res) => {
    const id = Number(req.params.id);
    if (!storage.getPipelineDeal(id)) return res.status(404).json({ message: "Not found" });
    const parsed = insertDealActivitySchema.extend({
      kind: z.enum(ACTIVITY_KINDS),
      date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      summary: z.string().trim().min(1),
    }).safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ message: readable(parsed.error) });
    res.status(201).json(storage.addDealActivity(id, parsed.data.date, parsed.data.kind, parsed.data.summary));
  });

  // Standard due diligence checklist, created once when a deal enters DD.
  function createDueDiligenceTasks(deal: PipelineDeal) {
    const already = storage.getTasks().some(t => t.dealId === deal.id && t.category === "due-diligence");
    if (already) return;
    const todayYmd = new Date().toISOString().slice(0, 10);
    // Shift a YYYY-MM-DD date back n days, never earlier than today.
    const minusDays = (ymd: string, n: number) => {
      const d = new Date(ymd + "T12:00:00Z");
      d.setUTCDate(d.getUTCDate() - n);
      const out = d.toISOString().slice(0, 10);
      return out < todayYmd ? todayYmd : out;
    };
    const plusDays = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);
    const ddEnd = deal.ddEndDate || plusDays(30);
    setState(`ddBase:${deal.id}`, ddEnd);
    const before = (n: number) => minusDays(ddEnd, n);
    const isIncome = (deal.units ?? 0) > 0 || deal.occupancy != null || deal.noi != null;
    const isLand = deal.type === "land" || !!deal.scenarios;

    const items: { title: string; priority: string; due: string; show?: boolean }[] = [
      { title: "Order Phase I environmental report", priority: "high", due: before(21) },
      { title: "Order title commitment and review exceptions", priority: "high", due: before(21) },
      { title: "Order ALTA survey", priority: "high", due: before(18) },
      { title: "Confirm zoning and permitted uses with municipality", priority: "high", due: before(14) },
      { title: "Entitlement feasibility: approvals path, timeline, variances", priority: "high", due: before(14), show: isLand },
      { title: "Floodplain analysis and flood insurance quote", priority: "high", due: before(14), show: !!deal.floodZone },
      { title: "Confirm water and sewer capacity and connection fees", priority: "medium", due: before(14) },
      { title: "Property condition / structural inspection", priority: "medium", due: before(14), show: (deal.sqft ?? 0) > 0 },
      { title: "Review rent roll, leases and estoppels", priority: "high", due: before(10), show: isIncome },
      { title: "Order appraisal", priority: "medium", due: before(10) },
      { title: "Update underwriting with DD findings", priority: "medium", due: before(5) },
      { title: "Go / no-go decision before DD expires", priority: "urgent", due: before(2) },
    ];
    const created = new Date().toISOString();
    for (const item of items) {
      if (item.show === false) continue;
      storage.createTask({
        title: `${deal.name}: ${item.title}`,
        description: `Due diligence checklist for ${deal.dealCode}`,
        projectId: null, dealId: deal.id,
        priority: item.priority, status: "open",
        dueDate: item.due, reminderDate: minusDays(item.due, 3),
        assignedTo: null, category: "due-diligence",
        completedAt: null, createdAt: created, notes: null,
      });
    }
  }
  // ── ARM ──────────────────────────────────────────────────────────────
  app.get("/api/arm", (_req, res) => res.json(storage.getArmLoans()));
  app.post("/api/arm", (req, res) => {
    const parsed = insertArmLoanSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ message: parsed.error.message });
    res.status(201).json(storage.createArmLoan(parsed.data));
  });
  app.patch("/api/arm/:id", (req, res) => {
    const parsed = insertArmLoanSchema.partial().safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ message: parsed.error.message });
    const u = storage.updateArmLoan(Number(req.params.id), parsed.data);
    if (!u) return res.status(404).json({ message: "Not found" });
    res.json(u);
  });
  app.delete("/api/arm/:id", (req, res) => { storage.deleteArmLoan(Number(req.params.id)); res.status(204).send(); });

  // ── Cash Flow ─────────────────────────────────────────────────────────
  app.get("/api/cashflow", (req, res) => {
    const projectId = req.query.projectId ? Number(req.query.projectId) : undefined;
    res.json(storage.getCashFlow(projectId));
  });
  app.post("/api/cashflow", (req, res) => {
    const parsed = insertCashFlowSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ message: parsed.error.message });
    res.status(201).json(storage.createCashFlowEntry(parsed.data));
  });
  app.patch("/api/cashflow/:id", (req, res) => {
    const parsed = insertCashFlowSchema.partial().safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ message: parsed.error.message });
    const u = storage.updateCashFlowEntry(Number(req.params.id), parsed.data);
    if (!u) return res.status(404).json({ message: "Not found" });
    res.json(u);
  });
  app.delete("/api/cashflow/:id", (req, res) => { storage.deleteCashFlowEntry(Number(req.params.id)); res.status(204).send(); });

  // ── Contacts ──────────────────────────────────────────────────────────
  app.get("/api/contacts", (_req, res) => res.json(storage.getContacts()));
  app.post("/api/contacts", (req, res) => {
    const parsed = insertContactSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ message: parsed.error.message });
    res.status(201).json(storage.createContact(parsed.data));
  });
  app.patch("/api/contacts/:id", (req, res) => {
    const parsed = insertContactSchema.partial().safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ message: parsed.error.message });
    const u = storage.updateContact(Number(req.params.id), parsed.data);
    if (!u) return res.status(404).json({ message: "Not found" });
    res.json(u);
  });
  app.delete("/api/contacts/:id", (req, res) => { storage.deleteContact(Number(req.params.id)); res.status(204).send(); });

  // ── Investors ─────────────────────────────────────────────────────────
  app.get("/api/investors", (req, res) => {
    const projectId = req.query.projectId ? Number(req.query.projectId) : undefined;
    res.json(storage.getInvestors(projectId));
  });
  app.post("/api/investors", (req, res) => {
    const parsed = insertInvestorSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ message: parsed.error.message });
    res.status(201).json(storage.createInvestor(parsed.data));
  });
  app.patch("/api/investors/:id", (req, res) => {
    const parsed = insertInvestorSchema.partial().safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ message: parsed.error.message });
    const u = storage.updateInvestor(Number(req.params.id), parsed.data);
    if (!u) return res.status(404).json({ message: "Not found" });
    res.json(u);
  });
  app.delete("/api/investors/:id", (req, res) => { storage.deleteInvestor(Number(req.params.id)); res.status(204).send(); });

  // ── Documents ─────────────────────────────────────────────────────────
  app.get("/api/documents", (req, res) => {
    const projectId = req.query.projectId ? Number(req.query.projectId) : undefined;
    res.json(storage.getDocuments(projectId));
  });
  app.post("/api/documents", (req, res) => {
    const parsed = insertDocumentSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ message: parsed.error.message });
    res.status(201).json(storage.createDocument(parsed.data));
  });
  app.patch("/api/documents/:id", (req, res) => {
    const parsed = insertDocumentSchema.partial().safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ message: parsed.error.message });
    const u = storage.updateDocument(Number(req.params.id), parsed.data);
    if (!u) return res.status(404).json({ message: "Not found" });
    res.json(u);
  });
  app.delete("/api/documents/:id", (req, res) => { storage.deleteDocument(Number(req.params.id)); res.status(204).send(); });

  // ── Tasks ─────────────────────────────────────────────────────────────
  app.get("/api/tasks", (_req, res) => res.json(storage.getTasks()));
  app.post("/api/tasks", (req, res) => {
    const parsed = insertTaskSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ message: parsed.error.message });
    res.status(201).json(storage.createTask(parsed.data));
  });
  app.patch("/api/tasks/:id", (req, res) => {
    const parsed = insertTaskSchema.partial().safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ message: parsed.error.message });
    const u = storage.updateTask(Number(req.params.id), parsed.data);
    if (!u) return res.status(404).json({ message: "Not found" });
    res.json(u);
  });
  app.delete("/api/tasks/:id", (req, res) => { storage.deleteTask(Number(req.params.id)); res.status(204).send(); });

  // ── Underwriting ──────────────────────────────────────────────────────────
  app.get("/api/underwriting", (_req, res) => res.json(storage.getUnderwritingDeals()));
  app.get("/api/underwriting/:id", (req, res) => {
    const d = storage.getUnderwritingDeal(Number(req.params.id));
    if (!d) return res.status(404).json({ message: "Not found" });
    res.json(d);
  });
  app.post("/api/underwriting", (req, res) => {
    const parsed = insertUnderwritingSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ message: parsed.error.message });
    res.status(201).json(storage.createUnderwritingDeal(parsed.data));
  });
  app.patch("/api/underwriting/:id", (req, res) => {
    const parsed = insertUnderwritingSchema.partial().safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ message: parsed.error.message });
    const u = storage.updateUnderwritingDeal(Number(req.params.id), parsed.data);
    if (!u) return res.status(404).json({ message: "Not found" });
    res.json(u);
  });
  app.delete("/api/underwriting/:id", (req, res) => { storage.deleteUnderwritingDeal(Number(req.params.id)); res.status(204).send(); });

  // ── Document extraction (AI auto-populate) ──────────────────────────────────────────
  const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024 } }); // 50MB limit
  app.post("/api/underwriting/extract", upload.single("file"), async (req, res) => {
    try {
      if (!claudeConfigured() && !process.env.OPENAI_API_KEY) {
        return res.status(400).json({ message: "Set ANTHROPIC_API_KEY in Railway to enable document reading." });
      }
      if (!req.file) return res.status(400).json({ message: "No file uploaded." });
      const docType = (req.body.docType ?? "om") as DocType;
      if (!["om", "rentroll", "pl"].includes(docType)) {
        return res.status(400).json({ message: "docType must be om, rentroll, or pl" });
      }
      const result = await extractFromPdf(req.file.buffer, docType);
      res.json(result);
    } catch (err: any) {
      res.status(500).json({ message: err.message ?? "Extraction failed" });
    }
  });

  // ── OM intake: Claude reads the package, returns a prefilled deal + screening ──
  const omUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_PDF_BYTES } });
  app.post("/api/intake/om", (req, res, next) => {
    omUpload.single("file")(req, res, err => {
      if (err?.code === "LIMIT_FILE_SIZE") return res.status(413).json({ message: "This PDF is over 24 MB. Compress it (Preview: File → Export → Reduce File Size) or upload the financial section only." });
      if (err) return next(err);
      next();
    });
  }, async (req, res) => {
    if (!claudeConfigured()) return res.status(400).json({ message: "Set ANTHROPIC_API_KEY in Railway to turn on OM upload." });
    if (!req.file) return res.status(400).json({ message: "No file uploaded." });
    const isPdf = req.file.mimetype === "application/pdf" || req.file.buffer.subarray(0, 5).toString() === "%PDF-";
    if (!isPdf) return res.status(400).json({ message: "Upload the OM as a PDF." });
    try {
      const analysis = await analyzeOm(req.file.buffer);
      const checks = mathCheck(analysis);
      // Match the listing broker to an existing contact by name or email.
      const b = analysis.broker;
      const match = b?.name || b?.email
        ? storage.getContacts().find(c =>
            (b.email && c.email?.toLowerCase() === b.email.toLowerCase()) ||
            (b.name && c.name.trim().toLowerCase() === b.name.trim().toLowerCase()))
        : undefined;
      // Keep the PDF; it's attached to the deal when the review form is saved.
      const saved = storage.saveDealFile(req.file.buffer, req.file.originalname, "application/pdf", null, "om");
      res.json({
        analysis,
        mathCheck: checks,
        memo: screeningMemo(analysis, checks, req.file.originalname),
        brokerContactId: match?.id ?? null,
        fileId: saved.id,
      });
    } catch (err: any) {
      res.status(502).json({ message: err.message ?? "Could not read this OM." });
    }
  });

  // ── Deal files ─────────────────────────────────────────────────────
  const ALLOWED_TYPES: Record<string, string> = {
    ".pdf": "application/pdf", ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    ".xls": "application/vnd.ms-excel", ".csv": "text/csv",
    ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
  };
  const fileUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_PDF_BYTES } });

  app.get("/api/pipeline/:id/files", (req, res) => res.json(storage.getDealFiles(Number(req.params.id))));
  app.post("/api/pipeline/:id/files", (req, res, next) => {
    fileUpload.single("file")(req, res, err => {
      if (err?.code === "LIMIT_FILE_SIZE") return res.status(413).json({ message: "Files are limited to 24 MB." });
      if (err) return next(err);
      next();
    });
  }, (req, res) => {
    const id = Number(req.params.id);
    if (!storage.getPipelineDeal(id)) return res.status(404).json({ message: "Deal not found" });
    if (!req.file) return res.status(400).json({ message: "No file uploaded." });
    const ext = (req.file.originalname.match(/\.[a-z0-9]+$/i)?.[0] ?? "").toLowerCase();
    const mime = ALLOWED_TYPES[ext];
    if (!mime) return res.status(400).json({ message: "Upload a PDF, Excel, CSV, Word or image file." });
    const f = storage.saveDealFile(req.file.buffer, req.file.originalname, mime, id, "other");
    storage.addDealActivity(id, new Date().toISOString().slice(0, 10), "note", `File added: ${f.name}`);
    res.status(201).json(f);
  });
  app.patch("/api/files/:id", (req, res) => {
    const dealId = Number(req.body?.dealId);
    const f = storage.getDealFile(Number(req.params.id));
    if (!f || !storage.getPipelineDeal(dealId)) return res.status(404).json({ message: "Not found" });
    res.json(storage.attachDealFile(f.id, dealId));
  });
  app.get("/api/files/:id/download", (req, res) => {
    const f = storage.getDealFile(Number(req.params.id));
    if (!f) return res.status(404).json({ message: "Not found" });
    let data: Buffer;
    try { data = storage.readDealFile(f); } catch { return res.status(410).json({ message: "This file is missing from storage." }); }
    res.setHeader("Content-Type", f.mime);
    res.setHeader("Content-Disposition", `${req.query.inline ? "inline" : "attachment"}; filename*=UTF-8''${encodeURIComponent(f.name)}`);
    res.send(data);
  });
  app.delete("/api/files/:id", (req, res) => { storage.deleteDealFile(Number(req.params.id)); res.status(204).send(); });

  // ── Letter of intent: terms are kept per deal in app_state; drafts are saved as deal files ──
  const loiInput = z.object({
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Pick a date for the letter."),
    recipientName: z.string().max(200), recipientCompany: z.string().max(200), recipientEmail: z.string().max(200),
    property: z.string().trim().min(1, "Describe the property.").max(1000),
    seller: z.string().trim().min(1, "Enter the seller.").max(300),
    buyer: z.string().trim().min(1, "Enter the buyer.").max(300),
    price: z.number().positive("Enter a purchase price."),
    paymentTerms: z.string().max(500),
    expirationDays: z.number().int().min(1).max(90),
    deposits: z.array(z.object({ amount: z.number().positive("Each deposit needs an amount."), when: z.string().trim().min(1, "Say when each deposit is due.").max(600) })).max(6),
    investigationDays: z.number().int().min(1).max(730),
    approvals: z.string().max(4000),
    closingDays: z.number().int().min(0).max(730),
    closingAfter: z.string().trim().min(1).max(300),
    prorations: z.boolean(),
    brokerage: z.string().max(2000),
    exclusivityMonths: z.number().int().min(0).max(24),
    signerName: z.string().trim().min(1).max(200), signerTitle: z.string().max(200), signerPhone: z.string().max(50),
  });
  const loiKey = (id: number) => `loi:${id}`;
  function loiDefaults(deal: PipelineDeal): LoiTerms {
    const broker = deal.brokerContactId ? storage.getContacts().find(c => c.id === deal.brokerContactId) : null;
    const uw = storage.getUnderwritingDeals().find(u => u.dealId === deal.id);
    return defaultLoiTerms(deal, broker, uw?.purchasePrice);
  }

  app.get("/api/pipeline/:id/loi", (req, res) => {
    const deal = storage.getPipelineDeal(Number(req.params.id));
    if (!deal) return res.status(404).json({ message: "Deal not found" });
    const saved = getState(loiKey(deal.id));
    res.json({ terms: saved ? { ...loiDefaults(deal), ...JSON.parse(saved) } : loiDefaults(deal), saved: !!saved });
  });
  app.put("/api/pipeline/:id/loi", (req, res) => {
    const deal = storage.getPipelineDeal(Number(req.params.id));
    if (!deal) return res.status(404).json({ message: "Deal not found" });
    const parsed = loiInput.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ message: readable(parsed.error) });
    setState(loiKey(deal.id), JSON.stringify(parsed.data));
    res.json({ terms: parsed.data, saved: true });
  });
  app.delete("/api/pipeline/:id/loi", (req, res) => {
    deleteState(loiKey(Number(req.params.id)));
    res.status(204).send();
  });
  // Saves the terms, writes the Word draft to the deal's files and logs it. The user edits and sends it.
  app.post("/api/pipeline/:id/loi/draft", async (req, res) => {
    const deal = storage.getPipelineDeal(Number(req.params.id));
    if (!deal) return res.status(404).json({ message: "Deal not found" });
    const parsed = loiInput.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ message: readable(parsed.error) });
    const t = parsed.data;
    setState(loiKey(deal.id), JSON.stringify(t));
    let buffer: Buffer;
    try { buffer = await buildLoiDocx(t); } catch (e: any) {
      console.error(`[loi] build failed: ${e?.message}`);
      return res.status(500).json({ message: `Could not create the Word file: ${e?.message ?? "unknown error"}` });
    }
    const safeName = deal.name.replace(/[\\/:*?"<>|]+/g, " ").trim();
    const f = storage.saveDealFile(buffer, `LOI draft - ${safeName} - ${t.date}.docx`, ALLOWED_TYPES[".docx"], deal.id, "loi");
    storage.addDealActivity(deal.id, todayYmd(), "note",
      `LOI draft created: $${Math.round(t.price).toLocaleString("en-US")}, ${t.investigationDays}-day investigation, settlement ${t.closingDays} days after ${t.closingAfter}. Saved to Files as ${f.name}.`);
    res.status(201).json(f);
  });

  storage.cleanupPendingFiles();
  setInterval(() => storage.cleanupPendingFiles(), 6 * 3_600_000);

  // ── Ask about a deal ───────────────────────────────────────────────
  function dealContext(deal: PipelineDeal): string {
    const broker = deal.brokerContactId ? storage.getContacts().find(c => c.id === deal.brokerContactId) : undefined;
    const record: Record<string, unknown> = { ...deal };
    for (const k of ["id", "brokerContactId", "stageChangedAt", "lastActivityAt", "updatedAt"]) delete record[k];
    for (const k of Object.keys(record)) if (record[k] == null || record[k] === "") delete record[k];
    record.stage = STAGE_LABELS[deal.stage as Stage] ?? deal.stage;
    if (broker) record.broker = [broker.name, broker.company, broker.phone, broker.email].filter(Boolean).join(", ");

    const activity = storage.getDealActivity(deal.id).slice(0, 60)
      .map(a => `${a.date} [${a.kind}] ${a.summary}`).join("\n") || "(none)";
    const tasks = storage.getTasks().filter(t => t.dealId === deal.id)
      .map(t => `[task id ${t.id}] ${t.status === "done" ? "[done]" : "[open]"} ${t.title}${t.dueDate ? ` (due ${t.dueDate})` : ""}`).join("\n") || "(none)";
    const milestones = storage.getDealMilestones(deal.id)
      .map(m => `[milestone id ${m.id}] ${m.status === "done" ? "[done]" : "[open]"} ${m.name}: ${m.dueDate ?? "date not set"}${m.notes ? ` (${m.notes})` : ""}`).join("\n") || "(none)";
    const models = storage.getUnderwritingDeals().filter(m => m.dealId === deal.id).map(m => {
      const { id: _i, dealId: _d, createdAt: _c, ...inputs } = m;
      let out = `Model "${m.name}" inputs: ${JSON.stringify(inputs)}`;
      if (m.purchasePrice > 0 && m.grossPotentialRent > 0) {
        const r = calcReturns(m, buildProforma(m));
        const max15 = maxPriceForIrr(m, 15);
        out += `\nCalculated: levered IRR ${r.irr.toFixed(1)}%, equity multiple ${r.equityMultiple.toFixed(2)}x, `
          + `year-1 yield on cost ${r.yr1CapRate.toFixed(2)}%, year-1 cash-on-cash ${r.yr1CoC.toFixed(1)}%, `
          + `year-1 DSCR ${r.yr1Dscr.toFixed(2)}x, equity $${Math.round(r.equity).toLocaleString()}, `
          + `max price for 15% IRR (loan at same LTV) ${max15 ? `$${max15.toLocaleString()}` : "not reachable"}`;
      }
      return out;
    }).join("\n\n") || "(no underwriting model)";
    return `TODAY'S DATE: ${todayYmd()}\n\nDEAL RECORD\n${JSON.stringify(record, null, 1)}\n\nACTIVITY LOG (newest first)\n${activity}\n\nTASKS\n${tasks}\n\nMILESTONES\n${milestones}\n\nUNDERWRITING\n${models}`;
  }

  app.post("/api/pipeline/:id/ask", async (req, res) => {
    const deal = storage.getPipelineDeal(Number(req.params.id));
    if (!deal) return res.status(404).json({ message: "Deal not found" });
    if (!claudeConfigured()) return res.status(400).json({ message: "Set ANTHROPIC_API_KEY in Railway to ask questions." });
    const parsed = z.object({
      question: z.string().trim().min(1).max(4000),
      history: z.array(z.object({ role: z.enum(["user", "assistant"]), content: z.string().max(20000) })).max(20).default([]),
    }).safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ message: readable(parsed.error) });

    // Newest files first, up to the per-request budget. PDFs are sent as documents;
    // Word, CSV and text files are converted to text so Claude can read them too.
    const pdfs: { name: string; data: Buffer }[] = [];
    const texts: { name: string; text: string }[] = [];
    const skipped: string[] = [];
    const unreadable: string[] = [];
    let budget = MAX_PDF_BYTES;
    let textBudget = 600_000; // characters, roughly 150k tokens
    for (const f of storage.getDealFiles(deal.id)) {
      try {
        if (f.mime === "application/pdf") {
          if (f.size > budget) { skipped.push(f.name); continue; }
          pdfs.push({ name: f.name, data: storage.readDealFile(f) });
          budget -= f.size;
        } else if (/\.(docx|csv|txt|md)$/i.test(f.name)) {
          let text = /\.docx$/i.test(f.name)
            ? (await mammoth.extractRawText({ buffer: storage.readDealFile(f) })).value
            : storage.readDealFile(f).toString("utf8");
          text = text.trim();
          if (!text) { unreadable.push(f.name); continue; }
          if (text.length > textBudget) { skipped.push(f.name); continue; }
          texts.push({ name: f.name, text });
          textBudget -= text.length;
        } else {
          unreadable.push(f.name);
        }
      } catch (err: any) {
        console.error(`[ask] could not read ${f.name}: ${err.message}`);
        unreadable.push(f.name);
      }
    }
    let context = dealContext(deal);
    if (unreadable.length) context += `\n\nOther files saved that you cannot read (e.g. Excel, images, or old .doc format): ${unreadable.join(", ")}`;
    if (skipped.length) context += `\n\nFiles not included (over the size limit): ${skipped.join(", ")}`;

    try {
      const result = await askAboutDeal({ context, pdfs, texts, history: parsed.data.history as AskTurn[], question: parsed.data.question });
      res.json({
        answer: result.text,
        proposals: normalizeProposals(deal, result.proposals),
        filesUsed: [...pdfs.map(p => p.name), ...texts.map(t => t.name)],
        filesSkipped: [...skipped, ...unreadable],
      });
    } catch (err: any) {
      res.status(502).json({ message: err.message ?? "Could not get an answer." });
    }
  });

  // ── Suggested changes from Claude: check, compute dates, apply ─────
  const DEAL_DATE_LABELS: Record<string, string> = {
    firstContactDate: "First contact", loiDate: "LOI sent", loiExpiration: "LOI expiration",
    contractDate: "Contract signed", ddEndDate: "Due diligence end date", closingDate: "Closing date",
  };
  const money = (n: number) => `$${Math.round(n).toLocaleString()}`;

  interface Proposal {
    type: string; reason: string; summary: string; ruleText?: string; problem?: string;
    field?: string; priceField?: string; amount?: number; taskId?: number; milestoneId?: number;
    title?: string; priority?: string; name?: string; notes?: string; status?: string; date?: string | null;
  }

  function normalizeProposals(deal: PipelineDeal, raw: any[]): Proposal[] {
    // Dates other proposals can refer to, updated as we go so later actions can chain off earlier ones.
    const anchors = new Map<string, { date: string | null; label: string }>();
    for (const f of Object.keys(DEAL_DATE_LABELS)) anchors.set(`deal.${f}`, { date: (deal as any)[f] ?? null, label: DEAL_DATE_LABELS[f] });
    const existingMs = storage.getDealMilestones(deal.id);
    for (const m of existingMs) anchors.set(`milestone:${m.name.toLowerCase()}`, { date: m.dueDate, label: m.name });
    const dealTasks = storage.getTasks().filter(t => t.dealId === deal.id);
    const out: Proposal[] = [];

    for (const r of raw.slice(0, 25)) {
      if (!r || typeof r.type !== "string") continue;
      const p: Proposal = { type: r.type, reason: String(r.reason ?? "").slice(0, 600), summary: "" };

      // Work out the date: a rule is computed here; a literal date is used as given.
      let date: string | null = null;
      if (r.dateRule && typeof r.dateRule.from === "string") {
        const from = String(r.dateRule.from).trim();
        const anchor = isYmd(from) ? { date: from, label: from } : anchors.get(from.startsWith("milestone:") ? `milestone:${from.slice(10).trim().toLowerCase()}` : from);
        const months = Number.isInteger(r.dateRule.addMonths) ? r.dateRule.addMonths : 0;
        const days = Number.isInteger(r.dateRule.addDays) ? r.dateRule.addDays : 0;
        const before = months < 0 || (months === 0 && days < 0);
        const offset = [months ? `${Math.abs(months)} month${Math.abs(months) === 1 ? "" : "s"}` : "", days ? `${Math.abs(days)} day${Math.abs(days) === 1 ? "" : "s"}` : ""].filter(Boolean).join(" and ") || "0 days";
        const rel = before ? "before" : "after";
        if (anchor?.date) {
          date = addDaysYmd(addMonthsYmd(anchor.date, months), days);
          p.ruleText = `${offset} ${rel} ${anchor.label === anchor.date ? anchor.date : `${anchor.label} (${anchor.date})`}`;
        } else {
          p.ruleText = `${offset} ${rel} ${anchor?.label ?? from.replace(/^deal\.|^milestone:/, "")}, which isn't set yet`;
        }
      } else if (isYmd(r.date)) {
        date = r.date;
      }
      p.date = date;

      switch (r.type) {
        case "set_deal_date": {
          if (!DEAL_DATE_LABELS[r.field]) continue;
          p.field = r.field;
          if (!date) { p.problem = "No date could be determined."; }
          const current = (deal as any)[r.field];
          if (date && date === current) continue;
          p.summary = `Set ${DEAL_DATE_LABELS[r.field].toLowerCase()} to ${date ?? "?"}${current ? ` (now ${current})` : ""}`;
          if (date) anchors.set(`deal.${r.field}`, { date, label: DEAL_DATE_LABELS[r.field] });
          break;
        }
        case "set_deal_price": {
          if (!["askingPrice", "offerPrice"].includes(r.priceField) || !(r.amount > 0)) continue;
          p.priceField = r.priceField; p.amount = r.amount;
          p.summary = `Set ${r.priceField === "offerPrice" ? "our offer" : "asking price"} to ${money(r.amount)}`;
          break;
        }
        case "add_task": {
          if (!r.title) continue;
          const norm = (x: string) => x.replace(`${deal.name}: `, "").trim().toLowerCase();
          if (dealTasks.some(t => t.status !== "done" && norm(t.title) === norm(String(r.title)))) continue; // already on the list
          p.title = String(r.title).slice(0, 200);
          p.priority = ["low", "medium", "high", "urgent"].includes(r.priority) ? r.priority : "medium";
          p.summary = `Add task: ${p.title}${date ? `, due ${date}` : ""}`;
          break;
        }
        case "update_task": {
          const t = dealTasks.find(x => x.id === r.taskId);
          if (!t) continue;
          p.taskId = t.id;
          if (r.title) p.title = String(r.title).slice(0, 200);
          if (r.status === "open" || r.status === "done") p.status = r.status;
          const parts = [date && date !== t.dueDate ? `due ${t.dueDate ?? "none"} → ${date}` : "", p.title ? `rename to "${p.title}"` : "", p.status ? `mark ${p.status}` : ""].filter(Boolean);
          if (!parts.length) continue;
          p.summary = `Update task "${t.title}": ${parts.join(", ")}`;
          break;
        }
        case "add_milestone": {
          if (!r.name) continue;
          // Same name as an existing milestone: update its date instead of adding a duplicate.
          const same = existingMs.find(m => m.name.trim().toLowerCase() === String(r.name).trim().toLowerCase());
          if (same) {
            if (!date || date === same.dueDate) continue;
            p.type = "update_milestone"; p.milestoneId = same.id;
            p.summary = `Update milestone "${same.name}": date ${same.dueDate ?? "not set"} → ${date}`;
            anchors.set(`milestone:${same.name.toLowerCase()}`, { date, label: same.name });
            break;
          }
          p.name = String(r.name).slice(0, 200);
          p.notes = r.notes ? String(r.notes).slice(0, 2000) : undefined;
          p.summary = `Add milestone: ${p.name}, ${date ? `due ${date}` : "date to be confirmed"}`;
          anchors.set(`milestone:${p.name.toLowerCase()}`, { date, label: p.name });
          break;
        }
        case "update_milestone": {
          const m = existingMs.find(x => x.id === r.milestoneId);
          if (!m) continue;
          p.milestoneId = m.id;
          if (r.name) p.name = String(r.name).slice(0, 200);
          if (r.status === "open" || r.status === "done") p.status = r.status;
          const parts = [date && date !== m.dueDate ? `date ${m.dueDate ?? "not set"} → ${date}` : "", p.name ? `rename to "${p.name}"` : "", p.status ? `mark ${p.status}` : ""].filter(Boolean);
          if (!parts.length) continue;
          p.summary = `Update milestone "${m.name}": ${parts.join(", ")}`;
          if (date) anchors.set(`milestone:${(p.name ?? m.name).toLowerCase()}`, { date, label: p.name ?? m.name });
          break;
        }
        default: continue;
      }
      out.push(p);
    }
    return out;
  }

  const applyInput = z.object({
    type: z.enum(["set_deal_date", "set_deal_price", "add_task", "update_task", "add_milestone", "update_milestone"]),
    reason: z.string().max(600).default(""),
    summary: z.string().max(400),
    field: z.enum(["firstContactDate", "loiDate", "loiExpiration", "contractDate", "ddEndDate", "closingDate"]).optional(),
    priceField: z.enum(["askingPrice", "offerPrice"]).optional(),
    amount: z.number().positive().optional(),
    taskId: z.number().int().optional(),
    milestoneId: z.number().int().optional(),
    title: z.string().max(200).optional(),
    priority: z.enum(["low", "medium", "high", "urgent"]).optional(),
    name: z.string().max(200).optional(),
    notes: z.string().max(2000).optional(),
    status: z.enum(["open", "done"]).optional(),
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
  });

  app.post("/api/pipeline/:id/apply", (req, res) => {
    const deal = storage.getPipelineDeal(Number(req.params.id));
    if (!deal) return res.status(404).json({ message: "Deal not found" });
    const parsed = applyInput.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ message: readable(parsed.error) });
    const a = parsed.data;
    const today = todayYmd();
    const fail = (message: string) => res.status(400).json({ message });

    switch (a.type) {
      case "set_deal_date": {
        if (!a.field || !a.date) return fail("This suggestion has no date to apply.");
        const r = updateDeal(deal.id, { [a.field]: a.date });
        if (r.status !== 200) return res.status(r.status).json(r.body);
        break;
      }
      case "set_deal_price": {
        if (!a.priceField || !a.amount) return fail("This suggestion has no amount to apply.");
        const r = updateDeal(deal.id, { [a.priceField]: a.amount });
        if (r.status !== 200) return res.status(r.status).json(r.body);
        break;
      }
      case "add_task": {
        if (!a.title) return fail("This suggestion has no task title.");
        storage.createTask({
          title: a.title.startsWith(`${deal.name}:`) ? a.title : `${deal.name}: ${a.title}`,
          description: a.reason || "Suggested by Claude", projectId: null, dealId: deal.id,
          priority: a.priority ?? "medium", status: "open",
          dueDate: a.date ?? null, reminderDate: a.date ? maxYmd(addDaysYmd(a.date, -3), today) : null,
          assignedTo: null, category: "general", completedAt: null, createdAt: new Date().toISOString(), notes: null,
        });
        break;
      }
      case "update_task": {
        const t = storage.getTasks().find(x => x.id === a.taskId && x.dealId === deal.id);
        if (!t) return fail("That task no longer exists on this deal.");
        const data: Record<string, unknown> = {};
        if (a.date) { data.dueDate = a.date; data.reminderDate = maxYmd(addDaysYmd(a.date, -3), today); }
        if (a.title) data.title = a.title;
        if (a.status) { data.status = a.status; data.completedAt = a.status === "done" ? new Date().toISOString() : null; }
        storage.updateTask(t.id, data as any);
        break;
      }
      case "add_milestone": {
        if (!a.name) return fail("This suggestion has no milestone name.");
        storage.createMilestone({ dealId: deal.id, name: a.name, dueDate: a.date ?? null, notes: a.notes ?? null });
        break;
      }
      case "update_milestone": {
        const m = storage.getMilestone(a.milestoneId ?? -1);
        if (!m || m.dealId !== deal.id) return fail("That milestone no longer exists on this deal.");
        const data: Record<string, unknown> = {};
        if (a.date) data.dueDate = a.date;
        if (a.name) data.name = a.name;
        if (a.status) { data.status = a.status; data.completedAt = a.status === "done" ? new Date().toISOString() : null; }
        storage.updateMilestone(m.id, data as any);
        break;
      }
    }
    storage.addDealActivity(deal.id, today, "note", `Applied Claude's suggestion: ${a.summary}.${a.reason ? ` ${a.reason}` : ""}`);
    res.json({ ok: true });
  });

  // ── Morning email ──────────────────────────────────────────────────
  app.get("/api/digest/status", (_req, res) => res.json(digestStatus()));
  app.get("/api/digest/preview", (_req, res) => {
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.send(buildDigest().html);
  });
  app.post("/api/digest/test", async (_req, res) => {
    try {
      const r = await sendDigest({ test: true });
      clearDigestError();
      res.json({ ok: true, to: r.to });
    } catch (err: any) {
      res.status(400).json({ message: err.message });
    }
  });

  // Unknown API paths get a JSON 404 instead of falling through to the web app.
  app.use("/api", (_req, res) => res.status(404).json({ message: "Not found" }));

  return httpServer;
}
