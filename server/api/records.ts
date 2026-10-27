// Simple records: projects, backup, ARM loans, cash flow, contacts, investors, documents, tasks.
import type { Express } from "express";
import { claudeConfigured } from "../claude";
import { storage, DB_IS_PERSISTENT } from "../storage";
import { insertProjectSchema, insertArmLoanSchema, insertCashFlowSchema, insertContactSchema, insertInvestorSchema, insertDocumentSchema, insertTaskSchema } from "@shared/schema";

export function registerRecordRoutes(app: Express) {
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

}
