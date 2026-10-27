// Upload OM intake, deal files and letters of intent.
import type { Express } from "express";
import multer from "multer";
import { z } from "zod";
import { analyzeOm, mathCheck, screeningMemo, claudeConfigured, MAX_PDF_BYTES } from "../claude";
import { storage, getState, setState, deleteState } from "../storage";
import { buildLoiDocx } from "../loi";
import { matchBrokerContact, finishOmIntake } from "../intake";
import { dealFromOm, omHasIncome, type OmAnalysis } from "@shared/intake";
import { defaultLoiTerms, type LoiTerms } from "@shared/loi";
import type { PipelineDeal } from "@shared/schema";
import { todayYmd, readable } from "./common";

export function registerDealFileRoutes(app: Express) {
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
      const memo = screeningMemo(analysis, checks, req.file.originalname);
      const match = matchBrokerContact(analysis.broker);
      // Keep the PDF and the reading; both go to the deal when the review form is saved.
      const saved = storage.saveDealFile(req.file.buffer, req.file.originalname, "application/pdf", null, "om");
      setState(`intake:${saved.id}`, JSON.stringify({ analysis, memo, fileName: req.file.originalname }));
      res.json({
        analysis,
        mathCheck: checks,
        memo,
        brokerContactId: match?.id ?? null,
        fileId: saved.id,
        // The review form's starting values: the same mapping the Box import uses.
        deal: dealFromOm(analysis, { stage: "screening", brokerContactId: match?.id ?? null, today: todayYmd() }),
        hasIncome: omHasIncome(analysis),
      });
    } catch (err: any) {
      res.status(502).json({ message: err.message ?? "Could not read this OM." });
    }
  });

  // After the review form saves the deal: attach the OM, save the screening memo, and create the
  // linked underwriting model if the box was ticked (finishOmIntake, shared with the Box import).
  app.post("/api/pipeline/:id/intake", (req, res) => {
    const deal = storage.getPipelineDeal(Number(req.params.id));
    if (!deal) return res.status(404).json({ message: "Deal not found" });
    const fileId = Number(req.body?.fileId);
    const raw = getState(`intake:${fileId}`);
    const file = storage.getDealFile(fileId);
    if (!raw || !file || file.dealId != null) {
      return res.status(410).json({ message: "This OM reading has expired (OMs not saved within a day are removed). Upload the OM again." });
    }
    const intake = JSON.parse(raw) as { analysis: OmAnalysis; memo: string; fileName: string };
    const { model } = finishOmIntake(deal, { ...intake, fileId, createUnderwriting: req.body?.createUnderwriting === true });
    deleteState(`intake:${fileId}`);
    res.json({ ok: true, underwritingId: model?.id ?? null });
  });

  // ── Deal files ─────────────────────────────────────────────────────
  const ALLOWED_TYPES: Record<string, string> = {
    ".pdf": "application/pdf", ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    ".xlsm": "application/vnd.ms-excel.sheet.macroEnabled.12",
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

}
