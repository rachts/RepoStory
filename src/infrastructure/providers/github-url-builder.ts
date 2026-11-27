import { AppError } from "@/domain/errors";

function getApiBaseUrl(): string {
  if (process.env.NODE_ENV !== "production" && process.env.GITHUB_API_BASE_URL) {
    return process.env.GITHUB_API_BASE_URL.replace(/\/+$/, "");
  }
  return "https://api.github.com";
}

/**
 * Builds and strictly validates GitHub API URLs.
 * Defense-in-depth: enforces that host is always api.github.com (or test override) and path begins with /repos/.
 */
export function buildSafeGitHubApiUrl(
  pathOrOwner: string,
  repo?: string,
  pathSuffix = "",
  searchParams?: Record<string, string>,
): URL {
  const base = getApiBaseUrl();
  let url: URL;

  if (repo === undefined) {
    // Single path mode (e.g. buildSafeGitHubApiUrl("/zen"))
    if (pathOrOwner.includes("://") || pathOrOwner.startsWith("//")) {
      throw new AppError({
        code: "INVALID_URL",
        message: "Path must not contain a scheme or authority.",
        retryable: false,
      });
    }
    const rawPath = pathOrOwner.startsWith("/") ? pathOrOwner : `/${pathOrOwner}`;
    try {
      url = new URL(`${base}${rawPath}`);
    } catch {
      throw new AppError({
        code: "INVALID_URL",
        message: "Failed to construct valid GitHub API URL.",
        retryable: false,
      });
    }
  } else {
    // Standard owner/repo mode
    const encodedOwner = encodeURIComponent(pathOrOwner);
    const encodedRepo = encodeURIComponent(repo);
    const cleanSuffix = pathSuffix.startsWith("/") ? pathSuffix : (pathSuffix ? `/${pathSuffix}` : "");

    try {
      url = new URL(`${base}/repos/${encodedOwner}/${encodedRepo}${cleanSuffix}`);
    } catch {
      throw new AppError({
        code: "INVALID_URL",
        message: "Failed to construct valid GitHub API URL.",
        retryable: false,
      });
    }
  }

  const expectedHost = new URL(base).hostname.toLowerCase();
  if (url.hostname.toLowerCase() !== expectedHost) {
    throw new AppError({
      code: "INVALID_URL",
      message: `Target host must be ${expectedHost}.`,
      retryable: false,
    });
  }

  if (!url.pathname.startsWith("/repos/") && !url.pathname.startsWith("/repositories/") && url.pathname !== "/zen") {
    throw new AppError({
      code: "INVALID_URL",
      message: "Target pathname must start with /repos/, /repositories/, or be /zen.",
      retryable: false,
    });
  }

  if (searchParams) {
    for (const [key, value] of Object.entries(searchParams)) {
      url.searchParams.set(key, value);
    }
  }

  return url;
}
