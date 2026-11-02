// Owned properties: records, monthly figures (actual and budget) and files. Monthly figures come
// from the manager's reports: Claude reads a report into the standard categories, the user reviews
// the month-by-month table, and only then are the months saved.
import type { Express } from "express";
import multer from "multer";
import { z } from "zod";
import { storage } from "../storage";
import { claudeConfigured, readOperatingReport, MAX_PDF_BYTES } from "../claude";
import { fileToText, TEXT_READABLE } from "../fileText";
import { insertPropertySchema } from "@shared/schema";
import { ALL_LINES, isMonth, type Lines } from "@shared/properties";
import { readable } from "./common";

const FILE_TYPES: Record<string, string> = {
  ".pdf": "application/pdf",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".xlsm": "application/vnd.ms-excel.sheet.macroEnabled.12",
  ".xls": "application/vnd.ms-excel",
  ".csv": "text/csv",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
};
const LINE_KEYS = ALL_LINES.map(l => l.key) as string[];

// Keep known categories with finite numbers; round to cents.
function cleanLines(raw: unknown): Lines {
  const out: Record<string, number> = {};
  if (raw && typeof raw === "object") {
    for (const k of LINE_KEYS) {
      const v = Number((raw as Record<string, unknown>)[k]);
      if ((raw as Record<string, unknown>)[k] != null && isFinite(v)) out[k] = Math.round(v * 100) / 100;
    }
  }
  return out as Lines;
}
const numOrNull = (v: unknown) => (v == null || v === "" || !isFinite(Number(v)) ? null : Number(v));

