import { NextRequest, NextResponse } from "next/server";

import {
  loadEVDailySummary,
  loadEVLatestSnapshot,
  loadEVSessionTotals,
} from "@/lib/ev-charging-server";

export async function GET(request: NextRequest) {
  const dayLimit = Number(request.nextUrl.searchParams.get("days") ?? 30);
  const [totals, daily, latest] = await Promise.all([
    loadEVSessionTotals(),
    loadEVDailySummary(Number.isFinite(dayLimit) ? dayLimit : 30),
    loadEVLatestSnapshot(),
  ]);

  return NextResponse.json({
    generated_at: new Date().toISOString(),
    lifetime_energy_kwh:
      typeof latest?.lifetime_energy_wh === "number" ? latest.lifetime_energy_wh / 1000 : null,
    tracked_session_count: totals.session_count,
    tracked_kwh: totals.tracked_kwh,
    tracked_charging_seconds: totals.charging_seconds,
    daily,
  });
}
