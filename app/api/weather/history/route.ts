import { NextResponse } from "next/server";

import { loadWeatherHistory, summarizeWeatherByDay } from "@/lib/weather";
import { CACHE_SECONDS, sharedCacheHeaders } from "@/lib/http-cache";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(request: Request) {
  const url = new URL(request.url);
  const hours = Number(url.searchParams.get("hours") ?? "24");
  const points = await loadWeatherHistory(Number.isFinite(hours) ? hours : 24);

  return NextResponse.json(
    {
      provider: "Open-Meteo",
      points,
      dailySummary: summarizeWeatherByDay(points),
    },
    {
      headers: sharedCacheHeaders(CACHE_SECONDS.history),
    },
  );
}
