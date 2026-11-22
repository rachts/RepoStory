import { NextResponse } from "next/server";
import { analysisRepository, jobQueue } from "@/composition/container";
import { resolveRequestIdentity } from "@/application/jobs/job-identity";
import { jsonResponse, inferErrorStage, inferErrorHint } from "@/shared/http";
import { redactPathValues } from "@/shared/redaction";

interface RouteContext { params: Promise<{ jobId: string }> }

export async function GET(request: Request, context: RouteContext): Promise<NextResponse> {
  const { jobId } = await context.params;
  if (jobId.length > 256) return jsonResponse({ error: { code: "JOB_NOT_FOUND", message: "Analysis job not found.", retryable: false } }, { status: 404 });

  const identity = await resolveRequestIdentity(request, analysisRepository);
  if (!identity.ok) {
    return jsonResponse({ error: { code: identity.error.code, message: identity.error.message, retryable: false } }, { status: 401 });
  }

  await analysisRepository.markExpiredJobs();
  if (analysisRepository.recoverStuckJobs) {
    await analysisRepository.recoverStuckJobs();
  }
  const job = await analysisRepository.getJob(jobId, identity.value.ownerId);
  if (!job) return jsonResponse({ error: { code: "JOB_NOT_FOUND", message: "Analysis job not found.", retryable: false } }, { status: 404 });

  // Detect stuck jobs in fetching, analyzing, or explaining (older than 2 minutes without heartbeat)
  const isStalledCandidate =
    job.status === "fetching" || job.status === "analyzing" || job.status === "explaining";

  const STALLED_TIMEOUT_MS = 2 * 60 * 1000; // 2 minutes
  const lastHeartbeatTime = job.heartbeatAt
    ? new Date(job.heartbeatAt).getTime()
    : new Date(job.updatedAt || job.createdAt).getTime();
  const isStalled = isStalledCandidate && !isNaN(lastHeartbeatTime) && Date.now() - lastHeartbeatTime > STALLED_TIMEOUT_MS;

  // Detect stale jobs stuck in validating-input or queued state (older than 5 minutes)
  const isStaleCandidate =
    (job.status === "queued" || job.stage === "validating-input") &&
    job.status !== "completed" &&
    job.status !== "failed" &&
    job.status !== "cancelled" &&
    job.status !== "expired";

  const STALE_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes
  const lastUpdatedTime = new Date(job.updatedAt || job.createdAt).getTime();
  const isStale = isStaleCandidate && !isNaN(lastUpdatedTime) && Date.now() - lastUpdatedTime > STALE_TIMEOUT_MS;

  let effectiveJob = job;
  if (isStalled) {
    const stalledMessage = "Analysis worker stopped responding";
    const stalledError = {
      code: "JOB_STALLED",
      stage: "analyze" as const,
      reason: "The background analysis worker stopped reporting heartbeats.",
      hint: "You can retry this analysis now.",
      message: stalledMessage,
      retryable: true,
    };

    const patch = {
      status: "failed" as const,
      stage: "completed" as const,
      progress: 100,
      message: stalledMessage,
      error: stalledError,
      updatedAt: new Date().toISOString(),
    };

    const updateResult = analysisRepository.updateJobIfStatus
      ? await analysisRepository.updateJobIfStatus(jobId, patch, ["fetching", "analyzing", "explaining"], identity.value.ownerId)
      : { won: true, job: await analysisRepository.updateJob(jobId, patch, identity.value.ownerId) };

    if (updateResult.won && updateResult.job) {
      effectiveJob = updateResult.job;
      try {
        const queueItem = await jobQueue.get(jobId);
        if (queueItem && queueItem.status === "running") {
          await jobQueue.fail(jobId, queueItem.workerId ?? "stalled-sweeper", {
            code: "JOB_STALLED",
            stage: "analyze",
            message: stalledMessage,
            retryable: true,
          });
        }
      } catch {
        // Ignore queue error if in-memory queue or not queued
      }
    } else {
      effectiveJob = updateResult.job ?? (await analysisRepository.getJob(jobId, identity.value.ownerId)) ?? job;
    }
  } else if (isStale) {
    const timeoutMessage = "Job timed out during validation. The worker may be offline or crashed.";
    const timeoutError = {
      code: "VALIDATION_TIMEOUT",
      message: timeoutMessage,
      retryable: true,
    };

    const patch = {
      status: "failed" as const,
      stage: "completed" as const,
      progress: 100,
      message: timeoutMessage,
      error: timeoutError,
      updatedAt: new Date().toISOString(),
    };

    const updateResult = analysisRepository.updateJobIfStatus
      ? await analysisRepository.updateJobIfStatus(jobId, patch, ["queued"], identity.value.ownerId)
      : { won: true, job: await analysisRepository.updateJob(jobId, patch, identity.value.ownerId) };

    if (updateResult.won && updateResult.job) {
      effectiveJob = updateResult.job;
      try {
        const queueItem = await jobQueue.get(jobId);
        if (queueItem && (queueItem.status === "queued" || queueItem.status === "running")) {
          await jobQueue.fail(jobId, queueItem.workerId ?? "stale-validation-sweeper", {
            code: "VALIDATION_TIMEOUT",
            stage: "validate",
            message: timeoutMessage,
            retryable: true,
          });
        }
      } catch {
        // Ignore queue error if in-memory queue or not queued
      }
    } else {
      effectiveJob = updateResult.job ?? (await analysisRepository.getJob(jobId, identity.value.ownerId)) ?? job;
    }
  }

  const isTerminal =
    effectiveJob.status === "completed" ||
    effectiveJob.status === "failed" ||
    effectiveJob.status === "cancelled" ||
    effectiveJob.status === "expired";

  const WORKER_OFFLINE_THRESHOLD_MS = 40_000;
  let workerStatus: "active" | "offline" | "idle" = "idle";
  if (!isTerminal) {
    const lastHeartbeatMs = effectiveJob.heartbeatAt
      ? new Date(effectiveJob.heartbeatAt).getTime()
      : new Date(effectiveJob.updatedAt || effectiveJob.createdAt).getTime();
    const isOffline = !isNaN(lastHeartbeatMs) && Date.now() - lastHeartbeatMs > WORKER_OFFLINE_THRESHOLD_MS;
    workerStatus = isOffline ? "offline" : "active";
  }

  return jsonResponse(redactPathValues({
    jobId: effectiveJob.jobId,
    analysisId: effectiveJob.analysisId,
    repositoryUrl: effectiveJob.repositoryUrl,
    branch: effectiveJob.branch,
    status: effectiveJob.status,
    stage: effectiveJob.stage,
    progress: effectiveJob.progress,
    message: effectiveJob.message,
    createdAt: effectiveJob.createdAt,
    updatedAt: effectiveJob.updatedAt,
    expiresAt: effectiveJob.expiresAt,
    retryCount: effectiveJob.retryCount,
    explanationRequested: effectiveJob.explanationRequested,
    heartbeatAt: effectiveJob.heartbeatAt ?? null,
    workerStatus,
    cancellationRequested: effectiveJob.cancellationRequested ?? false,
    error: effectiveJob.error
      ? {
          code: effectiveJob.error.code,
          stage: effectiveJob.error.stage ?? inferErrorStage(effectiveJob.error.code),
          reason: effectiveJob.error.reason ?? effectiveJob.error.message,
          message: effectiveJob.error.message,
          retryable: effectiveJob.error.retryable,
          hint: effectiveJob.error.hint ?? inferErrorHint(effectiveJob.error.code),
          details: effectiveJob.error.details,
        }
      : undefined,
    coverage: effectiveJob.coverage,
    statusUrl: `/api/analyze/jobs/${encodeURIComponent(effectiveJob.jobId)}`,
    resultUrl: effectiveJob.analysisId ? `/api/analyze/${encodeURIComponent(effectiveJob.analysisId)}` : null,
  }));
}
