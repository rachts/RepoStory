# RepoStory Deployment Architecture

This document describes the production deployment architecture for RepoStory, explaining the separation of responsibilities between the Vercel web application and the persistent background worker.

---

## 1. Architecture Overview

RepoStory employs a decoupled serverless + persistent worker architecture:

```
┌─────────────────────────┐          ┌───────────────────────────┐
│     Next.js on Vercel   │          │  Persistent Worker        │
│  (Serverless API + Web) │          │  (Railway / Fly / Render) │
│                         │          │                           │
│  - maxDuration = 60s    │          │  - npm run worker         │
│  - IN_PROCESS_JOBS=false│          │  - Long-running pipeline  │
│  - Enqueues jobs        │          │  - Polling loop           │
└────────────┬────────────┘          └─────────────┬─────────────┘
             │                                     │
             │         ┌────────────────┐          │
             └────────►│ Supabase       │◄─────────┘
                       │ (PostgreSQL)   │
                       │                │
                       │ - RLS / Auth   │
                       │ - Migrations   │
                       │   001–004      │
                       │ - Job Queue    │
                       │   (SKIP LOCKED)│
                       └────────────────┘
```

---

## 2. Why Vercel Cannot Run Persistent Background Workers

1. **Execution Lifecycle Limits**:
   - Vercel Serverless Functions have execution duration limits (60 seconds max on Pro, 10–15 seconds on Hobby).
   - Once an HTTP response is returned, the serverless container is frozen or destroyed. Any background promises or timers (`setTimeout`, polling intervals) stop executing immediately.

2. **No Persistent Polling**:
   - A durable job queue relies on continuous polling (`FOR UPDATE SKIP LOCKED`) and heartbeats to ensure workers are alive.
   - Running background queue workers directly inside Vercel serverless request handlers leads to job starvation, truncated analysis runs, and double-execution conflicts across concurrent ephemeral lambdas.

3. **Production Guard**:
   - In production, `IN_PROCESS_JOBS` is set to `false` (or omitted). The Next.js API route writes the job record to PostgreSQL, enqueues the job ID in the durable queue, and returns an HTTP `202 Accepted` response with the polling status URL.

---

## 3. Component Deployment Details

### A. Next.js Web Application (Vercel)

- **Platform**: Vercel
- **Command**: `npm run build`
- **Output**: Next.js App Router (SSR + API routes)
- **Configuration**:
  - `export const maxDuration = 60;` on `/api/analyze` routes.
  - `DEFAULT_LIMITS.maxAnalysisMs = 50_000` (provides $\ge 10$ seconds headroom below the 60s platform ceiling).
  - Environment variables:
    - `IN_PROCESS_JOBS=false`
    - `REPO_STORY_JOB_STORE=supabase`
    - `REPO_STORY_QUEUE_MODE=supabase`
    - `NEXT_PUBLIC_SUPABASE_URL=https://<project-ref>.supabase.co`
    - `NEXT_PUBLIC_SUPABASE_ANON_KEY=<anon-key>`
    - `SUPABASE_SERVICE_ROLE_KEY=<service-role-key>`
    - `NEXTAUTH_SECRET=<secret>`
    - `NEXTAUTH_URL=https://repostory-github.vercel.app`
    - `GITHUB_ID=<github-oauth-client-id>`
    - `GITHUB_SECRET=<github-oauth-client-secret>`

### B. Background Worker (Railway / Fly.io / Render / EC2)

- **Platform**: Any container or VM runtime that supports persistent Node.js processes (Railway, Fly.io, Render, AWS ECS/EC2).
- **Start Command**: `npm run worker` (or `node dist/worker.js` / Dockerfile).
- **Build Command**: `npm run build:worker` (runs `tsc -p tsconfig.worker.json`).
- **Health Check**:
  - Built-in lightweight HTTP health server listening on `process.env.PORT || 10000`, responding with `200 OK` and `{"status": "healthy"}` for container health probes.
