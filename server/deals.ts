// Deal logic shared by the API routes, the Box import and applied suggestions:
// creating and updating deals, deal → project sync, and the due diligence checklist.
import { z } from "zod";
import { storage, getState, setState } from "./storage";
import { projectFromDeal, PSA_STAGES, PROJECT_STATUS_LABELS } from "@shared/projects";
import { STAGES, DEAL_TYPES, STAGE_LABELS, daysSince, type Stage, isYmd, addDaysYmd, diffDaysYmd } from "@shared/pipeline";
import type { PipelineDeal } from "@shared/schema";
import { insertPipelineSchema } from "@shared/schema";
import { todayYmd, maxYmd, readable } from "./api/common";

export const dealInput = insertPipelineSchema.extend({
  stage: z.enum(STAGES),
  type: z.enum(DEAL_TYPES),
  probabilityOverride: z.number().int().min(0).max(100).nullable().optional(),
});

// One path for new deals: the Add deal form, the Upload OM review form and the Box import.
// `extra` sets fields users can't send (the Box import's needsReview flag).
export function createDeal(body: unknown, extra: Partial<PipelineDeal> = {}): { deal?: PipelineDeal; error?: string } {
  const parsed = dealInput.safeParse(body);
  if (!parsed.success) return { error: readable(parsed.error) };
  if (parsed.data.stage === "dead" && !parsed.data.deadReason) return { error: "A reason is required when marking a deal dead." };
  let deal = storage.createPipelineDeal(parsed.data);
  if (Object.keys(extra).length) deal = storage.updatePipelineDeal(deal.id, extra)!;
  const today = new Date().toISOString().slice(0, 10);
  storage.addDealActivity(deal.id, deal.firstContactDate || today, "created", `Deal added in ${STAGE_LABELS[deal.stage as Stage]}`);
  if (deal.stage === "due-diligence") createDueDiligenceTasks(deal);
  if (PSA_STAGES.includes(deal.stage)) createProjectForDeal(deal);
  return { deal: storage.getPipelineDeal(deal.id)! };
}

// One update path for the edit form, stage moves and applied suggestions.
export function updateDeal(id: number, body: unknown): { status: number; body: unknown } {
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
export function createProjectForDeal(deal: PipelineDeal) {
  const uw = storage.getUnderwritingDeals().find(u => u.dealId === deal.id);
  const p = storage.createProject(projectFromDeal(deal, uw, todayYmd()));
  storage.addDealActivity(deal.id, todayYmd(), "note",
    `Project created on the Projects tab (${PROJECT_STATUS_LABELS[p.status]}, budget $${Math.round(p.totalBudget).toLocaleString("en-US")}${uw ? ` from "${uw.name}"` : ""}).`);
  return p;
}
export function syncProject(deal: PipelineDeal) {
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

// When the DD end date changes, shift the open checklist tasks by the same number of days.
export function redateChecklist(before: PipelineDeal, after: PipelineDeal) {
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

// Standard due diligence checklist, created once when a deal enters DD.
export function createDueDiligenceTasks(deal: PipelineDeal) {
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
