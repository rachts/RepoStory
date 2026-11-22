# Reliability Progress & Verification Tracker

Branch: `fix/analysis-reliability`

## Checklist

| Item | Description | Status | Commit Hash | Evidence / Notes |
|------|-------------|--------|-------------|-------------------|
| **Phase 1** | Pipeline stream error handling, watchdog, worker timeout, and heartbeats | Verified | `736546a`, `52f748c`, `342a7ca` | Phase 1 committed |
| **Item 0** | Phase 1 follow-up checks (null heartbeat fallback, no revival on failed, runner early-exit, socket cancel on watchdog, cleanup finally, unhandledRejection decision, browser E2E) | Verified | `42b6268` | All checks passed, unit tests added, ADR 008 created, browser E2E verified with 3 screenshots |
| **Fix 4** | Byte-level progress in `archive-extractor.ts` & `github-provider.ts` (content-length vs chunked curve, 45-60%) | Verified | `06cad30` | Monotonic 45-60% progress, chunked asymptotic curve, 1s throttle; screenshots: 11-phase2-progress-content-length.png, 12-phase2-progress-chunked.png |
| **Fix 5** | Polling cap & configurable timeout in `RepoAnalysis.tsx` with Retry CTA | Verified | `62ceeda` | 3m default cap, configurable via prop/env, 'Analysis timed out. Try again' with Retry CTA; screenshot: 13-phase2-polling-timeout-cta.png |
| **Fix 6** | `render.yaml` worker env vars with `sync: false`, update `DEPLOYMENT.md` (no plan change) | Verified | `b40b772` | All worker env vars aligned with code, sync: false set, DEPLOYMENT.md updated, valid YAML confirmed, plan sizing recommendations documented |
| **Fix 7** | Lower `MAX_HEAP_BYTES` to 350MB, yield event loop in AST parse loop | Verified | `4bdbb29` | Lowered DEFAULT_MAX_HEAP_BYTES to 350MB, yielded event loop every 10 files in AST loops via setImmediate; tested in tests/unit/ast-event-loop-yield.test.ts |
| **Fix 8** | Private-repo tokens encrypted (AES-GCM) in queue mode | Verified | `68fcfc4` | AES-256-GCM encryption for queue tokens, secure cacheStore fallback transport, zero token leak in logs/API; screenshot: 14-phase3-private-repo-authenticated.png |
| **Fix 9** | Pre-snapshot cache check in `pipeline.ts` with ref lookup | Verified | `347aa73` | Added resolveCommitSha, pre-snapshot cache check before getSnapshot; verified 0 tree/archive calls on cache hit in tests/unit/pre-snapshot-cache-lookup.test.ts |
| **Fix 10** | Persist remapped diagrams & preserve edits on cache hit | Verified | `6efc86b` | Remapped unique diagram IDs, saved to store & repository on cache hit, merged user edits from cacheStore, verified /api/analysis/[id]/diagrams > 0; screenshot: 15-phase4-cache-hit-diagrams.png |
| **Fix 11** | Jittered rate-limit backoff in GitHub dispatch without 100ms cap | Verified | `6e6f078` | Removed 100ms artificial cap, implemented full retry-after backoff with jitter, fast-failed with GITHUB_RATE_LIMITED on budget overflow; tested in tests/unit/github-rate-limit-backoff.test.ts |
| **Fix 12** | Atomic `createOrReuseJob` with unique constraint / ON CONFLICT, event wait in `waitForIdle` | Verified | `8546c80` | Created migration 007 partial unique index on active jobs, handled 409 conflict atomically, replaced sleep(0) busy-spin with event-driven idleWaiters; tested in tests/unit/atomic-job-dedup.test.ts |
| **Fix 13** | Last worker heartbeat in job status response, UI worker offline indicator | Verified | `be4547b` | Computed workerStatus ('active'/'offline'/'idle') and exposed heartbeatAt in GET /api/analyze/jobs/[jobId], added worker offline UI indicator, verified in tests/unit/worker-heartbeat-status.test.ts and Playwright browser test (screenshot: 16-phase5-worker-offline-indicator.png) |
| **Fix 14** | Frontend `diagramAvailability` reasons & structure fallback diagram | Verified | `dd8a1d6` | Surfaced diagramAvailability reasons in empty states with fallback defaults, added on-demand structure fallback diagram synthesized from repository findings paths, verified in tests/unit/diagram-availability-empty-state.test.tsx and Playwright browser test (screenshot: 17-phase5-diagram-fallback.png) |
| **0% Stuck Fix** | In-process execution in dev, queued job re-enqueue on resubmit, polling enqueue safeguard | Verified | `a8eece5` | Enabled in-process runner by default in dev/test, re-enqueued queued jobs on resubmit in POST /api/analyze, added polling enqueue self-healing safeguard in GET /api/analyze/jobs/[jobId], reduced stale queued timeout to 90s, verified with 327 passing tests and Playwright browser E2E (0% -> 100% -> rendered diagrams) |
| **AI Explanation Fix** | Robust sanitization, 6k token headroom, code fence cleaning & instant cached render | Verified | `d7a10c6` | Added sanitizeProjectExplanation for LLM output resilience (clamping strings, normalizing enums, defaulting arrays), cleaned markdown fences, boosted max_completion_tokens to 6,000, wired initialExplanation into ProjectExplanationPanel for instant render without re-clicking, verified with 329 passing tests and Playwright browser E2E (screenshot: 18-ai-explanation-rendered.png) |
| **Regression** | Final full-suite pass, multi-scenario browser verification & deployment runbook | Verified | Full Suite | 48 test suites passing (329 tests), 0 lint errors/warnings, typecheck & build:worker passing, Playwright browser test passing |

