# CLAUDE.md — RE Developer Dashboard

Private dashboard for a two-partner commercial real estate development firm (DPP Group,
southeastern Pennsylvania): deal pipeline/CRM, underwriting, projects, cash flow, investors,
ARM loans, contacts, documents and tasks. Two users share one password. The owner is not a
developer: explain changes in plain language, and describe anything he must do in Railway,
GitHub, Resend or Anthropic's console as exact click paths.

## First session checklist

1. **Add a `.gitignore`** (the repo has none). Before committing anything, create it with:
   ```
   node_modules/
   dist/
   *.db
   *.db-wal
   *.db-shm
   .env
   .env.*
   .DS_Store
   ```
   Then confirm `git status` shows no `node_modules/`, `dist/` or `*.db` files.
2. **Confirm the latest update is in the repo:** `grep -n milestoneAlerts shared/pipeline.ts`
   and `grep -n deal_milestones server/storage.ts` should both match. If not, ask the owner to
   upload the `re-dashboard-milestones` files (from his Claude.ai chat) before changing those areas.
3. Run `npm install`, `npm run check`, `npm run build` to establish the baseline (see Known issues).

## Stack and layout

- React + Vite + Tailwind + shadcn/ui (client), Express (server), SQLite via better-sqlite3 +
  Drizzle ORM. TypeScript throughout. Node >= 20. Hash routing (wouter `useHashLocation`).
- `client/src/pages/*.tsx`: one file per sidebar tab. `Pipeline.tsx` is the largest: deal board and the
  deal workspace (a wide sheet with Overview, Underwriting, Files and Activity tabs), OM intake,
  milestones, files, Ask about this deal, suggestion cards. There is no separate Underwriting page
  (decided 2026-10-26): `/underwriting` redirects to the Pipeline; models are always worked on inside
  their deal. New deals open on the Underwriting tab. Unattached models are listed on the Pipeline page.
