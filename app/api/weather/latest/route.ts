import { NextResponse } from "next/server";

import { loadLatestWeather } from "@/lib/weather";

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
      headers: {
        "Cache-Control": "no-store, max-age=0",
      },
    },
  );
}
