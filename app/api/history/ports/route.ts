import { NextResponse } from "next/server";

import { loadPortHistory } from "@/lib/port-history";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(request: Request) {
  const url = new URL(request.url);
  const payload = await loadPortHistory(url.hostname);

  return NextResponse.json(payload, {
    headers: {
      "Cache-Control": "no-store, max-age=0",
      "X-History-Source": "csv",
    },
  });
}
