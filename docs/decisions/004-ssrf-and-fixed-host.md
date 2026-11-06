# Decision 004: SSRF Defense and Fixed Host Strategy

## Status
Accepted

## Context
The architecture review flagged potential Server-Side Request Forgery (SSRF) vulnerabilities through `owner` and `repo` path construction in GitHub API calls.

## Investigation Finding
Inspection of `parseGitHubUrl` in `src/infrastructure/providers/github-url.ts` confirmed that the application already strictly validates incoming URLs:
- It enforces `protocol === "https:"` and `hostname === "github.com"`.
- It rejects credentials (`username`/`password`), query strings (`?`), and hash fragments (`#`).
- It checks for path traversal segments (`..`, `%2e%2e`, `%2F`), backslashes, and null bytes in path segments.
Therefore, the practical SSRF risk was significantly lower than the review suggested.

## Decision
1. Apply defense-in-depth at the provider boundary using `buildSafeGitHubApiUrl`:
   - Every GitHub API URL is constructed using the `new URL()` API.
   - All `owner`, `repo`, `branch`, and path parameters are strictly encoded with `encodeURIComponent`.
   - The URL constructor validates that `url.hostname === "api.github.com"` and `url.pathname.startsWith("/repos/")`.
   - Outbound requests specify `redirect: "error"` and refuse cross-origin redirects.
     - **Reconciliation with spec (`redirect: "error"` superseding `redirect: 'manual'`)**: The review proposed `redirect: 'manual'` and inspecting redirects. In implementation, `redirect: "error"` is strictly stronger and applied consistently across all GitHub calls (including Octokit and health probes). It commands the HTTP transport to treat 3xx redirects as hard errors and abort the connection without following them, eliminating redirect-based host escapes. Additionally, any 3xx response encountered with a cross-host `Location` header is actively intercepted and rejected with `REPOSITORY_INACCESSIBLE`.
2. IP-range blocking (CIDR filtering / private IP resolution) is intentionally **not** implemented because the API host is permanently fixed to `api.github.com` and cannot be customized by user input. Adding DNS resolution hooks and IP filtering would introduce latency and complexity without providing additional security value for a fixed public SaaS endpoint.

## Consequences
- Path traversal, credential stuffing, homoglyph domain attacks, and URL injection are systematically prevented.
- All outbound repository requests are guaranteed to target `https://api.github.com/repos/...`.
