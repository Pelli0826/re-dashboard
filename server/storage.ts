import { drizzle } from "drizzle-orm/better-sqlite3";
import Database from "better-sqlite3";
import fs from "fs";
import path from "path";
import {
  projects, pipeline, dealActivity, armLoans, cashFlow, contacts, investors, documents, tasks, underwriting
} from "@shared/schema";
import type {
  Project, InsertProject,
  PipelineDeal, InsertPipeline,
  DealActivity,
  ArmLoan, InsertArmLoan,
  CashFlowEntry, InsertCashFlow,
  Contact, InsertContact,
  Investor, InsertInvestor,
  Document, InsertDocument,
  Task, InsertTask,
  UnderwritingDeal, InsertUnderwriting,
} from "@shared/schema";
import { eq, desc, like } from "drizzle-orm";

// ── Where the database lives ──────────────────────────────────────────────
// Priority: DB_PATH env var → Railway volume (auto-detected) → project folder.
// On Railway, anything outside a volume is wiped on every redeploy.
const volumeDir = process.env.RAILWAY_VOLUME_MOUNT_PATH;
export const DATA_DIR = process.env.DB_PATH
  ? path.dirname(process.env.DB_PATH)
  : volumeDir || process.cwd();
const DB_PATH = process.env.DB_PATH || path.join(DATA_DIR, "data.db");
fs.mkdirSync(DATA_DIR, { recursive: true });

export const DB_IS_PERSISTENT = Boolean(process.env.DB_PATH || volumeDir) || process.env.NODE_ENV !== "production";
console.log("[db] using database at:", DB_PATH);
if (!DB_IS_PERSISTENT) {
  console.warn("[db] WARNING: no Railway volume or DB_PATH detected. Data will be lost on the next deploy.");
}
const sqlite = new Database(DB_PATH);
sqlite.pragma("journal_mode = WAL");
const db = drizzle(sqlite);

