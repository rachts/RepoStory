import http from "node:http";
import tar from "tar-stream";
import zlib from "node:zlib";

export interface MockServerOptions {
  port?: number;
  host?: string;
}

export function createMockTarball(files: Record<string, string>): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const pack = tar.pack();
    for (const [filepath, content] of Object.entries(files)) {
      pack.entry({ name: `repo-main/${filepath}` }, content);
    }
    pack.finalize();
    const chunks: Buffer[] = [];
    const gzip = zlib.createGzip();
    pack.pipe(gzip);
    gzip.on("data", (chunk) => chunks.push(chunk));
    gzip.on("end", () => resolve(Buffer.concat(chunks)));
    gzip.on("error", reject);
  });
}

const defaultFiles: Record<string, string> = {
  "package.json": JSON.stringify({
    name: "mock-repo",
    version: "1.0.0",
    dependencies: { react: "^18.0.0", "next": "^14.0.0" },
  }, null, 2),
  "app/layout.tsx": "export default function Layout({ children }: { children: React.ReactNode }) { return <html><body>{children}</body></html>; }",
  "app/page.tsx": "export default function Page() { return <h1>Hello from Mock Repo</h1>; }",
  "app/api/chat/route.ts": "export async function POST() { return new Response(JSON.stringify({ reply: 'pong' })); }",
};

