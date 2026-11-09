# RepoStory

RepoStory is an application that analyzes public GitHub repositories and translates their codebase structures into plain-English architecture stories and interactive workflow diagrams. Built for engineering teams, technical writers, and developers onboarding onto unfamiliar codebases, the system accepts a public GitHub repository URL, runs a deterministic static analysis pipeline across source trees and dependency manifests, generates editable interactive diagrams (System Overview, API Request Flow, Authentication Flow, and Component Relationships), and provides an optional AI-assisted explanatory narrative grounded in verified code evidence.

[![Next.js](https://img.shields.io/badge/Next.js-16.4.2-black?style=flat&logo=next.js)](https://nextjs.org/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.x-blue?style=flat&logo=typescript)](https://www.typescriptlang.org/)
[![License](https://img.shields.io/badge/License-Unspecified-lightgrey.svg)](#license-and-acknowledgments)
[![CI Status](https://github.com/rachts/repo-story/actions/workflows/ci.yml/badge.svg)](https://github.com/rachts/repo-story/actions/workflows/ci.yml)

---

## Quick Links

- [How It Works](#how-it-works)
- [Features](#features)
- [Architecture](#architecture)
- [API Reference](#api-reference)
- [Job Queue and Worker](#job-queue-and-worker)
- [Getting Started](#getting-started)
- [Running with Docker](#running-with-docker)
- [Testing](#testing)
- [CI/CD](#cicd)
- [Limitations and Known Issues](#limitations-and-known-issues)
- [Project Structure](#project-structure)
- [Decisions and Documentation](#decisions-and-documentation)
- [Contributing](#contributing)
- [License and Acknowledgments](#license-and-acknowledgments)

---

## How It Works

RepoStory executes analysis asynchronously to handle repositories ranging from small utilities to monorepos:

1. **Submission (`POST /api/analyze`)**: The client submits a public GitHub repository URL and optional branch. Inbound rate limiting (10 requests per minute) and daily quotas (5 analyses per UTC day by default) are evaluated.
2. **Asynchronous 202 Contract**: The endpoint validates the URL against the GitHub allowlist, persists a job record in the database or store, enqueues the job ID into the durable queue, and returns an HTTP `202 Accepted` response with `{ jobId, statusUrl, deduplicated }` and a `Location: /api/analyze/jobs/:jobId` header.
3. **Queue Claiming & Execution**: A worker process (`src/worker.ts`) claims the job via `FOR UPDATE SKIP LOCKED` (PostgreSQL) or in-memory lock, periodically issuing heartbeats.
4. **Data Retrieval & Resilience**: The worker queries the GitHub REST API using `@octokit/rest` wrapped with `@octokit/plugin-throttling` and `@octokit/plugin-retry`. Outbound requests select tokens dynamically from `GITHUB_TOKENS` based on remaining rate-limit quota, with a per-job circuit breaker halting execution if consecutive rate-limit errors occur. Git trees and blob contents are cached against immutable commit SHAs.
5. **Deterministic Pipeline (`src/application/pipeline.ts`)**:
   - Decodes source files (with automatic UTF-16 LE/BE and UTF-8 BOM detection, skipping LFS pointers and submodules by default).
   - Identifies technologies, directory topologies, entry points, and database ORMs/drivers.
   - Detects API routes across Next.js App Router, Pages Router, and Express router patterns.
   - Maps module relationships and import graphs.
   - Generates four deterministic diagram definitions with technical and plain-English label tiers.
   - Synthesizes the structured Architecture Story narrative.
6. **Optional AI Narrative (`POST /api/explain`)**: If enabled, the system compiles deterministic evidence and invokes Groq LLM inference, validating that all citations match verified file evidence IDs.
7. **Interactive UI & Export**: The client polls the status URL until completion, rendering interactive React Flow diagrams with layout direction toggles, element editing panels, and export capabilities (Mermaid `.mmd` or Markdown `.md`).

---

## Features

### Analysis Pipeline
- **Framework & Manifest Detection**: Discovers dependencies, packages, and framework configurations across Node.js/TypeScript manifests (`package.json`, `tsconfig.json`).
- **Route & Endpoint Discovery**: Detects HTTP routes, methods, and dynamic parameters across Next.js App Router (`app/**/route.ts`), Pages Router (`pages/api/**`), and Express router declarations.
- **Data Layer Evidence**: Detects database clients, query builders, and ORMs, including Prisma schema files, Supabase, Mongoose, Drizzle, TypeORM, Knex, and raw database drivers.
- **Authentication Pattern Detection**: Detects NextAuth / Auth.js, Supabase Auth, Clerk, Firebase Auth, JWT signing, and session cookies.
- **External Integrations**: Identifies third-party SDKs and service integrations such as Stripe, GitHub API, SendGrid, Sentry, AWS SDK, and Upstash.
- **File Decoding & Safety**: Safely decodes text files, handles binary files without crashing, skips Git LFS pointer files by default, records submodules in coverage, and warns on case-insensitive path collisions.
- **Truncated Tree Fallback**: Recovers from GitHub API tree truncation (`truncated: true`) by non-recursively resolving subtrees and merging results.

### Diagrams & Visualization
- **Four Diagram Types**:
  - *System Overview*: High-level architectural layout of entrypoints, core services, and persistence.
  - *API Request Flow*: Request routing from client to route handlers and storage.
  - *Authentication Flow*: Session verification, OAuth callbacks, and protected route guards.
  - *Component / Module Relationships*: Import and dependency graphs across internal modules.
- **Dual Label Tiers**: Toggle between technical identifiers (function names, paths) and plain-English descriptions on the canvas.
- **Layout Direction Controls**: Re-orient diagrams on demand (Top to Bottom, Left to Right, Right to Left, Bottom to Top).

### Editing and Export
- **Canvas Editing**: Customize diagram titles, descriptions, custom notes, and node/edge visibility directly in the editor panel.
- **Undo / Redo & Dirty Tracking**: Track revisions in memory with the ability to reset to the original analysis state (`POST /api/diagrams/:id/reset`).
- **Mermaid Export**: Copy clean, standalone Mermaid syntax (`.mmd`) to the clipboard.
- **Markdown Export**: Copy formatted Markdown documentation (`.md`) combining Mermaid diagrams, technical evidence tables, and optional architecture summary narratives.

### Authentication & Quotas
- **GitHub OAuth**: Authentication via NextAuth (`/api/auth/[...nextauth]`) using GitHub as an OAuth provider.
- **Anonymous Usage Mode**: Feature-flagged via `ANONYMOUS_ANALYSIS_ENABLED` (enabled in local development, disabled by default in production).
- **Session Migration**: Anonymous analysis jobs created in local sessions are automatically linked to the user account upon first OAuth login.
- **Daily Quotas**: Per-user daily limits enforced at 5 analyses per UTC day (`ANALYSIS_DAILY_QUOTA`), returning HTTP 429 with `Retry-After` calculated until 00:00 UTC.
- **Strict Isolation**: Accessing analyses or diagrams owned by another account returns `404 Not Found` rather than `403 Forbidden` to prevent resource enumeration.

### Jobs & Worker Execution
- **Durable Queue**: Queue state machine (`queued → running → succeeded | failed | cancelled`) backed by PostgreSQL with `FOR UPDATE SKIP LOCKED` or local in-memory fallback.
- **Background Worker**: Standalone runner (`src/worker.ts`) decoupled from HTTP web processes.
- **Heartbeat & Orphan Reclamation**: Active workers periodically heartbeat; jobs abandoned by crashed workers are reclaimed after a configurable timeout (default: 120 seconds).
- **Job Control**: Dedicated endpoints to cancel in-flight jobs or retry failed jobs.

### Observability & Security
- **Structured Logging**: JSON logging via Pino with automated field-level redaction for tokens, cookies, authorization headers, and secrets.
- **Prometheus Metrics**: Metrics endpoint (`/api/metrics`) protected by `METRICS_BEARER_TOKEN`, exposing job statuses, execution durations, and GitHub rate-limit metrics.
- **Error Telemetry**: Sentry instrumentation with request body and header sanitization.
- **Strict Content Security Policy**: CSP restricting script execution, disallowing iframe embedding (`frame-ancestors 'none'`), and enforcing HSTS preload.
- **CORS Allowlist**: API endpoints block cross-origin requests by default unless explicitly whitelisted in `CORS_ALLOWED_ORIGINS`.

---

## Architecture

RepoStory enforces a layered architecture. High-level requests pass downward, with business rules isolated from external infrastructure:

```text
       ┌────────────────────────────────────────────────────────┐
       │                   app / (Next.js UI)                   │
       │     Pages, Components, API Route Handlers (HTTP)       │
       └───────────────────────────┬────────────────────────────┘
                                   │
       ┌───────────────────────────▼────────────────────────────┐
       │                      application /                     │
       │    Use Cases, Pipeline Orchestration, Job Ports,       │
       │         Store Interfaces, Rate Limit Ports             │
       └─────────────┬────────────────────────────┬─────────────┘
                     │                            │
       ┌─────────────▼──────────────┐┌────────────▼─────────────┐
       │         analysis /         ││        domain /          │
       │ Heuristic & AST Extractors,││ Core Entities, Findings, │
       │ Flow Generators, Exporters ││   Errors, Value Objects  │
       └─────────────┬──────────────┘└──────────────────────────┘
                     │
       ┌─────────────▼──────────────────────────────────────────┐
       │                    infrastructure /                    │
       │    Octokit Providers, Supabase Adapters, Redis Limits, │
       │         Groq AI Client, File & In-Memory Stores        │
       └───────────────────────────┬────────────────────────────┘
                                   │
       ┌───────────────────────────▼────────────────────────────┐
       │                       shared /                         │
       │       Logger, Metrics, Tracer, IDs, Redaction, HTTP    │
       └────────────────────────────────────────────────────────┘
```

### Layer Responsibilities and Dependency Rules
- **`domain/`**: Houses core business entities (`AnalysisJobRecord`, `Diagram`, `EvidenceReference`, `AppError`). It has zero dependencies on infrastructure, network frameworks, or database libraries.
- **`application/`**: Coordinates workflows (`runAnalysis`, `JobWorker`, `JobQueue` ports, `AnalysisJobRepository` interfaces). *(Note: `application/health.ts` imports the safe GitHub URL builder utility from `infrastructure`)*.
- **`analysis/`**: Contains deterministic static analysis logic, route extractors, database pattern detectors, Mermaid exporters, and Markdown formatters.
- **`infrastructure/`**: Implements ports defined by the application layer, interacting with external APIs (GitHub, Groq, Supabase REST, Upstash Redis).
- **`shared/`**: Low-level cross-cutting utilities (Pino logger, Prometheus registry, Sentry configuration, opaque ID generators).
- **`composition/`**: Container module (`src/composition/container.ts`) that instantiates concrete adapters based on environment configuration.

---

## API Reference

All JSON endpoints accept and return UTF-8 payloads. Route handlers enforce strict input validation via Zod.

| Method | Path | Auth Required | Purpose | Response Codes |
| :--- | :--- | :--- | :--- | :--- |
| `POST` | `/api/analyze` | Optional (Session / Anonymous) | Enqueues a new repository analysis job. | `202`, `400`, `401`, `429` |
| `GET` | `/api/analyze/jobs/[jobId]` | Yes (Job Owner) | Polls the execution status and progress of a queued/running job. | `200`, `401`, `404` |
| `POST` | `/api/analyze/jobs/[jobId]/cancel` | Yes (Job Owner) | Cancels an in-flight analysis job. | `200`, `401`, `404` |
| `POST` | `/api/analyze/jobs/[jobId]/retry` | Yes (Job Owner) | Retries an eligible failed analysis job. | `200`, `401`, `404`, `409` |
| `GET` | `/api/analyze/[analysisId]` | Yes (Job Owner) | Retrieves the completed analysis result, diagrams, and explanation. | `200`, `401`, `404`, `409`, `410` |
| `GET` | `/api/analysis/[analysisId]` | Yes (Job Owner) | Alias endpoint retrieving completed analysis results. | `200`, `401`, `404` |
| `GET` | `/api/analysis/[analysisId]/diagrams` | Yes (Job Owner) | Retrieves the list of diagrams generated for an analysis. | `200`, `401`, `404` |
| `GET` | `/api/diagrams/[diagramId]` | Yes (Diagram Owner) | Fetches a diagram definition and its rendered Mermaid representation. | `200`, `401`, `404` |
| `PATCH`| `/api/diagrams/[diagramId]` | Yes (Diagram Owner) | Updates labels, notes, or element visibility on a diagram. | `200`, `400`, `401`, `404` |
| `POST` | `/api/diagrams/[diagramId]/reset` | Yes (Diagram Owner) | Resets all edits on a diagram back to its generated analysis state. | `200`, `401`, `404` |
| `POST` | `/api/explain` | Yes (Analysis Owner)| Generates or retrieves an AI project explanation citing verified evidence. | `200`, `400`, `401`, `404`, `409`, `503` |
| `POST` | `/api/exports` | Yes (Diagram Owner) | Generates Mermaid (`.mmd`) or Markdown (`.md`) documentation export. | `200`, `400`, `401`, `404`, `500` |
| `GET` | `/api/health/live` | No | Liveness probe indicating process uptime (`200 OK`). | `200` |
| `GET` | `/api/health/ready` | No | Readiness probe testing GitHub reachability, database connectivity, and queue. | `200`, `503` |
| `GET` | `/api/health` | No | Base health status endpoint. | `200` |
| `GET` | `/api/live` | No | Thin backward-compatibility alias re-exporting `/api/health/live`. | `200` |
| `GET` | `/api/ready` | No | Thin backward-compatibility alias re-exporting `/api/health/ready`. | `200`, `503` |
| `GET` | `/api/metrics` | Yes (`Bearer <METRICS_BEARER_TOKEN>`)| Exposes Prometheus scrape metrics. | `200`, `401` |
| `ALL` | `/api/auth/[...nextauth]` | No | NextAuth handler for GitHub OAuth flow and session management. | `200`, `302` |

---

## Job Queue and Worker

RepoStory decouples job scheduling from pipeline execution to prevent HTTP connection timeouts and support horizontal worker scaling.

### State Machine
Jobs transition through five explicit states defined in [`src/application/jobs/job-queue.ts`](file:///Users/macbookair/CODING/EXPLAIN_ARCH/repo-story/src/application/jobs/job-queue.ts):

```text
                  ┌──────────────┐
                  │   Queued     │◄────────┐
                  └──────┬───────┘         │
                         │ claim           │ retry
                         ▼                 │
                  ┌──────────────┐         │
        ┌─────────┤   Running    ├─────────┘
        │ cancel  └──────┬───────┘ fail (attempts < max)
        ▼                │
 ┌─────────────┐         ├─────────────────┐
 │  Cancelled  │         ▼ complete        ▼ fail (attempts >= max)
 └─────────────┘  ┌──────────────┐  ┌─────────────┐
                  │  Succeeded   │  │   Failed    │
                  └──────────────┘  └─────────────┘
```

- `queued`: Enqueued and waiting for an available worker.
- `running`: Claimed by a worker; actively updated via heartbeats.
- `succeeded`: Pipeline completed; results persisted.
- `failed`: Terminal failure when retry budget is exhausted.
- `cancelled`: Explicitly cancelled by user request.

### Worker Execution & Heartbeats
- **Worker Entry Point**: Execute the background worker via `npm run worker` (production compiled `node dist/worker.js`) or `npm run worker:dev` (local development with `tsx`).
- **Heartbeat & Reclaim**: Workers send heartbeats to the queue backend every 15 seconds (`WORKER_HEARTBEAT_INTERVAL_MS`). If a worker crashes or loses connectivity, its lock expires after the heartbeat timeout (default: 120 seconds / `WORKER_HEARTBEAT_TIMEOUT_MS`). The next polling worker reclaims the abandoned job and resumes execution.
- **Verification Documentation**:
  - Worker crash recovery verification: [`docs/operations/worker-crash-verification.md`](file:///Users/macbookair/CODING/EXPLAIN_ARCH/repo-story/docs/operations/worker-crash-verification.md)
  - Database contention and concurrency testing: [`docs/operations/db-verification.md`](file:///Users/macbookair/CODING/EXPLAIN_ARCH/repo-story/docs/operations/db-verification.md)

---

## Getting Started

### Prerequisites
- **Node.js**: Version `22.14.0` (specified in `.nvmrc`).
- **npm**: Version `10.x` or higher.
- **PostgreSQL**: Version 16 or Supabase database (required for durable production queue and storage; local development can use in-memory mode).
- **GitHub Account / Tokens**: A GitHub Personal Access Token (or OAuth App credentials for user sign-in).

### 1. Installation and Environment Setup

```bash
git clone https://github.com/rachts/repo-story.git
cd repo-story
npm ci
cp .env.example .env.local
```

### 2. Environment Variables Configuration

Configure variables in `.env.local`:

| Variable | Required in Production | Default Value | Purpose & Source File |
| :--- | :--- | :--- | :--- |
| `NODE_ENV` | Optional | `development` | Runtime environment (`development`, `production`, `test`). Read by `src/config/env.ts`. |
| `PORT` | Optional | `3000` | Port for the Next.js HTTP server. Read by `src/config/env.ts`. |
| `GITHUB_TOKEN` | Optional | *empty* | Single GitHub token fallback for API calls. Read by `src/shared/config.ts`. |
| `GITHUB_TOKENS` | Optional | *empty* | Comma-separated list of GitHub tokens for dynamic quota pooling. Read by `src/infrastructure/providers/github-provider.ts`. |
| `NEXTAUTH_URL` | Optional | `http://localhost:3000` | Canonical application URL for OAuth redirects. Read by `src/config/env.ts`. |
| `NEXTAUTH_SECRET` | **Required** in prod | *empty* | Secret key for JWT session encryption. Read by `src/app/api/auth/[...nextauth]/route.ts`. |
| `GITHUB_CLIENT_ID` | Optional | `mock-client-id` (dev) | GitHub OAuth application client ID. Read by `src/app/api/auth/[...nextauth]/route.ts`. |
| `GITHUB_CLIENT_SECRET` | Optional | `mock-client-secret` (dev) | GitHub OAuth application client secret. Read by `src/app/api/auth/[...nextauth]/route.ts`. |
| `ANONYMOUS_ANALYSIS_ENABLED`| Optional | `true` (dev) / `false` (prod)| Feature flag allowing unauthenticated analyses. Read by `src/application/jobs/job-identity.ts`. |
| `ANALYSIS_DAILY_QUOTA` | Optional | `5` | Daily UTC analysis limit per user. Read by `src/config/env.ts`. |
| `REPO_STORY_JOB_STORE` | **Required** in prod | `memory` (dev) | Storage backend (`supabase`, `file`, or `memory`). Read by `src/config/production-guards.ts`. |
| `REPO_STORY_JOB_STORE_PATH`| Optional | `.repo-story-data/state.json`| File path used when `REPO_STORY_JOB_STORE=file`. Read by `src/composition/container.ts`. |
| `SUPABASE_URL` | **Required** if Supabase | *empty* | Supabase project REST URL. Read by `src/shared/config.ts`. |
| `SUPABASE_SECRET_KEY` | **Required** if Supabase | *empty* | Supabase service role secret key. Read by `src/shared/config.ts`. |
| `ALLOW_IN_MEMORY_QUEUE` | Optional | `false` | Explicit bypass permitting in-memory queue in production. Read by `src/config/production-guards.ts`. |
| `ALLOW_IN_MEMORY_STORE` | Optional | `false` | Explicit bypass permitting in-memory store in production. Read by `src/config/production-guards.ts`. |
| `WORKER_ID` | Optional | `worker-<pid>` | Worker process identifier. Read by `src/worker.ts`. |
| `WORKER_HEARTBEAT_TIMEOUT_MS`| Optional | `120000` | Inactivity window before abandoned jobs are reclaimed. Read by `src/composition/container.ts`. |
| `WORKER_HEARTBEAT_INTERVAL_MS`| Optional | `15000` | Frequency of worker heartbeat pings. Read by `src/worker.ts`. |
| `WORKER_POLL_INTERVAL_MS` | Optional | `1000` | Queue polling interval. Read by `src/worker.ts`. |
| `WORKER_CONCURRENCY` | Optional | `2` | Number of simultaneous jobs processed per worker. Read by `src/worker.ts`. |
| `METRICS_BEARER_TOKEN` | Optional | *empty* | Bearer token protecting `GET /api/metrics`. Read by `src/app/api/metrics/route.ts`. |
| `UPSTASH_REDIS_REST_URL`| Optional | *empty* | Upstash Redis REST URL for distributed rate limiting. Read by `src/config/env.ts`. |
| `UPSTASH_REDIS_REST_TOKEN`| Optional | *empty* | Upstash Redis REST token. Read by `src/config/env.ts`. |
| `FETCH_LFS` | Optional | `false` | When true, fetches contents for Git LFS pointer files. Read by `src/analysis/file-decoder.ts`. |
| `SUBMODULE_MAX_DEPTH` | Optional | `0` | Git submodule recursion depth (0 = skip and record in coverage). Read by `src/infrastructure/providers/github-provider.ts`. |
| `CORS_ALLOWED_ORIGINS` | Optional | *empty* | Comma-separated allowed origins for `/api/*`. Read by `src/middleware.ts`. |
| `GROQ_API_KEY` | Optional | *empty* | Groq API key for AI explanation layer. Read by `src/infrastructure/ai/groq-client.ts`. |
| `GROQ_MODEL` | Optional | `openai/gpt-oss-120b` | LLM model identifier for explanations. Read by `src/shared/config.ts`. |
| `GROQ_ENABLED` | Optional | `true` | Feature flag for AI explanation generation. Read by `src/shared/config.ts`. |

### Production Startup Guards
When `NODE_ENV=production`, the application executes fail-fast configuration checks before serving requests:
1. **Missing `REPO_STORY_JOB_STORE`**: If unset, initialization halts immediately with exit code 1:
   ```text
   [RepoStory Config Error] In production, REPO_STORY_JOB_STORE must be explicitly set ('supabase' or 'memory').
   ```
2. **Missing `ALLOW_IN_MEMORY_QUEUE`**: If `REPO_STORY_JOB_STORE=memory` is specified in production without explicit permission:
   ```text
   [RepoStory Config Error] InMemoryJobQueue is not allowed in production unless ALLOW_IN_MEMORY_QUEUE=true is explicitly set.
   ```
3. **Missing Supabase Credentials**: If `REPO_STORY_JOB_STORE=supabase` is specified without `SUPABASE_URL` and `SUPABASE_SECRET_KEY`:
   ```text
   [RepoStory Config Error] In production with Supabase mode, SUPABASE_URL and SUPABASE_SECRET_KEY are required.
   ```

### 3. Database Migrations
When using PostgreSQL or Supabase, apply migrations in sequential order using `psql`:

```bash
# Connect to your target database and apply migrations 001 through 005:
psql "$DATABASE_URL" -f supabase/migrations/001_repo_story.sql
psql "$DATABASE_URL" -f supabase/migrations/002_job_queue.sql
psql "$DATABASE_URL" -f supabase/migrations/003_auth_and_rls.sql
psql "$DATABASE_URL" -f supabase/migrations/004_cache_store.sql
psql "$DATABASE_URL" -f supabase/migrations/005_organizations_and_rbac.sql
```

### 4. Running the Application

```bash
# Local development server (Next.js with Turbopack on port 3000):
npm run dev

# Local background worker process (with tsx hot-reload):
npm run worker:dev

# Production build and execution:
npm run build
npm run build:worker
npm run start       # Starts Next.js server on port 3000
npm run worker      # Starts background job worker (node dist/worker.js)
```

---

## Running with Docker

> [!NOTE]
> **Status: Not yet verified locally**
> The multi-stage `Dockerfile` is configured for production builds, but image builds have not been executed on the local development host due to the absence of the Docker engine CLI. Run the commands below after starting Docker Desktop.

### Build Targets

```bash
# 1. Build the Next.js Web Application container
docker build --target web -t repostory-web .

# 2. Build the Background Job Worker container (pure Node.js runtime without tsx or devDependencies)
docker build --target worker -t repostory-worker .
```

### Automated Verification Script
To verify container builds, dependency tree pruning, and health probes, run the included test script:

```bash
chmod +x scripts/verify-docker.sh
./scripts/verify-docker.sh
```

---

## Testing

RepoStory maintains test tiers covering unit logic, integration with mocked GitHub APIs, browser end-to-end user journeys, and process recovery.

### Test Tier Summary

| Tier | Command | Covered Test Suites | Real Execution Output |
| :--- | :--- | :--- | :--- |
| **All Vitest Tests** | `npm test` | All 26 unit and component test suites in `tests/` | `Test Files: 26 passed (26)`<br>`Tests: 225 passed (225)`<br>`Duration: 5.39s` |
| **Unit Tier** | `npm run test:unit` | Fast unit tests excluding MSW network mocks | `Test Files: 24 passed (24)`<br>`Tests: 219 passed (219)` |
| **Integration Tier** | `npm run test:integration` | GitHub API resilience, token pool, truncated trees (MSW) | `Test Files: 2 passed (2)`<br>`Tests: 6 passed (6)` |
| **End-to-End Tier** | `make test-e2e` | Playwright browser smoke tests (`tests/e2e/smoke.spec.ts`) | `4 passed (5.1s)` |
| **Worker Crash Recovery**| `make test-crash` | Real process groups, SIGKILL termination, heartbeat reclaim | `Worker crash recovery verified: Job was claimed, worker 1 killed, worker 2 reclaimed and completed without data loss.` |

### Static Analysis Checks

```bash
# TypeScript type checking
npm run typecheck
# Result: tsc --noEmit (0 errors)

# ESLint verification
npm run lint
# Result: eslint . (0 errors, 0 warnings)
```

---

## CI/CD

Continuous integration is defined under `.github/workflows/`:

1. **Continuous Integration (`.github/workflows/ci.yml`)**:
   - Triggers on pushes to `main` and feature branches (`rachts/**`), and pull requests targeting `main`.
   - `lint-and-typecheck`: Executes `npm run lint` and `npm run typecheck`.
   - `test-unit`: Runs fast unit tests (`npm run test:unit`).
   - `test-integration`: Runs MSW integration tests (`make test-integration`).
   - `build`: Compiles the Next.js production build (`npm run build`).
   - `test-e2e`: Installs Playwright Chromium dependencies and runs `make test-e2e`.
   - `test-crash`: Spins up PostgreSQL 16 and PostgREST service containers, applies migrations `001`–`005`, and executes `make test-crash`.
2. **Security Scanner (`.github/workflows/security.yml`)**:
   - Triggers on pushes, pull requests, and a weekly schedule (Mondays at 06:00 UTC).
   - Runs GitHub CodeQL static analysis for JavaScript/TypeScript.
   - Runs `npm audit --audit-level=high`.
   - Runs TruffleHog secrets scanner across git commit history.

*(Note: Verification of CI workflows has been performed locally; GitHub Actions remote run status depends on repository settings on GitHub).*

---

## Limitations and Known Issues

1. **Docker Container Verification**: Docker image creation has not been tested in this local environment because Docker Desktop / Docker CLI is not installed on the workstation.
2. **Database Engine Differences**: Migrations `001` through `005` were validated against PostgreSQL 16. Supabase-specific features (such as real-time subscriptions, Supabase Storage, and built-in GoTrue authentication) require a full Supabase environment or external polyfills.
3. **Git LFS Handling**: Git LFS pointer files are detected and skipped by default (`FETCH_LFS=false`). Large LFS binary blobs are not downloaded or parsed unless explicit LFS fetching is configured.
4. **Git Submodules**: Submodule entries (Git mode `160000`) are flagged in analysis coverage metadata but are not traversed or analyzed by default (`SUBMODULE_MAX_DEPTH=0`).
5. **AST Parser Engine**: The TypeScript streaming analyzer uses the official TypeScript Compiler API (`typescript`), not `tree-sitter`. (See [Decision 006](file:///Users/macbookair/CODING/EXPLAIN_ARCH/repo-story/docs/decisions/006-phase3-scaling-foundations.md)).
6. **Phase 3 Foundations Status**: Multi-tenant organizations, incremental analysis planners, and streaming analyzers exist as backend foundations with schema migrations, domain logic, and unit tests. Full organization management UI and GitHub webhook automation remain roadmap deliverables.
7. **Development Fallbacks**: When running without external infrastructure, NextAuth uses fallback client credentials, and rate limiting falls back to an in-memory sliding window when Upstash Redis credentials are omitted.

---

## Project Structure

```text
repo-story/
├── .github/                 # GitHub Actions workflows (ci.yml, security.yml) and dependabot config
├── docs/                    # Architecture decision records (001-006) and operational verification logs
├── fixtures/                # Repository mock fixtures (LFS pointers, submodules, AST samples)
├── load/                    # K6 and Autocannon load testing scripts
├── public/                  # Static assets and application icons
├── scripts/                 # Operational verification scripts (crash recovery, contention, Docker)
├── src/
│   ├── analysis/            # Deterministic code analysis, route extractors, and Mermaid/Markdown exporters
│   ├── app/                 # Next.js 14 App Router pages, layout, and API route handlers
│   ├── application/         # Pipeline orchestration, job worker, store interfaces, and health checks
│   ├── components/          # React components (interactive canvas, explanation panel, brand assets)
│   ├── composition/         # Dependency injection container (container.ts)
│   ├── config/              # Zod environment schemas and production fail-fast guards
│   ├── domain/              # Core domain entities, diagram models, findings, and errors
│   ├── infrastructure/      # Octokit GitHub providers, Supabase repositories, and Groq AI client
│   ├── shared/              # Pino logger, Prometheus metrics, Sentry scrubbing, and HTTP utilities
│   ├── middleware.ts        # Next.js security headers, HSTS, and CORS enforcement proxy
│   └── worker.ts            # Background job worker entry point
├── supabase/
│   └── migrations/          # PostgreSQL database migrations (001_repo_story through 005_organizations)
├── tests/
│   ├── component/           # React component unit tests (React Testing Library)
│   ├── e2e/                 # Playwright end-to-end browser smoke test suite
│   └── unit/                # Vitest unit and integration test suites
├── Dockerfile               # Multi-stage production container build (web and worker targets)
├── Makefile                 # Make targets for testing, linting, and worker execution
├── package.json             # Scripts, dependencies, and project metadata
├── playwright.config.ts     # Playwright browser automation configuration
└── tsconfig.json            # Base TypeScript configuration
```

---

## Decisions and Documentation

Architecture decision records (ADRs) are documented under `docs/decisions/`:

| Record | Title | Key Decision |
| :--- | :--- | :--- |
| [001](file:///Users/macbookair/CODING/EXPLAIN_ARCH/repo-story/docs/decisions/001-queue-backend.md) | Queue Backend Architecture | Established `JobQueue` port with PostgreSQL `FOR UPDATE SKIP LOCKED` and in-memory dev guards. |
| [002](file:///Users/macbookair/CODING/EXPLAIN_ARCH/repo-story/docs/decisions/002-auth-and-ownership.md) | Auth and Ownership | Implemented NextAuth GitHub OAuth, per-user daily quotas (5/day), and 404 resource privacy. |
| [003](file:///Users/macbookair/CODING/EXPLAIN_ARCH/repo-story/docs/decisions/003-token-pool-and-resilience.md) | Token Pool and Resilience | Implemented dynamic token quota routing, 3-failure circuit breaker, and commit-SHA caching. |
| [004](file:///Users/macbookair/CODING/EXPLAIN_ARCH/repo-story/docs/decisions/004-ssrf-and-fixed-host.md) | SSRF Defense Strategy | Enforced fixed `api.github.com` host validation, encoded paths, and `redirect: "error"`. |
| [005](file:///Users/macbookair/CODING/EXPLAIN_ARCH/repo-story/docs/decisions/005-security-headers-and-cors.md) | Security Headers and CORS | Configured strict CSP, clickjacking prevention (`frame-ancestors 'none'`), and per-origin CORS. |
| [006](file:///Users/macbookair/CODING/EXPLAIN_ARCH/repo-story/docs/decisions/006-phase3-scaling-foundations.md) | Phase 3 Scaling Foundations | Selected TypeScript Compiler API over tree-sitter, added RBAC schema, and compare planner. |

Operational runbooks and test reports are documented under `docs/operations/`:
- [Worker Crash Recovery Verification](file:///Users/macbookair/CODING/EXPLAIN_ARCH/repo-story/docs/operations/worker-crash-verification.md)
- [Database Contention and Concurrency Report](file:///Users/macbookair/CODING/EXPLAIN_ARCH/repo-story/docs/operations/db-verification.md)

---

## Contributing

### Verification Workflow
Before submitting a pull request, run all verification tiers locally to ensure type safety, linting conformance, and test passage:

```bash
# 1. Typecheck and lint
npm run typecheck
npm run lint

# 2. Run unit and integration tests
npm test

# 3. Run browser end-to-end tests
make test-e2e
```

### Git Branch & Commit Style
- **Branch Naming**: Feature and bugfix branches follow the format `rachts/<type>/<short-description>` (for example, `rachts/feat/token-pool` or `rachts/fix/production-readiness`).
- **Commit Messages**: Follow Conventional Commits format with explicit scopes, for example:
  - `feat(worker): implement heartbeat reclaim and process group signal handling`
  - `fix(config): enforce production startup guards for job store and in-memory queue`
  - `docs(readme): rewrite README from verified project facts`

---

## License and Acknowledgments

### License
*A formal `LICENSE` file is not currently present in the repository root, and `"private": true` is marked in `package.json`. The maintainer should add a LICENSE file (such as MIT or Apache-2.0) if publishing as an open-source project.*

### Acknowledgments & External Services
RepoStory integrates with and references the following external services and platforms:
- **[GitHub REST API](https://docs.github.com/en/rest)**: Upstream provider for public repository git trees, commits, and source file retrieval.
- **[Supabase](https://supabase.com/) / PostgreSQL**: Relational database persistence and lock-free job queue backend utilizing `FOR UPDATE SKIP LOCKED`.
- **[NextAuth.js](https://next-auth.js.org/)**: Authentication library handling GitHub OAuth session management.
- **[React Flow (@xyflow/react)](https://reactflow.dev/)**: Interactive node-based diagram canvas for architecture visualization.
- **[Groq SDK](https://groq.com/)**: Fast LLM inference engine powering optional natural-language architecture summaries.
- **[Upstash Redis](https://upstash.com/)**: Distributed REST-based sliding window rate limiter.
- **[Sentry](https://sentry.io/)**: Application monitoring and error reporting telemetry.
- **[Prometheus Client](https://github.com/siimon/prom-client)**: Metrics aggregation library exposing system telemetry.
