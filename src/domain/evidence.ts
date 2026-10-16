export interface EvidenceReference {
  id: string;
  filePath: string;
  lineStart?: number;
  lineEnd?: number;
  symbol?: string;
  excerpt?: string;
  reason: string;
}
