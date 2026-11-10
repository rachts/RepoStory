# Decision 001: Queue Backend Architecture

## Status
Accepted

## Context
Analysis jobs were previously held in memory (`AnalysisJobRunner` in-process `Set`/`Map`), meaning queued and running jobs were lost whenever the server process restarted, and the system could not scale horizontally across multiple instances or separate worker processes.

## Decision
1. Define a `JobQueue` port in `application/jobs/` defining a durable state machine (`queued → running → succeeded | failed | cancelled`), heartbeats, and worker leasing.
2. Implement `SupabaseJobQueue` (backed by PostgreSQL using `FOR UPDATE SKIP LOCKED` and RPCs) as the production default adapter.
3. Implement `InMemoryJobQueue` strictly for local development and unit tests. In production (`NODE_ENV=production`), `InMemoryJobQueue` and `InMemoryAnalysisStore` refuse initialization unless explicitly overridden via `ALLOW_IN_MEMORY_QUEUE=true` and `ALLOW_IN_MEMORY_STORE=true`.
4. Provide a standalone worker entrypoint (`src/worker.ts`, script `worker`, `Procfile`) for background queue processing.
5. Inactive/dead workers are detected via a configurable heartbeat timeout (default 2 minutes), allowing orphan jobs to be automatically reclaimed by healthy workers without losing state.

## Consequences
- Analyses can scale horizontally across multiple stateless worker processes.
- Process crashes or restarts do not drop jobs; uncompleted jobs are reclaimed and retried.
- Production requires a durable store (Supabase PostgreSQL), preventing accidental loss of customer work.
