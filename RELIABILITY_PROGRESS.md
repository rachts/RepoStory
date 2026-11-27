# Reliability Progress & Verification Tracker

Branch: `fix/analysis-reliability`

## Master Checklist

| Item | Description | Status | Commit Hash | Test Names | Screenshot Paths (in `audit-evidence/`) | Note |
|------|-------------|--------|-------------|------------|----------------------------------------|------|
| **Fix 1** | Stream pipeline error forwarding & codeload archive download watchdog | Verified | `736546a` | `tests/unit/archive-extractor-reliability.test.ts` | `audit-evidence/08-phase1-stalled-download-error.png`, `audit-evidence/09-phase1-stalled-download-retried.png` | Fixed unhandled undici body timeout by forwarding pipeline errors and cancelling sockets after 15s inactivity. |
| **Fix 2** | Worker per-job execution timeout budget enforcement | Verified | `52f748c` | `tests/unit/worker-execution-reliability.test.ts` | No UI surface (background worker process execution) | Added AbortController timeout signal ensuring workers abort gracefully before deadline instead of hanging. |
| **Fix 3** | Heartbeat-driven stuck job sweeper & retryable expiration | Verified | `342a7ca` | `tests/unit/stuck-job-recovery.test.ts` | `audit-evidence/10-phase1-worker-killed-stalled.png` | Replaced 10-minute wall-clock timeout with 40s heartbeat check, allowing long analyses with active workers. |
| **Item 0** | Phase 1 follow-ups (null heartbeat fallback, no revival, idempotent sweeper, socket cancel) | Verified | `42b6268`, `4e8030b` | `tests/unit/worker-crash-handler.test.ts`, `tests/unit/analysis-repository-overwrite.test.ts`, `tests/unit/stuck-job-recovery.test.ts` | `audit-evidence/10-phase1-worker-killed-stalled.png` | Fallback to `updated_at`, worker crash await, sweeper race prevention with conditional UPDATE RETURNING. |
| **Fix 4** | Monotonic byte-level archive progress reporting (45% -> 60%) | Verified | `06cad30` | `tests/unit/archive-extractor-reliability.test.ts` | `audit-evidence/11-phase2-progress-content-length.png`, `audit-evidence/12-phase2-progress-chunked.png` | Content-length ratio mapping and asymptotic curve for chunked streams with 1s throttling. |
| **Fix 5** | Configurable polling cap (3m default) and retry CTA in frontend UI | Verified | `62ceeda` | `tests/component/repo-analysis.test.tsx` | `audit-evidence/13-phase2-polling-timeout-cta.png` | Replaced infinite polling spinner with 'Analysis timed out. Try again' card and active Retry CTA. |
| **Fix 6** | `render.yaml` worker environment variables with `sync: false` & deployment runbook | Verified | `b40b772` | YAML syntax check & deployment configuration audit | No UI surface (infrastructure configuration) | Aligned all worker env vars with code, marked sensitive credentials `sync: false`, and updated `DEPLOYMENT.md`. |
| **Fix 7** | Lower `MAX_HEAP_BYTES` to 350MB & yield event loop during AST parsing | Verified | `4bdbb29` | `tests/unit/ast-event-loop-yield.test.ts` | No UI surface (in-process engine & memory management) | Default heap reduced to 350MB; `setImmediate` yields every 10 files to keep worker heartbeats healthy. |
| **Fix 8** | Private repository tokens passed via AES-256-GCM encryption in queue mode | Verified | `68fcfc4` | `tests/unit/job-token-encryption.test.ts` | `audit-evidence/14-phase3-private-repo-authenticated.png` | Encrypted token payloads with random IV per job; zero credentials leaked in logs, DB, or API responses. |
| **Fix 9** | Pre-snapshot cache check via lightweight commit SHA ref lookup | Verified | `347aa73` | `tests/unit/pre-snapshot-cache-lookup.test.ts` | No UI surface (backend pipeline optimization) | Lightweight ref query resolves commit SHA and checks cache before fetching tree or downloading tarball. |
| **Fix 10** | Remap diagrams on cache hit & merge preserved user customizations | Verified | `6efc86b` | `tests/unit/cache-diagram-persistence.test.ts` | `audit-evidence/15-phase4-cache-hit-diagrams.png` | Generates unique diagram IDs for new analysis runs and preserves user edits across cache hits. |
| **Fix 11** | Jittered rate-limit backoff without 100ms cap & fail-fast on budget overflow | Verified | `6e6f078` | `tests/unit/github-rate-limit-backoff.test.ts` | No UI surface (network retry & backoff engine) | Respects `retry-after` and `x-ratelimit-reset` with 0-20% jitter; aborts early if delay exceeds remaining budget. |
| **Fix 12** | Atomic `createOrReuseJob` with unique constraint & event-driven idle wait | Verified | `8546c80` | `tests/unit/atomic-job-dedup.test.ts` | No UI surface (concurrency and DB locking) | Migration 007 partial unique index prevents race conditions; replaced busy-spin with event-driven wait. |
| **Fix 13** | Expose worker heartbeat status & display worker offline indicator | Verified | `be4547b` | `tests/unit/worker-heartbeat-status.test.ts`, `tests/component/repo-analysis.test.tsx` | `audit-evidence/16-phase5-worker-offline-indicator.png` | Surfaces `workerStatus` ('active'/'offline'/'idle') and shows non-blocking status pill when worker is stalled. |
| **Fix 14** | Surface diagram availability reasons & synthesize structure fallback diagram | Verified | `dd8a1d6` | `tests/unit/diagram-availability-empty-state.test.tsx`, `tests/component/repo-analysis.test.tsx` | `audit-evidence/17-phase5-diagram-fallback.png` | Explains missing diagram types clearly and provides on-demand synthesized directory structure diagram. |
| **Item 2** | AI explanation schema normalizer, single retry, cut-off detection & neutral UI fallback | Verified | `802a9b4` | `tests/unit/sanitize-json-response.test.ts`, `tests/unit/ai-explanation-normalize.test.ts`, `tests/unit/ai-explanation.test.ts`, `tests/component/project-explanation-panel.test.tsx` | `audit-evidence/18-ai-explanation-rendered.png`, `audit-evidence/19-ai-explanation-neutral-fallback.png`, `audit-evidence/20-weathergpt-ai-explanation-rendered.png` | Strips markdown fences, normalizes bounds, clamps integers, fixes enums, retries once on schema error, neutral notice for retryable AI errors. |
| **Next.js 16** | Migrate `middleware.ts` to `proxy.ts`, enforce literal segment configs, remove non-standard route exports | Verified | `ee2e9de` | `tests/unit/security-headers.test.ts`, `tests/unit/job-enqueue-guard.test.ts`, `tests/unit/limits-and-duration.test.ts` | No UI surface (framework file conventions & build optimization) | Converted deprecated `middleware.ts` to `proxy.ts`, made `export const maxDuration = 60` literal, moved custom exports out of `route.ts`. |

