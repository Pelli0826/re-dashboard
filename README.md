# RE Developer Dashboard

A full-stack real estate developer dashboard:
Overview, Projects, Pipeline (deal flow CRM), ARM Loans, Cash Flow, Investors, Contacts, Documents, Tasks, Underwriting.

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
- Vocabulary (stages, types, sources, default probabilities) lives in `shared/pipeline.ts`.

## Local development
```bash
npm install
npm run dev            # http://localhost:5000 (no password needed locally)
```
