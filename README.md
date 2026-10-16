# RepoStory

RepoStory turns public GitHub repositories into evidence-backed stories that
are easier to explain to clients, investors, product teams, and students.

This repository currently contains **Phase 0**: the Next.js foundation, design
tokens, test tooling, Docker configuration, and initial domain contracts. GitHub
ingestion, static analysis, diagrams, and exports are intentionally not
implemented yet.

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

`GITHUB_TOKEN` is optional during Phase 0. It must never be committed.

## Development

```bash
npm run dev
```

Open <http://localhost:3000>.

The Phase 0 health route is available at:

```text
GET http://localhost:3000/api/health
```

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
types live under `src/domain`. Future implementation layers are reserved under
`src/application`, `src/analysis`, `src/infrastructure`, `src/shared`, and
`src/composition`.

The approved first vertical slice will use synchronous bounded analysis for
small public repositories. `AnalysisJob` already models future asynchronous
states, but Phase 1 will not start unawaited background work.

## Deployment

RepoStory is hosting-provider neutral. Any Docker-compatible host can run the
image produced by the Docker commands above. Configure environment variables
through the host's secret manager rather than committing them to the project.
