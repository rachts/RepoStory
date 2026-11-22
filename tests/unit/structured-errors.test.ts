import { describe, it, expect } from "vitest";
import { AppError } from "@/domain/errors";
import { errorResponse, inferErrorStage, inferErrorHint } from "@/shared/http";

describe("Structured Actionable Errors", () => {
  it("infers appropriate stage for all standard error codes", () => {
    expect(inferErrorStage("REPOSITORY_NOT_FOUND_OR_PRIVATE")).toBe("fetch");
    expect(inferErrorStage("REPOSITORY_NOT_FOUND")).toBe("fetch");
    expect(inferErrorStage("GITHUB_TREE_TRUNCATED")).toBe("tree");
    expect(inferErrorStage("REPO_TOO_LARGE")).toBe("tree");
    expect(inferErrorStage("GITHUB_CONTENT_TOO_LARGE")).toBe("blob");
    expect(inferErrorStage("GITHUB_INVALID_CONTENT")).toBe("parse");
    expect(inferErrorStage("ANALYSIS_TIMEOUT")).toBe("analyze");
    expect(inferErrorStage("ANALYSIS_FAILED")).toBe("analyze");
    expect(inferErrorStage("ANALYSIS_STORAGE_UNAVAILABLE")).toBe("persist");
  });

  it("infers actionable hints for user-facing errors", () => {
    expect(inferErrorHint("REPOSITORY_NOT_FOUND_OR_PRIVATE")).toContain("sign in with a GitHub token");
    expect(inferErrorHint("GITHUB_RATE_LIMITED")).toContain("Provide a GitHub token");
    expect(inferErrorHint("REPO_TOO_LARGE")).toContain("Analyze a smaller repository");
  });

  it("formats HTTP error responses with the { code, stage, reason, retryable, hint } shape", async () => {
    const error = new AppError({
      code: "REPOSITORY_NOT_FOUND_OR_PRIVATE",
      stage: "fetch",
      message: "Repository not found or private.",
      reason: "Repository not found or requires authentication.",
      hint: "Make the repository public or sign in with a GitHub token with repo scope.",
      retryable: false,
    });

    const response = errorResponse(error);
    expect(response.status).toBe(404);

    const body = await response.json();
    expect(body.code).toBe("REPOSITORY_NOT_FOUND_OR_PRIVATE");
    expect(body.stage).toBe("fetch");
    expect(body.reason).toBe("Repository not found or requires authentication.");
    expect(body.retryable).toBe(false);
    expect(body.hint).toContain("Make the repository public");

    // Also backward-compatible nested under body.error
    expect(body.error.code).toBe("REPOSITORY_NOT_FOUND_OR_PRIVATE");
    expect(body.error.stage).toBe("fetch");
    expect(body.error.message).toBe("Repository not found or private.");
  });
});
