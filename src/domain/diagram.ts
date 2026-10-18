import type { ConfidenceLevel } from "@/domain/finding";
import type { EvidenceReference } from "@/domain/evidence";

export type DiagramType =
  | "repository-structure"
  | "system-overview"
  | "api-request-flow"
  | "authentication-flow";
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
  /** Inferred relationships render as dashed lines in visual and Mermaid views. */
  inferred?: boolean;
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

export interface DiagramPatch {
  title?: string;
  description?: string;
  direction?: DiagramDirection;
  customNote?: string;
  nodeUpdates?: Array<{
    nodeId: string;
    technicalLabel?: string;
    plainEnglishLabel?: string;
    explanation?: string;
    visible?: boolean;
  }>;
  edgeUpdates?: Array<{
    edgeId: string;
    label?: string;
    explanation?: string;
    visible?: boolean;
  }>;
}