// Auto-create tables on first run (no manual db:push needed on Railway)
sqlite.exec(`
  CREATE TABLE IF NOT EXISTS projects (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL, address TEXT NOT NULL, type TEXT NOT NULL,
    status TEXT NOT NULL, total_budget REAL NOT NULL, spent_to_date REAL NOT NULL DEFAULT 0,
    projected_noi REAL, units INTEGER, sqft INTEGER,
    start_date TEXT NOT NULL, expected_completion TEXT, equity REAL, notes TEXT
  );
  CREATE TABLE IF NOT EXISTS deals (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    deal_code TEXT NOT NULL UNIQUE, name TEXT NOT NULL, address TEXT NOT NULL DEFAULT '',
    municipality TEXT, county TEXT, state TEXT,
    type TEXT NOT NULL, stage TEXT NOT NULL, dead_reason TEXT,
    source TEXT, broker_contact_id INTEGER, seller_name TEXT,
    temperature TEXT NOT NULL DEFAULT 'warm', competition TEXT, seller_motivation TEXT, reason_for_sale TEXT,
    asking_price REAL, price_notes TEXT, offer_price REAL, noi REAL, cap_rate REAL,
    projected_value REAL, probability_override INTEGER,
    units INTEGER, sqft INTEGER, acres REAL, year_built INTEGER, occupancy REAL,
    zoning TEXT, flood_zone TEXT, utilities TEXT, ground_lease INTEGER NOT NULL DEFAULT 0,
    key_risks TEXT, scenarios TEXT,
    first_contact_date TEXT, loi_date TEXT, loi_expiration TEXT, contract_date TEXT,
    dd_end_date TEXT, closing_date TEXT,
    stage_changed_at TEXT NOT NULL, last_activity_at TEXT NOT NULL,
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL, notes TEXT
  );
  CREATE TABLE IF NOT EXISTS deal_activity (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    deal_id INTEGER NOT NULL, date TEXT NOT NULL, kind TEXT NOT NULL,
    summary TEXT NOT NULL, created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_deal_activity_deal ON deal_activity(deal_id);
  CREATE TABLE IF NOT EXISTS arm_loans (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    loan_name TEXT NOT NULL, project_id INTEGER, lender TEXT NOT NULL,
    original_balance REAL NOT NULL, current_balance REAL NOT NULL,
    current_rate REAL NOT NULL, index_type TEXT NOT NULL,
    margin REAL NOT NULL DEFAULT 0, current_index REAL NOT NULL DEFAULT 0,
    cap REAL, floor REAL, next_reset_date TEXT, maturity_date TEXT NOT NULL,
    monthly_payment REAL, loan_type TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'active', notes TEXT
  );
  CREATE TABLE IF NOT EXISTS cash_flow (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id INTEGER NOT NULL, month TEXT NOT NULL, category TEXT NOT NULL,
    subcategory TEXT NOT NULL, amount REAL NOT NULL, notes TEXT
  );
  CREATE TABLE IF NOT EXISTS contacts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL, company TEXT, role TEXT NOT NULL,
    email TEXT, phone TEXT, project_ids TEXT, notes TEXT
  );
  CREATE TABLE IF NOT EXISTS investors (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL, entity_name TEXT, contact_id INTEGER, project_id INTEGER NOT NULL,
    commitment REAL NOT NULL, funded REAL NOT NULL DEFAULT 0,
    preferred_return REAL NOT NULL DEFAULT 8, equity_share REAL NOT NULL,
    total_distributed REAL NOT NULL DEFAULT 0, status TEXT NOT NULL DEFAULT 'active',
    close_date TEXT, notes TEXT
  );
  CREATE TABLE IF NOT EXISTS documents (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id INTEGER, name TEXT NOT NULL, category TEXT NOT NULL,
    url TEXT, notes TEXT, uploaded_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS tasks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL, description TEXT, project_id INTEGER,
    priority TEXT NOT NULL DEFAULT 'medium', status TEXT NOT NULL DEFAULT 'open',
    due_date TEXT, reminder_date TEXT, assigned_to TEXT, category TEXT,
    completed_at TEXT, created_at TEXT NOT NULL, notes TEXT
  );
  CREATE TABLE IF NOT EXISTS underwriting (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL, deal_type TEXT NOT NULL, address TEXT, created_at TEXT NOT NULL,
    purchase_price REAL NOT NULL DEFAULT 0, closing_costs REAL NOT NULL DEFAULT 0,
    renovation_budget REAL NOT NULL DEFAULT 0, equity_in REAL NOT NULL DEFAULT 0,
    gross_potential_rent REAL NOT NULL DEFAULT 0, vacancy_rate REAL NOT NULL DEFAULT 5,
    other_income REAL NOT NULL DEFAULT 0, operating_expenses REAL NOT NULL DEFAULT 0,
    management_fee_rate REAL NOT NULL DEFAULT 8, capex_reserve REAL NOT NULL DEFAULT 0,
    loan_amount REAL NOT NULL DEFAULT 0, interest_rate REAL NOT NULL DEFAULT 7,
    amortization_years INTEGER NOT NULL DEFAULT 30, interest_only INTEGER NOT NULL DEFAULT 0,
    io_years INTEGER NOT NULL DEFAULT 0, hold_years INTEGER NOT NULL DEFAULT 5,
    rent_growth_rate REAL NOT NULL DEFAULT 3, expense_growth_rate REAL NOT NULL DEFAULT 2,
    exit_cap_rate REAL NOT NULL DEFAULT 5.5, selling_costs REAL NOT NULL DEFAULT 2,
    preferred_return REAL NOT NULL DEFAULT 8, notes TEXT
  );
`);

function parseIds(raw: string | null | undefined): number[] {
  if (!raw) return [];
  try { const v = JSON.parse(raw); return Array.isArray(v) ? v.map(Number) : []; } catch { return []; }
}

// ── Lightweight migrations for databases created by older versions ───────
function addColumnIfMissing(table: string, column: string, ddl: string) {
  const cols = sqlite.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  if (!cols.some(c => c.name === column)) {
    sqlite.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
    console.log(`[db] migrated: added ${table}.${column}`);
  }
}
addColumnIfMissing("tasks", "deal_id", "deal_id INTEGER");
addColumnIfMissing("underwriting", "deal_id", "deal_id INTEGER");

