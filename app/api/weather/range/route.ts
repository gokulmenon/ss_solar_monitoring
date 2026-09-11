import { NextResponse } from "next/server";

import { loadWeatherRange, summarizeWeatherByDay } from "@/lib/weather";
import { CACHE_SECONDS, sharedCacheHeaders } from "@/lib/http-cache";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(request: Request) {
  const url = new URL(request.url);
  const start = url.searchParams.get("start");
  const end = url.searchParams.get("end");

  if (!start || !end) {
    return NextResponse.json(
      { error: "Missing required start and end query parameters." },
      { status: 400 },
    );
  }

  const startDate = new Date(start);
  const endDate = new Date(end);
  if (!Number.isFinite(startDate.getTime()) || !Number.isFinite(endDate.getTime())) {
    return NextResponse.json(
      { error: "start and end must be valid date/time strings." },
      { status: 400 },
    );
  }

  const points = await loadWeatherRange(startDate.toISOString(), endDate.toISOString());

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