---

## Detailed Item Log & Evidence

### Setup
- Branch `fix/analysis-reliability` confirmed clean and synchronized with origin.
- Local verification environment configured.
- Mock GitHub server created under `scripts/mock-github-server.ts`.
- Non-production test base URL overrides added via `GITHUB_API_BASE_URL` and `GITHUB_CODELOAD_BASE_URL` in `github-url-builder.ts` and `github-provider.ts` (strictly ignored when `NODE_ENV === "production"`).

### Item 0: Phase 1 Follow-Up Checks & Browser E2E
- Null `heartbeat_at` fallback: confirmed and verified in `supabase-analysis-job-repository.ts`, `store.ts`, and `/api/analyze/jobs/[jobId]/route.ts`. Added unit tests in `tests/unit/stuck-job-recovery.test.ts` testing both fresh and stale updated_at with null heartbeat.
- Overwrite and revival protection: verified that a late-finishing worker cannot overwrite or revive a job marked `failed` by the sweeper, including inside `saveAnalysisResult` (which returns `false`). Added unit tests in `tests/unit/analysis-repository-overwrite.test.ts`.
- Runner early-exit: added `current.status === "failed"` early-exit check to `AnalysisJobRunner.runNow` so requeued terminal jobs are immediately ignored. Added unit test in `tests/unit/analysis-repository-overwrite.test.ts`.
- Watchdog socket cancellation & fresh timeout signal: verified `destroyAll()` in `archive-extractor.ts` cancels the reader/stream, and rethrow `ARCHIVE_DOWNLOAD_STALLED` in `github-provider.ts`.
- Cleanup in `finally` and fire-and-forget promise error handling: added `.catch(() => {})` across runner `onProgress`, `scheduleDrain`, `runWithSlot`, worker `startupSweep`, and `shutdown`.
- Process crash architecture: documented intentional `unhandledRejection` exit strategy given concurrency 2 in `docs/decisions/008-worker-error-handling.md`.
- Browser E2E verification:
  - Stalled archive download: watchdog triggered at 3s with `ARCHIVE_DOWNLOAD_STALLED`, UI rendered "The analysis stopped early." / `Archive download stalled: no data received for 3s.` with actionable Retry CTA. Verified clicking "Retry analysis" resets state to queued/fetching. Captured screenshots `08-phase1-stalled-download-error.png` and `09-phase1-stalled-download-retried.png`.
  - Worker killed mid-job: killed worker process mid-analysis, simulated stale heartbeat, verified polling route swept job to `failed` (`JOB_STALLED`, `retryable: true`), and UI reflected stopped state with Retry CTA. Captured screenshot `10-phase1-worker-killed-stalled.png`.

### Phase 2: Progress and UI
- **Fix 4**: Added monotonic byte-level and time-based progress curve (45% -> 60%) to `extractRepositoryArchive` with throttle rate of ~1/s. For archives with `Content-Length`, mapped ratio to 45-60%. For chunked archives without `Content-Length`, used asymptotic curve and byte factor, strictly capped at 60%. Tested both paths in `tests/unit/archive-extractor-reliability.test.ts`. Browser E2E verified with screenshots `11-phase2-progress-content-length.png` and `12-phase2-progress-chunked.png`.
- **Fix 5**: Implemented 3-minute polling timeout in `RepoAnalysis.tsx`, configurable via `maxPollingDurationMs` prop and `NEXT_PUBLIC_ANALYSIS_POLL_TIMEOUT_MS` env. Displays title "Analysis timed out. Try again" with message and actionable "Retry analysis" CTA button. Tested via component tests in `tests/component/repo-analysis.test.tsx` and browser E2E in `scripts/verify-phase2-browser-e2e.ts`. Captured screenshot `13-phase2-polling-timeout-cta.png`.

