import type { EvidenceReference } from "@/domain/evidence";

export type ConfidenceLevel =
  | "high"
  | "medium"
  | "low"
  | "needs-verification";

export type FindingKind =
  | "technology"
  | "directory"
  | "entry-point"
  | "module"
  | "integration"
  | "route"
  | "database"
  | "frontend"
  | "backend";

export interface AnalysisFinding {
  id: string;
  kind: FindingKind;
  technicalLabel: string;
  plainEnglishLabel: string;
  explanation: string;
  technicalDetail?: string;
  confidence: ConfidenceLevel;
  evidence: EvidenceReference[];
}
