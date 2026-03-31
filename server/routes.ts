import type { Express } from "express";
import { createServer, type Server } from "http";
import multer from "multer";
import { extractFromPdf, type DocType } from "./extract";
import { storage } from "./storage";
import {
  insertProjectSchema, insertPipelineSchema, insertArmLoanSchema,
  insertCashFlowSchema, insertContactSchema, insertInvestorSchema, insertDocumentSchema,
  insertTaskSchema, insertUnderwritingSchema
} from "@shared/schema";

// Auth middleware — protects all /api routes except /api/auth/*
function requireAuth(req: any, res: any, next: any) {
  const password = process.env.DASHBOARD_PASSWORD;
  // If no password set, allow all access
  if (!password) return next();
  if (req.session?.authenticated) return next();
  return res.status(401).json({ message: "Unauthorized" });
}

export async function registerRoutes(httpServer: Server, app: Express): Promise<Server> {

  // ── Auth routes (public — no middleware) ────────────────────────────────
  app.post("/api/auth/login", (req, res) => {
    const { password } = req.body;
    const correctPassword = process.env.DASHBOARD_PASSWORD;
    // If no password configured, auto-login
    if (!correctPassword || password === correctPassword) {
      req.session.authenticated = true;
      return res.json({ ok: true });
    }
    return res.status(401).json({ message: "Incorrect password" });
  });

  app.post("/api/auth/logout", (req, res) => {
    req.session.destroy(() => {});
    res.json({ ok: true });
  });

  app.get("/api/auth/check", (req, res) => {
    const password = process.env.DASHBOARD_PASSWORD;
    // If no password set, always authenticated
    if (!password) return res.json({ authenticated: true, passwordRequired: false });
    res.json({ authenticated: !!req.session?.authenticated, passwordRequired: true });
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

  // ── Pipeline ──────────────────────────────────────────────────────────
  app.get("/api/pipeline", (_req, res) => res.json(storage.getPipeline()));
  app.post("/api/pipeline", (req, res) => {
    const parsed = insertPipelineSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ message: parsed.error.message });
    res.status(201).json(storage.createPipelineDeal(parsed.data));
  });
  app.patch("/api/pipeline/:id", (req, res) => {
    const parsed = insertPipelineSchema.partial().safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ message: parsed.error.message });
    const u = storage.updatePipelineDeal(Number(req.params.id), parsed.data);
    if (!u) return res.status(404).json({ message: "Not found" });
    res.json(u);
  });
  app.delete("/api/pipeline/:id", (req, res) => { storage.deletePipelineDeal(Number(req.params.id)); res.status(204).send(); });

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
  const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 100 * 1024 * 1024 } }); // 100MB limit
  app.post("/api/underwriting/extract", upload.single("file"), async (req, res) => {
    try {
      if (!process.env.OPENAI_API_KEY) {
        return res.status(400).json({ message: "OPENAI_API_KEY not configured on server." });
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

  // ── Seed ──────────────────────────────────────────────────────────────
  app.post("/api/seed", (_req, res) => {
    storage.createProject({ name: "The Meridian Lofts", address: "412 W Grand Ave, Chicago IL", type: "residential", status: "construction", totalBudget: 14500000, spentToDate: 9200000, projectedNoi: 920000, units: 48, sqft: 52000, startDate: "2024-06-01", expectedCompletion: "2026-08-01", equity: 4350000, notes: "Class-A multifamily, LIHTC deal" });
    storage.createProject({ name: "Lakeview Commerce Center", address: "8800 Lake Shore Dr, Chicago IL", type: "commercial", status: "entitlement", totalBudget: 28000000, spentToDate: 1100000, projectedNoi: 2100000, units: null, sqft: 85000, startDate: "2025-03-01", expectedCompletion: "2027-06-01", equity: 8400000, notes: "Mixed-use ground floor retail + office" });
    storage.createProject({ name: "Southside Townhomes", address: "2200 S Halsted St, Chicago IL", type: "residential", status: "stabilized", totalBudget: 6800000, spentToDate: 6800000, projectedNoi: 580000, units: 22, sqft: 28000, startDate: "2022-01-15", expectedCompletion: "2023-09-01", equity: 2040000, notes: "Fully leased, refinanced Q1 2024" });
    storage.createProject({ name: "Pilsen Mixed-Use", address: "1800 W 18th St, Chicago IL", type: "mixed-use", status: "planning", totalBudget: 9200000, spentToDate: 320000, projectedNoi: 740000, units: 18, sqft: 22000, startDate: "2025-11-01", expectedCompletion: "2027-10-01", equity: 2760000, notes: "Retail + residential, historic tax credits pending" });

    storage.createPipelineDeal({ name: "Wicker Park Apartment", address: "1650 N Damen Ave, Chicago IL", type: "residential", stage: "due-diligence", askingPrice: 5800000, projectedValue: 7200000, capRate: 4.8, units: 32, sqft: 36000, probability: 70, targetCloseDate: "2026-05-15", broker: "JLL", notes: "Off-market, seller motivated" });
    storage.createPipelineDeal({ name: "Logan Square Retail Strip", address: "2400 N Milwaukee Ave, Chicago IL", type: "commercial", stage: "loi", askingPrice: 3200000, projectedValue: 4100000, capRate: 5.5, units: null, sqft: 12000, probability: 55, targetCloseDate: "2026-06-01", broker: "CBRE", notes: "3 tenants in place, 1 vacancy" });
    storage.createPipelineDeal({ name: "Lincoln Park Dev Site", address: "900 W Belden Ave, Chicago IL", type: "land", stage: "prospecting", askingPrice: 2100000, projectedValue: 9500000, capRate: null, units: 40, sqft: 8500, probability: 30, targetCloseDate: "2026-09-01", broker: "Marcus Millichap", notes: "Zoning variance needed, R4 target" });
    storage.createPipelineDeal({ name: "Evanston Medical Office", address: "1720 Orrington Ave, Evanston IL", type: "commercial", stage: "under-contract", askingPrice: 7400000, projectedValue: 8900000, capRate: 6.2, units: null, sqft: 24000, probability: 85, targetCloseDate: "2026-04-20", broker: "Colliers", notes: "NNN leases, anchor tenant Northwestern" });

    storage.createArmLoan({ loanName: "Meridian Lofts Construction Loan", projectId: 1, lender: "Inland Bank", originalBalance: 10150000, currentBalance: 8900000, currentRate: 7.85, indexType: "SOFR", margin: 3.25, currentIndex: 4.6, cap: 10.0, floor: 5.5, nextResetDate: "2026-06-01", maturityDate: "2027-08-01", monthlyPayment: 58300, loanType: "construction", status: "active", notes: "Interest-only during construction" });
    storage.createArmLoan({ loanName: "Lakeview Commerce Bridge", projectId: 2, lender: "Wintrust Bank", originalBalance: 20000000, currentBalance: 1100000, currentRate: 8.10, indexType: "SOFR", margin: 3.50, currentIndex: 4.6, cap: 11.0, floor: 6.0, nextResetDate: "2026-09-01", maturityDate: "2027-06-01", monthlyPayment: 7425, loanType: "bridge", status: "active", notes: "Drawn down as entitlement progresses" });
    storage.createArmLoan({ loanName: "Southside Townhomes Perm", projectId: 3, lender: "First Midwest Bank", originalBalance: 4760000, currentBalance: 4490000, currentRate: 6.15, indexType: "fixed", margin: 0, currentIndex: 0, cap: null, floor: null, nextResetDate: null, maturityDate: "2033-09-01", monthlyPayment: 27600, loanType: "permanent", status: "active", notes: "Locked in at 6.15% fixed for 10 years" });
    storage.createArmLoan({ loanName: "Evanston Medical Bridge", projectId: null, lender: "BMO Harris", originalBalance: 5550000, currentBalance: 5550000, currentRate: 7.50, indexType: "Prime", margin: 1.25, currentIndex: 6.25, cap: 10.5, floor: 5.0, nextResetDate: "2026-07-01", maturityDate: "2027-04-20", monthlyPayment: 34688, loanType: "bridge", status: "active", notes: "Bridge to permanent on close" });

    // Cash Flow — Meridian Lofts (projectId=1), recent months
    const cfItems = [
      { projectId: 1, month: "2026-01", category: "income", subcategory: "loan-proceeds", amount: 850000, notes: "Draw #7" },
      { projectId: 1, month: "2026-01", category: "expense", subcategory: "construction-cost", amount: 920000, notes: "GC payment" },
      { projectId: 1, month: "2026-01", category: "expense", subcategory: "interest", amount: 58300, notes: "Inland Bank" },
      { projectId: 1, month: "2026-02", category: "income", subcategory: "loan-proceeds", amount: 700000, notes: "Draw #8" },
      { projectId: 1, month: "2026-02", category: "expense", subcategory: "construction-cost", amount: 680000, notes: "GC + subs" },
      { projectId: 1, month: "2026-02", category: "expense", subcategory: "interest", amount: 58300, notes: "Inland Bank" },
      { projectId: 1, month: "2026-03", category: "income", subcategory: "loan-proceeds", amount: 500000, notes: "Draw #9" },
      { projectId: 1, month: "2026-03", category: "expense", subcategory: "construction-cost", amount: 520000, notes: "Finishes + MEP" },
      { projectId: 1, month: "2026-03", category: "expense", subcategory: "interest", amount: 58300, notes: "Inland Bank" },
      { projectId: 1, month: "2026-03", category: "expense", subcategory: "soft-costs", amount: 22000, notes: "Architect + legal" },
      // Southside Townhomes (projectId=3) — stabilized, showing rental income
      { projectId: 3, month: "2026-01", category: "income", subcategory: "rent", amount: 52000, notes: "22 units @ avg $2,363" },
      { projectId: 3, month: "2026-01", category: "expense", subcategory: "mgmt-fee", amount: 5200, notes: "10% of gross" },
      { projectId: 3, month: "2026-01", category: "expense", subcategory: "interest", amount: 27600, notes: "First Midwest Perm" },
      { projectId: 3, month: "2026-01", category: "expense", subcategory: "opex", amount: 8100, notes: "Utilities, R&M" },
      { projectId: 3, month: "2026-02", category: "income", subcategory: "rent", amount: 52000 },
      { projectId: 3, month: "2026-02", category: "expense", subcategory: "mgmt-fee", amount: 5200 },
      { projectId: 3, month: "2026-02", category: "expense", subcategory: "interest", amount: 27600 },
      { projectId: 3, month: "2026-02", category: "expense", subcategory: "opex", amount: 7400 },
      { projectId: 3, month: "2026-03", category: "income", subcategory: "rent", amount: 52500 },
      { projectId: 3, month: "2026-03", category: "expense", subcategory: "mgmt-fee", amount: 5250 },
      { projectId: 3, month: "2026-03", category: "expense", subcategory: "interest", amount: 27600 },
      { projectId: 3, month: "2026-03", category: "expense", subcategory: "opex", amount: 6900 },
    ];
    cfItems.forEach(item => storage.createCashFlowEntry({ ...item, notes: item.notes ?? null }));

    // Contacts
    storage.createContact({ name: "Sarah Chen", company: "Inland Bank", role: "lender", email: "schen@inlandbank.com", phone: "312-555-0142", projectIds: "[1]", notes: "Primary contact for Meridian construction loan" });
    storage.createContact({ name: "Tom DiMaggio", company: "JLL Chicago", role: "broker", email: "tom.dimaggio@jll.com", phone: "312-555-0288", projectIds: "[1,3]", notes: "Multifamily specialist" });
    storage.createContact({ name: "Maria Gonzalez", company: "Colliers International", role: "broker", email: "m.gonzalez@colliers.com", phone: "312-555-0374", projectIds: "[2]", notes: "Office/retail leasing" });
    storage.createContact({ name: "James Whitmore", company: "Whitmore Realty Law", role: "attorney", email: "jw@whitmore-law.com", phone: "312-555-0590", projectIds: "[1,2,3,4]", notes: "Handles all closings" });
    storage.createContact({ name: "Robert Kim", company: "Wintrust Bank", role: "lender", email: "rkim@wintrust.com", phone: "847-555-0210", projectIds: "[2]", notes: "Bridge loan officer" });
    storage.createContact({ name: "Lisa Park", company: "Park Capital Group", role: "investor", email: "lisa@parkcapital.com", phone: "773-555-0441", projectIds: "[1,3]", notes: "Lead LP on two deals" });

    // Investors
    storage.createInvestor({ name: "Lisa Park", entityName: "Park Capital Group LLC", contactId: 6, projectId: 1, commitment: 2000000, funded: 2000000, preferredReturn: 8, equityShare: 25, totalDistributed: 0, status: "active", closeDate: "2024-05-15", notes: "Lead LP, 8% pref + 25% promote" });
    storage.createInvestor({ name: "David Stern", entityName: "Stern Family Trust", contactId: null, projectId: 1, commitment: 1500000, funded: 1500000, preferredReturn: 8, equityShare: 18.75, totalDistributed: 0, status: "active", closeDate: "2024-05-15" });
    storage.createInvestor({ name: "Angela Torres", entityName: "AT Ventures LLC", contactId: null, projectId: 1, commitment: 850000, funded: 850000, preferredReturn: 8, equityShare: 10, totalDistributed: 0, status: "active", closeDate: "2024-05-20" });
    storage.createInvestor({ name: "Lisa Park", entityName: "Park Capital Group LLC", contactId: 6, projectId: 3, commitment: 1200000, funded: 1200000, preferredReturn: 8, equityShare: 35, totalDistributed: 145000, status: "active", closeDate: "2022-01-10", notes: "Two quarterly distributions made" });
    storage.createInvestor({ name: "Michael Russo", entityName: "Russo Holdings", contactId: null, projectId: 3, commitment: 840000, funded: 840000, preferredReturn: 8, equityShare: 25, totalDistributed: 101500, status: "active", closeDate: "2022-01-10" });

    // Documents
    const today = new Date().toISOString().split("T")[0];
    storage.createDocument({ projectId: 1, name: "Construction Loan Agreement", category: "contracts", url: "https://drive.google.com/file/meridian-loan", notes: "Inland Bank, signed 2024-05-01", uploadedAt: today });
    storage.createDocument({ projectId: 1, name: "Building Permit", category: "permits", url: null, notes: "City of Chicago #B2024-48201, issued 2024-06-15", uploadedAt: today });
    storage.createDocument({ projectId: 1, name: "Architect Drawings", category: "contracts", url: "https://drive.google.com/file/meridian-drawings", notes: "Schematic + CD set", uploadedAt: today });
    storage.createDocument({ projectId: 2, name: "Entitlement Application", category: "permits", url: null, notes: "Filed 2025-04-01, hearing pending", uploadedAt: today });
    storage.createDocument({ projectId: 3, name: "HUD Appraisal", category: "financials", url: "https://drive.google.com/file/southside-appraisal", notes: "Value: $7.4M as of 2024-01-10", uploadedAt: today });
    storage.createDocument({ projectId: 3, name: "Lease Agreements", category: "legal", url: "https://drive.google.com/file/southside-leases", notes: "All 22 units, current as of 2026-01", uploadedAt: today });
    storage.createDocument({ projectId: null, name: "Company Operating Agreement", category: "legal", url: "https://drive.google.com/file/company-oa", notes: "Master entity OA", uploadedAt: today });

    // Tasks — realistic real estate action items
    const now = new Date().toISOString();
    const taskItems = [
      { title: "Submit Meridian Lofts final draw request", description: "Prepare and submit draw #10 to Inland Bank for MEP finishes", projectId: 1, priority: "urgent", status: "open", dueDate: "2026-04-01", reminderDate: "2026-03-28", assignedTo: "Self", category: "finance", createdAt: now },
      { title: "Schedule city inspection — Meridian framing", description: "Rough framing + MEP inspection required before drywall", projectId: 1, priority: "high", status: "open", dueDate: "2026-04-05", reminderDate: "2026-04-03", assignedTo: "GC", category: "permit", createdAt: now },
      { title: "Renew Southside Townhomes unit 14 lease", description: "Lease expires 2026-04-30, send renewal offer 60 days out", projectId: 3, priority: "high", status: "open", dueDate: "2026-04-15", reminderDate: "2026-04-01", assignedTo: "Property Manager", category: "legal", createdAt: now },
      { title: "Evanston Medical Office — closing checklist", description: "Coordinate title, insurance binder, and wire with James Whitmore", projectId: null, priority: "urgent", status: "in-progress", dueDate: "2026-04-18", reminderDate: "2026-04-10", assignedTo: "Self", category: "closing", createdAt: now },
      { title: "Finalize Pilsen Mixed-Use architect contract", description: "Review AIA B101 contract, get Whitmore sign-off", projectId: 4, priority: "medium", status: "open", dueDate: "2026-05-01", reminderDate: "2026-04-20", assignedTo: "Self", category: "legal", createdAt: now },
      { title: "Lakeview entitlement hearing prep", description: "Prepare presentation for Zoning Board of Appeals", projectId: 2, priority: "high", status: "in-progress", dueDate: "2026-04-22", reminderDate: "2026-04-15", assignedTo: "Architect", category: "permit", createdAt: now },
      { title: "Q1 investor distribution — Southside", description: "Calculate and wire Q1 2026 distributions to Lisa Park + Michael Russo", projectId: 3, priority: "medium", status: "open", dueDate: "2026-04-30", reminderDate: "2026-04-25", assignedTo: "Self", category: "finance", createdAt: now },
      { title: "Meridian Lofts certificate of occupancy", description: "File CO application with City of Chicago once inspections pass", projectId: 1, priority: "high", status: "open", dueDate: "2026-07-01", reminderDate: "2026-06-15", assignedTo: "GC", category: "permit", createdAt: now },
      { title: "Update insurance policies — annual renewal", description: "Builder's risk, GL, and umbrella policies up for renewal", projectId: null, priority: "medium", status: "open", dueDate: "2026-05-15", reminderDate: "2026-05-01", assignedTo: "Insurance Broker", category: "general", createdAt: now },
      { title: "Wicker Park LOI response", description: "Counter-sign or decline LOI from JLL buyer", projectId: null, priority: "urgent", status: "done", dueDate: "2026-03-20", completedAt: now, assignedTo: "Self", category: "closing", createdAt: now },
    ];
    taskItems.forEach(t => storage.createTask({ ...t, notes: null, description: t.description ?? null, reminderDate: t.reminderDate ?? null, assignedTo: t.assignedTo ?? null, category: t.category ?? null, completedAt: t.completedAt ?? null }));

    res.json({ ok: true });
  });

  return httpServer;
}