- **Fix 7**:
  - Defined `DEFAULT_MAX_HEAP_BYTES = 350 * 1024 * 1024` (350 MB) in `src/shared/limits.ts`.
  - Updated `src/infrastructure/streaming/archive-extractor.ts`, `src/infrastructure/providers/github-provider.ts`, and `.env.example` to default to 350 MB.
  - Implemented event loop yielding (`await new Promise((resolve) => setImmediate(resolve))`) every 10 files during AST parsing in `src/application/pipeline.ts` and `src/application/analysis/streaming-analyzer.ts`.
  - Added unit tests in `tests/unit/ast-event-loop-yield.test.ts` verifying that event loop turns and simulated worker heartbeat updates advance during AST parsing of 35+ files without starvation.
- **Fix 8**:
  - Created `src/infrastructure/jobs/job-token-registry.ts` implementing AES-256-GCM authenticated encryption/decryption with random 12-byte IV per payload, auth tag verification, and automatic TTL expiration.
  - Added unit tests in `tests/unit/job-token-encryption.test.ts` verifying correct decryption, wrong key rejection, tampered ciphertext/tag/IV rejection, production `CONFIG_ERROR` on missing secret key, and TTL expiration.
  - In `src/app/api/analyze/route.ts`, encrypted private repo tokens before enqueuing and stored in `cacheStore` under `job-token:<jobId>` with 15-minute TTL.
  - Added migration `supabase/migrations/006_job_queue_payload.sql` for queue payloads.
  - In `src/worker.ts` and `analysis-job-runner.ts`, decrypted token for authenticated GitHub requests and ensured tokens are deleted from both memory and `cacheStore` upon completion, failure, cancellation, or crash.
  - Fixed `github-provider.ts` so `isCodeload` only applies to archive stage, ensuring `authorization` headers are correctly sent on API metadata and contents requests.
  - Browser E2E verified in `scripts/verify-phase3-fix8-browser.ts`: successfully analyzed private repository with token in queue mode, verified UI renders completed diagrams, captured screenshot `14-phase3-private-repo-authenticated.png`, and confirmed ZERO raw token occurrences in stdout, stderr, or API responses.
- **Fix 6**:
  - Aligned all worker and web service environment variables in `render.yaml` with the exact keys consumed in code (`REPO_STORY_JOB_STORE`, `REPO_STORY_QUEUE_MODE`, `REPO_STORY_CACHE_STORE`, `SUPABASE_URL`, `SUPABASE_SECRET_KEY`, `GITHUB_TOKENS`, `GROQ_API_KEY`, `REPO_STORY_TOKEN_ENCRYPTION_KEY`, worker tuning parameters).
  - Explicitly marked all credential and secret variables with `sync: false` so secrets are never synced from git.
  - Allowed both `SUPABASE_SECRET_KEY` and `SUPABASE_SERVICE_ROLE_KEY` in `src/shared/config.ts` and `src/config/production-guards.ts` for maximum environment compatibility.
  - Updated `DEPLOYMENT.md` with complete environment variable specifications, security notes, and step-by-step Render deployment runbook.
  - Validated YAML syntax via Ruby YAML parser.
  - Sizing & Plan Recommendations: Render free web service plan has 512MB RAM and sleeps after 15 minutes of inbound HTTP inactivity. For production, persistent background worker requires at least 1 GB RAM (e.g. Starter/Standard plan) and no idle spindown, or a dedicated Background Worker service (`type: worker`). Retained `plan: free` in `render.yaml` to comply with guardrails (no plan changes that cost money).

- **Fix 9**:
  - Implemented lightweight `resolveCommitSha` in `src/infrastructure/providers/github-provider.ts` via GitHub commit ref API.
  - Added pre-snapshot cache check in `src/application/pipeline.ts` to query cache before calling `getSnapshot`.
  - Added unit tests in `tests/unit/pre-snapshot-cache-lookup.test.ts` verifying that cached analyses avoid tree and archive downloads completely.
- **Fix 10**:
  - Remapped unique diagram IDs on cache hits and persisted remapped diagrams to `repo_story_diagrams` and `analysisStore`.
  - Implemented `mergeDiagramEdits` in `src/application/diagram-edits.ts` to merge user customizations (labels, visibility, descriptions) into base diagrams.
  - Recorded diagram edits in `cacheStore` under `${owner}/${repo}@${commitSha}:diagram-edits` on `PATCH /api/diagrams/[diagramId]`.
  - Added fallback to `analysisStore` in `/api/analysis/[analysisId]/diagrams` and `/api/analysis/[analysisId]` if repository diagrams query is empty.
  - Verified with unit tests in `tests/unit/cache-diagram-persistence.test.ts` and automated browser E2E test in `scripts/verify-phase4-fix10-browser.ts` (screenshot: `15-phase4-cache-hit-diagrams.png`).
