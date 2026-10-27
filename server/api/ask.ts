// Ask about this deal, and applying the changes Claude suggests.
import type { Express } from "express";
import { fileToText, TEXT_READABLE } from "../fileText";
import { z } from "zod";
import { claudeConfigured, MAX_PDF_BYTES, askAboutDeal, type AskTurn } from "../claude";
import { buildProforma, calcReturns, maxPriceForIrr } from "@shared/underwriting";
import { storage } from "../storage";
import { STAGE_LABELS, type Stage, isYmd, addDaysYmd, addMonthsYmd } from "@shared/pipeline";
import type { PipelineDeal } from "@shared/schema";
import { todayYmd, maxYmd, readable } from "./common";
import { updateDeal } from "../deals";

export function registerAskRoutes(app: Express) {
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
    // Word, Excel, CSV and text files are converted to text so Claude can read them too.
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
        } else if (TEXT_READABLE.test(f.name)) {
          const text = await fileToText(f.name, storage.readDealFile(f));
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

}
