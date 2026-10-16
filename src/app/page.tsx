export default function Home() {
  return (
    <main className="flex min-h-screen flex-col items-center justify-center px-6 py-16">
      <div className="w-full max-w-3xl rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-8 shadow-sm sm:p-12">
        <p className="mb-6 font-mono text-sm font-semibold uppercase tracking-[0.18em] text-[var(--accent)]">
          RepoStory / Phase 0
        </p>
        <h1 className="max-w-2xl text-4xl font-semibold tracking-tight sm:text-6xl">
          Turn any GitHub repository into a story people can understand.
        </h1>
        <p className="mt-6 max-w-2xl text-lg leading-8 text-[var(--muted)]">
          The foundation is ready for evidence-backed architecture and workflow
          diagrams, built for README files, presentations, and project
          explanations.
        </p>
        <div className="mt-10 flex flex-wrap items-center gap-3">
          <span className="rounded-full bg-[var(--accent-soft)] px-3 py-1 text-sm font-medium text-[var(--accent-strong)]">
            Strict TypeScript
          </span>
          <span className="rounded-full border border-[var(--border)] px-3 py-1 text-sm text-[var(--muted)]">
            Next.js App Router
          </span>
          <span className="rounded-full border border-[var(--border)] px-3 py-1 text-sm text-[var(--muted)]">
            Docker-ready
          </span>
        </div>
      </div>
      <p className="mt-6 text-sm text-[var(--muted)]">
        Phase 0 smoke route: <code className="font-mono">/api/health</code>
      </p>
    </main>
  );
}
