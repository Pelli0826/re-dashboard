# RE Developer Dashboard

A full-stack real estate developer dashboard:
Overview, Projects, Pipeline (deal flow CRM), ARM Loans, Cash Flow, Investors, Contacts, Tasks. Underwriting lives inside each deal on the Pipeline; document links live inside each project.

## Tech stack
- Frontend: React + Vite + Tailwind CSS + shadcn/ui
- Backend: Express (Node.js)
- Database: SQLite via better-sqlite3 + Drizzle ORM

## Railway setup (required)

1. **Attach a volume.** In the service, add a Volume mounted at `/data`.
   The app detects it automatically through `RAILWAY_VOLUME_MOUNT_PATH` and stores
   `data.db` and `sessions.db` there. Without a volume, every deploy erases all data
   and the dashboard shows a red warning banner.
2. **Set variables** (service → Variables):
   - `DASHBOARD_PASSWORD`: required. Without it the dashboard stays locked.
   - `SESSION_SECRET`: a long random string. Keeps people signed in across restarts.
   - `ANTHROPIC_API_KEY`: turns on **Upload OM** (Pipeline) and PDF auto-fill (Underwriting).
     Create one at console.anthropic.com. Usage is billed per request by Anthropic.
   - `ANTHROPIC_MODEL`: optional, defaults to `claude-sonnet-5`.
   - `OPENAI_API_KEY`: optional legacy fallback for Underwriting auto-fill if no Anthropic key is set.
   - `DB_PATH`: optional, overrides the database location (e.g. `/data/data.db`).
3. Deploys run automatically when you push to GitHub. Health check: `/api/health`.

## Morning email
Each morning (weekdays at 7:00 AM Eastern by default) the app emails deal deadlines due within
3 days or overdue, overdue and due-today tasks, task reminders, and deals with no recent activity.
It uses Resend's HTTPS API because Railway's Hobby plan blocks SMTP.

Variables: `RESEND_API_KEY` and `DIGEST_TO` (comma-separated) are required. Optional:
`DIGEST_FROM`, `DIGEST_HOUR` (0-23), `DIGEST_TZ`, `DIGEST_DAYS` (`weekdays` or `daily`), `APP_URL`.
Until you verify a domain in Resend, the default sender can only email your own Resend account
address. The Overview page shows status and has Preview and Send test buttons.

## Box import
Each evening (6 PM Eastern by default) the app checks one Box folder, "Deals Inbox", for new PDFs,
reads each one exactly like **Upload OM**, and creates a deal in Lead marked **Needs review**, with
the OM saved to the deal, the screening memo in its activity log, the broker matched or added to
Contacts, and an underwriting model when the OM has income figures. It only reads from Box; it never
moves, renames, deletes or uploads anything there.

- Each Box file is imported once, even if it's renamed. Files that aren't PDFs, or are over 24 MB,
  are skipped with the reason. At most `BOX_DAILY_LIMIT` PDFs a night (oldest first); the rest wait.
- The Overview page's **Box import** card shows whether it's set up, the last run, recent files with
  links to their deals, and a **Check Box now** button. Failed files have **Try again**.
- The morning email has a **New from Box** section: deals created since the last email, and files that
  failed or were skipped, with the reason.
- On the Pipeline, flagged deals show a "Needs review" badge and can be filtered; the deal panel has a
  **Mark reviewed** button that clears the flag and logs it.

Variables: `BOX_CLIENT_ID`, `BOX_CLIENT_SECRET`, `BOX_ENTERPRISE_ID`, `BOX_FOLDER_ID` (required);
`BOX_SYNC_HOUR` (0-23, default 18, in `DIGEST_TZ`) and `BOX_DAILY_LIMIT` (default 10) optional.
The Box app uses Server Authentication (Client Credentials Grant), must be authorized in the Box Admin
Console, and the Deals Inbox folder must be shared with the app's service account.

## Backups
Click the download icon at the bottom of the sidebar (or open `/api/backup` while signed in)
to download every table as one JSON file. Do this before any change to the Railway service.

## Pipeline
- Stages: Lead, Screening, LOI / Offer, Due Diligence, Closing, Closed, Dead (dead requires a reason).
- Each deal gets an ID like `D-2026-001`, days-in-stage tracking and an activity log.
- Moving a deal to Due Diligence creates a checklist in Tasks, dated back from the DD end date.
- "Needs attention" flags overdue or near deadlines, deals with no logged activity,
  and deals stuck in screening.
- Land and redevelopment deals can hold acreage, zoning, floodplain, utilities and
  multiple development scenarios for sites priced by use.
- **Upload OM**: Claude reads the whole PDF (up to 24 MB), pre-fills a new deal for review,
  matches or adds the listing broker, runs NOI and cap-rate math checks in code, and saves a
  screening memo (risks, missing info, broker questions) to the deal's activity log. For income
  properties it can also start an Underwriting model.
- **Files**: OMs from Upload OM are saved with the deal on the volume; add rent rolls, T12s,
  surveys and so on from the deal panel. Deleting a deal deletes its files. Note: the Download
  backup file lists files but doesn't contain them; they stay on the Railway volume.
- **Ask about this deal**: Claude answers from the deal's saved PDFs, record, activity log, tasks
  and underwriting, citing its sources. Answers can be saved to the activity log.
- **Milestones**: per-deal contract deadlines (rezoning petition, approvals, elections, deposit
  releases). Open milestones due within 14 days show in Needs attention; within 7 days, in the
  morning email.
- **Suggested changes**: when you ask Claude to set up dates or tasks, it proposes changes as cards
  with Apply buttons. Relative dates ("120 days after the Inspection Period") are computed by the
  dashboard, not by Claude. Nothing changes until you click Apply; applied changes are logged.
- **Checklist follows the DD date**: changing a deal's DD end date shifts its open due diligence
  checklist tasks by the same number of days.
- Vocabulary (stages, types, sources, default probabilities) lives in `shared/pipeline.ts`.

## Underwriting: maximum price
Each model shows the highest price that still meets a target levered IRR (default 15%), with the
loan held at the same LTV or the same dollar amount, plus a price sensitivity table. For models
linked to a deal, "Set as our offer" updates the deal (and the model follows).

## Local development
```bash
npm install
npm run dev            # http://localhost:5000 (no password needed locally)
```

Box import test (mock Box and Anthropic, no real calls):
```bash
npm run build && npx tsx script/test-box-import.ts
```