export function registerPropertyRoutes(app: Express) {
  const propertyInput = insertPropertySchema.extend({
    name: z.string().trim().min(1, "Give the property a name.").max(200),
    type: z.enum(["apartments", "retail", "mixed"]),
    status: z.enum(["owned", "sold"]).optional(),
  });

  app.get("/api/properties", (_req, res) => res.json(storage.getProperties()));
  app.get("/api/property-months", (_req, res) => res.json(storage.getAllPropertyMonths()));
  app.get("/api/properties/:id", (req, res) => {
    const p = storage.getProperty(Number(req.params.id));
    if (!p) return res.status(404).json({ message: "Not found" });
    res.json(p);
  });
  app.post("/api/properties", (req, res) => {
    const parsed = propertyInput.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ message: readable(parsed.error) });
    res.status(201).json(storage.createProperty(parsed.data));
  });
  app.patch("/api/properties/:id", (req, res) => {
    const parsed = propertyInput.partial().safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ message: readable(parsed.error) });
    const p = storage.updateProperty(Number(req.params.id), parsed.data);
    if (!p) return res.status(404).json({ message: "Not found" });
    res.json(p);
  });
  app.get("/api/properties/:id/related", (req, res) => res.json(storage.propertyRelatedCounts(Number(req.params.id))));
  app.delete("/api/properties/:id", (req, res) => { storage.deleteProperty(Number(req.params.id)); res.status(204).send(); });

  // A stabilized project becomes a property, carrying over what the project and its deal know.
  app.post("/api/projects/:id/property", (req, res) => {
    const project = storage.getProject(Number(req.params.id));
    if (!project) return res.status(404).json({ message: "Project not found" });
    const existing = storage.getProperties().find(p => p.projectId === project.id);
    if (existing) return res.status(409).json({ message: `This project is already the property "${existing.name}".` });
    const deal = project.dealId ? storage.getPipelineDeal(project.dealId) : undefined;
    const type = project.type === "commercial" ? "retail" : project.type === "mixed-use" ? "mixed" : "apartments";
    const property = storage.createProperty({
      name: project.name, address: project.address, type,
      units: project.units ?? deal?.units ?? null, sqft: project.sqft ?? deal?.sqft ?? null,
      ownerEntity: null, manager: null, managerContactId: null,
      acquiredDate: deal?.closingDate ?? null, purchasePrice: deal?.offerPrice ?? null,
      projectId: project.id, dealId: project.dealId ?? null, status: "owned",
      notes: null,
    });
    if (deal) storage.addDealActivity(deal.id, new Date().toISOString().slice(0, 10), "note", `Moved to Properties as "${property.name}".`);
    res.status(201).json(property);
  });

  // ── Monthly figures ─────────────────────────────────────────────────
  app.get("/api/properties/:id/months", (req, res) => res.json(storage.getPropertyMonths(Number(req.params.id))));

  const monthsInput = z.object({
    kind: z.enum(["actual", "budget"]),
    sourceFileId: z.number().int().nullable().optional(),
    months: z.array(z.object({
      month: z.string().refine(isMonth, "Months must look like 2026-03."),
      lines: z.record(z.string(), z.number().nullable()),
      reportedNoi: z.number().nullable().optional(),
      occupancy: z.number().min(0).max(100).nullable().optional(),
    })).min(1, "Choose at least one month to save.").max(60),
  });
  app.put("/api/properties/:id/months", (req, res) => {
    const property = storage.getProperty(Number(req.params.id));
    if (!property) return res.status(404).json({ message: "Property not found" });
    const parsed = monthsInput.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ message: readable(parsed.error) });
    const { kind, months, sourceFileId } = parsed.data;
    for (const m of months) {
      storage.savePropertyMonth({
        propertyId: property.id, month: m.month, kind, lines: JSON.stringify(cleanLines(m.lines)),
        reportedNoi: m.reportedNoi ?? null, occupancy: m.occupancy ?? null, sourceFileId: sourceFileId ?? null,
      });
    }
    res.json({ saved: months.length });
  });
  app.delete("/api/properties/:id/months/:month", (req, res) => {
    const kind = req.query.kind === "budget" ? "budget" : "actual";
    storage.deletePropertyMonth(Number(req.params.id), String(req.params.month), kind);
    res.status(204).send();
  });

  // ── Files ───────────────────────────────────────────────────────────
  const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_PDF_BYTES } });
  app.get("/api/properties/:id/files", (req, res) => res.json(storage.getPropertyFiles(Number(req.params.id))));
  app.post("/api/properties/:id/files", (req, res, next) => {
    upload.single("file")(req, res, err => {
      if (err?.code === "LIMIT_FILE_SIZE") return res.status(413).json({ message: "Files are limited to 24 MB." });
      if (err) return next(err);
      next();
    });
  }, (req, res) => {
    const property = storage.getProperty(Number(req.params.id));
    if (!property) return res.status(404).json({ message: "Property not found" });
    if (!req.file) return res.status(400).json({ message: "No file uploaded." });
    const ext = (req.file.originalname.match(/\.[a-z0-9]+$/i)?.[0] ?? "").toLowerCase();
    const mime = FILE_TYPES[ext];
    if (!mime) return res.status(400).json({ message: "Upload a PDF, Excel, CSV, Word or image file." });
    const kind = ["report", "budget"].includes(String(req.body?.kind)) ? String(req.body.kind) : "other";
    res.status(201).json(storage.savePropertyFile(req.file.buffer, req.file.originalname, mime, property.id, kind));
  });
  app.get("/api/property-files/:id/download", (req, res) => {
    const f = storage.getPropertyFile(Number(req.params.id));
    if (!f) return res.status(404).json({ message: "Not found" });
    let data: Buffer;
    try { data = storage.readPropertyFile(f); } catch { return res.status(410).json({ message: "This file is missing from storage." }); }
    res.setHeader("Content-Type", f.mime);
    res.setHeader("Content-Disposition", `${req.query.inline ? "inline" : "attachment"}; filename*=UTF-8''${encodeURIComponent(f.name)}`);
    res.send(data);
  });
  app.delete("/api/property-files/:id", (req, res) => { storage.deletePropertyFile(Number(req.params.id)); res.status(204).send(); });

  // Read a saved report into monthly figures for review. Nothing is saved here.
  app.post("/api/properties/:id/files/:fileId/read", async (req, res) => {
    const property = storage.getProperty(Number(req.params.id));
    const f = storage.getPropertyFile(Number(req.params.fileId));
    if (!property || !f || f.propertyId !== property.id) return res.status(404).json({ message: "File not found on this property." });
    if (!claudeConfigured()) return res.status(400).json({ message: "Set ANTHROPIC_API_KEY in Railway to read reports." });
    let buffer: Buffer;
    try { buffer = storage.readPropertyFile(f); } catch { return res.status(410).json({ message: "This file is missing from storage." }); }
    try {
      let result;
      if (f.mime === "application/pdf") result = await readOperatingReport({ name: f.name, pdf: buffer });
      else if (/\.xls$/i.test(f.name)) return res.status(400).json({ message: "Older .xls files can't be read. Open it in Excel, choose File → Save As → Excel Workbook (.xlsx), and upload that." });
      else if (TEXT_READABLE.test(f.name)) {
        const text = await fileToText(f.name, buffer);
        if (!text) return res.status(400).json({ message: `${f.name} looks empty.` });
        result = await readOperatingReport({ name: f.name, text });
      } else return res.status(400).json({ message: "Reports can be read from PDF, Excel (.xlsx or .xlsm) or CSV files." });

      // Keep valid months only, one entry per month (the last one wins), in order.
      const byMonth = new Map<string, { month: string; lines: Lines; reportedNoi: number | null; occupancy: number | null }>();
      for (const m of result.months) {
        if (!isMonth(m?.month)) continue;
        const occ = numOrNull(m.occupancy);
        byMonth.set(m.month, { month: m.month, lines: cleanLines(m.lines), reportedNoi: numOrNull(m.reportedNoi), occupancy: occ != null && occ >= 0 && occ <= 100 ? occ : null });
      }
      const months = Array.from(byMonth.values()).sort((a, b) => a.month.localeCompare(b.month));
      if (!months.length) return res.status(422).json({ message: "No monthly columns were found in this file. If it only has annual totals, it can't be split into months." });
      const existing = storage.getPropertyMonths(property.id).filter(r => r.kind === result.kind).map(r => r.month);
      res.json({ kind: result.kind, propertyName: result.propertyName, notes: result.notes, months, existing, fileId: f.id });
    } catch (err: any) {
      console.error(`[properties] could not read file ${f.id}: ${err?.message}`);
      res.status(502).json({ message: err?.message ?? "Could not read the report." });
    }
  });
}
