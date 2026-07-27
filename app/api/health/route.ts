import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const revalidate = 0;

const MAX_STALE_SECONDS = 300;
const SUPABASE_URL =
  process.env.SUPABASE_URL?.trim() || process.env.NEXT_PUBLIC_SUPABASE_URL?.trim() || "";
const SUPABASE_API_KEY =
  process.env.SUPABASE_SERVICE_ROLE_KEY?.trim() ||
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY?.trim() ||
  "";
const SUPABASE_TABLE_NAME = process.env.SUPABASE_TABLE_NAME?.trim() || "meter_readings";

type LatestMeterRow = {
  timestamp: string;
};

function jsonError(message: string, status = 500, extra?: Record<string, unknown>) {
  return NextResponse.json(
    {
      status: "error",
      message,
      ...extra,
    },
    {
      status,
      headers: {
        "Cache-Control": "no-store, max-age=0",
      },
    },
  );
}

export async function GET() {
  if (!SUPABASE_URL || !SUPABASE_API_KEY) {
    return jsonError("Supabase credentials are missing");
  }

  try {
    const url = new URL(`/rest/v1/${SUPABASE_TABLE_NAME}`, SUPABASE_URL);
    url.searchParams.set("select", "timestamp");
    url.searchParams.set("order", "timestamp.desc");
    url.searchParams.set("limit", "1");

    const response = await fetch(url.toString(), {
      headers: {
        apikey: SUPABASE_API_KEY,
        Authorization: `Bearer ${SUPABASE_API_KEY}`,
        Accept: "application/json",
      },
      cache: "no-store",
    });

    if (!response.ok) {
      return jsonError(`Database query failed with status ${response.status}`);
    }

    const payload = (await response.json()) as LatestMeterRow[];
    const latest = payload[0];

    if (!latest?.timestamp) {
      return jsonError("No meter readings found", 503);
    }

    const lastUpdateMs = Date.parse(latest.timestamp);
    if (Number.isNaN(lastUpdateMs)) {
      return jsonError("Latest timestamp could not be parsed");
    }

    const staleSeconds = Math.floor((Date.now() - lastUpdateMs) / 1000);
    if (staleSeconds > MAX_STALE_SECONDS) {
      return jsonError("Data is stale", 503, {
        last_update: latest.timestamp,
        stale_seconds: staleSeconds,
      });
    }

    return NextResponse.json(
      {
        status: "healthy",
        last_update: latest.timestamp,
        stale_seconds: staleSeconds,
      },
      {
        headers: {
          "Cache-Control": "no-store, max-age=0",
        },
      },
    );
  } catch (error) {
    return jsonError("Database query failed", 500, {
      detail: error instanceof Error ? error.message : "Unknown error",
    });
  }
}
