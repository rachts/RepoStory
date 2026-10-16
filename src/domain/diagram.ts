import type { ConfidenceLevel } from "@/domain/finding";
import type { EvidenceReference } from "@/domain/evidence";

export type DiagramType = "repository-structure" | "system-overview";
export type DiagramDirection = "TB" | "LR" | "RL" | "BT";

export interface DiagramNode {
  id: string;
  technicalLabel: string;
  plainEnglishLabel: string;
  explanation: string;
  technicalDetail?: string;
  kind:
    | "person"
    | "frontend"
    | "backend"
    | "api"
    | "database"
    | "service"
    | "file"
    | "directory";
  visible: boolean;
  confidence: ConfidenceLevel;
  evidence: EvidenceReference[];
  position?: { x: number; y: number };
}

export interface DiagramEdge {
  id: string;
  source: string;
  target: string;
  label: string;
  explanation?: string;
  visible: boolean;
  confidence: ConfidenceLevel;
  evidence: EvidenceReference[];
}

export interface Diagram {
  id: string;
  analysisId: string;
  type: DiagramType;
  title: string;
  description: string;
  direction: DiagramDirection;
  nodes: DiagramNode[];
  edges: DiagramEdge[];
  customNote?: string;
  createdAt: string;
  updatedAt: string;
}
