# RepoStory Architecture Roadmap

This document outlines the architectural milestones, completed foundations, and deferred initiatives for Phase 3 and beyond.

---

## Completed in Production Hardening (Phase 2)

### 1. Durable Execution & Scaling
- [x] Defined `JobQueue` port with `queued -> running -> succeeded | failed | cancelled` state machine.
- [x] Implemented `InMemoryJobQueue` with mutex locking and production safety guard.
- [x] Implemented `SupabaseJobQueue` using Postgres `FOR UPDATE SKIP LOCKED` for lock-free multi-worker scaling.
- [x] Dedicated background worker entry point (`src/worker.ts`), Procfile, and npm `worker` script.
- [x] Heartbeat monitoring and automated claim recovery for crashed workers.

### 2. Authentication, Authorization & Quotas
- [x] Integrated NextAuth with GitHub OAuth provider.
- [x] Feature-flagged anonymous analysis (`ANONYMOUS_ANALYSIS_ENABLED`, default `false` in production).
- [x] Automatic session migration for anonymous analyses upon first OAuth sign-in.
- [x] Daily UTC quota enforcement (`ANALYSIS_DAILY_QUOTA`, default 5/day) returning `429` with `Retry-After`.
- [x] Strict ownership enforcement: returns `404 Not Found` for foreign analyses/jobs to prevent information leakage.
- [x] Row-Level Security (RLS) migrations for Supabase tables keyed on `owner_id`.

### 3. GitHub Resilience & Caching
- [x] Token pool accepting multiple `GITHUB_TOKENS`, dynamically routing requests to the token with highest remaining quota.
- [x] Per-job circuit breaker tripping on consecutive rate-limit failures with structured `GITHUB_RATE_LIMITED` and `retryAt`.
- [x] Content and tree cache store keyed by immutable `owner/repo@commitSha`.
- [x] Fixed-host SSRF allowlist and strict URL validation.

### 4. Real-World File Handling & Large Repositories
- [x] Git LFS pointer detection and skipping, with optional `FETCH_LFS` mode.
- [x] Submodule detection (mode `160000`) and coverage recording.
- [x] UTF-16 LE/BE and UTF-8 BOM auto-detection and resilient decoding.
- [x] Robust binary file handling (e.g. invalid UTF-8 `.py` files) without crashing.
- [x] Case-insensitive path collision warnings and NFC path normalization.
- [x] Streaming pipeline accepting `AsyncIterable<RepositoryFile>` with heap memory budget checks and partial analysis coverage reporting for 20,000+ file trees.
- [x] Truncated tree fallback: non-recursive root fetching and subtree merging with graceful degradation.

### 5. Observability & Security
- [x] Structured JSON logging via Pino with field-level credential redaction.
- [x] OpenTelemetry tracing spans across pipeline execution stages.
- [x] Prometheus metrics endpoint (`/api/metrics`) protected by `METRICS_BEARER_TOKEN`.
- [x] Sentry error tracking with sensitive payload scrubbing.
- [x] Health check probes: `/api/health/live` (process liveness) and `/api/health/ready` (dependency readiness).
- [x] Security headers: Strict CSP, HSTS preload, X-Content-Type-Options, X-Frame-Options DENY, and per-origin CORS.

---

## Phase 3 Foundations (Implemented)

- [x] **Multi-Tenant Organizations & RBAC**:
  - Schema migrations for `organizations` and `organization_memberships`.
  - Roles: `viewer`, `analyst`, `admin`.
  - Scoped `org_id` on jobs and diagrams with `OrganizationService` role enforcement.
- [x] **Incremental Analysis**:
  - Recording `commitSha` and `blobShas` in analysis results.
  - GitHub compare API planner (`planIncrementalAnalysis`) to fetch only modified files between commits.
- [x] **Streaming Static Analysis**:
  - `StreamingAnalyzer` interface consuming `AsyncIterable<RepositoryFile>`.
  - Heuristic streaming analyzer and TypeScript AST streaming analyzer (`TypeScriptAstStreamingAnalyzer`).
- [x] **Load Testing Suite**:
  - `load/analyze.k6.js` and `load/autocannon.js` scripts for benchmark validation.

---

## Deferred to Phase 3 Execution

1. **Organization UI**:
   - Organization switching dropdown in the navigation bar.
   - Member invitation and role management UI.
2. **Webhook-Driven Incremental CI**:
   - GitHub App webhook listener (`push` and `pull_request` events) automatically invoking the incremental analysis planner on commit.
3. **Advanced AST Graph Extractors**:
   - Expanding the TypeScript AST analyzer to extract full call graphs, type references, and database query schemas.
   - Adding Python (Tree-sitter or Ruff AST) and Go AST streaming analyzers.
