// Pipeline deals: list, add, edit, review, milestones, activity, delete.
import type { Express } from "express";
import { z } from "zod";
import { storage } from "../storage";
import { ACTIVITY_KINDS } from "@shared/pipeline";
import { insertDealActivitySchema } from "@shared/schema";
import { todayYmd, readable } from "./common";
import { createDeal, updateDeal, createProjectForDeal } from "../deals";

export function registerPipelineRoutes(app: Express) {
  // ── Pipeline ──────────────────────────────────────────────────────────

  app.get("/api/pipeline", (_req, res) => res.json(storage.getPipeline()));
  app.get("/api/pipeline/:id", (req, res) => {
    const d = storage.getPipelineDeal(Number(req.params.id));
    if (!d) return res.status(404).json({ message: "Not found" });
    res.json(d);
  });


  app.post("/api/pipeline", (req, res) => {
    const r = createDeal(req.body);
    if (!r.deal) return res.status(400).json({ message: r.error });
    res.status(201).json(r.deal);
  });

  // Clears the "Needs review" flag on a deal the Box import created.
  app.post("/api/pipeline/:id/reviewed", (req, res) => {
    const deal = storage.getPipelineDeal(Number(req.params.id));
    if (!deal) return res.status(404).json({ message: "Deal not found" });
    if (deal.needsReview) {
      storage.updatePipelineDeal(deal.id, { needsReview: 0 });
      storage.addDealActivity(deal.id, todayYmd(), "note", "Marked reviewed: figures checked against the OM.");
    }
    res.json(storage.getPipelineDeal(deal.id));
  });

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

}
