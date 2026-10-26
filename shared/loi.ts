// Letter of intent: terms, defaults from a deal, and the wording of each section.
// Used by the server (Word document) and the client (form preview), so both always agree.
// Dollar amounts and day counts are written out in words by code, never by the model.
import type { PipelineDeal, Contact } from "./schema";

export interface LoiDeposit { amount: number; when: string }

export interface LoiTerms {
  date: string;                 // YYYY-MM-DD
  recipientName: string;
  recipientCompany: string;
  recipientEmail: string;
  property: string;             // follows "Letter of Intent to Purchase"
  seller: string;
  buyer: string;
  price: number;
  paymentTerms: string;         // blank = section left out
  expirationDays: number;       // business days to sign
  deposits: LoiDeposit[];
  investigationDays: number;
  approvals: string;            // land deals; blank = section left out
  closingDays: number;
  closingAfter: string;         // e.g. "the expiration of the Investigation Period"
  prorations: boolean;          // income properties
  brokerage: string;
  exclusivityMonths: number;    // 0 = section left out
  signerName: string;
  signerTitle: string;
  signerPhone: string;
}

// ── Numbers in words ────────────────────────────────────────────────────────
const ONES = ["", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten",
  "eleven", "twelve", "thirteen", "fourteen", "fifteen", "sixteen", "seventeen", "eighteen", "nineteen"];
const TENS = ["", "", "twenty", "thirty", "forty", "fifty", "sixty", "seventy", "eighty", "ninety"];
const SCALES = ["", "thousand", "million", "billion"];

function under1000(n: number): string {
  const h = Math.floor(n / 100), r = n % 100;
  const rest = r < 20 ? ONES[r] : TENS[Math.floor(r / 10)] + (r % 10 ? `-${ONES[r % 10]}` : "");
  return [h ? `${ONES[h]} hundred` : "", rest].filter(Boolean).join(" ");
}

/** 4750000 → "four million, seven hundred fifty thousand" (whole numbers below one trillion). */
export function numberToWords(n: number): string {
  n = Math.round(Math.abs(n));
  if (n === 0) return "zero";
  const groups: string[] = [];
  for (let i = 0; n > 0; i++, n = Math.floor(n / 1000)) {
    const g = n % 1000;
    if (g) groups.unshift(`${under1000(g)}${SCALES[i] ? ` ${SCALES[i]}` : ""}`);
  }
  return groups.join(", ");
}

const titleCase = (s: string) => s.replace(/(^|[\s-])([a-z])/g, (_, p, c) => p + c.toUpperCase());

/** 4750000 → "Four Million, Seven Hundred Fifty Thousand Dollars ($4,750,000)" */
export function dollarsInWords(n: number): string {
  const whole = Math.round(n);
  return `${titleCase(numberToWords(whole))} Dollars ($${whole.toLocaleString("en-US")})`;
}

/** 60 → "sixty (60)" */
export function countInWords(n: number): string {
  return `${numberToWords(n)} (${Math.round(n)})`;
}

// ── Defaults from the deal ──────────────────────────────────────────────────
export const LOI_SIGNER = { name: "Jason C. Dempsey", title: "Managing Member", phone: "(610) 389-2474" };
export const LOI_BUYER = "DP Partners, LLC or its assignee";
const AGREEMENT_DEPOSIT = "within two (2) business days of the full execution of the Agreement";
// Opening paragraph of the letter; defines "Agreement" for the terms below.
export const LOI_INTRO = "As a follow up to our conversations and our initial review of the Property, I am pleased to present this non-binding Letter of Intent (\"LOI\") for your consideration. Below are the terms and conditions under which we would pursue a purchase of the Property pursuant to a mutually agreeable agreement of sale (the \"Agreement\"):";

export function defaultLoiTerms(deal: PipelineDeal, broker?: Contact | null, uwPrice?: number | null, today = new Date()): LoiTerms {
  const land = deal.type === "land";
  const place = [deal.address || deal.name, deal.municipality, deal.county ? `${deal.county} County` : null, deal.state]
    .filter(Boolean).join(", ");
  const acres = deal.acres ? `, consisting of approximately ${deal.acres} acres` : "";
  return {
    date: today.toISOString().slice(0, 10),
    recipientName: broker?.name ?? "",
    recipientCompany: broker?.company ?? "",
    recipientEmail: broker?.email ?? "",
    property: `the property located at ${place}${acres}`,
    seller: deal.sellerName || "Owner of Record",
    buyer: LOI_BUYER,
    price: deal.offerPrice || uwPrice || deal.askingPrice || 0,
    paymentTerms: "All cash at Settlement",
    expirationDays: 5,
    deposits: land
      ? [{ amount: 100000, when: AGREEMENT_DEPOSIT }, { amount: 100000, when: "at the expiration of the Investigation Period" }]
      : [{ amount: 100000, when: AGREEMENT_DEPOSIT }],
    investigationDays: land ? 120 : 60,
    approvals: land
      ? "Buyer shall be responsible, at its sole cost and expense, for obtaining all zoning, subdivision, land development and other approvals and permits necessary for Buyer's intended development of the Property, excluding building permits (the \"Approvals\"). The Approval Period shall commence on the execution of the Agreement and end on the earlier of (a) receipt of final, unappealable Approvals or (b) eighteen (18) months from the execution of the Agreement (the \"Approval Period\")."
      : "",
    closingDays: 45,
    closingAfter: land ? "the expiration of the Approval Period" : "the expiration of the Investigation Period",
    prorations: !land,
    brokerage: broker
      ? `Buyer and Seller recognize that Buyer is not responsible for any brokerage commissions. Seller shall be responsible for payment of any commission due to ${[broker.name, broker.company].filter(Boolean).join(" of ")} pursuant to a separate agreement.`
      : "Seller and Buyer each warrant to the other that neither has dealt with any agent or broker in connection with this transaction, and each shall hold the other harmless against any claim for a commission or finder's fee arising from its own actions.",
    exclusivityMonths: 3,
    signerName: LOI_SIGNER.name,
    signerTitle: LOI_SIGNER.title,
    signerPhone: LOI_SIGNER.phone,
  };
}

