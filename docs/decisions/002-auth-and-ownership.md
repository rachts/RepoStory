# Decision 002: Authentication, Authorization, and Quotas

## Status
Accepted

## Context
Previously, ownership of analyses and diagrams was anchored purely to an opaque cookie (`ownerIdFromRequest`). There was no user identity, no quota enforcement, and read routes could inadvertently expose analyses across users if the durable job record was missing.

## Decision
1. Integrate NextAuth / Auth.js with GitHub OAuth (`/api/auth/[...nextauth]`).
2. Feature flag anonymous usage (`ANONYMOUS_ANALYSIS_ENABLED`). In production, anonymous analyses are disabled by default (`ANONYMOUS_ANALYSIS_ENABLED=false`). When disabled, unauthenticated calls to `/api/analyze`, `/api/jobs/*`, `/api/analysis/*`, and `/api/diagrams/*` return `401 Unauthorized`.
3. Ownership is derived from the verified session (or bearer/proxy header), never client-supplied parameters.
4. On first login, any jobs previously owned by the valid anonymous session cookie are migrated to the authenticated user ID and logged (`[Auth Migration]`).
5. Enforce per-user daily quotas (default 5 analyses per UTC day, configured via `ANALYSIS_DAILY_QUOTA`). Exceeding returns `429 Too Many Requests` with a calculated `Retry-After` header matching the time until 00:00 UTC.
6. Enforce strict ownership on every read: accessing another user's job, analysis, diagram, or export returns `404 Not Found` (never `403`) to avoid leaking resource existence.
7. Supabase database tables include Row-Level Security (RLS) policies keyed on `owner_id`.

## Consequences
- Multi-user isolation is enforced at the API, application, and database layers.
- Resource existence cannot be probed by malicious actors.
- Abuse via repeated large repository analysis is constrained by per-user daily limits.
