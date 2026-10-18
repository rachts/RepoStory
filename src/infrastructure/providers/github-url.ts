import { AppError } from "@/domain/errors";
import type { RepositoryReference } from "@/domain/repository";
import { err, ok, type Result } from "@/shared/result";

const INVALID_REPOSITORY_URL = "Expected https://github.com/{owner}/{repository}[/tree/{branch}].";
const MAX_BRANCH_BYTES = 255;

function invalidUrl(message = "Invalid GitHub repository URL."): Result<RepositoryReference, AppError> {
  return err(new AppError({ code: "INVALID_URL", message }));
}

function extractRawPath(input: string): string {
  const schemeEnd = input.indexOf("://");
  const authorityStart = schemeEnd + 3;
  const pathStart = input.indexOf("/", authorityStart);
  if (pathStart === -1) return "/";
  const suffix = input.slice(pathStart);
  const queryOrFragment = suffix.search(/[?#]/);
  return queryOrFragment === -1 ? suffix : suffix.slice(0, queryOrFragment);
}

function hasTraversalSegment(segment: string): boolean {
  if (segment === "." || segment === "..") return true;

  let candidate = segment;
  for (let attempt = 0; attempt < 2 && candidate.includes("%"); attempt += 1) {
    let decoded: string;
    try {
      decoded = decodeURIComponent(candidate);
    } catch {
      return false;
    }
    if (decoded === candidate) return false;
    candidate = decoded;
    if (candidate === "." || candidate === "..") return true;
  }
  return false;
}

export function validateGitHubBranch(branch: string): Result<string, AppError> {
  if (typeof branch !== "string" || branch.length === 0) {
    return err(new AppError({ code: "INVALID_BRANCH", message: "GitHub branch names cannot be empty." }));
  }

  if (Buffer.byteLength(branch, "utf8") > MAX_BRANCH_BYTES) {
    return err(new AppError({ code: "INVALID_BRANCH", message: "GitHub branch names cannot exceed 255 bytes." }));
  }

  const segments = branch.split("/");
  if (branch.includes("\\") || /[\u0000-\u001f\u007f?#]/.test(branch) || branch.includes("..") || segments.some((segment) => segment.length === 0 || hasTraversalSegment(segment))) {
    return err(new AppError({ code: "INVALID_BRANCH", message: "GitHub branch names cannot contain empty or traversal segments." }));
  }
  return ok(branch);
}

export function parseGitHubUrl(input: string): Result<RepositoryReference, AppError> {
  try {
    const rawInput = typeof input === "string" ? input.trim() : "";
    const url = new URL(rawInput);
    if (url.username || url.password || url.search || url.hash || rawInput.includes("?") || rawInput.includes("#")) {
      return invalidUrl("Repository URLs cannot include credentials, queries, or fragments.");
    }
    if (url.protocol !== "https:" || url.hostname.toLowerCase() !== "github.com" || url.port) {
      return err(new AppError({ code: "UNSUPPORTED_HOST", message: "Only https://github.com repositories are supported." }));
    }

    let decodedPath: string;
    try {
      decodedPath = decodeURIComponent(extractRawPath(rawInput));
    } catch {
      return invalidUrl("Repository URL contains invalid URL encoding.");
    }
    if (!decodedPath.startsWith("/") || decodedPath.includes("\\")) return invalidUrl(INVALID_REPOSITORY_URL);

    const parts = decodedPath.split("/");
    if (parts[0] === "") parts.shift();
    if (parts.length === 3 && parts[2] === "") parts.pop();
    if (parts.length < 2 || parts.some((part) => part.length === 0 || hasTraversalSegment(part))) return invalidUrl(INVALID_REPOSITORY_URL);

    const [owner, rawName, kind] = parts;
    const name = rawName?.replace(/\.git$/, "");
    if (!owner || !name || (parts.length > 2 && (kind !== "tree" || parts.length < 4))) return invalidUrl(INVALID_REPOSITORY_URL);

    if (parts.length === 2) {
      return ok<RepositoryReference>({ owner, name, url: `https://github.com/${encodeURIComponent(owner)}/${encodeURIComponent(name)}` });
    }

    const branchResult = validateGitHubBranch(parts.slice(3).join("/"));
    if (!branchResult.ok) return invalidUrl(branchResult.error.message);
    return ok<RepositoryReference>({ owner, name, branch: branchResult.value, url: `https://github.com/${encodeURIComponent(owner)}/${encodeURIComponent(name)}` });
  } catch {
    return invalidUrl("Invalid URL.");
  }
}