- **Queue Mechanism**:
  - Uses PostgreSQL `FOR UPDATE SKIP LOCKED` to safely claim jobs without race conditions or locks between multiple worker instances.
  - Heartbeat checks every 15 seconds to ensure active jobs are not marked stale.
- **Environment variables**:
  - `REPO_STORY_JOB_STORE=supabase` (Required in production)
  - `REPO_STORY_QUEUE_MODE=supabase` (Required in production)
  - `REPO_STORY_CACHE_STORE=supabase` (Recommended in production)
  - `SUPABASE_URL=https://<project-ref>.supabase.co` (Required)
  - `SUPABASE_SECRET_KEY=<service-role-secret-key>` (Required, bypasses RLS; also accepts `SUPABASE_SERVICE_ROLE_KEY`)
  - `GITHUB_TOKEN=<personal-access-token>` (Optional single token)
  - `GITHUB_TOKENS=<token1,token2>` (Optional comma-separated token pool)
  - `GROQ_API_KEY=<groq-api-key>` (Optional AI reasoning key)
  - `REPO_STORY_TOKEN_ENCRYPTION_KEY=<key>` (Required for encrypted queue payload mode)
  - `WORKER_CONCURRENCY=2` (Default 2, tune based on memory limits)
  - `WORKER_POLL_INTERVAL_MS=1000` (Default 1000ms)
  - `WORKER_HEARTBEAT_INTERVAL_MS=15000` (Default 15000ms)
  - `WORKER_HEARTBEAT_TIMEOUT_MS=120000` (Default 120000ms)

### Deployment Steps on Render

1. **Database Readiness**: Ensure all migrations (`001_initial_schema.sql` through `004_durable_jobs.sql`) have been applied to your Supabase PostgreSQL instance.
2. **Render Blueprint / Web Service**:
   - Apply `render.yaml` as an infrastructure blueprint, or create a Web Service pointing to this repository.
   - For `repostory-worker`, ensure `buildCommand` is `npm install && npm run build:worker` and `startCommand` is `npm run worker`.
3. **Configure Environment Variables**:
   - In the Render Dashboard under **Environment**, configure each variable marked with `sync: false` (`SUPABASE_URL`, `SUPABASE_SECRET_KEY`, `GITHUB_TOKENS`, `REPO_STORY_TOKEN_ENCRYPTION_KEY`, etc.).
   - Never commit actual secrets into `render.yaml`.
4. **Health Check Verification**:
   - Render will send HTTP GET requests to `/` on port 10000 (or `PORT`). Verify the worker responds with HTTP 200 `{"status": "healthy"}`.
5. **Logs & Monitoring**:
   - Inspect worker startup logs: verify `[RepoStory Worker] Starting worker worker-<pid>...`, successful startup sweep, and polling loop activation.

### C. Database & Job Store (Supabase)

- **Platform**: Supabase (PostgreSQL)
- **Migrations**: Ensure migrations `001_initial_schema.sql` through `004_durable_jobs.sql` in `supabase/migrations/` are applied.
- **Key Tables**:
  - `analysis_jobs`: Stores job progress, status, coverage metadata, and structured error payloads.
  - `analysis_results`: Stores completed deterministic repository analysis stories and findings.
  - `analysis_diagrams`: Stores generated Mermaid diagram payloads and metadata.
  - `job_queue`: Durable queue table with `claimed_at`, `worker_id`, and `heartbeat_at` for `SKIP LOCKED` processing.

---

## 4. Local Development vs. Production

| Environment | Queue Mode | IN_PROCESS_JOBS | Worker Process |
| :--- | :--- | :--- | :--- |
| **Local Dev (In-Memory)** | `memory` | `true` (auto) | Embedded within Next.js dev server |
| **Local Dev (Supabase)** | `supabase` | `false` | Run `npm run worker` in separate terminal |
| **Production (Vercel)** | `supabase` | `false` | Deployed to Railway / Render / Fly.io |
