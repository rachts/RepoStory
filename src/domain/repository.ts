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

export interface RepositoryReference {
  owner: string;
  name: string;
  branch?: string;
  url: string;
}

export interface RepositorySnapshot {
  repository: Repository;
  files: RepositoryFile[];
}

export interface RepositoryProvider {
  getSnapshot(reference: RepositoryReference, signal?: AbortSignal): Promise<import("@/shared/result").Result<RepositorySnapshot, import("@/domain/errors").AppError>>;
}