---

## AI Explanation Diagnostic Report (Item 2)

- **Configured Model**: `openai/gpt-oss-120b` (confirmed in `STRICT_STRUCTURED_OUTPUT_MODELS` and `.env.local`).
- **Observed Mode**: `strict-json-schema` (no provider 400/422 rejection on initial schema submission, no downgrade to `json-object-fallback`).
- **Root Cause Classification**: **Branch A (Bound Violations under Strict Mode)**.
  - In repositories without explicit security/authentication controls (such as `WEATHERGPT`), the model produced an empty string `""` for `securityAndAuthentication.plainEnglish`.
  - Because `toGroqSchema()` removes `minLength: 1` before sending schema to Groq, Groq accepted the empty string, but Zod rejected it with `too_small`.
  - Additionally, Groq's multi-turn completion endpoint validates assistant messages against the strict JSON Schema, causing multi-turn retry with the failing assistant message to be rejected with 400 `json_validate_failed`.
- **Fix Applied**:
  1. Updated system prompt with explicit instructions for empty sections: `"If a section has no supporting evidence, leave its array empty or describe the uncertainty in knownLimitations. If security or authentication controls were not confirmed in the repository, describe that status in securityAndAuthentication.plainEnglish. Never return empty strings, keep prose concise, at most 10 evidence IDs per item."`
  2. Refactored corrective retry in `src/infrastructure/ai/groq-client.ts`: appends the correction note (`failingFields` paths and issue codes only) to the user message instead of passing an unvalidated assistant message, preventing Groq's 400 rejection.
  3. Enforced `remainingBudgetMs > config.timeoutMs * 0.4` condition before attempting a retry.
  4. Exported `normalizeExplanationCandidate` in `src/domain/ai-explanation-normalize.ts` and `src/domain/ai-explanation.ts`.
  5. Preserved graceful neutral UI fallback (`.is-neutral`) and active "Try again" CTA for transient AI errors, keeping red error styles strictly for config/auth issues.
