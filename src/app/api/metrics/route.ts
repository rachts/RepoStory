import { NextResponse } from "next/server";
import { registry } from "@/shared/metrics";

export async function GET(request: Request): Promise<NextResponse> {
  const metricsBearerToken = process.env.METRICS_BEARER_TOKEN?.trim();
  const authHeader = request.headers.get("authorization");

  if (!metricsBearerToken || authHeader !== `Bearer ${metricsBearerToken}`) {
    return new NextResponse(JSON.stringify({ error: "Unauthorized" }), {
      status: 401,
      headers: { "Content-Type": "application/json" },
    });
  }

  const metrics = await registry.metrics();
  return new NextResponse(metrics, {
    status: 200,
    headers: { "Content-Type": registry.contentType },
  });
}
