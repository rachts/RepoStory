import { describe, expect, it, beforeEach } from "vitest";
import { POST as analyzePost } from "@/app/api/analyze/route";
import { GET as jobGet } from "@/app/api/analyze/jobs/[jobId]/route";
import { GET as analysisGet } from "@/app/api/analysis/[analysisId]/route";
import { GET as diagramGet } from "@/app/api/diagrams/[diagramId]/route";
import { analysisRepository } from "@/composition/container";
import { checkDailyQuota } from "@/application/jobs/job-identity";
import { opaqueId } from "@/shared/ids";

describe("Workstream 2: Authentication, Authorization & Quotas", () => {
  beforeEach(async () => {
    delete process.env.ANONYMOUS_ANALYSIS_ENABLED;
    delete process.env.ANALYSIS_DAILY_QUOTA;
  });

  it("returns 401 when anonymous mode is disabled and no authentication is provided", async () => {
    process.env.ANONYMOUS_ANALYSIS_ENABLED = "false";

    const request = new Request("http://localhost:3000/api/analyze", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ repositoryUrl: "https://github.com/fixture/small-react" }),
    });

    const response = await analyzePost(request);
    expect(response.status).toBe(401);
    const body = await response.json();
    expect(body.error.code).toBe("UNAUTHORIZED");
  });

  it("allows authenticated request when anonymous mode is disabled", async () => {
    process.env.ANONYMOUS_ANALYSIS_ENABLED = "false";

    const request = new Request("http://localhost:3000/api/analyze", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-user-id": "user-auth-123",
      },
      body: JSON.stringify({ repositoryUrl: "https://github.com/fixture/small-react" }),
    });

    const response = await analyzePost(request);
    expect(response.status).toBe(202);
    const body = await response.json();
    expect(body.jobId).toBeDefined();
  });

  it("enforces ownership: User A cannot read User B's job, returning 404", async () => {
    // Create a job owned by User A
    const jobId = opaqueId("job");
    await analysisRepository.createJob({
      jobId,
      analysisId: null,
      repositoryUrl: "https://github.com/fixture/small-react",
      branch: "main",
      ownerId: "user-a",
      cacheKey: "cache-user-a",
      status: "queued",
      stage: "validating-input",
      progress: 0,
      message: "Queued",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      expiresAt: "2099-01-01T00:00:00.000Z",
      retryCount: 0,
      explanationRequested: false,
    });

    // User A reads their own job -> 200
    const reqA = new Request(`http://localhost:3000/api/analyze/jobs/${jobId}`, {
      headers: { "x-user-id": "user-a" },
    });
    const resA = await jobGet(reqA, { params: Promise.resolve({ jobId }) });
    expect(resA.status).toBe(200);

    // User B attempts to read User A's job -> 404 (does not leak existence)
    const reqB = new Request(`http://localhost:3000/api/analyze/jobs/${jobId}`, {
      headers: { "x-user-id": "user-b" },
    });
    const resB = await jobGet(reqB, { params: Promise.resolve({ jobId }) });
    expect(resB.status).toBe(404);
    const bodyB = await resB.json();
    expect(bodyB.error.code).toBe("JOB_NOT_FOUND");
  });

  it("enforces ownership: User A cannot read User B's analysis or diagram, returning 404", async () => {
    const analysisId = opaqueId("analysis");
    const diagramId = opaqueId("diagram");

    await analysisRepository.createJob({
      jobId: opaqueId("job"),
      analysisId,
      repositoryUrl: "https://github.com/fixture/small-react",
      branch: "main",
      ownerId: "user-alice",
      cacheKey: "cache-alice",
      status: "completed",
      stage: "completed",
      progress: 100,
      message: "Done",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      expiresAt: "2099-01-01T00:00:00.000Z",
      retryCount: 0,
      explanationRequested: false,
    });

    await analysisRepository.saveAnalysisResult({
      id: analysisId,
      repository: { id: "repo", owner: "fixture", name: "small-react", url: "https://github.com/fixture/small-react", defaultBranch: "main", selectedBranch: "main", sizeBytes: 100, fileCount: 1 },
      status: "completed",
      stage: "completed",
      progressPercent: 100,
      filesDiscovered: 1,
      filesAnalyzed: 1,
      technologies: [],
      findings: [],
      diagramIds: [diagramId],
      createdAt: new Date().toISOString(),
    }, "user-alice");

    await analysisRepository.saveAnalysisDiagram({
      id: diagramId,
      analysisId,
      title: "Architecture",
      type: "system-overview",
      description: "Overview",
      direction: "TB",
      nodes: [],
      edges: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }, "user-alice");

    // User Bob attempts to access Alice's analysis
    const analysisReq = new Request(`http://localhost:3000/api/analysis/${analysisId}`, {
      headers: { "x-user-id": "user-bob" },
    });
    const analysisRes = await analysisGet(analysisReq, { params: Promise.resolve({ analysisId }) });
    expect(analysisRes.status).toBe(404);

    // User Bob attempts to access Alice's diagram
    const diagramReq = new Request(`http://localhost:3000/api/diagrams/${diagramId}`, {
      headers: { "x-user-id": "user-bob" },
    });
    const diagramRes = await diagramGet(diagramReq, { params: Promise.resolve({ diagramId }) });
    expect(diagramRes.status).toBe(404);
  });

  it("enforces daily quota: allows 5 analyses, rejects 6th with 429 and Retry-After, resets next UTC day", async () => {
    process.env.ANALYSIS_DAILY_QUOTA = "5";
    const quotaUser = "quota-test-user";

    // Create 5 jobs today for quotaUser
    for (let i = 0; i < 5; i++) {
      const q = await checkDailyQuota(quotaUser, analysisRepository);
      expect(q.allowed).toBe(true);
      expect(q.count).toBe(i);

      await analysisRepository.createJob({
        jobId: opaqueId("job"),
        analysisId: null,
        repositoryUrl: `https://github.com/fixture/test-${i}`,
        branch: "main",
        ownerId: quotaUser,
        cacheKey: `cache-${i}`,
        status: "queued",
        stage: "validating-input",
        progress: 0,
        message: "Queued",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        expiresAt: "2099-01-01T00:00:00.000Z",
        retryCount: 0,
        explanationRequested: false,
      });
    }

    // 6th analysis check
    const sixthCheck = await checkDailyQuota(quotaUser, analysisRepository);
    expect(sixthCheck.allowed).toBe(false);
    expect(sixthCheck.count).toBe(5);
    expect(sixthCheck.retryAfterSeconds).toBeGreaterThan(0);

    // Route test: 6th POST /api/analyze returns 429
    const req = new Request("http://localhost:3000/api/analyze", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-user-id": quotaUser,
      },
      body: JSON.stringify({ repositoryUrl: "https://github.com/fixture/repo-six" }),
    });
    const res = await analyzePost(req);
    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toBeDefined();
    const body = await res.json();
    expect(body.error.code).toBe("QUOTA_EXCEEDED");

    // Simulating daily reset: yesterday's jobs do not count towards today's quota
    const yesterday = new Date(Date.now() - 25 * 3600 * 1000);
    const oldUser = "old-user-quota";
    await analysisRepository.createJob({
      jobId: opaqueId("job"),
      analysisId: null,
      repositoryUrl: "https://github.com/fixture/old-repo",
      branch: "main",
      ownerId: oldUser,
      cacheKey: "cache-old",
      status: "queued",
      stage: "validating-input",
      progress: 0,
      message: "Queued",
      createdAt: yesterday.toISOString(),
      updatedAt: yesterday.toISOString(),
      expiresAt: "2099-01-01T00:00:00.000Z",
      retryCount: 0,
      explanationRequested: false,
    });

    const resetCheck = await checkDailyQuota(oldUser, analysisRepository);
    expect(resetCheck.allowed).toBe(true);
    expect(resetCheck.count).toBe(0);
  });

  it("migrates anonymous session jobs to the authenticated user on first login", async () => {
    const anonSession = "session_anonymous_999";
    const authUser = "user_github_456";

    // Create an anonymous job
    const anonJobId = opaqueId("job");
    await analysisRepository.createJob({
      jobId: anonJobId,
      analysisId: null,
      repositoryUrl: "https://github.com/fixture/small-react",
      branch: "main",
      ownerId: anonSession,
      cacheKey: "cache-anon",
      status: "queued",
      stage: "validating-input",
      progress: 0,
      message: "Queued",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      expiresAt: "2099-01-01T00:00:00.000Z",
      retryCount: 0,
      explanationRequested: false,
    });

    // Make an authenticated request with the anonymous session cookie
    const request = new Request("http://localhost:3000/api/analyze", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-user-id": authUser,
        cookie: `repo_story_session=${anonSession}`,
      },
      body: JSON.stringify({ repositoryUrl: "https://github.com/fixture/new-repo" }),
    });

    const response = await analyzePost(request);
    expect(response.status).toBe(202);

    // Verify the previously anonymous job is now owned by authUser
    const migratedJob = await analysisRepository.getJob(anonJobId, authUser);
    expect(migratedJob).toBeDefined();
    expect(migratedJob?.ownerId).toBe(authUser);

    // It should no longer be accessible by the old anonymous session
    const oldAnonAccess = await analysisRepository.getJob(anonJobId, anonSession);
    expect(oldAnonAccess).toBeUndefined();
  });
});
