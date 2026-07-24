"use client";

import { useEffect, useMemo, useState } from "react";
import { Cloud, CloudRain, Sun, Thermometer, Wind, type LucideIcon } from "lucide-react";
import {
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import type { LiveSeriesPoint } from "@/components/telemetry/use-live-telemetry";
import type { WeatherSnapshot } from "@/lib/weather";

type WeatherLatestResponse = {
  provider: string;
  status: "healthy" | "offline";
  latest: WeatherSnapshot | null;
};

type WeatherHistoryResponse = {
  provider: string;
  points: WeatherSnapshot[];
};

type VisibleLine = "solar" | "cloud" | "temperature";

type ChartPoint = {
  timestamp: string;
  solar_production_w?: number | null;
  cloud_cover?: number | null;
  temperature_2m?: number | null;
};

const LINE_OPTIONS: Array<{ key: VisibleLine; label: string }> = [
  { key: "solar", label: "Solar" },
  { key: "cloud", label: "Clouds" },
  { key: "temperature", label: "Temp" },
];

function formatNumber(value: number | null | undefined, suffix: string, digits = 0) {
  return typeof value === "number" && Number.isFinite(value) ? `${value.toFixed(digits)}${suffix}` : "—";
}

function formatTimestamp(timestamp: string | null | undefined) {
  if (!timestamp) return "Awaiting update";

  return new Date(timestamp).toLocaleString([], {
    hour: "numeric",
    minute: "2-digit",
    month: "short",
    day: "numeric",
  });
}

function nearestWeatherFor(timestamp: string, weatherPoints: WeatherSnapshot[]) {
  const target = new Date(timestamp).getTime();
  let best: WeatherSnapshot | null = null;
  let bestDelta = Number.POSITIVE_INFINITY;

  for (const point of weatherPoints) {
    const delta = Math.abs(new Date(point.timestamp).getTime() - target);
    if (delta < bestDelta) {
      best = point;
      bestDelta = delta;
    }
  }

  return bestDelta <= 20 * 60 * 1000 ? best : null;
}

function buildChartData(series: LiveSeriesPoint[], weatherPoints: WeatherSnapshot[]): ChartPoint[] {
  const rows = new Map<string, ChartPoint>();

  for (const point of weatherPoints) {
    rows.set(point.timestamp, {
      timestamp: point.timestamp,
      cloud_cover: point.cloud_cover,
      temperature_2m: point.temperature_2m,
    });
  }

  for (const point of series.slice(-24 * 60)) {
    const weather = nearestWeatherFor(point.timestamp, weatherPoints);
    rows.set(point.timestamp, {
      ...(rows.get(point.timestamp) ?? { timestamp: point.timestamp }),
      solar_production_w: point.solar_production_w,
      cloud_cover: weather?.cloud_cover ?? rows.get(point.timestamp)?.cloud_cover ?? null,
      temperature_2m: weather?.temperature_2m ?? rows.get(point.timestamp)?.temperature_2m ?? null,
    });
  }

  return Array.from(rows.values())
    .sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime())
    .slice(-24 * 60);
}

