import { NextResponse } from "next/server";

import { loadPortHistory } from "@/lib/port-history";
import { CACHE_SECONDS, sharedCacheHeaders } from "@/lib/http-cache";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(request: Request) {
  const url = new URL(request.url);
  const payload = await loadPortHistory(url.hostname);

  return NextResponse.json(payload, {
    headers: {
      ...sharedCacheHeaders(CACHE_SECONDS.csvHistory),
      "X-History-Source": "csv",
    },
  });
}
