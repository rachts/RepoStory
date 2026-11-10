import { buildSafeGitHubApiUrl } from "@/infrastructure/providers/github-url-builder";
import type { RepositoryFile } from "@/domain/repository";

export interface CompareApiResponse {
  status: string;
  ahead_by: number;
  behind_by: number;
  total_commits: number;
  files?: Array<{
    filename: string;
    status: "added" | "modified" | "removed" | "renamed";
    previous_filename?: string;
    sha?: string;
  }>;
}

export interface IncrementalAnalysisPlan {
  reusableFiles: RepositoryFile[];
  changedPathsToFetch: string[];
  deletedPaths: string[];
}

export function isIncrementalAnalysisEnabled(): boolean {
  return process.env.INCREMENTAL_ANALYSIS_ENABLED === "true";
}

export async function planIncrementalAnalysis(
  owner: string,
  repo: string,
  baseCommitSha: string,
  headCommitSha: string,
  previousFiles: RepositoryFile[],
  fetchImpl: typeof fetch = fetch,
): Promise<IncrementalAnalysisPlan> {
  if (!isIncrementalAnalysisEnabled()) {
    return {
      reusableFiles: [],
      changedPathsToFetch: [],
      deletedPaths: [],
    };
  }

  const compareUrl = buildSafeGitHubApiUrl(
    owner,
    repo,
    `compare/${encodeURIComponent(baseCommitSha)}...${encodeURIComponent(headCommitSha)}`,
  );

  const res = await fetchImpl(compareUrl.toString(), {
    headers: { Accept: "application/vnd.github+json" },
  });

  if (!res.ok) {
    // If compare fails, fallback to full fetch
    return {
      reusableFiles: [],
      changedPathsToFetch: [],
      deletedPaths: [],
    };
  }

  const data = (await res.json()) as CompareApiResponse;
  const changedPathsToFetch: string[] = [];
  const deletedPaths: string[] = [];

  for (const file of data.files || []) {
    if (file.status === "removed") {
      deletedPaths.push(file.filename);
    } else if (file.status === "added" || file.status === "modified" || file.status === "renamed") {
      changedPathsToFetch.push(file.filename);
      if (file.previous_filename) {
        deletedPaths.push(file.previous_filename);
      }
    }
  }

  const deletedSet = new Set(deletedPaths);
  const changedSet = new Set(changedPathsToFetch);

  const reusableFiles = previousFiles.filter(
    (f) => !deletedSet.has(f.path) && !changedSet.has(f.path),
  );

  return {
    reusableFiles,
    changedPathsToFetch,
    deletedPaths,
  };
}
