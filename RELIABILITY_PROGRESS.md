# Reliability Progress & Verification Tracker

Branch: `fix/analysis-reliability`

## Checklist

| Item | Description | Status | Commit Hash | Evidence / Notes |
|------|-------------|--------|-------------|-------------------|
| **Phase 1** | Pipeline stream error handling, watchdog, worker timeout, and heartbeats | Verified | `736546a`, `52f748c`, `342a7ca` | Phase 1 committed |
| **Item 0** | Phase 1 follow-up checks (null heartbeat fallback, no revival on failed, runner early-exit, socket cancel on watchdog, cleanup finally, unhandledRejection decision, browser E2E) | Verified | Pending commit | All checks passed, unit tests added, ADR 008 created, browser E2E verified with 3 screenshots |
| **Fix 4** | Byte-level progress in `archive-extractor.ts` & `github-provider.ts` (content-length vs chunked curve, 45-60%) | Todo | | |
| **Fix 5** | Polling cap & configurable timeout in `RepoAnalysis.tsx` with Retry CTA | Todo | | |
| **Fix 6** | `render.yaml` worker env vars with `sync: false`, update `DEPLOYMENT.md` (no plan change) | Todo | | |
| **Fix 7** | Lower `MAX_HEAP_BYTES` to 350MB, yield event loop in AST parse loop | Todo | | |
| **Fix 8** | Private-repo tokens encrypted (AES-GCM) in queue mode | Todo | | |
| **Fix 9** | Pre-snapshot cache check in `pipeline.ts` with ref lookup | Todo | | |
| **Fix 10** | Persist remapped diagrams & preserve edits on cache hit | Todo | | |
| **Fix 11** | Jittered rate-limit backoff in GitHub dispatch without 100ms cap | Todo | | |
| **Fix 12** | Atomic `createOrReuseJob` with unique constraint / ON CONFLICT, event wait in `waitForIdle` | Todo | | |
| **Fix 13** | Last worker heartbeat in job status response, UI worker offline indicator | Todo | | |
| **Fix 14** | Frontend `diagramAvailability` reasons & structure fallback diagram | Todo | | |
| **Regression** | Final full-suite pass, multi-scenario browser verification & deployment runbook | Todo | | |

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

