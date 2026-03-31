# RE Developer Dashboard

A full-stack real estate developer dashboard with 9 modules:
Overview · Projects · Pipeline · ARM Loans · Cash Flow · Investors · Contacts · Documents · Tasks & Reminders

## Tech Stack
- **Frontend**: React + Vite + Tailwind CSS + shadcn/ui
- **Backend**: Express.js (Node.js)
- **Database**: SQLite via better-sqlite3 + Drizzle ORM

## Local Development

```bash
npm install
npm run db:push        # create database tables
npm run dev            # starts on http://localhost:5000
```

Then visit http://localhost:5000 and click **Load Sample Data** on the Overview page (or POST to /api/seed).

## Deploy to Railway

1. Push this repo to GitHub
2. Go to [railway.app](https://railway.app) → New Project → Deploy from GitHub repo
3. Railway auto-detects `railway.toml` and builds/deploys automatically
4. Add a custom domain in Railway: Settings → Networking → Custom Domain

## Environment

No environment variables required. The SQLite database (`data.db`) is created automatically on first run in the project directory.

## Database

Tables are created automatically via `npm run db:push` (runs as part of the start script is not needed — Drizzle creates tables on first query if missing).

> **Note**: On Railway, the SQLite file lives in the container filesystem. Data persists between deploys as long as you don't redeploy (Railway containers are ephemeral by default). For persistent storage, consider attaching a Railway Volume or migrating to PostgreSQL.
