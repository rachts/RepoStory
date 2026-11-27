# 008. Worker Crash and Error Handling Strategy

## Status
Accepted

## Context
RepoStory runs background repository analysis via an asynchronous worker process (`src/worker.ts`), polling jobs with a configurable concurrency limit (default: 2). The worker executes long-running CPU and I/O tasks, including AST parsing, tarball streaming, and external API requests.

In Node.js, an `unhandledRejection` or `uncaughtException` signals an unexpected failure mode where application state or heap invariants may be corrupted. If a process catches an `unhandledRejection` and continues running when concurrency is greater than 1:
1. The corrupted memory or broken async flow can contaminate the second concurrently running job or any subsequent jobs.
2. Sockets, file descriptors, or timers may remain leaked or half-open.
3. The root cause becomes masked, causing silent data corruption or stalled jobs.

## Decision
1. **Process-Level Crash Guards**:
   - For both `uncaughtException` and `unhandledRejection`, the worker captures active job IDs (`activeJobIds`).
   - It performs an explicit asynchronous write (`failActiveJobsOnCrash`) to update active jobs in the database to `failed` (`WORKER_CRASHED` or `JOB_STALLED`, `retryable: true`) and marks the corresponding queue entries as failed so they can be reclaimed or retried.
   - Once the terminal state writes complete (or a short crash write timeout elapses), the process deliberately terminates via `process.exit(1)`.
2. **Container Orchestrator Supervised Restart**:
   - Process supervisors (such as Render, Docker, Kubernetes, or systemd) are configured to automatically restart the worker container on non-zero exit codes.
   - Upon restart, the worker's `startupSweep()` inspects any orphaned or stalled jobs and restores system invariants.
3. **Idempotent Job Completion & Anti-Revival Guards**:
   - The worker and `AnalysisJobRunner` verify job status before saving results (`saveAnalysisResult`) and before marking a job `completed`. If a sweeper marked the job `failed` or `cancelled` while the worker was processing, the runner abandons the write to prevent revived zombie jobs.
   - A job already in `failed` or `cancelled` state will immediately early-exit if re-queued.

## Consequences
- Guaranteed fail-fast behavior without lingering state contamination across concurrent tasks.
- Stuck jobs are promptly marked retryable in the database and surfaced to users with actionable retry CTAs.
- Clean process restarts ensure healthy memory and connection pools for all subsequent analyses.