// ── Wording ─────────────────────────────────────────────────────────────────
export interface LoiSection { label: string; paragraphs: string[] }

const ORDINALS = ["First", "Second", "Third", "Fourth", "Fifth", "Sixth"];

export function loiSections(t: LoiTerms): LoiSection[] {
  const s: LoiSection[] = [];
  const add = (label: string, ...paragraphs: string[]) => s.push({ label, paragraphs });
  const hasApprovals = !!t.approvals.trim();

  add("Seller", t.seller);
  add("Buyer", `${t.buyer} ("Buyer")`);
  add("Purchase Price", dollarsInWords(t.price));
  if (t.paymentTerms.trim()) add("Terms", t.paymentTerms.trim());
  add("LOI Expiration", `In the event that this LOI is not executed by both Buyer and Seller within ${countInWords(t.expirationDays)} business days from the date hereof, this LOI shall automatically be revoked and shall be null and void and of no further force and effect.`);

  if (t.deposits.length) {
    const refund = `The Deposit shall be refundable to Buyer if Buyer terminates the Agreement during the Investigation Period${hasApprovals ? " or if Buyer is unable, despite its good faith efforts, to obtain the Approvals within the Approval Period" : ""}, and shall be credited against the Purchase Price at Settlement.`;
    if (t.deposits.length === 1) {
      add("Deposit", `${dollarsInWords(t.deposits[0].amount)} ${t.deposits[0].when} (the "Deposit"). ${refund}`);
    } else {
      add("Deposits",
        ...t.deposits.map((d, i) => `${ORDINALS[i]} Deposit: ${dollarsInWords(d.amount)} ${d.when}.`),
        `The deposits above are together referred to as the "Deposit". ${refund}`);
    }
  }

  add("Investigation Period",
    `Buyer shall have a period of ${countInWords(t.investigationDays)} days commencing on the full execution of the Agreement (the "Investigation Period") to conduct such studies and investigations of the Property as Buyer deems appropriate, including environmental, geotechnical, title, survey, zoning and physical inspections. Within five (5) days of the execution of the Agreement, Seller shall deliver to Buyer all Property-related materials in Seller's possession reasonably requested by Buyer, including ${t.prorations ? "leases, rent rolls, operating statements, service contracts and environmental reports" : "environmental reports, surveys, wetland delineations, site plans and zoning documentation"}. If Buyer, in its sole discretion, elects not to proceed for any reason or no reason, Buyer may terminate the Agreement prior to the expiration of the Investigation Period and the Deposit shall be returned to Buyer.`);
  if (hasApprovals) add("Approval Period", t.approvals.trim());
  add("Settlement", `Settlement shall occur ${countInWords(t.closingDays)} days after ${t.closingAfter.trim()} ("Settlement").`);
  add("Title", "Seller shall deliver fee simple title to the Property that is good and marketable, free of liens and encumbrances, and insurable at regular rates by a reputable title insurance company selected by Buyer.");
  add("Closing Costs", "Buyer and Seller will divide all closing costs per local custom (not including each party's transaction costs, which each party shall bear on its own).");
  if (t.prorations) add("Closing Pro-Rations", "Rents, operating expenses, real estate taxes and other customary items shall be prorated as of the date of Settlement. Buyer shall receive a credit against the Purchase Price for all tenant security deposits held by Seller.");
  if (t.brokerage.trim()) add("Brokerage", t.brokerage.trim());
  add("Agreement of Sale", "This LOI and the obligations of the parties hereunder are subject to the negotiation and execution by the parties of an Agreement consistent with the terms set forth in this LOI. Upon execution of this LOI by Seller and its return to Buyer, Buyer shall promptly prepare and present to Seller an Agreement, which shall contain such other provisions as are mutually acceptable to Seller and Buyer.");
  add("Confidentiality", "Neither this LOI nor the transactions contemplated herein shall be disclosed by either party without the express written consent of the other party, except to such party's attorneys, lenders, investors and consultants.");
  if (t.exclusivityMonths > 0) add("Exclusivity", `Seller agrees not to market, negotiate, sell, contract to sell or execute another letter of intent to sell the Property to another party for a period of ${countInWords(t.exclusivityMonths)} months following the full execution of this LOI.`);
  const binding = t.exclusivityMonths > 0 ? "Confidentiality and Exclusivity" : "Confidentiality";
  add("Non-Binding Effect", `This LOI sets forth the present intentions of the parties. It shall not create any legal rights or obligations between the parties (other than with respect to the paragraphs labeled ${binding}), it being intended that all such rights and obligations will come into existence only when, and if, the Agreement is signed and delivered.`);
  return s;
}

/** "DP Partners, LLC or its assignee" → "DP Partners, LLC" for signature lines. */
export function buyerEntity(buyer: string): string {
  return buyer.replace(/\s+or its (permitted )?assignee.*$/i, "").trim();
}
