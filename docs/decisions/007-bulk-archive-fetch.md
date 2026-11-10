# Decision 007: Bulk Repository Content Retrieval via Tarball Archive Streaming

## Status
Accepted

## Context
RepoStory originally fetched individual repository files via GitHub's Contents API (`GET /repos/{owner}/{repo}/contents/{path}`). In large repositories or monorepos (such as `facebook/react`), this resulted in thousands of HTTP requests per analysis (e.g. 2,507 requests for `facebook/react`). Even with concurrent worker pools and high timeouts, this architecture caused:
1. Severe rate-limit exhaustion (burning half of a user's 5,000 requests/hour quota on a single run).
2. Analysis timeouts (timing out at 120s before finishing file retrieval).
3. Upstream 500/503 errors and cascading rate-limiting.

## Options Considered

### 1. Git Blob Fetching by Tree SHA (`GET /repos/{owner}/{repo}/git/blobs/{file_sha}`)
- **Rejected**: While fetching blobs avoids base64 JSON envelope overhead in some paths, it is still inherently a per-file HTTP request model. A repository with 2,000 files still requires 2,000 HTTP requests, failing the requirement for bounded-cost analysis.

### 2. Zipball Archive (`GET /repos/{owner}/{repo}/zipball/{ref}`)
- **Rejected as primary**: ZIP archives store the central directory at the *end* of the file. Streaming decompression of a ZIP archive requires either buffering the entire archive into memory/disk before indexing files, or using complex random-access chunking.

### 3. Tarball Archive (`GET /repos/{owner}/{repo}/tarball/{ref}`) with Streaming Decompression
- **Selected**: Gzipped TAR archives (`.tar.gz`) are sequential streams. Each file entry contains its header immediately followed by its data bytes. By combining Node's built-in `createGunzip()` from `node:zlib` with the lightweight, event-driven `tar-stream` library (pinned at `3.2.2`), we can decompress and parse the stream in a single pass. Files that are not candidates in `filter-files.ts` are skipped immediately without buffering into memory.

## Decision

1. **Bounded Content Retrieval (1 Request per Analysis)**:
   - For all candidate file contents, RepoStory requests the tarball archive pinned to the commit SHA:
     `GET /repos/{owner}/{repo}/tarball/{commitSha}`
   - The archive is requested with `stage: "archive"`.
   - The response body is piped through `createGunzip()` and `tar.extract()` via `extractRepositoryArchive()`.

2. **Redirect and SSRF Security Model**:
   - The archive endpoint returns an HTTP 302 redirect to `https://codeload.github.com/{owner}/{repo}/legacy.tar.gz/{ref}`.
   - The dispatch loop permits redirection to `codeload.github.com` **exclusively** when `stage === "archive"` over HTTPS.
   - Any attempt to redirect to `codeload.github.com` from other stages (e.g. metadata, tree) or to redirect to unvetted external hosts is blocked with `REPOSITORY_INACCESSIBLE`.
   - The `Authorization` header is stripped when redirecting to `codeload.github.com` to prevent token leakage and avoid CDN authentication errors.

3. **Streaming Limits and Memory Bounds**:
   - `candidatePaths: Set<string>`: Only files pre-selected by `filter-files.ts` have their bodies read. Non-candidate entries in the archive are resumed/skipped instantly without allocation.
   - `maxContentBytes`: Files exceeding the per-file size cap are aborted mid-stream, recorded in coverage with reason `too-large`, and discarded.
   - `maxTotalBytes`: Total decompressed bytes are accumulated; once the threshold is crossed, subsequent files are recorded with reason `limit-reached`.
   - `maxHeapBytes`: Process memory is inspected between entries. If heap usage exceeds the configured budget, extraction halts gracefully.
   - `signal`: Abort signals and timeout budgets immediately destroy decompression streams to prevent worker hanging.

4. **Commit SHA Cache Integration**:
   - Extracted candidate files are saved to `CacheStore` with key `${owner}/${repo}@${commitSha}:content:${path}`.
   - Subsequent analyses of the same commit SHA read from cache with zero network requests.

5. **Per-File Fallback**:
   - If the archive endpoint returns an HTTP error, fails extraction, or if `REPO_STORY_FORCE_PER_FILE_FETCH=true` is set, the provider automatically falls back to the concurrent Contents API worker pool.
   - The fallback event is recorded in analysis coverage via `usedFallbackContentFetch: true` and `contentFetchStrategy: "per-file"`.

## Consequences
- Content retrieval drops from O(N) requests to O(1) request (1 archive request) for any repository size.
- `facebook/react` analysis completes well inside timeout limits without burning token quotas.
- Memory consumption remains strictly bounded during large archive processing.

