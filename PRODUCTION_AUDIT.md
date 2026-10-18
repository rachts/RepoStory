# RepoStory production audit

**Audit revision:** `2c4e87c`
**Audit date:** 2026-10-18
**Scope:** the complete `repo-story` application, including static analysis,
API routes, browser workflow, tests, dependency setup, and container packaging.

## Executive summary

RepoStory is a Next.js 16.4.2 / React 19.3.0 / TypeScript application that
turns public GitHub repository contents into evidence-backed architecture
diagrams. The audit found correctness, input-boundary, resource-exhaustion,
redaction, UI-state, and reproducibility issues. Those issues are fixed in the
current branch and covered by the existing unit, component, and browser tests.

The application is production-shaped for a trusted single-process deployment.
It is **not yet a public multi-user service**: analyses are process-local, there
is no authentication or ownership boundary, and upstream rate limiting is not
distributed. Those are explicit product limitations, not hidden assumptions.

## Main fixes

### Static-analysis correctness

- File filtering now uses UTF-8 byte counts and rejects malformed metadata,
  directory entries, unsafe paths, generated/dependency directories, and
  over-budget files.
- Extensionless analyzable files such as `Dockerfile`, `Makefile`, `go.mod`,
  and `Cargo.toml` are retained.
- Technology and entry-point detectors require file evidence instead of
  trusting a filename alone.
- Local module resolution preserves relative imports, resolves emitted `.js`
  specifiers to TypeScript sources, and chooses the most specific path alias.
- Express route detection supports nonstandard application variable names and
  inferred mount prefixes.
- Diagram and architecture-story generation preserve evidence and confidence,
  exclude hidden/unlinked elements, and sanitize Mermaid identifiers and labels.

### API and security boundaries

- JSON bodies are streamed with byte limits and malformed or oversized input
  maps to structured `400`/`413` responses.
- GitHub branches are validated against Git ref constraints before upstream
  requests are made.
- GitHub requests use a fixed API origin, `redirect: "error"`, `cache:
  "no-store"`, bounded response reads, strict tree-path validation, bounded
  content decoding, and bounded concurrency.
- Analysis and diagram responses are redacted and use `Cache-Control:
  no-store`.
- The process-local store has TTL/capacity bounds and prevents an evicted
  in-flight analysis from recreating jobs or diagrams.
- Next.js sends `nosniff`, same-origin framing/resource policies, a strict
  referrer policy, a restrictive permissions policy, and cross-origin opener
  isolation. The framework signature is disabled.

### Browser and deployment reliability

- Landing-page URL validation uses the same parser as the API, avoiding client/
  server contract drift.
- Analysis route changes abort stale requests and reset draft state.
- Diagram save, reset, export, undo/redo, loading, error, and accessibility
  states have regression coverage.
- Vitest uses the native ESM `vitest.config.mts` setup and no longer depends on
  the obsolete `vite-tsconfig-paths` package.
- The standalone Docker image binds to `0.0.0.0`, runs as a non-root user, and
  has a health check against `/api/health`.
- `.nvmrc`, `package-lock.json`, `Makefile`, `.env.example`, Dockerfile, and
  README setup/deployment instructions are present.

## Verification evidence

| Check | Result |
| --- | --- |
| `make test` | 10 test files, 109 tests passed |
| `make lint` | Passed |
| `make typecheck` | Passed |
| `make build` | Passed; standalone Next.js build generated |
| `npm run test:e2e` | 3 Chromium tests passed |
| `npm ci --dry-run --ignore-scripts` | Passed |
| `npm audit --omit=dev --audit-level=high` | 0 production vulnerabilities |
| Production server smoke | `/api/health` returned `200`, `no-store`, and security headers |
| `git diff --check` | Passed |
| Docker build | Not run: Docker CLI is unavailable in this environment |

The local machine used Node `v25.8.0`; the project pins Node `22.14.0` in
`.nvmrc` and the Dockerfile. The exact pinned runtime should be exercised in CI
or Docker before release.

## Remaining release gates

1. **Do not expose this as a shared public service without an ownership
   boundary.** Add authentication, per-user analysis ownership, authorization
   on analysis/diagram IDs, and durable storage before multi-user deployment.
2. **Add an external rate limiter and reverse proxy.** The in-process active
   analysis cap protects one process only and is not a distributed abuse
   control.
3. **Build and run the Docker image in CI or the target environment.** The
   committed Dockerfile is structurally ready, but this workstation has no
   Docker CLI.
4. **Resolve the development-only audit advisory when upstream fixes it.** A
   full `npm audit` reports the unresolved `braces` advisory through
   `eslint-config-next`; `npm audit --omit=dev` is clean. `npm audit fix
   --force` would downgrade the Next.js ESLint configuration and is therefore
   intentionally not used.

## Production-shaped deployment

```bash
nvm use
npm ci
cp .env.example .env.local
npm run build
npm run start
```

For the container path:

```bash
docker build --tag repo-story:local .
docker run --rm --publish 3000:3000 --env-file .env.local repo-story:local
curl --fail --show-error http://localhost:3000/api/health
```

The full setup, API reference, security model, test commands, and limitations
are documented in `README.md`.
