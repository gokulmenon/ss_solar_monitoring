import { NextRequest, NextResponse } from "next/server";

import { loadDailyEnergySummary } from "@/lib/daily-energy";

export async function GET(request: NextRequest) {
  const dayLimit = Number(request.nextUrl.searchParams.get("days") ?? 30);
  const points = await loadDailyEnergySummary(Number.isFinite(dayLimit) ? dayLimit : 30);

  return NextResponse.json({
    generated_at: new Date().toISOString(),
    points,
  });
}
