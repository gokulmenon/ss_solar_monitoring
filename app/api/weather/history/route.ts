import { NextResponse } from "next/server";

import { loadWeatherHistory, summarizeWeatherByDay } from "@/lib/weather";

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
      headers: {
        "Cache-Control": "no-store, max-age=0",
      },
    },
  );
}
