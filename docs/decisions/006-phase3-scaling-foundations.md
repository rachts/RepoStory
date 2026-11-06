# Decision Record 006: Phase 3 Scaling Foundations (RBAC, Incremental Analysis, Streaming AST)

## Status
Accepted

## Context
RepoStory is transitioning from a prototype tool to a production-grade multi-tenant platform. To ensure horizontal scalability, multi-user collaboration, and efficient resource usage on large monorepos, foundational architecture for Phase 3 must be laid early without disrupting current Phase 2 capabilities.

## Decisions

### 1. Multi-Tenant Organizations & RBAC
- Defined `organizations` and `organization_memberships` relational tables with roles:
  - `viewer`: Read-only access to organization repositories, analyses, and diagrams.
  - `analyst`: Ability to submit new repositories for analysis and generate architecture stories.
  - `admin`: Full administration including membership management and billing.
- Scoped `analysis_jobs` and `analysis_diagrams` with an optional `org_id` column, allowing personal analyses (unscoped) to coexist with organization-owned repositories.
- Service layer (`OrganizationService`) enforces permission checks before triggering analysis or mutating diagrams.

### 2. Incremental Analysis Architecture
- Recorded `commitSha` and per-file `blobShas` within analysis results.
- Added a feature-flagged compare workflow (`INCREMENTAL_ANALYSIS_ENABLED`):
  - Queries GitHub's `GET /repos/{owner}/{repo}/compare/{base}...{head}`.
  - Determines added, modified, renamed, and deleted files.
  - Re-uses unchanged repository files and findings directly from the previous analysis cache, eliminating redundant GitHub content requests and analysis cycles.

### 3. Streaming Static Analysis
- Defined a `StreamingAnalyzer` interface consuming `AsyncIterable<RepositoryFile>` to prevent unbounded heap allocations on large repositories.
- Implemented `HeuristicStreamingAnalyzer` for low-latency rule-based detection.
- Implemented `TypeScriptAstStreamingAnalyzer` using the TypeScript compiler API to parse ASTs incrementally and detect framework entry points, Supabase clients, and routing structures without loading full repository trees into memory.

### 4. Load Testing
- Added `load/analyze.k6.js` and `load/autocannon.js` to benchmark end-to-end throughput under concurrent job submissions and status polling.
