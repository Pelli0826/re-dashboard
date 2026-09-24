import type { Express } from "express";
import { createServer, type Server } from "http";
import multer from "multer";
import crypto from "crypto";
import { z } from "zod";
import { extractFromPdf, type DocType } from "./extract";
import { analyzeOm, mathCheck, screeningMemo, claudeConfigured, MAX_PDF_BYTES } from "./claude";
import { storage, DB_IS_PERSISTENT } from "./storage";
import {
  STAGES, DEAL_TYPES, ACTIVITY_KINDS, STAGE_LABELS, daysSince, type Stage,
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
    res.status(201).json(storage.getPipelineDeal(deal.id));
  });

  app.patch("/api/pipeline/:id", (req, res) => {
    const id = Number(req.params.id);
    const existing = storage.getPipelineDeal(id);
    if (!existing) return res.status(404).json({ message: "Not found" });
    const parsed = dealInput.partial().safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ message: readable(parsed.error) });

    const data: Partial<PipelineDeal> = { ...parsed.data };
    const newStage = data.stage ?? existing.stage;
    const stageChanged = newStage !== existing.stage;

    if (newStage === "dead" && !(data.deadReason ?? existing.deadReason)) {
      return res.status(400).json({ message: "A reason is required when marking a deal dead." });
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
        storage.addDealActivity(id, new Date().toISOString().slice(0, 10), "note",
          `Underwriting "${m.name}" purchase price updated from $${Math.round(m.purchasePrice).toLocaleString()} to $${Math.round(newPrice).toLocaleString()} to match the ${updated.offerPrice ? "offer" : "asking price"}.`);
      }
    }

    if (stageChanged) {
      const days = daysSince(existing.stageChangedAt) ?? 0;
      let summary = `${STAGE_LABELS[existing.stage as Stage] ?? existing.stage} → ${STAGE_LABELS[newStage as Stage] ?? newStage} after ${days} day${days === 1 ? "" : "s"}`;
      if (newStage === "dead" && updated.deadReason) summary += `. Reason: ${updated.deadReason}`;
      storage.addDealActivity(id, new Date().toISOString().slice(0, 10), "stage-change", summary);
      if (newStage === "due-diligence") createDueDiligenceTasks(updated);
    }
    res.json(storage.getPipelineDeal(id));
  });

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
      res.json({
        analysis,
        mathCheck: checks,
        memo: screeningMemo(analysis, checks, req.file.originalname),
        brokerContactId: match?.id ?? null,
      });
    } catch (err: any) {
      res.status(502).json({ message: err.message ?? "Could not read this OM." });
    }
  });

  // Unknown API paths get a JSON 404 instead of falling through to the web app.
  app.use("/api", (_req, res) => res.status(404).json({ message: "Not found" }));

  return httpServer;
}