export function LiveWeatherPanel({ series }: { series: LiveSeriesPoint[] }) {
  const [latest, setLatest] = useState<WeatherSnapshot | null>(null);
  const [history, setHistory] = useState<WeatherSnapshot[]>([]);
  const [visibleLines, setVisibleLines] = useState<Record<VisibleLine, boolean>>({
    solar: true,
    cloud: true,
    temperature: true,
  });

  useEffect(() => {
    const controller = new AbortController();

    async function loadWeather() {
      try {
        const [latestResponse, historyResponse] = await Promise.all([
          fetch("/api/weather/latest", { signal: controller.signal, cache: "no-store" }),
          fetch("/api/weather/history?hours=24", { signal: controller.signal, cache: "no-store" }),
        ]);

        if (latestResponse.ok) {
          const payload = (await latestResponse.json()) as WeatherLatestResponse;
          setLatest(payload.latest);
        }

        if (historyResponse.ok) {
          const payload = (await historyResponse.json()) as WeatherHistoryResponse;
          setHistory(payload.points);
        }
      } catch (error) {
        if ((error as Error).name !== "AbortError") {
          console.error(error);
        }
      }
    }

    void loadWeather();
    const interval = window.setInterval(loadWeather, 5 * 60 * 1000);

    return () => {
      controller.abort();
      window.clearInterval(interval);
    };
  }, []);

  const chartData = useMemo(() => buildChartData(series, history), [history, series]);
  const timeline = history.slice(-6).reverse();

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-5">
        <WeatherMetric icon={Thermometer} label="Temp" value={formatNumber(latest?.temperature_2m, "°C", 1)} />
        <WeatherMetric icon={Cloud} label="Cloud cover" value={formatNumber(latest?.cloud_cover, "%")} />
        <WeatherMetric icon={Sun} label="Radiation" value={formatNumber(latest?.shortwave_radiation, " W/m²")} />
        <WeatherMetric icon={Wind} label="Wind" value={formatNumber(latest?.wind_speed_10m, " km/h", 1)} />
        <WeatherMetric icon={CloudRain} label="Last updated" value={formatTimestamp(latest?.timestamp)} compact />
      </div>

      <Card className="overflow-hidden border-white/10 bg-slate-950/80">
        <CardHeader className="flex-row items-start justify-between gap-3 pb-2">
          <div>
            <CardTitle className="text-[11px] uppercase tracking-[0.24em] text-slate-400">
              Solar and weather overlay
            </CardTitle>
            <p className="mt-1 text-sm text-slate-500">
              Dual-axis view: production on the left, weather signals on the right.
            </p>
          </div>
          <div className="flex shrink-0 flex-wrap items-center gap-1 rounded-2xl border border-white/10 bg-white/[0.03] p-1">
            {LINE_OPTIONS.map((option) => (
              <Button
                key={option.key}
                type="button"
                size="sm"
                variant={visibleLines[option.key] ? "default" : "ghost"}
                className="h-8 px-3 text-[11px]"
                onClick={() =>
                  setVisibleLines((previous) => ({
                    ...previous,
                    [option.key]: !previous[option.key],
                  }))
                }
              >
                {option.label}
              </Button>
            ))}
          </div>
        </CardHeader>
        <CardContent className="pt-0">
          <div className="h-[340px] w-full">
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={chartData} margin={{ top: 16, right: 12, left: 0, bottom: 0 }}>
                <CartesianGrid stroke="rgba(148,163,184,0.14)" strokeDasharray="4 4" vertical={false} />
                <XAxis
                  dataKey="timestamp"
                  tickFormatter={(value) =>
                    new Date(String(value)).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })
                  }
                  tickLine={false}
                  axisLine={false}
                  tick={{ fill: "#94a3b8", fontSize: 11 }}
                />
                <YAxis
                  yAxisId="left"
                  tickLine={false}
                  axisLine={false}
                  tick={{ fill: "#94a3b8", fontSize: 11 }}
                  tickFormatter={(value) => `${Math.round(Number(value) / 1000)} kW`}
                />
                <YAxis
                  yAxisId="right"
                  orientation="right"
                  tickLine={false}
                  axisLine={false}
                  tick={{ fill: "#94a3b8", fontSize: 11 }}
                  domain={[0, 100]}
                  tickFormatter={(value) => `${Math.round(Number(value))}`}
                />
                <Tooltip
                  contentStyle={{
                    background: "rgba(2, 6, 23, 0.96)",
                    border: "1px solid rgba(148, 163, 184, 0.16)",
                    borderRadius: "18px",
                    color: "#e2e8f0",
                  }}
                  labelFormatter={(label) => formatTimestamp(String(label))}
                />
                <Legend />
                {visibleLines.solar ? (
                  <Line
                    yAxisId="left"
                    type="monotone"
                    dataKey="solar_production_w"
                    name="Solar W"
                    stroke="#facc15"
                    strokeWidth={3}
                    dot={false}
                    connectNulls
                  />
                ) : null}
                {visibleLines.cloud ? (
                  <Line
                    yAxisId="right"
                    type="monotone"
                    dataKey="cloud_cover"
                    name="Cloud %"
                    stroke="#94a3b8"
                    strokeWidth={2}
                    dot={false}
                    connectNulls
                  />
                ) : null}
                {visibleLines.temperature ? (
                  <Line
                    yAxisId="right"
                    type="monotone"
                    dataKey="temperature_2m"
                    name="Temp °C"
                    stroke="#38bdf8"
                    strokeWidth={2}
                    dot={false}
                    connectNulls
                  />
                ) : null}
              </LineChart>
            </ResponsiveContainer>
          </div>
        </CardContent>
      </Card>

      <Card className="border-white/10 bg-slate-950/80">
        <CardHeader className="pb-2">
          <CardTitle className="text-[11px] uppercase tracking-[0.24em] text-slate-400">
            Weather timeline
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-2 pt-0">
          {timeline.length === 0 ? (
            <div className="rounded-2xl border border-dashed border-white/10 bg-white/[0.02] p-4 text-sm text-slate-400">
              No weather snapshots have landed yet.
            </div>
          ) : (
            timeline.map((point) => (
              <div
                key={point.timestamp}
                className="flex items-center justify-between gap-3 rounded-2xl border border-white/[0.08] bg-white/[0.03] px-4 py-3 text-sm"
              >
                <span className="font-medium text-slate-200">{formatTimestamp(point.timestamp)}</span>
                <span className="text-slate-400">
                  {formatNumber(point.temperature_2m, "°C", 1)} · {formatNumber(point.cloud_cover, "%")} clouds ·{" "}
                  {formatNumber(point.shortwave_radiation, " W/m²")}
                </span>
              </div>
            ))
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function WeatherMetric({
  icon: Icon,
  label,
  value,
  compact,
}: {
  icon: LucideIcon;
  label: string;
  value: string;
  compact?: boolean;
}) {
  return (
    <Card className="border-white/10 bg-slate-950/80">
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center gap-2 text-[11px] uppercase tracking-[0.24em] text-slate-400">
          <Icon className="h-4 w-4 text-sky-300" />
          {label}
        </CardTitle>
      </CardHeader>
      <CardContent className="pt-0">
        <div className={`${compact ? "text-sm" : "text-2xl"} font-semibold text-slate-50`}>{value}</div>
      </CardContent>
    </Card>
  );
}
