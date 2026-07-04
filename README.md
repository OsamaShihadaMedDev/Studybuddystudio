# StudyBuddy Studio

An internal authoring and ingestion pipeline for the **StudyBuddy AI** QBank — a browser-based studio for scaffolding medical exam questions and a validated batch ingester that pushes them (and their media) into Supabase.

## What it does

- **Studio (`studio.html` / `studio.ts`)** — a browser UI for authoring structured QBank questions against a defined subject/domain/topic taxonomy.
- **Scaffolder (`scaffoldQuestion.ts`)** — generates a correctly-shaped question template so every question conforms to the schema from the start.
- **Ingester (`ingestQuestions.ts`)** — validates each question JSON (external ID format, difficulty, reasoning order, five options, correct answer, explanation, teaching point), verifies and uploads associated media to the `qbank-media` storage bucket with license metadata, writes to the database, and logs any failures for re-runs.

## Question schema (enforced at ingest)

Each question carries: `external_id` (e.g. `CV-PATH-015`), subject, domain, topic, difficulty (Easy/Medium/Hard), reasoning order (1st/2nd/3rd), competency, stem, five options, correct option, explanation, teaching point, and optional licensed media.

## Tech stack

TypeScript · Node.js · Supabase JS · dotenv

## Running

```bash
npm install
# create .env with SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY
npx tsx scripts/src/ingestQuestions.ts
```

> The ingester uses the Supabase **service_role** key. It is loaded from a gitignored `.env` and must never be committed or exposed client-side.
