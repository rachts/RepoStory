"use client";

import { FormEvent, useState } from "react";
import { useRouter } from "next/navigation";
import { parseGitHubUrl } from "@/infrastructure/providers/github-url";
import { RepoStoryBrand, RepoStoryIcon } from "@/components/RepoStoryBrand";

const exampleRepository = "https://github.com/facebook/react";

function validateRepositoryUrl(value: string): string {
  const parsed = parseGitHubUrl(value);
  if (parsed.ok) return "";
  if (parsed.error.code === "UNSUPPORTED_HOST") return "Paste a public github.com repository URL.";
  if (parsed.error.message.includes("invalid URL encoding")) return "The repository URL contains invalid URL encoding.";
  if (parsed.error.message === "Invalid URL.") return "Enter a valid GitHub URL, such as https://github.com/owner/repo.";
  return "Use a repository URL or an optional /tree/{branch} URL.";
}

export default function Home(): React.JSX.Element {
  const router = useRouter();
  const [url, setUrl] = useState("");
  const [error, setError] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);

  const submit = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    const validationError = validateRepositoryUrl(url);
    setError(validationError);
    if (validationError) return;
    setIsSubmitting(true);
    try {
      const response = await fetch("/api/analyze", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ repositoryUrl: url.trim() }),
      });
      if (!response.ok) {
        const payload = (await response.json().catch(() => null)) as { error?: { message?: string } } | null;
        throw new Error(payload?.error?.message ?? "The repository could not be analyzed.");
      }
       const payload = (await response.json()) as { jobId?: string };
       if (!payload.jobId) throw new Error("The analysis response was incomplete.");
       router.push(`/analysis/${encodeURIComponent(payload.jobId)}`);
    } catch (submissionError) {
      setError(submissionError instanceof Error ? submissionError.message : "Something went wrong. Try again.");
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <main className="landing-page">
      <header className="site-header page-width">
        <RepoStoryBrand />
        <span className="header-note"><span className="status-dot" /> Evidence-backed repository stories</span>
      </header>

      <section className="hero page-width">
        <div className="hero-copy">
          <RepoStoryIcon className="hero-brand-icon" alt="RepoStory" />
          <p className="eyebrow"><span className="eyebrow-line" /> Repository intelligence</p>
          <h1>Make your codebase <em>make sense.</em></h1>
          <p className="hero-lede">RepoStory turns a public GitHub repository into a clear, evidence-backed story your whole team can follow.</p>
          <form className="repo-form" onSubmit={submit} noValidate aria-busy={isSubmitting}>
            <label htmlFor="repository-url">Public GitHub repository URL</label>
            <div className={`input-row ${error ? "has-error" : ""}`}>
              <span className="input-prefix" aria-hidden="true">↗</span>
              <input id="repository-url" type="url" value={url} onChange={(event) => { setUrl(event.target.value); setError(""); }} placeholder="https://github.com/owner/repository" disabled={isSubmitting} aria-invalid={Boolean(error)} aria-describedby={error ? "repository-url-error" : "repository-url-hint"} />
              <button className="primary-button" type="submit" disabled={isSubmitting}>{isSubmitting ? <><span className="spinner" /> Reading…</> : <>Tell the story <span>→</span></>}</button>
            </div>
            {error ? <p id="repository-url-error" className="form-error" role="alert"><span aria-hidden="true">!</span>{error}</p> : <p id="repository-url-hint" className="form-hint">Public repositories only · No token required</p>}
          </form>
          <button className="example-link" type="button" onClick={() => setUrl(exampleRepository)}>Try an example <span>↗</span></button>
        </div>
        <div className="hero-visual" role="img" aria-label="Abstract repository map illustration">
          <div className="orbit orbit-one" /><div className="orbit orbit-two" />
          <div className="map-card map-card-main"><span className="map-icon">✦</span><strong>your-repository</strong><small>system overview</small></div>
          <div className="map-card map-card-frontend"><span className="map-icon blue">◒</span><strong>frontend</strong><small>components / routes</small></div>
          <div className="map-card map-card-data"><span className="map-icon orange">▦</span><strong>data layer</strong><small>models / persistence</small></div>
          <div className="map-node node-a" /><div className="map-node node-b" /><div className="map-node node-c" />
          <svg className="map-lines" viewBox="0 0 440 360" aria-hidden="true"><path d="M220 180 C220 112 112 105 82 72" /><path d="M220 180 C300 120 350 137 362 102" /><path d="M220 180 C180 250 120 282 95 312" /><path d="M220 180 C286 235 340 263 372 300" /></svg>
        </div>
      </section>

      <section className="steps page-width" aria-labelledby="how-it-works"><div className="section-rule" /><p className="eyebrow" id="how-it-works"><span className="eyebrow-line" /> From repository to story</p><div className="step-grid"><Step number="01" title="Point to a repo" body="Share a public GitHub URL. We read the structure, not your secrets." /><Step number="02" title="We find the signal" body="Files, entry points, technologies, and connections become evidence." /><Step number="03" title="Get the story" body="Explore diagrams in technical detail or plain English, then take them with you." /></div></section>
      <footer className="site-footer page-width"><span>Built for clarity</span></footer>
    </main>
  );
}

function Step({ number, title, body }: { number: string; title: string; body: string }): React.JSX.Element {
  return <article className="step"><span className="step-number">{number}</span><h2>{title}</h2><p>{body}</p></article>;
}
