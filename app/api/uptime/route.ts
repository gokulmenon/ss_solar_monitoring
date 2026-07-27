import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const revalidate = 0;

const UPTIMEROBOT_API_URL = "https://api.uptimerobot.com/v2/getMonitors";
const UPTIMEROBOT_READ_ONLY_API_KEY =
  process.env.UPTIMEROBOT_READ_ONLY_API_KEY?.trim() ||
  process.env.UPTIMEROBOT_API_KEY?.trim() ||
  "";
const UPTIMEROBOT_MONITOR_IDS = process.env.UPTIMEROBOT_MONITOR_IDS?.trim() || "";

type RawUptimeRobotMonitor = {
  id?: number | string;
  friendly_name?: string;
  url?: string;
  status?: number | string;
  type?: number | string;
  custom_uptime_ratio?: string;
  average_response_time?: string | number;
};

function statusMeta(statusValue: number) {
  switch (statusValue) {
    case 0:
      return { label: "Paused", tone: "paused" as const };
    case 1:
      return { label: "Pending", tone: "pending" as const };
    case 2:
      return { label: "Up", tone: "up" as const };
    case 8:
      return { label: "Seems Down", tone: "warning" as const };
    case 9:
      return { label: "Down", tone: "down" as const };
    default:
      return { label: "Unknown", tone: "unknown" as const };
  }
}

function parseRatios(rawValue: string | undefined) {
  const [ratio24h, ratio7d, ratio30d] = (rawValue ?? "")
    .split("-")
    .map((value) => Number.parseFloat(value));

  return {
    ratio24h: Number.isFinite(ratio24h) ? ratio24h : null,
    ratio7d: Number.isFinite(ratio7d) ? ratio7d : null,
    ratio30d: Number.isFinite(ratio30d) ? ratio30d : null,
  };
}

function jsonError(message: string, status = 500, detail?: unknown) {
  return NextResponse.json(
    {
      status: "error",
      message,
      ...(detail !== undefined ? { detail } : {}),
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
  if (!UPTIMEROBOT_READ_ONLY_API_KEY) {
    return jsonError("UptimeRobot API key is missing", 503);
  }

  try {
    const body = new URLSearchParams({
      api_key: UPTIMEROBOT_READ_ONLY_API_KEY,
      format: "json",
      custom_uptime_ratios: "1-7-30",
      response_times: "1",
      response_times_limit: "1",
      response_times_average: "30",
    });

    if (UPTIMEROBOT_MONITOR_IDS) {
      body.set("monitors", UPTIMEROBOT_MONITOR_IDS);
    }

    const response = await fetch(UPTIMEROBOT_API_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "Cache-Control": "no-cache",
      },
      body: body.toString(),
      cache: "no-store",
    });

    if (!response.ok) {
      return jsonError(`UptimeRobot request failed with status ${response.status}`, response.status);
    }

    const payload = (await response.json()) as {
      stat?: string;
      error?: { message?: string };
      monitors?: RawUptimeRobotMonitor[];
    };

    if (payload.stat !== "ok") {
      return jsonError(payload.error?.message || "UptimeRobot returned a non-ok response", 502);
    }

    const monitors = (payload.monitors ?? []).map((monitor) => {
      const statusValue = Number.parseInt(String(monitor.status ?? ""), 10);
      const responseTime = Number.parseFloat(String(monitor.average_response_time ?? ""));
      const ratios = parseRatios(monitor.custom_uptime_ratio);
      const meta = statusMeta(Number.isFinite(statusValue) ? statusValue : -1);

      return {
        id: String(monitor.id ?? ""),
        name: monitor.friendly_name?.trim() || "Unnamed monitor",
        url: monitor.url?.trim() || null,
        status: Number.isFinite(statusValue) ? statusValue : null,
        status_label: meta.label,
        tone: meta.tone,
        average_response_time_ms: Number.isFinite(responseTime) ? responseTime : null,
        uptime_24h: ratios.ratio24h,
        uptime_7d: ratios.ratio7d,
        uptime_30d: ratios.ratio30d,
      };
    });

    return NextResponse.json(
      {
        status: "ok",
        generated_at: new Date().toISOString(),
        monitors,
      },
      {
        headers: {
          "Cache-Control": "no-store, max-age=0",
        },
      },
    );
  } catch (error) {
    return jsonError("Failed to load UptimeRobot monitor data", 500, {
      message: error instanceof Error ? error.message : "Unknown error",
    });
  }
}
