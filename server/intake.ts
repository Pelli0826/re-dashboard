// The steps after Claude reads an OM, shared by the Upload OM review form and the Box import:
// matching the broker to Contacts, and saving the PDF, screening memo and underwriting model
// to the new deal.
import { storage } from "./storage";
import { underwritingFromOm, type OmAnalysis } from "@shared/intake";
import type { Contact, PipelineDeal } from "@shared/schema";

// The listing broker's existing contact, matched by email or name.
export function matchBrokerContact(b: OmAnalysis["broker"]): Contact | undefined {
  if (!b?.name && !b?.email) return undefined;
  return storage.getContacts().find(c =>
    (b.email && c.email?.toLowerCase() === b.email.trim().toLowerCase()) ||
    (b.name && c.name.trim().toLowerCase() === b.name.trim().toLowerCase()));
}

// Match the broker, or add them to Contacts (the review form does this when "Add a new broker" is saved).
export function findOrAddBroker(b: OmAnalysis["broker"]): { contact: Contact | null; added: boolean } {
  const match = matchBrokerContact(b);
  if (match) return { contact: match, added: false };
  if (!b?.name?.trim()) return { contact: null, added: false };
  const contact = storage.createContact({
    name: b.name.trim(), company: b.company?.trim() || null, role: "broker",
    email: b.email?.trim() || null, phone: b.phone?.trim() || null, projectIds: null, notes: null,
  });
  return { contact, added: true };
}

// Save the OM to the deal, the screening memo to its activity log, and optionally a linked model.
export function finishOmIntake(deal: PipelineDeal, opts: {
  analysis: OmAnalysis; memo: string; fileName: string; createUnderwriting: boolean;
  fileId?: number;   // Upload OM: the PDF was saved when it was read
  pdf?: Buffer;      // Box import: save it now
}) {
  const today = new Date().toISOString().slice(0, 10);
  storage.addDealActivity(deal.id, today, "note", opts.memo);
  if (opts.fileId) storage.attachDealFile(opts.fileId, deal.id);
  else if (opts.pdf) storage.saveDealFile(opts.pdf, opts.fileName, "application/pdf", deal.id, "om");
  const model = opts.createUnderwriting
    ? storage.createUnderwritingDeal(underwritingFromOm(opts.analysis, deal, opts.fileName, new Date().toISOString()))
    : null;
  return { model };
}
