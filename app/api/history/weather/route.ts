import { NextResponse } from "next/server";

import { loadCsvWeatherHistory } from "@/lib/csv-weather-history";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(request: Request) {
  const url = new URL(request.url);
  const payload = await loadCsvWeatherHistory(url.hostname);

  return NextResponse.json(payload, {
    headers: {
      "Cache-Control": "no-store, max-age=0",
      "X-History-Source": "csv",
    },
  });
}
