export interface Repository {
  id: string;
  owner: string;
  name: string;
  url: string;
  defaultBranch: string;
  selectedBranch: string;
  description?: string;
  sizeBytes: number;
  fileCount: number;
}

export interface RepositoryFile {
  path: string;
  type: "file" | "directory";
  sizeBytes?: number;
  language?: string;
  content?: string;
  isAnalyzable: boolean;
  exclusionReason?: string;
}
