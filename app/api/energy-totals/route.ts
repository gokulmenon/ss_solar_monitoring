import { NextResponse } from "next/server";

import { loadEnergyTotals } from "@/lib/daily-energy";
import { CACHE_SECONDS, noStoreHeaders, sharedCacheHeaders } from "@/lib/http-cache";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET() {
  try {
    const totals = await loadEnergyTotals();

    return NextResponse.json(totals, {
      headers: sharedCacheHeaders(CACHE_SECONDS.energy),
    });
  } catch (error) {
    console.error("Unable to load home energy totals:", error);

    return NextResponse.json(
      {
        this_month_solar_kwh: 0,
        this_month_home_consumption_kwh: 0,
        lifetime_solar_kwh: 0,
        lifetime_home_consumption_kwh: 0,
        tracked_day_count: 0,
      },
      { headers: noStoreHeaders },
    );
  }
}
