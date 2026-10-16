import type { Diagram } from "@/domain/diagram";

export type ExportFormat = "mermaid" | "markdown";

export interface ExportRequest {
  diagramId: string;
  format: ExportFormat;
  includeExplanation: boolean;
  includeEvidence: boolean;
  includeAttribution: boolean;
}

export interface ExportedArtifact {
  id: string;
  diagramId: string;
  format: ExportFormat;
  filename: string;
  content: string;
  mimeType: string;
}

export interface MarkdownExportOptions {
  includeExplanation: boolean;
  includeEvidence: boolean;
  includeAttribution: boolean;
}

export interface MermaidSource {
  diagram: Diagram;
  source: string;
}
