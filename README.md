# RepoStory

RepoStory turns public GitHub repositories into evidence-backed stories that
are easier to explain to clients, investors, product teams, and students.

This repository contains **Phase 3**: bounded public GitHub or fixture
ingestion, deterministic technology/directory/entry-point analysis, API route
and module-relationship detection, database and external-service evidence,
authentication evidence, redacted file-backed evidence, Mermaid/Markdown
exports, repository/system/API/authentication diagrams, an in-memory store,
synchronous API routes, and an interactive React Flow results workspace.

Generated diagrams can now be edited temporarily in the browser. Title,
description, notes, labels, explanations, visibility, and direction changes are
validated by the server and saved in the process-local store. Undo, redo, reset,
and evidence-preserving exports are included.

## Requirements

- Node.js `22.14.0` (see `.nvmrc`)
- npm 11+
- Docker, optional for local container verification

## Setup

```bash
git clone <repository-url>
cd repo-story
nvm use
npm ci
cp .env.example .env.local
```

`GITHUB_TOKEN` is optional for public GitHub ingestion and only raises API rate
limits. It must never be committed.

## Development

```bash
npm run dev
```

Open <http://localhost:3000>.

The health route is available at:

```text
GET http://localhost:3000/api/health
```

Analysis and diagram routes include:

```text
POST /api/analyze
GET  /api/analysis/:id
GET  /api/analysis/:id/diagrams
GET  /api/diagrams/:id
POST /api/exports
PATCH /api/diagrams/:id
POST /api/diagrams/:id/reset
```

`GET /api/analysis/:id` returns the completed `AnalysisJob` together with
Phase 3 evidence collections when present: `apiRoutes`,
`moduleRelationships`, `databases`, `externalIntegrations`, and
`authentication`. It also returns `diagramAvailability`, which explains why a
diagram was omitted when the repository does not contain enough evidence.

The pipeline never executes repository code. Route, module, database,
integration, and authentication findings are inferred from bounded file
content, package manifests, and local import resolution. A route whose method
cannot be proven is reported as `UNKNOWN` with `needs-verification` confidence.

Supported generated diagrams are:

- Repository structure
- System overview
- API request flow
- Authentication flow

The last two are generated only when the corresponding evidence exists. The
fixture provider supports the repositories under
`fixtures/repositories/`, making the Phase 3 analysis suite runnable offline.

## Checks

The single offline-capable test command is:

```bash
make test
```

Individual checks:

```bash
npm run lint
npm run typecheck
npm test -- --run
npm run build
npm run test:e2e
```

The default unit test suite uses fixtures and does not require network access
or GitHub credentials.

## Docker

Build and run the production image:

```bash
docker build -t repo-story .
docker run --rm -p 3000:3000 repo-story
```

The image uses the pinned Node.js `22.14.0` Alpine runtime and runs the
Next.js production server.

## Architecture

The application uses a Next.js App Router shell with strict TypeScript. Domain
types live under `src/domain`. The synchronous analysis pipeline is composed
from replaceable repository providers, deterministic analyzers, evidence
collection, diagram generators, and an in-memory store under
`src/application`, `src/analysis`, `src/infrastructure`, `src/shared`, and
`src/composition`.

The approved vertical slice uses synchronous bounded analysis for small public
repositories. `AnalysisJob` already models future asynchronous states, but the
current pipeline does not start unawaited background work.

The current store is process-local and intended for local or trusted single-user
use. This phase does not provide authentication, session ownership, or
cross-worker persistence. Configure `REPO_STORY_MAX_ANALYSES` and
`REPO_STORY_ANALYSIS_TTL_MS` to bound in-memory retention.

## Deployment

RepoStory is hosting-provider neutral. Any Docker-compatible host can run the
image produced by the Docker commands above, but multi-user public deployment
requires an authentication and ownership boundary that is outside this phase.
Configure environment variables through the host's secret manager rather than
committing them to the project.
