# Decision 004: SSRF Defense, Manual Redirect Inspection, and Fixed Host Strategy

## Status
Accepted (Supersedes earlier `redirect: "error"` policy)

## Context
The architecture review flagged potential Server-Side Request Forgery (SSRF) vulnerabilities through `owner` and `repo` path construction in GitHub API calls. An earlier iteration applied `redirect: "error"`, which broke legitimate GitHub features:
1. GitHub issues HTTP 301 redirects for renamed or canonicalized repositories to their immutable internal ID endpoints (e.g. `https://api.github.com/repositories/10270250` for `facebook/react`).
2. GitHub issues HTTP 302 redirects from tarball archive endpoints to `codeload.github.com`.

With `redirect: "error"`, those legitimate GitHub workflows crashed. The redirect policy had to be refined to handle redirects manually with strict host and path validation.

## Decision
1. Apply defense-in-depth at the provider boundary using `buildSafeGitHubApiUrl`:
   - Every GitHub API URL is constructed using the `new URL()` API.
   - All `owner`, `repo`, `branch`, and path parameters are strictly encoded with `encodeURIComponent`.
   - The initial URL constructor validates that `url.hostname === "api.github.com"` and `url.pathname.startsWith("/repos/")`.

2. **Manual Redirect Inspection (`redirect: "manual"`)**:
   - Outbound requests across Octokit and raw streaming transports specify `redirect: "manual"`.
   - All 3xx redirect locations are inspected in an explicit dispatch loop with a strict hop cap: `maxRedirects = 3` (rejection with `REPOSITORY_INACCESSIBLE` if exceeded).
   - **Allowed Host Targets**:
     - `api.github.com` over HTTPS: permitted for canonical paths `/repos/`, `/repositories/`, and `/zen`.
     - `codeload.github.com` over HTTPS: permitted **exclusively** when `stage === "archive"`. Reaching `codeload.github.com` from any other endpoint or stage is rejected immediately.
     - Any other external host is unconditionally rejected with `REPOSITORY_INACCESSIBLE` ("GitHub redirected to an unauthorized external host.").
   - **Credential Hygiene**: When following redirects to `codeload.github.com`, the `Authorization` header is stripped to prevent token leakage and prevent CDN 404 rejections.

3. **Widened Path Allowlist (`/repositories/`)**:
   - GitHub's REST API internally references repositories by permanent integer ID under `/repositories/{id}` when an organization, owner, or repository has been renamed or aliased.
   - Allowing `/repositories/` on `api.github.com` does **not** widen SSRF exposure because:
     1. The protocol is pinned to HTTPS.
     2. The hostname is strictly validated to be `api.github.com`.
     3. User input cannot redirect traffic to internal IP ranges, metadata services, localhost, or unvetted hosts.

4. **IP-range blocking**:
   - CIDR filtering and private IP resolution are intentionally omitted because the API host is permanently fixed to vetted GitHub endpoints (`api.github.com` and `codeload.github.com`) and cannot be customized by user input.

## Consequences
- Path traversal, credential stuffing, homoglyph domain attacks, and URL injection are systematically prevented.
- Repositories that use GitHub canonical redirects (like `facebook/react`) complete cleanly.
- Bulk archive downloads from `codeload.github.com` function securely without SSRF risk or token leakage.