- **Fix 11**:
  - Removed artificial `Math.min(..., 100)` cap in `src/infrastructure/providers/github-provider.ts` `dispatch`.
  - Implemented jittered backoff based on `retry-after` header and `x-ratelimit-reset` epoch with full random jitter.
  - Checked backoff duration against active analysis budget: if backoff exceeds remaining analysis budget, fails fast immediately with retryable `GITHUB_RATE_LIMITED` AppError rather than sleeping past the deadline.
  - Added support for abort signal cancellation during backoff sleep.
  - Added unit tests in `tests/unit/github-rate-limit-backoff.test.ts` verifying full backoff without 100ms cap, budget overflow fail-fast, and signal cancellation.
- **Fix 12**:
  - Added PostgreSQL migration `supabase/migrations/007_atomic_jobs.sql` creating partial unique index `repo_story_jobs_active_unique_idx` on `(owner_id, cache_key)` for active jobs (`status in ('queued', 'fetching', 'analyzing', 'explaining')`).
  - Added race condition handling in `src/infrastructure/jobs/supabase-analysis-job-repository.ts` to re-query the winning active job on unique constraint conflict, guaranteeing atomic deduplication.
  - Added in-flight promise deduplication in `src/application/store.ts` for atomic deduplication in memory.
  - Replaced `sleep(0)` busy loop in `src/application/jobs/analysis-job-runner.ts` `waitForIdle` with an event-driven `idleWaiters` notification system that resolves cleanly without burning CPU ticks.
  - Verified with unit tests in `tests/unit/atomic-job-dedup.test.ts`.
- **Fix 13**:
  - Computed `workerStatus` (`'active' | 'offline' | 'idle'`) based on 40s heartbeat threshold in `GET /api/analyze/jobs/[jobId]`.
  - Exposed `heartbeatAt` (string or null) and `workerStatus` in the status JSON response.
  - Extended `AnalysisJobRecord` domain model with `workerStatus?: "active" | "offline" | "idle"`.
  - Added worker offline badge indicator in `ProgressState` (`src/components/RepoAnalysis.tsx`) and CSS styling in `src/app/globals.css`.
  - Added `waitForIdle()` on `JobWorker` to cleanly synchronize job processing lifecycle.
  - Verified with unit tests in `tests/unit/worker-heartbeat-status.test.ts`, component tests in `tests/component/repo-analysis.test.tsx`, and Playwright browser E2E test in `scripts/verify-phase5-fix13-browser.ts` (screenshot: `16-phase5-worker-offline-indicator.png`).
- **Fix 14**:
  - Surfaced `diagramAvailability` reasons in empty states (`StoryWithoutDiagram` and `StateCard`), pulling from `analysis.diagramAvailability`, `architectureStory.coverage.diagramAvailability`, or sensible default reasons.
  - Implemented `createStructureFallbackDiagram` in `RepoAnalysis.tsx` to synthesize a conservative repository structure diagram from findings paths when no specialized diagrams are available.
  - Added an interactive "Show repository structure fallback" CTA in empty states allowing users to load and explore the fallback diagram on demand.
  - Verified with unit tests in `tests/unit/diagram-availability-empty-state.test.tsx`, component tests in `tests/component/repo-analysis.test.tsx`, and Playwright browser E2E test in `scripts/verify-phase5-fix14-browser.ts` (screenshot: `17-phase5-diagram-fallback.png`).

### Final Regression Pass & Verification Summary
- **Typecheck**: Clean pass with `tsc --noEmit`.
- **Worker Build**: Clean pass with `tsc -p tsconfig.worker.json`.
- **Linter**: Zero errors and zero warnings across the entire repository with `eslint .`.
- **Test Suite**: 48 test suites passing (325 tests) with `vitest run`.
- **Browser Screenshot Artifacts (Saved to Artifacts Directory)**:
  - `08-phase1-stalled-download-error.png`: Stalled archive download error state with retry CTA.
  - `09-phase1-stalled-download-retried.png`: State after clicking retry analysis.
  - `10-phase1-worker-killed-stalled.png`: Worker process killed mid-job swept to failed with JOB_STALLED.
  - `11-phase2-progress-content-length.png`: Monotonic progress 45% -> 60% with content-length.
  - `12-phase2-progress-chunked.png`: Asymptotic chunked progress curve.
  - `13-phase2-polling-timeout-cta.png`: Polling timeout display with retry button.
  - `14-phase3-private-repo-authenticated.png`: Private repository analyzed in queue mode with zero token leak.
  - `15-phase4-cache-hit-diagrams.png`: Cache hit retrieving all diagrams and preserving edits.
  - `16-phase5-worker-offline-indicator.png`: Stale worker heartbeat (>40s) displaying "Worker offline" indicator.
  - `17-phase5-diagram-fallback.png`: Diagram availability reasons and rendered repository structure fallback diagram.
- **Deployment Runbook**: Documented in `DEPLOYMENT.md` and `render.yaml`.





