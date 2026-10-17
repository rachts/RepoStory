"use client";

import { Suspense } from "react";
import { useParams } from "next/navigation";
import { RepoAnalysis } from "@/components/RepoAnalysis";

export default function AnalysisPage(): React.JSX.Element {
  return <Suspense fallback={<div className="state-card page-width progress-state"><p>Loading story…</p></div>}><AnalysisRoute /></Suspense>;
}

function AnalysisRoute(): React.JSX.Element {
  const params = useParams<{ analysisId: string }>();
  return <RepoAnalysis analysisId={decodeURIComponent(params.analysisId)} />;
}
