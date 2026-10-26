"use client";

import { useRef, useState } from "react";
import type { ProjectExplanation } from "@/domain/ai-explanation";
import type { EvidenceReference } from "@/domain/evidence";
import { explainProject, ExplainProjectError } from "@/lib/api/explain-project";

interface ProjectExplanationPanelProps {
  analysisId: string;
  evidenceById: ReadonlyMap<string, EvidenceReference>;
}

type ExplanationState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "success"; explanation: ProjectExplanation; model: string }
  | { status: "error"; message: string; code: string; expired: boolean; unavailable: boolean; retryable: boolean };

export function ProjectExplanationPanel({ analysisId, evidenceById }: ProjectExplanationPanelProps): React.JSX.Element {
  const [state, setState] = useState<ExplanationState>({ status: "idle" });
  const requestId = useRef(0);

  const requestExplanation = async (force = false): Promise<void> => {
    const currentRequest = requestId.current + 1;
    requestId.current = currentRequest;
    setState({ status: "loading" });
    try {
      const response = await explainProject(analysisId, undefined, force);
      if (requestId.current !== currentRequest) return;
      setState({ status: "success", explanation: response.explanation, model: response.model });
    } catch (error) {
      if (requestId.current !== currentRequest) return;
      const normalized = error instanceof ExplainProjectError ? error : new ExplainProjectError({ code: "AI_EXPLANATION_FAILED", message: "The project explanation could not be generated.", status: 500, retryable: true });
      setState({
        status: "error",
        message: normalized.message,
        code: normalized.code,
        expired: normalized.code === "ANALYSIS_NOT_FOUND",
        unavailable: !normalized.retryable && normalized.code !== "ANALYSIS_NOT_FOUND",
        retryable: normalized.retryable,
      });
    }
  };

  return <section className="project-explanation-panel page-width" aria-labelledby="project-explanation-heading" aria-busy={state.status === "loading"}>
    <div className="project-explanation-header">
      <div>
        <p className="eyebrow"><span className="eyebrow-line" /> AI explanation</p>
        <h2 id="project-explanation-heading">Make the project easier to explain</h2>
        <p>Groq translates the verified static findings into simple language. It does not discover architecture independently or execute the repository.</p>
      </div>
      {state.status !== "success" ? <button className="primary-button project-explanation-action" onClick={() => void requestExplanation(state.status === "error" && state.retryable)} disabled={state.status === "loading" || state.status === "error" && (state.expired || state.unavailable)}>{state.status === "loading" ? "Reading the project structure…" : state.status === "error" && state.retryable && !state.expired ? "Try again" : "Explain this project"}</button> : <span className="project-explanation-ready">Evidence-backed explanation</span>}
    </div>
    {state.status === "idle" ? <p className="project-explanation-hint">Your diagrams remain available immediately while this optional explanation is generated.</p> : null}
    {state.status === "loading" ? <div className="project-explanation-loading" role="status" aria-live="polite"><span className="spinner" aria-hidden="true" /> Reading the project structure…</div> : null}
    {state.status === "error" ? <div className={`project-explanation-feedback ${state.unavailable || state.expired ? "is-neutral" : "is-error"}`} role={state.unavailable || state.expired ? "status" : "alert"}><strong>{state.expired ? "This analysis has expired." : state.unavailable ? "AI explanation is unavailable." : "The deterministic analysis is still available."}</strong><p>{state.expired ? "Analyze the repository again to create a fresh explanation." : state.message}</p>{state.unavailable ? <p>Deterministic analysis and diagrams remain available.</p> : null}</div> : null}
    {state.status === "success" ? <ExplanationContent explanation={state.explanation} evidenceById={evidenceById} model={state.model} /> : null}
  </section>;
}

