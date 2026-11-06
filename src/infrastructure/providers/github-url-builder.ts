import { AppError } from "@/domain/errors";

/**
 * Builds and strictly validates GitHub API URLs.
 * Defense-in-depth: enforces that host is always api.github.com and path begins with /repos/.
 */
export function buildSafeGitHubApiUrl(
  owner: string,
  repo: string,
  pathSuffix = "",
  searchParams?: Record<string, string>,
): URL {
  const encodedOwner = encodeURIComponent(owner);
  const encodedRepo = encodeURIComponent(repo);
  const cleanSuffix = pathSuffix.startsWith("/") ? pathSuffix : (pathSuffix ? `/${pathSuffix}` : "");

  let url: URL;
  try {
    url = new URL(`https://api.github.com/repos/${encodedOwner}/${encodedRepo}${cleanSuffix}`);
  } catch {
    throw new AppError({
      code: "INVALID_URL",
      message: "Failed to construct valid GitHub API URL.",
      retryable: false,
    });
  }

  if (url.hostname.toLowerCase() !== "api.github.com") {
    throw new AppError({
      code: "INVALID_URL",
      message: "Target host must be api.github.com.",
      retryable: false,
    });
  }

  if (!url.pathname.startsWith("/repos/")) {
    throw new AppError({
      code: "INVALID_URL",
      message: "Target pathname must start with /repos/.",
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
