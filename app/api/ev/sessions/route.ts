import { NextRequest, NextResponse } from "next/server";

import { loadEVSessions } from "@/lib/ev-charging-server";

export async function GET(request: NextRequest) {
  const limit = Number(request.nextUrl.searchParams.get("limit") ?? 50);
  const sessions = await loadEVSessions(Number.isFinite(limit) ? Math.min(limit, 200) : 50);

  return NextResponse.json({
    generated_at: new Date().toISOString(),
    sessions,
  });
}
