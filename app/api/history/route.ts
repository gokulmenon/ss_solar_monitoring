import { NextResponse } from "next/server";

import {
  loadHistoryResponse,
  resolveCsvHistoryMode,
  resolveHistorySource,
  type HistorySource,
} from "@/lib/history";
import { CACHE_SECONDS, sharedCacheHeaders } from "@/lib/http-cache";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(request: Request) {
  const url = new URL(request.url);
  const sourceParam = url.searchParams.get("source");
  const source: HistorySource =
    sourceParam === "csv" || sourceParam === "supabase"
      ? sourceParam
      : resolveHistorySource(url.hostname);

  const csvMode = source === "csv" ? resolveCsvHistoryMode(url.hostname) : null;
  const payload = await loadHistoryResponse(source, url.hostname);

  return NextResponse.json(payload, {
    headers: {
      ...sharedCacheHeaders(source === "csv" ? CACHE_SECONDS.csvHistory : CACHE_SECONDS.history),
      "X-History-Source": source,
      ...(csvMode
        ? {
            "X-History-Csv-Source":
              csvMode === "snapshot" ? "deployed-snapshot" : "local-files",
          }
        : {}),
    },
  });
}
