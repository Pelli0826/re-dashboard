import { sqliteTable, text, integer, real } from "drizzle-orm/sqlite-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod";

// ─── Projects ──────────────────────────────────────────────────────────────
export const projects = sqliteTable("projects", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  name: text("name").notNull(),
  address: text("address").notNull(),
  type: text("type").notNull(),
  status: text("status").notNull(),
  totalBudget: real("total_budget").notNull(),
  spentToDate: real("spent_to_date").notNull().default(0),
  projectedNoi: real("projected_noi"),
  units: integer("units"),
  sqft: integer("sqft"),
  startDate: text("start_date").notNull(),
  expectedCompletion: text("expected_completion"),
  equity: real("equity"),
  notes: text("notes"),
});

export const insertProjectSchema = createInsertSchema(projects).omit({ id: true });
export type InsertProject = z.infer<typeof insertProjectSchema>;
export type Project = typeof projects.$inferSelect;

// ─── Pipeline Deals ────────────────────────────────────────────────────────
export const pipeline = sqliteTable("pipeline", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  name: text("name").notNull(),
  address: text("address").notNull(),
  type: text("type").notNull(),
  stage: text("stage").notNull(),
  askingPrice: real("asking_price"),
  projectedValue: real("projected_value"),
  capRate: real("cap_rate"),
  units: integer("units"),
  sqft: integer("sqft"),
  probability: integer("probability").notNull().default(50),
  targetCloseDate: text("target_close_date"),
  broker: text("broker"),
  notes: text("notes"),
});

export const insertPipelineSchema = createInsertSchema(pipeline).omit({ id: true });
export type InsertPipeline = z.infer<typeof insertPipelineSchema>;
export type PipelineDeal = typeof pipeline.$inferSelect;

// ─── ARM Loans ─────────────────────────────────────────────────────────────
export const armLoans = sqliteTable("arm_loans", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  loanName: text("loan_name").notNull(),
  projectId: integer("project_id"),
  lender: text("lender").notNull(),
  originalBalance: real("original_balance").notNull(),
  currentBalance: real("current_balance").notNull(),
  currentRate: real("current_rate").notNull(),
  indexType: text("index_type").notNull(),
  margin: real("margin").notNull().default(0),
  currentIndex: real("current_index").notNull().default(0),
  cap: real("cap"),
  floor: real("floor"),
  nextResetDate: text("next_reset_date"),
  maturityDate: text("maturity_date").notNull(),
  monthlyPayment: real("monthly_payment"),
  loanType: text("loan_type").notNull(),
  status: text("status").notNull().default("active"),
  notes: text("notes"),
});

export const insertArmLoanSchema = createInsertSchema(armLoans).omit({ id: true });
export type InsertArmLoan = z.infer<typeof insertArmLoanSchema>;
export type ArmLoan = typeof armLoans.$inferSelect;

// ─── Cash Flow Entries ─────────────────────────────────────────────────────
export const cashFlow = sqliteTable("cash_flow", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  projectId: integer("project_id").notNull(),
  month: text("month").notNull(),          // YYYY-MM
  category: text("category").notNull(),    // income | expense
  subcategory: text("subcategory").notNull(), // rent, loan-proceeds, construction-cost, interest, mgmt-fee, etc.
  amount: real("amount").notNull(),
  notes: text("notes"),
});

export const insertCashFlowSchema = createInsertSchema(cashFlow).omit({ id: true });
export type InsertCashFlow = z.infer<typeof insertCashFlowSchema>;
export type CashFlowEntry = typeof cashFlow.$inferSelect;

// ─── Contacts ─────────────────────────────────────────────────────────────
export const contacts = sqliteTable("contacts", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  name: text("name").notNull(),
  company: text("company"),
  role: text("role").notNull(),            // lender, broker, attorney, investor, contractor, architect, other
  email: text("email"),
  phone: text("phone"),
  projectIds: text("project_ids"),        // JSON array of project IDs
  notes: text("notes"),
});

export const insertContactSchema = createInsertSchema(contacts).omit({ id: true });
export type InsertContact = z.infer<typeof insertContactSchema>;
export type Contact = typeof contacts.$inferSelect;

// ─── Equity Investors ──────────────────────────────────────────────────────
export const investors = sqliteTable("investors", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  name: text("name").notNull(),
  entityName: text("entity_name"),
  contactId: integer("contact_id"),        // optional link to contacts
  projectId: integer("project_id").notNull(),
  commitment: real("commitment").notNull(), // total capital committed $
  funded: real("funded").notNull().default(0), // amount actually wired
  preferredReturn: real("preferred_return").notNull().default(8), // pref % per year
  equityShare: real("equity_share").notNull(), // % ownership
  totalDistributed: real("total_distributed").notNull().default(0),
  status: text("status").notNull().default("active"), // active, exited, pending
  closeDate: text("close_date"),
  notes: text("notes"),
});

