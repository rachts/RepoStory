import { spawn, type ChildProcess } from "node:child_process";
import { SupabaseJobQueue } from "../src/infrastructure/jobs/supabase-job-queue";
import { SupabaseAnalysisJobRepository } from "../src/infrastructure/jobs/supabase-analysis-job-repository";

const SUPABASE_URL = "http://localhost:3002";
const SECRET_KEY =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJyb2xlIjoibWFjYm9va2FpciIsInN1YiI6InRlc3QtYWRtaW4ifQ.AedVMsBfk5ry6WRu2WHhj_s1IdvfzaMYUUWBiaeqh1s";

const ENV_BASE: NodeJS.ProcessEnv = {
  ...process.env,
  NODE_ENV: "production",
  ALLOW_IN_MEMORY_QUEUE: "false",
  REPO_STORY_JOB_STORE: "supabase",
  REPO_STORY_QUEUE_MODE: "supabase",
  SUPABASE_URL,
  SUPABASE_SECRET_KEY: SECRET_KEY,
  WORKER_HEARTBEAT_TIMEOUT_MS: "3000", // 3 second heartbeat timeout
  WORKER_HEARTBEAT_INTERVAL_MS: "1000",
  WORKER_POLL_INTERVAL_MS: "500",
};

async function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  console.log("=== Starting Worker Crash Recovery Verification ===");

  const queue = new SupabaseJobQueue({
    url: SUPABASE_URL,
    secretKey: SECRET_KEY,
    heartbeatTimeoutMs: 3000,
  });

  const repo = new SupabaseAnalysisJobRepository({
    url: SUPABASE_URL,
    secretKey: SECRET_KEY,
  });

  const testJobId = `crash-job-${Date.now()}`;
  const now = new Date().toISOString();

  console.log(`[Step 1] Creating job ${testJobId} in Supabase store and queue...`);
  await repo.createJob({
    jobId: testJobId,
    analysisId: `analysis-${testJobId}`,
    ownerId: "crash-test-user",
    repositoryUrl: "https://github.com/octocat/Hello-World",
    branch: "main",
    cacheKey: `cache-${testJobId}`,
    status: "queued",
    stage: "validating-input",
    progress: 0,
    message: "Queued for crash verification",
    createdAt: now,
    updatedAt: now,
    expiresAt: new Date(Date.now() + 86400000).toISOString(),
    retryCount: 0,
    explanationRequested: false,
  });

  await queue.enqueue(testJobId);
  console.log(`[Step 1] Job ${testJobId} enqueued.`);

  // Verify initial state
  const initialQueueItem = await queue.get(testJobId);
  console.log(`[Step 1] Initial queue state: status=${initialQueueItem?.status}, attempts=${initialQueueItem?.attempts}`);
  if (initialQueueItem?.status !== "queued") {
    throw new Error(`Expected job to be queued, got ${initialQueueItem?.status}`);
  }

  // Step 2: Spawn Worker 1
  console.log(`\n[Step 2] Spawning Worker 1 (worker-crash-alpha)...`);
  const worker1: ChildProcess = spawn("./node_modules/.bin/tsx", ["src/worker.ts"], {
    env: { ...ENV_BASE, WORKER_ID: "worker-crash-alpha", ANALYSIS_ARTIFICIAL_DELAY_MS: "8000" },
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
  });

  let worker1InternalPid: number | undefined;
  worker1.stdout?.on("data", (chunk) => {
    const text = chunk.toString();
    try {
      const parsed = JSON.parse(text);
      if (parsed.pid) worker1InternalPid = parsed.pid;
    } catch {}
    if (text.includes(testJobId) || text.includes("worker-crash-alpha")) {
      process.stdout.write(`[Worker 1 stdout] ${text}`);
    }
  });
  worker1.stderr?.on("data", (chunk) => {
    process.stderr.write(`[Worker 1 stderr] ${chunk.toString()}`);
  });

  // Wait for Worker 1 to claim the job
  console.log(`[Step 2] Waiting for Worker 1 to claim job ${testJobId}...`);
  const startWait = Date.now();
  let worker1ClaimItem = null;
  while (Date.now() - startWait < 15000) {
    const item = await queue.get(testJobId);
    if (item?.status === "running" && item?.workerId === "worker-crash-alpha") {
      worker1ClaimItem = item;
      break;
    }
    await sleep(250);
  }

  if (!worker1ClaimItem) {
    if (worker1.pid) {
      try { process.kill(-worker1.pid, "SIGKILL"); } catch {}
    }
    throw new Error(`Worker 1 failed to claim job ${testJobId} within timeout.`);
  }

  console.log(`[Step 2] SUCCESS: Worker 1 claimed job. workerId=${worker1ClaimItem.workerId}, status=${worker1ClaimItem.status}, attempts=${worker1ClaimItem.attempts}`);
  await sleep(1500); // Allow worker to run mid-job

  // Step 3: Hard kill Worker 1 process tree with SIGKILL
  console.log(`\n[Step 3] Hard killing Worker 1 (PID ${worker1.pid}, child ${worker1InternalPid}) with SIGKILL (kill -9)...`);
  try {
    if (worker1.pid) process.kill(-worker1.pid, "SIGKILL");
  } catch {}
  if (worker1InternalPid) {
    try { process.kill(worker1InternalPid, "SIGKILL"); } catch {}
  }

  await sleep(1000);
  console.log(`[Step 3] Worker 1 exitCode: ${worker1.exitCode}, signalCode: ${worker1.signalCode}`);

  // Step 4: Verify job is NOT lost
  const postKillItem = await queue.get(testJobId);
  console.log(`[Step 4] Queue state after Worker 1 SIGKILL: status=${postKillItem?.status}, workerId=${postKillItem?.workerId}, attempts=${postKillItem?.attempts}`);
  if (!postKillItem || postKillItem.status !== "running") {
    throw new Error(`Job was lost or corrupted after worker crash!`);
  }
  console.log(`[Step 4] Verified: Job remains intact in queue; not lost.`);

  // Step 5: Wait for heartbeat timeout (3000ms configured, wait 4500ms)
  console.log(`\n[Step 5] Waiting 4.5 seconds for heartbeat timeout to expire (timeout=3000ms)...`);
  await sleep(4500);

  // Step 6: Spawn Worker 2
  console.log(`\n[Step 6] Spawning Worker 2 (worker-crash-beta) to reclaim abandoned job...`);
  const worker2: ChildProcess = spawn("./node_modules/.bin/tsx", ["src/worker.ts"], {
    env: { ...ENV_BASE, WORKER_ID: "worker-crash-beta", ANALYSIS_ARTIFICIAL_DELAY_MS: "0" },
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
  });

  worker2.stdout?.on("data", (chunk) => {
    const text = chunk.toString();
    if (text.includes(testJobId) || text.includes("worker-crash-beta")) {
      process.stdout.write(`[Worker 2 stdout] ${text}`);
    }
  });
  worker2.stderr?.on("data", (chunk) => {
    process.stderr.write(`[Worker 2 stderr] ${chunk.toString()}`);
  });

  // Step 7: Wait for Worker 2 to reclaim and complete the job
  console.log(`[Step 7] Monitoring Worker 2 reclaim and execution...`);
  let reclaimed = false;
  let completed = false;
  const startWait2 = Date.now();

  while (Date.now() - startWait2 < 25000) {
    const item = await queue.get(testJobId);
    if (!reclaimed && item?.workerId === "worker-crash-beta") {
      reclaimed = true;
      console.log(`[Step 7] SUCCESS: Worker 2 reclaimed abandoned job! workerId=${item.workerId}, attempts=${item.attempts}, status=${item.status}`);
    }
    if (item?.status === "succeeded") {
      completed = true;
      console.log(`[Step 7] SUCCESS: Job reached status 'succeeded' in queue.`);
      break;
    }
    await sleep(500);
  }

  // Gracefully stop Worker 2
  if (worker2.pid) {
    try { process.kill(-worker2.pid, "SIGTERM"); } catch {}
  }
  await sleep(1000);

  if (!reclaimed) {
    throw new Error(`Worker 2 failed to reclaim the abandoned job.`);
  }

  if (!completed) {
    // Check final status in repo
    const repoJob = await repo.getJob(testJobId);
    console.log(`Repo job status: ${repoJob?.status}, message: ${repoJob?.message}`);
  }

  // Final verification assertions
  const finalQueue = await queue.get(testJobId);
  const finalRepoJob = await repo.getJob(testJobId);

  console.log(`\n=== Final Verification Results ===`);
  console.log(`Queue item: status=${finalQueue?.status}, attempts=${finalQueue?.attempts}, workerId=${finalQueue?.workerId}`);
  console.log(`Repo job: status=${finalRepoJob?.status}, stage=${finalRepoJob?.stage}, progress=${finalRepoJob?.progress}`);

  if (finalQueue?.status !== "succeeded" && finalRepoJob?.status !== "completed") {
    throw new Error(`Expected job to complete successfully after recovery.`);
  }

  console.log("\n Worker crash recovery test with real OS processes PASSED flawlessly!");
}

main().catch((err) => {
  console.error("Worker crash recovery verification failed:", err);
  process.exit(1);
});