- `client/src/components/ModelWorkspace.tsx`: one underwriting model (inputs, Fill in from deal
  files, returns, max price, proforma) and `DealUnderwriting` (a deal's models + Add scenario).
- `client/src/components/ConfirmDialog.tsx`: `useConfirm()`; every delete must go through it.
- `server/routes.ts`: all API routes, auth, deal update logic, proposals, file and ask endpoints.
- `server/storage.ts`: DB location, `CREATE TABLE IF NOT EXISTS` schema, migrations, storage methods.
- `server/claude.ts`: Anthropic API calls (plain `fetch`, no SDK): OM intake, PDF auto-fill,
  Ask about this deal + `propose_changes` tool.
- `server/digest.ts`: morning email (Resend HTTPS API) and its scheduler.
- `server/extract.ts`: Underwriting document auto-fill (Claude first, OpenAI fallback), from a direct
  upload or from a file saved to the linked deal (`POST /api/underwriting/:id/from-file`). Figures only
  fill the form; nothing is saved until the user clicks Save. Operating-statement management fees are
  taken out of operating expenses and set as the model's fee % (the proforma adds its own fee).
- `shared/pipeline.ts`: stages, labels, alert rules, date helpers. Used by client AND server so
  the Pipeline page and the morning email always agree. Change rules here, not in two places.
- `shared/underwriting.ts`: proforma, returns, IRR, max-price solver. Used by client and server.
- `shared/valueAdd.ts`: value-add / rehab plan (partly vacant property: vacant units renovated on a
  schedule, occupied units renovated on turnover), run month by month with lender holdback, optional
  refinance and sale; plus its max-price solver. Stored as JSON in `underwriting.value_add`; when the
  plan is on it replaces the stabilized proforma on the Underwriting tab. Verified against a hand-worked
  timeline, an independent Python implementation (cash flows match to the cent, IRR by bisection), and
  the stabilized model (identical yearly NOI when nothing is renovated). Re-run those checks after
  changing the engine.
- `shared/loi.ts`: LOI terms, defaults from a deal, section wording, numbers in words (code, not
  the model). `server/loi.ts` renders it to Word with the `docx` package;
  `client/src/components/LoiDialog.tsx` is the form ("Draft LOI" in the deal panel). Terms are
  kept in `app_state` as `loi:<dealId>`; drafts are saved as deal files with kind `loi`.
  The wording is modeled on the firm's own LOIs; change clauses in `loiSections()`.
- `shared/schema.ts`: Drizzle table definitions and types.

## Commands

- `npm run dev`: local dev server at http://localhost:5000. No password needed locally.
- `npm run check`: TypeScript. `npm run build`: production build to `dist/`.
- `npm start`: run the production build (`NODE_ENV=production`).
- Do NOT use `npm run db:push` (drizzle-kit). Tables are created and migrated by raw SQL in
  `server/storage.ts`; see Database below.

## Deploy

GitHub `Pelli0826/re-dashboard`, branch `main` → Railway auto-deploys on push (Nixpacks,
`railway.toml`: `npm install && npm run build`, start `npm run start`, health check `/api/health`).
Live URL: https://re-dashboard-production-929a.up.railway.app

- Pushing to `main` deploys to production immediately. Show the owner a summary of changes and
  get his OK before pushing. Prefer small, separate commits with plain-English messages.
- A Railway volume is mounted at `/data`. The app finds it through `RAILWAY_VOLUME_MOUNT_PATH`
  and stores `data.db`, `sessions.db` and uploaded files (`files/`) there. Anything outside the
  volume is wiped on every deploy.
- New npm dependencies: pin an exact version at least two weeks old (`npm install --save-exact`),
  and commit both `package.json` and `package-lock.json`.

## Environment variables (Railway → re-dashboard → Variables)

| Variable | Purpose |
|---|---|
| `DASHBOARD_PASSWORD` | Required in production. Without it the app stays locked (by design). |
| `SESSION_SECRET` | Keeps sessions valid across restarts. |
| `ANTHROPIC_API_KEY` | OM upload, PDF auto-fill, Ask about this deal. Key must belong to a Console workspace. |
| `ANTHROPIC_MODEL` | Optional; default `claude-sonnet-5`. |
| `RESEND_API_KEY` | Morning email. Key must be in the same Resend team (`dppgrp`) as the domain. |
| `DIGEST_TO` | Comma-separated recipients. |
| `DIGEST_FROM` | `RE Dashboard <deals@updates.dppgrp.com>` (domain verified in Resend, DNS at GoDaddy). |
| `DIGEST_HOUR`, `DIGEST_TZ`, `DIGEST_DAYS` | Optional: default 7, America/New_York, weekdays. |
| `APP_URL` | Optional link target in emails; defaults to the Railway public domain. |
| `DB_PATH` | Optional override. Don't set it unless the volume setup changes (it hides the storage warning). |
| `OPENAI_API_KEY` | Legacy fallback only; can be removed. |
| `ANTHROPIC_BASE_URL`, `RESEND_BASE_URL` | Test-only: point at local mock servers. Never set in Railway. |

Variable names are exact (all caps, underscores). Variable changes take effect only after Railway redeploys.

## Database

- SQLite file on the volume. Schema lives in two places that must stay in sync: the
  `CREATE TABLE IF NOT EXISTS` block in `server/storage.ts` and the Drizzle tables in `shared/schema.ts`.
- Existing databases are migrated with `addColumnIfMissing(table, column, ddl)` in `storage.ts`.
  Every new column needs one. Never drop or rename columns in place; the live DB has real deals.
- Key tables: `deals` (Pipeline; Drizzle export is named `pipeline`), `deal_activity`,
  `deal_files`, `deal_milestones`, `tasks` (has `deal_id` and `project_id`), `underwriting`
  (has `deal_id`), `projects`, `cash_flow`, `investors`, `documents` (links only), `contacts`,
  `arm_loans`, `app_state` (key/value: digest status, DD checklist base dates, deal ID counters).
- Deletes cascade in code: deal → activity, tasks, underwriting, files (also on disk), milestones;
  project → cash flow, investors, documents, tasks, ARM loans (contacts kept, unlinked).
  Confirmation dialogs list the related counts from `/api/pipeline/:id/related` and `/api/projects/:id/related`.
- Deal IDs (`D-YYYY-NNN`) are never reused; the highest issued number per year is in `app_state`.
- Sidebar download icon (`/api/backup`) exports all tables as JSON (not the uploaded files).

## Product rules (decided with the owner; keep them)

- **Claude never changes data on its own.** Ask about this deal is read-only; changes come back
  as `propose_changes` tool proposals, shown as cards. Nothing changes until the user clicks
  Apply (`POST /api/pipeline/:id/apply`), and every applied change is written to the activity log.
- **Numbers come from code, not the model.** Relative dates in proposals use `dateRule`
  (`{from, addDays, addMonths}`), resolved server-side in `normalizeProposals` (anchors: a literal
  date, `deal.<dateField>`, `milestone:<name>`, including milestones proposed earlier in the same
  batch). OM math checks, IRR and max price are computed in code.
- **One update path for deals:** `updateDeal()` in `routes.ts` (used by PATCH and Apply). It
  handles stage changes and dead reasons, syncs linked underwriting purchase price to the offer
  (only when the price actually changed), re-dates the open DD checklist when `ddEndDate` changes,
  and creates the DD checklist on entering Due Diligence.
- **Nothing is emailed to anyone outside the firm without approval.** The morning email goes only
  to `DIGEST_TO`.
- **Every delete asks first** via `useConfirm()`, naming what else gets deleted.
- Show real error reasons to the user (Anthropic, Resend), not generic messages.
- Never log response bodies or deal data (the request logger logs method, path, status, time only).
- Writing in the UI: plain language, sentence case, no jargon. Keep the existing visual style.
- **Lifecycle: deal → project → property.** A deal becomes a project when the PSA is signed
  (decided 2026-10-26), not at closing: entering Due Diligence, Closing or Closed creates a linked
  project (`projects.deal_id`) via `syncProject()` in `routes.ts`. Closed moves it to planning; Dead or
  moving back before DD sets it to cancelled (never deleted); reviving reopens it. Deleting a deal
  keeps its project, unlinked. Project vocabulary and `projectFromDeal()` live in `shared/projects.ts`.
  Owned, operating assets will become properties (not built yet).

## Testing

There is no test suite. What has worked:

- `npm run check` (compare against the known baseline below) and `npm run build`.
- Run the built server against a throwaway DB, then exercise the API with curl:
  `PORT=5070 DASHBOARD_PASSWORD=pw DB_PATH=/tmp/t/data.db node dist/index.cjs`.
  Log in with `POST /api/auth/login {"password":"pw"}` while sending `X-Forwarded-Proto: https`
  (cookies are `secure` in production and the app trusts the proxy header).
- Don't spend real API credits in tests: run a small local HTTP server that imitates
  `POST /v1/messages` (Anthropic) or `POST /emails` (Resend), and point `ANTHROPIC_BASE_URL` /
  `RESEND_BASE_URL` at it. Return `tool_use` blocks to test OM intake and proposals, and
  `stop_reason: "refusal"` or empty content to test error handling.
- Chrome blocks ports 5060 and 5061 (unsafe ports); use 5070+ for browser checks.
- When a bug fix changes calculations (IRR, equity multiple, dates), check results against an
  independent calculation, not just the code's own output.
- Never point a test at the production database or the live URL.

## Known issues

- `npm run check` reports 24 errors, all pre-existing in `client/src/pages/Underwriting.tsx`
  (`number | undefined` from form state). The build works. Don't add new errors; fixing these
  is a reasonable cleanup task.
- The default model is `claude-sonnet-5` (works in production). Newer models exist, e.g.
  `claude-sonnet-5-5`; to try one, set `ANTHROPIC_MODEL` in Railway and test OM upload and Ask
  on a real deal before making it the default in `server/claude.ts`.
- `extract.ts` keeps an OpenAI fallback path that is unused when `ANTHROPIC_API_KEY` is set.
- Old-format Excel (.xls) can't be read anywhere; .xlsx/.xlsm, .docx, .csv and PDF can. Excel is read by
  `server/fileText.ts` straight from the file's XML (JSZip), not by an Excel library: ExcelJS's full load
  used ~3 GB on large models and its streaming reader skipped sheets at random. Verified cell by cell
  against ExcelJS on ~70 of the owner's real workbooks (0 missing or changed values).
- The footer "Created with Perplexity Computer" comes from `PerplexityAttribution.tsx` (the app
  was originally generated there). Leave it unless the owner asks.

## Ideas discussed but not built

- Forward an email to a `deals@` address to create a deal from the attached OM.
- Broker follow-up email drafts (draft only; send needs approval).
- Closing checklist on moving to Closing.
- Project budget vs. actual by line item, and construction draws.
- Properties tab for owned assets (rent roll, leases, monthly reporting-package upload).
- Separate logins per partner so the activity log shows who did what.