export const insertInvestorSchema = createInsertSchema(investors).omit({ id: true });
export type InsertInvestor = z.infer<typeof insertInvestorSchema>;
export type Investor = typeof investors.$inferSelect;

// ─── Documents ────────────────────────────────────────────────────────────
export const documents = sqliteTable("documents", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  projectId: integer("project_id"),       // null = general
  name: text("name").notNull(),
  category: text("category").notNull(),   // permits, contracts, financials, legal, closing, other
  url: text("url"),                        // external link (Google Drive, Dropbox, etc.)
  notes: text("notes"),
  uploadedAt: text("uploaded_at").notNull(), // ISO date string
});

export const insertDocumentSchema = createInsertSchema(documents).omit({ id: true });
export type InsertDocument = z.infer<typeof insertDocumentSchema>;
export type Document = typeof documents.$inferSelect;

// ─── Tasks ────────────────────────────────────────────────────────────────
export const tasks = sqliteTable("tasks", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  title: text("title").notNull(),
  description: text("description"),
  projectId: integer("project_id"),          // optional link to a project
  priority: text("priority").notNull().default("medium"), // low | medium | high | urgent
  status: text("status").notNull().default("open"),       // open | in-progress | done
  dueDate: text("due_date"),                 // YYYY-MM-DD
  reminderDate: text("reminder_date"),       // YYYY-MM-DD — show alert on/after this date
  assignedTo: text("assigned_to"),           // free-text name
  category: text("category"),               // permit | closing | finance | legal | construction | general
  completedAt: text("completed_at"),         // ISO timestamp when marked done
  createdAt: text("created_at").notNull(),   // ISO timestamp
  notes: text("notes"),
});

export const insertTaskSchema = createInsertSchema(tasks).omit({ id: true });
export type InsertTask = z.infer<typeof insertTaskSchema>;
export type Task = typeof tasks.$inferSelect;

// ─── Underwriting ─────────────────────────────────────────────────────────
export const underwriting = sqliteTable("underwriting", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  name: text("name").notNull(),                    // deal name
  dealType: text("deal_type").notNull(),            // multifamily | commercial | development | value-add
  address: text("address"),
  createdAt: text("created_at").notNull(),

  // ── Acquisition
  purchasePrice: real("purchase_price").notNull().default(0),
  closingCosts: real("closing_costs").notNull().default(0),     // % of purchase
  renovationBudget: real("renovation_budget").notNull().default(0),
  equityIn: real("equity_in").notNull().default(0),             // total equity invested $

  // ── Income (Year 1)
  grossPotentialRent: real("gross_potential_rent").notNull().default(0), // annual
  vacancyRate: real("vacancy_rate").notNull().default(5),        // %
  otherIncome: real("other_income").notNull().default(0),        // parking, laundry, etc.

  // ── Expenses (Year 1)
  operatingExpenses: real("operating_expenses").notNull().default(0), // annual total OpEx
  managementFeeRate: real("management_fee_rate").notNull().default(8), // % of EGI
  capexReserve: real("capex_reserve").notNull().default(0),      // annual CapEx reserve

  // ── Debt
  loanAmount: real("loan_amount").notNull().default(0),
  interestRate: real("interest_rate").notNull().default(7),      // annual %
  amortizationYears: integer("amortization_years").notNull().default(30),
  interestOnly: integer("interest_only").notNull().default(0),   // 0=false,1=true
  ioYears: integer("io_years").notNull().default(0),             // years of I/O before amort

  // ── Proforma assumptions
  holdYears: integer("hold_years").notNull().default(5),
  rentGrowthRate: real("rent_growth_rate").notNull().default(3),  // % per year
  expenseGrowthRate: real("expense_growth_rate").notNull().default(2), // % per year
  exitCapRate: real("exit_cap_rate").notNull().default(5.5),      // % for exit valuation
  sellingCosts: real("selling_costs").notNull().default(2),       // % of exit value

  // ── Preferred return
  preferredReturn: real("preferred_return").notNull().default(8), // % pref to LP

  notes: text("notes"),
});

export const insertUnderwritingSchema = createInsertSchema(underwriting).omit({ id: true });
export type InsertUnderwriting = z.infer<typeof insertUnderwritingSchema>;
export type UnderwritingDeal = typeof underwriting.$inferSelect;