export async function startMockGitHubServer(options: MockServerOptions = {}): Promise<{
  server: http.Server;
  port: number;
  baseUrl: string;
  close: () => Promise<void>;
}> {
  const host = options.host ?? "127.0.0.1";
  const tarballBuffer = await createMockTarball(defaultFiles);

  const server = http.createServer((req, res) => {
    const parsedUrl = new URL(req.url ?? "/", `http://${req.headers.host ?? "127.0.0.1"}`);
    const pathname = parsedUrl.pathname;

    // Default headers
    res.setHeader("access-control-allow-origin", "*");
    res.setHeader("access-control-allow-headers", "*");
    res.setHeader("x-ratelimit-remaining", "5000");
    res.setHeader("x-ratelimit-reset", String(Math.floor(Date.now() / 1000) + 3600));

    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    // Zen endpoint
    if (pathname === "/zen") {
      res.writeHead(200, { "Content-Type": "text/plain" });
      res.end("Practicality beats purity.");
      return;
    }

    // Rate limit testing endpoints: 429 and 403 with retry-after
    if (pathname.includes("/rate-limit-429")) {
      res.writeHead(429, {
        "Content-Type": "application/json",
        "retry-after": "2",
        "x-ratelimit-remaining": "0",
        "x-ratelimit-reset": String(Math.floor(Date.now() / 1000) + 2),
      });
      res.end(JSON.stringify({ message: "API rate limit exceeded. Retry later." }));
      return;
    }

    if (pathname.includes("/rate-limit-403")) {
      res.writeHead(403, {
        "Content-Type": "application/json",
        "retry-after": "2",
        "x-ratelimit-remaining": "0",
        "x-ratelimit-reset": String(Math.floor(Date.now() / 1000) + 2),
      });
      res.end(JSON.stringify({ message: "API rate limit exceeded. Retry later." }));
      return;
    }

    // Private repo simulation
    if (pathname.includes("/private-repo") || pathname.includes("/private/")) {
      const auth = req.headers.authorization;
      if (!auth || !auth.startsWith("Bearer ") || auth.replace("Bearer ", "").trim().length === 0) {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ message: "Not Found", documentation_url: "https://docs.github.com" }));
        return;
      }
    }

    // 1. Metadata endpoint: /repos/:owner/:repo
    const repoMatch = pathname.match(/^\/repos\/([^/]+)\/([^/]+)$/);
    if (repoMatch) {
      const owner = repoMatch[1] ?? "";
      const repo = repoMatch[2] ?? "";
      const isPrivate = repo.includes("private");
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        id: 999999,
        name: repo,
        full_name: `${owner}/${repo}`,
        default_branch: "main",
        visibility: isPrivate ? "private" : "public",
        private: isPrivate,
        html_url: `http://${host}:${options.port ?? 4000}/${owner}/${repo}`,
        description: `Mock repository for ${owner}/${repo}`,
      }));
      return;
    }

    // 2. Commits / Ref lookup: /repos/:owner/:repo/commits/:branch or /git/ref/:ref
    if (pathname.includes("/commits/") || pathname.includes("/git/ref/")) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        sha: "a1b2c3d4e5f67890123456789abcdef012345678",
        commit: {
          message: "Initial commit",
          tree: { sha: "tree1234567890123456789abcdef012345678" },
        },
      }));
      return;
    }

    // 3. Git Trees endpoint: /repos/:owner/:repo/git/trees/:branch
    if (pathname.includes("/git/trees/")) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        sha: "tree1234567890123456789abcdef012345678",
        truncated: false,
        tree: Object.keys(defaultFiles).map((path, idx) => ({
          path,
          mode: "100644",
          type: "blob",
          sha: `sha${idx}${"0".repeat(36)}`,
          size: (defaultFiles[path] ?? "").length,
        })),
      }));
      return;
    }

    // 4. Tarball Archive endpoint: /repos/:owner/:repo/tarball/:ref
    const tarballMatch = pathname.match(/^\/repos\/([^/]+)\/([^/]+)\/tarball\/?(.*)$/);
    if (tarballMatch) {
      const [, owner, repo, ref] = tarballMatch;
      // GitHub redirects 302 to codeload
      const location = `http://${host}:${server.address() ? (server.address() as import("node:net").AddressInfo).port : options.port ?? 4000}/codeload/${owner}/${repo}/legacy.tar.gz/${ref || "main"}`;
      res.writeHead(302, { Location: location });
      res.end();
      return;
    }

    // 5. Codeload Archive download: /codeload/:owner/:repo/legacy.tar.gz/:ref
    if (pathname.startsWith("/codeload/")) {
      // Scenario A: Stalling tarball (sends few bytes and stalls indefinitely)
      if (pathname.includes("stall") || pathname.includes("stalling")) {
        res.writeHead(200, {
          "Content-Type": "application/x-gzip",
          "Content-Length": String(tarballBuffer.length),
        });
        res.write(tarballBuffer.subarray(0, 30));
        // Do not call res.end() or send more data -> watchdog should trigger
        return;
      }

      // Scenario B: Mid-stream error tarball (sends a few bytes and destroys socket)
      if (pathname.includes("error") || pathname.includes("corrupt")) {
        res.writeHead(200, {
          "Content-Type": "application/x-gzip",
          "Content-Length": String(tarballBuffer.length),
        });
        res.write(tarballBuffer.subarray(0, 30));
        setTimeout(() => {
          res.destroy(new Error("Simulated mid-stream socket crash"));
        }, 100);
        return;
      }

      // Scenario B2: Slow download with Content-Length header (for progress 45 -> 60 check)
      if (pathname.includes("slow-length")) {
        res.writeHead(200, {
          "Content-Type": "application/x-gzip",
          "Content-Length": String(tarballBuffer.length),
        });
        const chunkSize = Math.max(10, Math.floor(tarballBuffer.length / 8));
        let offset = 0;
        const interval = setInterval(() => {
          if (offset < tarballBuffer.length) {
            const next = tarballBuffer.subarray(offset, offset + chunkSize);
            res.write(next);
            offset += chunkSize;
          } else {
            clearInterval(interval);
            res.end();
          }
        }, 250);
        return;
      }

      // Scenario C: Chunked tarball with no Content-Length
      if (pathname.includes("chunked") || pathname.includes("no-length")) {
        res.writeHead(200, {
          "Content-Type": "application/x-gzip",
          // Intentionally omitting Content-Length for chunked transfer
        });
        const chunkSize = 40;
        let offset = 0;
        const interval = setInterval(() => {
          if (offset < tarballBuffer.length) {
            const next = tarballBuffer.subarray(offset, offset + chunkSize);
            res.write(next);
            offset += chunkSize;
          } else {
            clearInterval(interval);
            res.end();
          }
        }, 80);
        return;
      }

      // Scenario D: Standard normal tarball
      res.writeHead(200, {
        "Content-Type": "application/x-gzip",
        "Content-Length": String(tarballBuffer.length),
      });
      res.end(tarballBuffer);
      return;
    }

    // 6. Contents endpoint fallback: /repos/:owner/:repo/contents/:path*
    if (pathname.includes("/contents/")) {
      const match = pathname.match(/\/contents\/(.+)$/);
      const filePath = match && match[1] ? decodeURIComponent(match[1]) : "";
      const content = defaultFiles[filePath] ?? "console.log('mock');";
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        type: "file",
        encoding: "base64",
        size: content.length,
        name: filePath.split("/").pop(),
        path: filePath,
        content: Buffer.from(content).toString("base64"),
        sha: "file1234567890123456789abcdef012345678",
      }));
      return;
    }

    // Default 404
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ message: "Not Found", pathname }));
  });

  const port = options.port ?? 4000;
  await new Promise<void>((resolve) => {
    server.listen(port, host, () => {
      resolve();
    });
  });

  const actualPort = (server.address() as import("node:net").AddressInfo).port;
  const baseUrl = `http://${host}:${actualPort}`;

  return {
    server,
    port: actualPort,
    baseUrl,
    close: () => new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    }),
  };
}

// Standalone execution: node/tsx scripts/mock-github-server.ts [port]
if (process.argv[1]?.endsWith("mock-github-server.ts") || process.argv[1]?.endsWith("mock-github-server.js")) {
  const requestedPort = process.argv[2] ? parseInt(process.argv[2], 10) : 4000;
  startMockGitHubServer({ port: requestedPort }).then(({ baseUrl }) => {
    console.log(`[Mock GitHub Server] Running at ${baseUrl}`);
  }).catch((err) => {
    console.error(`[Mock GitHub Server] Failed to start:`, err);
    process.exit(1);
  });
}
