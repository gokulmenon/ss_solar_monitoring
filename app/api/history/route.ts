import { NextResponse } from "next/server";

import {
  loadHistoryResponse,
  resolveCsvHistoryMode,
  resolveHistorySource,
  type HistorySource,
} from "@/lib/history";

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
      "Cache-Control": "no-store, max-age=0",
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
