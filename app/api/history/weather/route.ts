import { NextResponse } from "next/server";

import { loadCsvWeatherHistory } from "@/lib/csv-weather-history";
import { CACHE_SECONDS, sharedCacheHeaders } from "@/lib/http-cache";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(request: Request) {
  const url = new URL(request.url);
  const payload = await loadCsvWeatherHistory(url.hostname);

  return NextResponse.json(payload, {
    headers: {
      ...sharedCacheHeaders(CACHE_SECONDS.csvHistory),
      "X-History-Source": "csv",
    },
  });
}