// Link models created from an OM before linking existed (named "D-2026-001 …").
{
  const orphans = sqlite.prepare("SELECT id, name FROM underwriting WHERE deal_id IS NULL").all() as { id: number; name: string }[];
  const findDeal = sqlite.prepare("SELECT id FROM deals WHERE deal_code = ?");
  const link = sqlite.prepare("UPDATE underwriting SET deal_id = ? WHERE id = ?");
  for (const o of orphans) {
    const code = o.name.match(/^(D-\d{4}-\d{3})\b/)?.[1];
    const deal = code ? findDeal.get(code) as { id: number } | undefined : undefined;
    if (deal) { link.run(deal.id, o.id); console.log(`[db] linked underwriting ${o.id} to deal ${code}`); }
  }
}
// ─────────────────────────────────────────────────────────────────────────

export interface IStorage {
  // Projects
  getProjects(): Project[];
  getProject(id: number): Project | undefined;
  createProject(data: InsertProject): Project;
  updateProject(id: number, data: Partial<InsertProject>): Project | undefined;
  deleteProject(id: number): void;
  projectRelatedCounts(id: number): Record<string, number>;
  dealRelatedCounts(id: number): Record<string, number>;
  // Pipeline
  getPipeline(): PipelineDeal[];
  getPipelineDeal(id: number): PipelineDeal | undefined;
  createPipelineDeal(data: InsertPipeline): PipelineDeal;
  updatePipelineDeal(id: number, data: Partial<PipelineDeal>): PipelineDeal | undefined;
  deletePipelineDeal(id: number): void;
  nextDealCode(): string;
  getDealActivity(dealId: number): DealActivity[];
  addDealActivity(dealId: number, date: string, kind: string, summary: string): DealActivity;
  // ARM
  getArmLoans(): ArmLoan[];
  getArmLoan(id: number): ArmLoan | undefined;
  createArmLoan(data: InsertArmLoan): ArmLoan;
  updateArmLoan(id: number, data: Partial<InsertArmLoan>): ArmLoan | undefined;
  deleteArmLoan(id: number): void;
  // Cash Flow
  getCashFlow(projectId?: number): CashFlowEntry[];
  createCashFlowEntry(data: InsertCashFlow): CashFlowEntry;
  updateCashFlowEntry(id: number, data: Partial<InsertCashFlow>): CashFlowEntry | undefined;
  deleteCashFlowEntry(id: number): void;
  // Contacts
  getContacts(): Contact[];
  createContact(data: InsertContact): Contact;
  updateContact(id: number, data: Partial<InsertContact>): Contact | undefined;
  deleteContact(id: number): void;
  // Investors
  getInvestors(projectId?: number): Investor[];
  createInvestor(data: InsertInvestor): Investor;
  updateInvestor(id: number, data: Partial<InsertInvestor>): Investor | undefined;
  deleteInvestor(id: number): void;
  // Documents
  getDocuments(projectId?: number): Document[];
  createDocument(data: InsertDocument): Document;
  updateDocument(id: number, data: Partial<InsertDocument>): Document | undefined;
  deleteDocument(id: number): void;
  // Tasks
  getTasks(status?: string): Task[];
  getTask(id: number): Task | undefined;
  createTask(data: InsertTask): Task;
  updateTask(id: number, data: Partial<InsertTask>): Task | undefined;
  deleteTask(id: number): void;
  // Underwriting
  getUnderwritingDeals(): UnderwritingDeal[];
  getUnderwritingDeal(id: number): UnderwritingDeal | undefined;
  createUnderwritingDeal(data: InsertUnderwriting): UnderwritingDeal;
  updateUnderwritingDeal(id: number, data: Partial<InsertUnderwriting>): UnderwritingDeal | undefined;
  deleteUnderwritingDeal(id: number): void;
}

export class DatabaseStorage implements IStorage {
  // Projects
  getProjects() { return db.select().from(projects).all(); }
  getProject(id: number) { return db.select().from(projects).where(eq(projects.id, id)).get(); }
  createProject(data: InsertProject) { return db.insert(projects).values(data).returning().get(); }
  updateProject(id: number, data: Partial<InsertProject>) { return db.update(projects).set(data).where(eq(projects.id, id)).returning().get(); }

