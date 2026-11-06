#!/usr/bin/env node

/**
 * Lightweight Node-based load testing runner using fetch.
 * Exercises POST /api/analyze and status polling concurrency.
 */

const targetUrl = process.env.TARGET_URL || "http://localhost:3000";
const concurrentUsers = Number(process.env.CONCURRENCY) || 5;
const iterations = Number(process.env.ITERATIONS) || 10;

async function runScenario(userId) {
  const submitRes = await fetch(`${targetUrl}/api/analyze`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-anonymous-session": `user-${userId}`,
    },
    body: JSON.stringify({ repositoryUrl: "https://github.com/acme/widget" }),
  });

  if (submitRes.status !== 202) {
    throw new Error(`Expected 202, got ${submitRes.status}`);
  }

  const { jobId, statusUrl } = await submitRes.json();
  const fullStatusUrl = statusUrl.startsWith("http") ? statusUrl : `${targetUrl}${statusUrl}`;

  let done = false;
  let attempts = 0;
  while (!done && attempts < 20) {
    await new Promise((r) => setTimeout(r, 1000));
    attempts++;
    const statusRes = await fetch(fullStatusUrl, {
      headers: { "x-anonymous-session": `user-${userId}` },
    });
    if (statusRes.ok) {
      const data = await statusRes.json();
      if (data.status === "completed" || data.status === "failed") {
        done = true;
      }
    }
  }
}

async function main() {
  console.log(`Starting load test against ${targetUrl} (concurrency: ${concurrentUsers}, iterations: ${iterations})`);
  const start = Date.now();
  let succeeded = 0;
  let failed = 0;

  for (let i = 0; i < iterations; i += concurrentUsers) {
    const batch = Array.from({ length: Math.min(concurrentUsers, iterations - i) }, (_, idx) =>
      runScenario(i + idx)
        .then(() => {
          succeeded++;
        })
        .catch((err) => {
          failed++;
          console.error(`Request error:`, err.message);
        }),
    );
    await Promise.all(batch);
  }

  const elapsedSec = (Date.now() - start) / 1000;
  console.log(`\nCompleted in ${elapsedSec.toFixed(2)}s. Succeeded: ${succeeded}, Failed: ${failed}`);
}

if (require.main === module) {
  main().catch(console.error);
}
