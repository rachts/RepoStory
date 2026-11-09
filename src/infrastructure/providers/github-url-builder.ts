import { AppError } from "@/domain/errors";

/**
 * Builds and strictly validates GitHub API URLs.
 * Defense-in-depth: enforces that host is always api.github.com and path begins with /repos/.
 */
export function buildSafeGitHubApiUrl(
  pathOrOwner: string,
  repo?: string,
  pathSuffix = "",
  searchParams?: Record<string, string>,
): URL {
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
      url = new URL(`https://api.github.com${rawPath}`);
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
      url = new URL(`https://api.github.com/repos/${encodedOwner}/${encodedRepo}${cleanSuffix}`);
    } catch {
      throw new AppError({
        code: "INVALID_URL",
        message: "Failed to construct valid GitHub API URL.",
        retryable: false,
      });
    }
  }

  if (url.hostname.toLowerCase() !== "api.github.com") {
    throw new AppError({
      code: "INVALID_URL",
      message: "Target host must be api.github.com.",
      retryable: false,
    });
  }

  if (!url.pathname.startsWith("/repos/") && url.pathname !== "/zen") {
    throw new AppError({
      code: "INVALID_URL",
      message: "Target pathname must start with /repos/ or be /zen.",
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