  // Pipeline
  getPipeline() { return db.select().from(pipeline).all(); }
  getPipelineDeal(id: number) { return db.select().from(pipeline).where(eq(pipeline.id, id)).get(); }
  createPipelineDeal(data: InsertPipeline) {
    const now = new Date().toISOString();
    return db.insert(pipeline).values({
      ...data,
      dealCode: this.nextDealCode(),
      stageChangedAt: now, lastActivityAt: now, createdAt: now, updatedAt: now,
    }).returning().get();
  }
  updatePipelineDeal(id: number, data: Partial<PipelineDeal>) {
    return db.update(pipeline).set({ ...data, updatedAt: new Date().toISOString() }).where(eq(pipeline.id, id)).returning().get();
  }
  // Deleting a deal removes everything that belongs to it.
  deletePipelineDeal(id: number) {
    sqlite.transaction(() => {
      db.delete(dealActivity).where(eq(dealActivity.dealId, id)).run();
      db.delete(tasks).where(eq(tasks.dealId, id)).run();
      db.delete(underwriting).where(eq(underwriting.dealId, id)).run();
      db.delete(pipeline).where(eq(pipeline.id, id)).run();
    })();
  }
  dealRelatedCounts(id: number) {
    const count = (sql: string) => (sqlite.prepare(sql).get(id) as { n: number }).n;
    return {
      tasks: count("SELECT COUNT(*) AS n FROM tasks WHERE deal_id = ?"),
      underwriting: count("SELECT COUNT(*) AS n FROM underwriting WHERE deal_id = ?"),
      activity: count("SELECT COUNT(*) AS n FROM deal_activity WHERE deal_id = ?"),
    };
  }
  // Deleting a project removes its cash flow, investors, documents, tasks and loans,
  // and takes it off any contacts (the contacts themselves are kept).
  deleteProject(id: number) {
    sqlite.transaction(() => {
      db.delete(cashFlow).where(eq(cashFlow.projectId, id)).run();
      db.delete(investors).where(eq(investors.projectId, id)).run();
      db.delete(documents).where(eq(documents.projectId, id)).run();
      db.delete(tasks).where(eq(tasks.projectId, id)).run();
      db.delete(armLoans).where(eq(armLoans.projectId, id)).run();
      for (const c of this.contactsOnProject(id)) {
        const ids = parseIds(c.projectIds).filter(x => x !== id);
        db.update(contacts).set({ projectIds: ids.length ? JSON.stringify(ids) : null }).where(eq(contacts.id, c.id)).run();
      }
      db.delete(projects).where(eq(projects.id, id)).run();
    })();
  }
  contactsOnProject(id: number) {
    return db.select().from(contacts).all().filter(c => parseIds(c.projectIds).includes(id));
  }
  projectRelatedCounts(id: number) {
    const count = (sql: string) => (sqlite.prepare(sql).get(id) as { n: number }).n;
    return {
      cashflow: count("SELECT COUNT(*) AS n FROM cash_flow WHERE project_id = ?"),
      investors: count("SELECT COUNT(*) AS n FROM investors WHERE project_id = ?"),
      documents: count("SELECT COUNT(*) AS n FROM documents WHERE project_id = ?"),
      tasks: count("SELECT COUNT(*) AS n FROM tasks WHERE project_id = ?"),
      loans: count("SELECT COUNT(*) AS n FROM arm_loans WHERE project_id = ?"),
      contacts: this.contactsOnProject(id).length,
    };
  }
  nextDealCode() {
    const prefix = `D-${new Date().getFullYear()}-`;
    const rows = db.select({ code: pipeline.dealCode }).from(pipeline).where(like(pipeline.dealCode, `${prefix}%`)).all();
    const max = rows.reduce((m, r) => Math.max(m, parseInt(r.code.slice(prefix.length), 10) || 0), 0);
    return `${prefix}${String(max + 1).padStart(3, "0")}`;
  }
  getDealActivity(dealId: number) {
    return db.select().from(dealActivity).where(eq(dealActivity.dealId, dealId))
      .orderBy(desc(dealActivity.date), desc(dealActivity.id)).all();
  }
  addDealActivity(dealId: number, date: string, kind: string, summary: string) {
    const now = new Date().toISOString();
    const row = db.insert(dealActivity).values({ dealId, date, kind, summary, createdAt: now }).returning().get();
    db.update(pipeline).set({ lastActivityAt: now }).where(eq(pipeline.id, dealId)).run();
    return row;
  }
  // Full export of every table, for the Download backup button.
  exportAll() {
    const tables = ["projects", "deals", "deal_activity", "arm_loans", "cash_flow", "contacts",
      "investors", "documents", "tasks", "underwriting"];
    const out: Record<string, unknown[]> = {};
    for (const t of tables) out[t] = sqlite.prepare(`SELECT * FROM ${t}`).all();
    return out;
  }