function ExplanationContent({ explanation, evidenceById, model }: { explanation: ProjectExplanation; evidenceById: ReadonlyMap<string, EvidenceReference>; model: string }): React.JSX.Element {
  return <div className="project-explanation-content">
    <div className="project-explanation-summary">
      <div>
        <p className="explanation-label">Project summary</p>
        <h3 className="explanation-summary-title">{explanation.projectSummary.title}</h3>
        <p>{explanation.projectSummary.oneSentence}</p>
        <ConfidenceBadge value={explanation.projectSummary.confidence} />
        <EvidenceReferences ids={explanation.projectSummary.evidenceIds} evidenceById={evidenceById} />
      </div>
      <div>
        <p className="explanation-label">In plain English</p>
        <p>{explanation.projectSummary.plainEnglish}</p>
      </div>
    </div>

    <ExplanationSection title="How the project is organized" intro={explanation.architectureAtAGlance.plainEnglish}>
      {explanation.architectureAtAGlance.layers.length ? <ExplanationList items={explanation.architectureAtAGlance.layers.map((item) => ({ heading: item.simpleName, body: `${item.purpose} ${item.name !== item.simpleName ? `Technical name: ${item.name}.` : ""}`, evidenceIds: item.evidenceIds, confidence: item.confidence }))} evidenceById={evidenceById} /> : null}
      <EvidenceReferences ids={explanation.architectureAtAGlance.evidenceIds} evidenceById={evidenceById} />
    </ExplanationSection>

    {explanation.mainComponents.length ? <ExplanationSection title="Main parts" intro="These are the repository-backed pieces that carry the application’s work."><ExplanationList items={explanation.mainComponents.map((item) => ({ heading: item.simpleName, body: `${item.whatItDoes} ${item.whyItMatters}`, meta: item.location, evidenceIds: item.evidenceIds, confidence: item.confidence }))} evidenceById={evidenceById} /></ExplanationSection> : null}
    {explanation.howTheSystemWorks.length ? <ExplanationSection title="How the system works" intro="This follows the supported path through the analyzed repository. It does not add generic steps that were not found."><ExplanationList items={explanation.howTheSystemWorks.slice().sort((left, right) => left.step - right.step).map((item) => ({ heading: `${item.step}. ${item.title}`, body: `${item.plainEnglish} ${item.technicalDetail}`, evidenceIds: item.evidenceIds, confidence: item.confidence }))} evidenceById={evidenceById} /></ExplanationSection> : null}
    {explanation.userJourney.length ? <ExplanationSection title="A user journey" intro="Only user-facing steps supported by the supplied actors, routes, or components are shown."><ExplanationList items={explanation.userJourney.slice().sort((left, right) => left.step - right.step).map((item) => ({ heading: `${item.step}. ${item.title}`, body: item.plainEnglish, meta: [...item.relatedRoutes, ...item.relatedComponents].join(" · "), evidenceIds: item.evidenceIds }))} evidenceById={evidenceById} /></ExplanationSection> : null}
    {explanation.technologyGuide.length ? <ExplanationSection title="Technology, translated" intro="Technical names are kept intact, with their role explained in everyday language."><ExplanationList items={explanation.technologyGuide.map((item) => ({ heading: item.simpleName, body: `${item.whatItIs} ${item.roleInThisProject}`, meta: item.technology, evidenceIds: item.evidenceIds, confidence: item.confidence }))} evidenceById={evidenceById} /></ExplanationSection> : null}
    {explanation.apiGuide.length ? <ExplanationSection title="API and request entry points" intro="These routes are included only when the deterministic analysis found endpoint evidence."><ExplanationList items={explanation.apiGuide.map((item) => ({ heading: `${item.method} ${item.route}`, body: `${item.simplePurpose} ${item.requestFlow}`, evidenceIds: item.evidenceIds, confidence: item.confidence }))} evidenceById={evidenceById} /></ExplanationSection> : null}
    {explanation.dataAndIntegrations.length ? <ExplanationSection title="Data and connected services" intro="The repository evidence shows these storage or service boundaries."><ExplanationList items={explanation.dataAndIntegrations.map((item) => ({ heading: item.name, body: item.simplePurpose, meta: item.type, evidenceIds: item.evidenceIds, confidence: item.confidence }))} evidenceById={evidenceById} /></ExplanationSection> : null}

    <ExplanationSection title="Security and access" intro={explanation.securityAndAuthentication.plainEnglish}>
      {explanation.securityAndAuthentication.confirmedControls.length ? <div className="explanation-bullet-group"><p className="explanation-label">Confirmed controls</p><ul>{explanation.securityAndAuthentication.confirmedControls.map((item) => <li key={item}>{item}</li>)}</ul></div> : null}
      {explanation.securityAndAuthentication.unknowns.length ? <div className="explanation-bullet-group"><p className="explanation-label">Not confirmed</p><ul>{explanation.securityAndAuthentication.unknowns.map((item) => <li key={item}>{item}</li>)}</ul></div> : null}
      <ConfidenceBadge value={explanation.securityAndAuthentication.confidence} />
      <EvidenceReferences ids={explanation.securityAndAuthentication.evidenceIds} evidenceById={evidenceById} />
    </ExplanationSection>

    {explanation.glossary.length ? <ExplanationSection title="Technical glossary" intro="Short definitions for terms that may be unfamiliar."><dl className="explanation-glossary">{explanation.glossary.map((item) => <div key={item.technicalTerm}><dt>{item.technicalTerm}</dt><dd><strong>{item.simpleMeaning}</strong><span>{item.projectSpecificMeaning}</span></dd></div>)}</dl></ExplanationSection> : null}

    <div className="project-explanation-footer">
      <div><p className="explanation-label">What could not be confirmed</p>{explanation.knownLimitations.length ? <ul>{explanation.knownLimitations.map((item) => <li key={item}>{item}</li>)}</ul> : <p>No additional limitations were returned beyond the deterministic evidence boundary.</p>}</div>
      <div><p className="explanation-label">Confidence and provenance</p><p>{explanation.confidenceNote}</p><small>Generated with {model}</small></div>
    </div>
  </div>;
}

