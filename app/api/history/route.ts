import { NextResponse } from "next/server";

import { generateHistorySeries } from "@/lib/mock-data";

export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json(generateHistorySeries(), {
    headers: {
      "Cache-Control": "no-store, max-age=0",
    },
  });
}
