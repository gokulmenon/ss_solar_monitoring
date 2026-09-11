import { NextResponse } from "next/server";

import { loadLatestWeather } from "@/lib/weather";
import { CACHE_SECONDS, sharedCacheHeaders } from "@/lib/http-cache";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET() {
  const latest = await loadLatestWeather();

  return NextResponse.json(
    {
      provider: "Open-Meteo",
      status: latest ? "healthy" : "offline",
      latest,
    },
    {
      headers: sharedCacheHeaders(CACHE_SECONDS.weather),
    },
  );
}
