import { NextResponse } from "next/server";

import { loadHistoryResponse, resolveHistorySource, type HistorySource } from "@/lib/history";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(request: Request) {
  const url = new URL(request.url);
  const sourceParam = url.searchParams.get("source");
  const source: HistorySource =
    sourceParam === "csv" || sourceParam === "supabase"
      ? sourceParam
      : resolveHistorySource(url.hostname);

  const payload = await loadHistoryResponse(source);

  return NextResponse.json(payload, {
    headers: {
      "Cache-Control": "no-store, max-age=0",
    },
  });
}
