# Decision 003: GitHub Token Pool, Caching, and Resilience

## Status
Accepted

## Context
Upstream GitHub requests previously used a single `GITHUB_TOKEN`, had no rate-limit coordination across analyses, no circuit breaker to prevent cascading failures during rate-limit events, and re-fetched identical trees and files on every analysis run.

## Decision
1. Implement a `GitHubTokenPool` that supports multiple tokens via `GITHUB_TOKENS` (comma-separated). The pool tracks remaining quota per token via `x-ratelimit-remaining` and selects the token with the highest available capacity for each outbound request.
2. If no tokens are configured, log a single warning and fall back to anonymous access.
3. Introduce a per-job `GitHubCircuitBreaker` that trips after 3 consecutive rate-limit rejections (HTTP 429 or HTTP 403 secondary rate limits). When tripped, it halts downstream requests and fails the job with retryable error code `GITHUB_RATE_LIMITED` and a computed `retryAt` timestamp.
4. Add a `CacheStore` port with `InMemoryCacheStore` and `SupabaseCacheStore` adapters.
5. Cache tree entries and file contents with a 1-hour TTL keyed by `${owner}/${repo}@${commitSha}`. Re-analyzing the same commit makes zero content requests.

## Consequences
- Analyses can leverage multiple GitHub accounts/tokens to increase rate-limit capacity.
- Secondary and primary rate limits gracefully back off and fail predictably rather than hanging or hammering GitHub.
- Subsequent runs against identical commits return instantly without consuming GitHub API quota.
