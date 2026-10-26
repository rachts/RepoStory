"use client";

import { Suspense } from "react";
import { useParams } from "next/navigation";
import { RepoAnalysis } from "@/components/RepoAnalysis";
import { RepoStoryIcon } from "@/components/RepoStoryBrand";

export default function AnalysisPage(): React.JSX.Element {
  return <Suspense fallback={<main className="analysis-page" role="status" aria-live="polite"><div className="state-card page-width progress-state"><RepoStoryIcon className="state-brand-icon" alt="RepoStory" size={64} /><p>Loading story…</p></div></main>}><AnalysisRoute /></Suspense>;
}

function AnalysisRoute(): React.JSX.Element {
  const params = useParams<{ analysisId: string }>();
  return <RepoAnalysis analysisId={params.analysisId} />;
}
