import { createClient } from "@supabase/supabase-js";
import { NextResponse } from "next/server";

export const supabase = createClient("https://example.supabase.co", "key");

export async function GET(): Promise<NextResponse> {
  return NextResponse.json({ ok: true });
}

