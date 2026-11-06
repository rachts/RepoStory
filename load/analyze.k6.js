import http from 'k6/http';
import { check, sleep } from 'k6';

export const options = {
  stages: [
    { duration: '10s', target: 5 },  // Ramp up to 5 VUs
    { duration: '30s', target: 10 }, // Sustained load at 10 VUs
    { duration: '5s', target: 0 },   // Ramp down
  ],
  thresholds: {
    http_req_duration: ['p(95)<1000'], // 95% of requests must complete below 1000ms
    http_req_failed: ['rate<0.05'],    // Less than 5% errors
    checks: ['rate>0.95'],             // Over 95% checks passing
  },
};

const BASE_URL = __ENV.TARGET_URL || 'http://localhost:3000';

export default function () {
  const payload = JSON.stringify({
    repositoryUrl: 'https://github.com/acme/widget',
  });

  const params = {
    headers: {
      'Content-Type': 'application/json',
      'x-anonymous-session': `k6-user-${__VU}`,
    },
  };

  // Step 1: Submit repository for analysis
  const res = http.post(`${BASE_URL}/api/analyze`, payload, params);
  const accepted = check(res, {
    'status is 202': (r) => r.status === 202,
    'has jobId': (r) => JSON.parse(r.body).jobId !== undefined,
  });

  if (!accepted) {
    sleep(1);
    return;
  }

  const { jobId, statusUrl } = JSON.parse(res.body);
  const targetStatusUrl = statusUrl.startsWith('http') ? statusUrl : `${BASE_URL}${statusUrl}`;

  // Step 2: Poll for job completion
  let attempts = 0;
  const maxAttempts = 15;
  let completed = false;

  while (attempts < maxAttempts && !completed) {
    sleep(1);
    attempts++;

    const pollRes = http.get(targetStatusUrl, params);
    const pollOk = check(pollRes, {
      'poll status is 200': (r) => r.status === 200,
    });

    if (pollOk) {
      const job = JSON.parse(pollRes.body);
      if (job.status === 'completed' || job.status === 'failed') {
        completed = true;
        check(job, {
          'job finished cleanly': (j) => j.status === 'completed',
        });
      }
    }
  }

  sleep(0.5);
}