- **Tests**:
  - `tests/unit/sanitize-json-response.test.ts` (7 tests)
  - `tests/unit/ai-explanation-normalize.test.ts` (11 tests)
  - `tests/unit/ai-explanation.test.ts` (13 tests)
  - `tests/component/project-explanation-panel.test.tsx` (6 tests)
- **Browser Verification**:
  - Live rendering on `https://github.com/rachts/WEATHERGPT` verified: title rendered as `"WEATHERGPT"`, summary rendered, diagrams interactive, zero error banner.
  - Screenshot: `audit-evidence/20-weathergpt-ai-explanation-rendered.png`.
- **Groq API Calls Used**: 3 calls (budget: $\le 10$).

---

## Blocked Items
- **None.** All 16 items (Phase 1, Item 0, Fixes 4–14, and Item 2) are completed, fully tested, and verified.

---

## Decisions Needed
- **Render Worker Service Sizing**: Render's free web service tier spins down after 15 minutes of inactivity and has a 512MB RAM cap. For production deployments with continuous queue processing, a dedicated Render Background Worker service (`type: worker`) with at least 1GB RAM is recommended.

---

## Production Rollout Order

To ensure zero downtime and prevent race conditions across distributed components, deploy in this strict sequence:

1. **Step 1: Database Migrations**
   - Execute PostgreSQL migrations:
     - `supabase/migrations/006_job_queue_payload.sql` (adds payload column for encrypted tokens and options).
     - `supabase/migrations/007_atomic_jobs.sql` (creates partial unique index `repo_story_jobs_active_unique_idx` on `(owner_id, cache_key)` for active jobs).
   - *Verification*: Confirm index creation via `\d repo_story_jobs` or Supabase dashboard.

2. **Step 2: Deploy Background Worker**
   - Deploy the updated worker build (`npm run build:worker`, running `dist/worker.js`).
   - Configure worker environment variables in `render.yaml` (or Render dashboard):
     - `REPO_STORY_JOB_STORE=supabase`
     - `REPO_STORY_CACHE_STORE=supabase`
     - `REPO_STORY_QUEUE_MODE=queue`
     - `REPO_STORY_TOKEN_ENCRYPTION_KEY` (32-byte hex key for AES-256-GCM)
     - `SUPABASE_URL`, `SUPABASE_SECRET_KEY`
     - `GROQ_API_KEY`, `GITHUB_TOKENS`
   - *Verification*: Verify worker logs show startup sweep, clean connection, and active heartbeats.

3. **Step 3: Deploy Web Application**
   - Deploy Next.js web application (`npm run build`).
   - Configure web service environment variables matching `render.yaml`.
   - *Verification*: Run end-to-end browser smoke test verifying:
     - New analysis submission transitions smoothly from 0% -> 100%.
     - Interactive diagrams render with node exploration.
     - Evidence-backed AI explanation renders without schema errors.
     - Stalled jobs or transient AI provider issues render neutral, retryable CTAs.
