import { NextResponse } from "next/server";
import { checkReadiness } from "@/application/health";

export async function GET(): Promise<NextResponse> {
  const result = await checkReadiness();
  const status = result.ready ? 200 : 503;

  return NextResponse.json(
    {
      status: result.ready ? "healthy" : "unhealthy",
      checks: result.checks,
      ...(result.errors ? { errors: result.errors } : {}),
    },
    { status },
  );
}
