// Underwriting models and document auto-fill.
import type { Express } from "express";
import multer from "multer";
import { fileToText, TEXT_READABLE } from "../fileText";
import { z } from "zod";
import { extractFromPdf, extractFromText, type DocType } from "../extract";
import { claudeConfigured } from "../claude";
import { storage } from "../storage";
import { insertUnderwritingSchema } from "@shared/schema";
import { readable } from "./common";

export function registerUnderwritingRoutes(app: Express) {
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
      const name = req.file.originalname ?? "";
      if (/\.pdf$/i.test(name) || req.file.mimetype === "application/pdf") return res.json(await extractFromPdf(req.file.buffer, docType));
      if (/\.xls$/i.test(name)) return res.status(400).json({ message: "Older .xls files can't be read. Open it in Excel, choose File → Save As → Excel Workbook (.xlsx), and upload that." });
      const text = TEXT_READABLE.test(name) ? await fileToText(name, req.file.buffer) : null;
      if (text == null) return res.status(400).json({ message: "Upload a PDF, Excel (.xlsx or .xlsm), Word (.docx) or CSV file." });
      if (!text) return res.status(400).json({ message: `${name} looks empty.` });
      res.json(await extractFromText(name, text, docType));
    } catch (err: any) {
      res.status(500).json({ message: err.message ?? "Extraction failed" });
    }
  });

  // Read a file already saved to the model's Pipeline deal (PDF, Excel, Word or CSV). Returns the
  // extracted figures; the page fills them in for review and nothing is saved until the user clicks Save.
  app.post("/api/underwriting/:id/from-file", async (req, res) => {
    const model = storage.getUnderwritingDeal(Number(req.params.id));
    if (!model) return res.status(404).json({ message: "Model not found" });
    const parsed = z.object({ fileId: z.number().int(), docType: z.enum(["om", "rentroll", "pl"]) }).safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ message: readable(parsed.error) });
    const f = storage.getDealFile(parsed.data.fileId);
    if (!f || !model.dealId || f.dealId !== model.dealId) return res.status(404).json({ message: "That file isn't saved to this model's deal." });
    if (!claudeConfigured()) return res.status(400).json({ message: "Set ANTHROPIC_API_KEY in Railway to enable document reading." });
    let buffer: Buffer;
    try { buffer = storage.readDealFile(f); } catch { return res.status(410).json({ message: "This file is missing from storage." }); }
    try {
      if (f.mime === "application/pdf") return res.json({ fileName: f.name, ...(await extractFromPdf(buffer, parsed.data.docType)) });
      if (!TEXT_READABLE.test(f.name)) {
        return res.status(400).json({ message: /\.xls$/i.test(f.name)
          ? "Older .xls files can't be read. Open it in Excel, choose File → Save As → Excel Workbook (.xlsx), and add that to the deal."
          : "Only PDF, Excel (.xlsx or .xlsm), Word (.docx) and CSV files can be read." });
      }
      const text = await fileToText(f.name, buffer);
      if (!text) return res.status(400).json({ message: `${f.name} looks empty.` });
      res.json({ fileName: f.name, ...(await extractFromText(f.name, text, parsed.data.docType)) });
    } catch (err: any) {
      console.error(`[underwriting] could not read file ${f.id}: ${err?.message}`);
      res.status(500).json({ message: err?.message ?? "Could not read the file." });
    }
  });

}