function ExplanationSection({ title, intro, children }: { title: string; intro: string; children: React.ReactNode }): React.JSX.Element {
  return <section className="project-explanation-block" aria-labelledby={`explanation-${title.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`}><p className="explanation-label">{title}</p><h3 id={`explanation-${title.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`} className="explanation-section-title">{title}</h3><p className="explanation-section-intro">{intro}</p>{children}</section>;
}

interface ExplanationListItem {
  heading: string;
  body: string;
  meta?: string;
  evidenceIds: string[];
  confidence?: string;
}

function ExplanationList({ items, evidenceById }: { items: ExplanationListItem[]; evidenceById: ReadonlyMap<string, EvidenceReference> }): React.JSX.Element {
  return <div className="explanation-list">{items.map((item) => <article key={`${item.heading}-${item.body}`}><div className="explanation-card-heading"><h4>{item.heading}</h4>{item.confidence ? <ConfidenceBadge value={item.confidence} /> : null}</div><p>{item.body}</p>{item.meta ? <small className="explanation-card-meta">{item.meta}</small> : null}<EvidenceReferences ids={item.evidenceIds} evidenceById={evidenceById} /></article>)}</div>;
}

function ConfidenceBadge({ value, hidden = false }: { value: string; hidden?: boolean }): React.JSX.Element | null {
  if (hidden) return null;
  const label = value === "needs-verification" ? "Needs verification" : `${value.charAt(0).toUpperCase()}${value.slice(1)} confidence`;
  return <span className={`explanation-confidence confidence-${value}`}>{label}</span>;
}

function EvidenceReferences({ ids, evidenceById }: { ids: string[]; evidenceById: ReadonlyMap<string, EvidenceReference> }): React.JSX.Element | null {
  const uniqueIds = [...new Set(ids)];
  if (!uniqueIds.length) return null;
  return <details className="explanation-evidence"><summary>Evidence references ({uniqueIds.length})</summary><ul>{uniqueIds.map((id) => { const evidence = evidenceById.get(id); return <li key={id}>{evidence ? <><strong>{evidence.filePath}{evidence.lineStart ? `:${evidence.lineStart}` : ""}</strong><span>{evidence.reason}</span></> : <code>{id}</code>}</li>; })}</ul></details>;
}
