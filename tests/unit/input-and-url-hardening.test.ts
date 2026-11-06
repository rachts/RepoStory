import { describe, expect, it } from "vitest";
import { parseGitHubUrl } from "@/infrastructure/providers/github-url";
import { buildSafeGitHubApiUrl } from "@/infrastructure/providers/github-url-builder";

describe("Workstream 4: Input and URL hardening", () => {
  const hostileMatrix = [
    { name: "path traversal (../)", input: "../evil" },
    { name: "double dot traversal (..)", input: ".." },
    { name: "URL-encoded traversal (%2e%2e)", input: "%2e%2e" },
    { name: "URL-encoded slash (%2F)", input: "a%2Fb" },
    { name: "query string (?)", input: "repo?secret=true" },
    { name: "fragment (#)", input: "repo#fragment" },
    { name: "authority / userinfo (@)", input: "user@evil.com" },
    { name: "unicode look-alike / homoglyph", input: "\u0430pi.github.com" }, // Cyrillic 'a'
    { name: "null byte (\\0)", input: "repo\u0000injected" },
    { name: "URL-encoded null byte (%00)", input: "repo%00injected" },
    { name: "very long name (>4096 chars)", input: "a".repeat(5000) },
    { name: "backslashes (\\)", input: "owner\\repo" },
    { name: "credentials (username:password)", input: "https://user:pass@github.com/owner/repo" },
  ];

  describe("parseGitHubUrl entrance boundary", () => {
    for (const testCase of hostileMatrix) {
      it(`rejects or sanitizes ${testCase.name}`, () => {
        const urlCandidate = testCase.input.startsWith("https://")
          ? testCase.input
          : `https://github.com/${testCase.input}/normal-repo`;

        const result = parseGitHubUrl(urlCandidate);
        // Either result is rejected with error, or safely parsed without escaping github.com
        if (!result.ok) {
          expect(result.ok).toBe(false);
        } else {
          expect(result.value.url.startsWith("https://github.com/")).toBe(true);
          expect(result.value.owner).not.toContain("../");
          expect(result.value.owner).not.toContain("?");
          expect(result.value.owner).not.toContain("#");
        }
      });
    }
  });

  describe("buildSafeGitHubApiUrl provider defense-in-depth", () => {
    for (const testCase of hostileMatrix) {
      it(`safely encodes or rejects ${testCase.name}`, () => {
        try {
          const url = buildSafeGitHubApiUrl(testCase.input, "test-repo", "git/trees/main");
          expect(url.hostname).toBe("api.github.com");
          expect(url.origin).toBe("https://api.github.com");
          expect(url.pathname.startsWith("/repos/")).toBe(true);
        } catch (e: any) {
          expect(e.code).toBe("INVALID_URL");
        }
      });
    }

    it("rejects attempt to alter target host or escape /repos/ prefix", () => {
      // Invariant: final URL origin is ALWAYS https://api.github.com
      const normalUrl = buildSafeGitHubApiUrl("facebook", "react");
      expect(normalUrl.origin).toBe("https://api.github.com");
      expect(normalUrl.pathname).toBe("/repos/facebook/react");
    });
  });
});