  // ARM
  getArmLoans() { return db.select().from(armLoans).all(); }
  getArmLoan(id: number) { return db.select().from(armLoans).where(eq(armLoans.id, id)).get(); }
  createArmLoan(data: InsertArmLoan) { return db.insert(armLoans).values(data).returning().get(); }
  updateArmLoan(id: number, data: Partial<InsertArmLoan>) { return db.update(armLoans).set(data).where(eq(armLoans.id, id)).returning().get(); }
  deleteArmLoan(id: number) { db.delete(armLoans).where(eq(armLoans.id, id)).run(); }

  // Cash Flow
  getCashFlow(projectId?: number) {
    if (projectId != null) return db.select().from(cashFlow).where(eq(cashFlow.projectId, projectId)).all();
    return db.select().from(cashFlow).all();
  }
  createCashFlowEntry(data: InsertCashFlow) { return db.insert(cashFlow).values(data).returning().get(); }
  updateCashFlowEntry(id: number, data: Partial<InsertCashFlow>) { return db.update(cashFlow).set(data).where(eq(cashFlow.id, id)).returning().get(); }
  deleteCashFlowEntry(id: number) { db.delete(cashFlow).where(eq(cashFlow.id, id)).run(); }

  // Contacts
  getContacts() { return db.select().from(contacts).all(); }
  createContact(data: InsertContact) { return db.insert(contacts).values(data).returning().get(); }
  updateContact(id: number, data: Partial<InsertContact>) { return db.update(contacts).set(data).where(eq(contacts.id, id)).returning().get(); }
  deleteContact(id: number) {
    sqlite.transaction(() => {
      db.update(pipeline).set({ brokerContactId: null }).where(eq(pipeline.brokerContactId, id)).run();
      db.delete(contacts).where(eq(contacts.id, id)).run();
    })();
  }

  // Investors
  getInvestors(projectId?: number) {
    if (projectId != null) return db.select().from(investors).where(eq(investors.projectId, projectId)).all();
    return db.select().from(investors).all();
  }
  createInvestor(data: InsertInvestor) { return db.insert(investors).values(data).returning().get(); }
  updateInvestor(id: number, data: Partial<InsertInvestor>) { return db.update(investors).set(data).where(eq(investors.id, id)).returning().get(); }
  deleteInvestor(id: number) { db.delete(investors).where(eq(investors.id, id)).run(); }

  // Documents
  getDocuments(projectId?: number) {
    if (projectId != null) return db.select().from(documents).where(eq(documents.projectId, projectId)).all();
    return db.select().from(documents).all();
  }
  createDocument(data: InsertDocument) { return db.insert(documents).values(data).returning().get(); }
  updateDocument(id: number, data: Partial<InsertDocument>) { return db.update(documents).set(data).where(eq(documents.id, id)).returning().get(); }
  deleteDocument(id: number) { db.delete(documents).where(eq(documents.id, id)).run(); }

  // Tasks
  getTasks(status?: string) {
    if (status) return db.select().from(tasks).where(eq(tasks.status, status)).all();
    return db.select().from(tasks).all();
  }
  getTask(id: number) { return db.select().from(tasks).where(eq(tasks.id, id)).get(); }
  createTask(data: InsertTask) { return db.insert(tasks).values(data).returning().get(); }
  updateTask(id: number, data: Partial<InsertTask>) { return db.update(tasks).set(data).where(eq(tasks.id, id)).returning().get(); }
  deleteTask(id: number) { db.delete(tasks).where(eq(tasks.id, id)).run(); }

  // Underwriting
  getUnderwritingDeals() { return db.select().from(underwriting).all(); }
  getUnderwritingDeal(id: number) { return db.select().from(underwriting).where(eq(underwriting.id, id)).get(); }
  createUnderwritingDeal(data: InsertUnderwriting) { return db.insert(underwriting).values(data).returning().get(); }
  updateUnderwritingDeal(id: number, data: Partial<InsertUnderwriting>) { return db.update(underwriting).set(data).where(eq(underwriting.id, id)).returning().get(); }
  deleteUnderwritingDeal(id: number) { db.delete(underwriting).where(eq(underwriting.id, id)).run(); }
}

export const storage = new DatabaseStorage();
