import { NextResponse } from "next/server";
import { jsonResponse } from "@/shared/http";

export function GET(): NextResponse {
  return jsonResponse({ status: "ok", service: "repo-story" });
}
