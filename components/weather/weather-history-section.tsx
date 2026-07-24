"use client";

import { useEffect, useMemo, useState } from "react";
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
import { pearsonCorrelation } from "@/lib/analytics";
import type { HistoryPoint, HistoryResponse } from "@/lib/history";
import type { DailyWeatherSummary, WeatherSnapshot } from "@/lib/weather";

type WeatherHistoryResponse = {
  points: WeatherSnapshot[];
  dailySummary: DailyWeatherSummary[];
};

type HistoryRange = "6h" | "1d" | "7d" | "30d";
type VisibleLine = "solar" | "temperature" | "cloud" | "radiation";

type OverlayPoint = {
  timestamp: string;
  solar_production_w: number | null;
  temperature_2m: number | null;
  cloud_cover: number | null;
  shortwave_radiation: number | null;
};

const RANGE_OPTIONS: Array<{ label: string; value: HistoryRange; hours: number }> = [
  { label: "6h", value: "6h", hours: 6 },
  { label: "1d", value: "1d", hours: 24 },
  { label: "7d", value: "7d", hours: 7 * 24 },
  { label: "30d", value: "30d", hours: 30 * 24 },
];

const LINE_OPTIONS: Array<{ label: string; value: VisibleLine }> = [
  { label: "Solar", value: "solar" },
  { label: "Temp", value: "temperature" },
  { label: "Clouds", value: "cloud" },
  { label: "Radiation", value: "radiation" },
];

function formatTimeLabel(timestamp: string, windowHours: number) {
  if (windowHours > 24) {
    return new Date(timestamp).toLocaleDateString([], { month: "short", day: "numeric" });
  }

  return new Date(timestamp).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

function formatNumber(value: number | null | undefined, suffix: string, digits = 0) {
  return typeof value === "number" && Number.isFinite(value) ? `${value.toFixed(digits)}${suffix}` : "—";
}

function nearestSolarFor(timestamp: string, history: HistoryPoint[]) {
  const target = new Date(timestamp).getTime();
  let best: HistoryPoint | null = null;
  let bestDelta = Number.POSITIVE_INFINITY;

  for (const point of history) {
    const delta = Math.abs(new Date(point.timestamp).getTime() - target);
    if (delta < bestDelta) {
      best = point;
      bestDelta = delta;
    }
  }

  return bestDelta <= 20 * 60 * 1000 ? best : null;
}

function buildOverlayData(history: HistoryPoint[], weather: WeatherSnapshot[]): OverlayPoint[] {
  return weather
    .map((point) => {
      const solar = nearestSolarFor(point.timestamp, history);

      return {
        timestamp: point.timestamp,
        solar_production_w: solar?.solar_production_w ?? null,
        temperature_2m: point.temperature_2m,
        cloud_cover: point.cloud_cover,
        shortwave_radiation: point.shortwave_radiation,
      };
    })
    .filter(
      (point) =>
        point.solar_production_w !== null ||
        point.temperature_2m !== null ||
        point.cloud_cover !== null ||
        point.shortwave_radiation !== null,
    );
}

function describeCorrelation(value: number | null) {
  if (value === null) return "Need more overlapping samples";
  const strength = Math.abs(value) >= 0.7 ? "strong" : Math.abs(value) >= 0.35 ? "moderate" : "weak";
  const direction = value < 0 ? "inverse" : "positive";
  return `${strength} ${direction} relationship`;
}

export function WeatherHistorySection() {
  const [weatherPoints, setWeatherPoints] = useState<WeatherSnapshot[]>([]);
  const [dailySummary, setDailySummary] = useState<DailyWeatherSummary[]>([]);
  const [historyPoints, setHistoryPoints] = useState<HistoryPoint[]>([]);
  const [loading, setLoading] = useState(true);
  const [range, setRange] = useState<HistoryRange>("30d");
  const [visibleLines, setVisibleLines] = useState<Record<VisibleLine, boolean>>({
    solar: true,
    temperature: true,
    cloud: true,
    radiation: true,
  });

  const rangeHours = RANGE_OPTIONS.find((option) => option.value === range)?.hours ?? 30 * 24;

  useEffect(() => {
    const controller = new AbortController();

    async function loadData() {
      try {
        const [weatherResponse, historyResponse] = await Promise.all([
          fetch(`/api/weather/history?hours=${rangeHours}`, {
            signal: controller.signal,
            cache: "no-store",
          }),
          fetch("/api/history?source=supabase", {
            signal: controller.signal,
            cache: "no-store",
          }),
        ]);

        if (weatherResponse.ok) {
          const payload = (await weatherResponse.json()) as WeatherHistoryResponse;
          setWeatherPoints(payload.points);
          setDailySummary(payload.dailySummary);
        }

        if (historyResponse.ok) {
          const payload = (await historyResponse.json()) as HistoryResponse;
          setHistoryPoints(payload.points);
        }
      } catch (error) {
        if ((error as Error).name !== "AbortError") {
          console.error(error);
        }
      } finally {
        setLoading(false);
      }
    }

    setLoading(true);
    void loadData();

    return () => controller.abort();
  }, [rangeHours]);

  const cutoff = Date.now() - rangeHours * 60 * 60 * 1000;
  const filteredHistory = useMemo(
    () => historyPoints.filter((point) => new Date(point.timestamp).getTime() >= cutoff),
    [cutoff, historyPoints],
  );
  const filteredWeather = useMemo(
    () => weatherPoints.filter((point) => new Date(point.timestamp).getTime() >= cutoff),
    [cutoff, weatherPoints],
  );
  const overlayData = useMemo(
    () => buildOverlayData(filteredHistory, filteredWeather),
    [filteredHistory, filteredWeather],
  );

  const cloudCorrelation = useMemo(
    () =>
      pearsonCorrelation(
        overlayData.map((point) => ({
          x: point.cloud_cover,
          y: point.solar_production_w,
        })),
      ),
    [overlayData],
  );
  const temperatureCorrelation = useMemo(
    () =>
      pearsonCorrelation(
        overlayData.map((point) => ({
          x: point.temperature_2m,
          y: point.solar_production_w,
        })),
      ),
    [overlayData],
  );

  const latestDaily = dailySummary[0];

  return (
    <div className="space-y-4">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <p className="text-[11px] uppercase tracking-[0.26em] text-slate-400">Weather</p>
          <h2 className="mt-1 text-xl font-semibold tracking-tight text-slate-50">
            Weather and solar correlation
          </h2>
          <p className="mt-1 text-sm text-slate-400">
            Open-Meteo snapshots aligned with Supabase solar production rows.
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-1 rounded-2xl border border-white/10 bg-white/[0.03] p-1">
          {RANGE_OPTIONS.map((option) => (
            <Button
              key={option.value}
              type="button"
              size="sm"
              variant={range === option.value ? "default" : "ghost"}
              className="h-8 px-3 text-[11px]"
              onClick={() => setRange(option.value)}
            >
              {option.label}
            </Button>
          ))}
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3 md:grid-cols-5">
        <SummaryMetric label="Min temp" value={formatNumber(latestDaily?.min_temperature_2m, "°C", 1)} />
        <SummaryMetric label="Max temp" value={formatNumber(latestDaily?.max_temperature_2m, "°C", 1)} />
        <SummaryMetric label="Avg clouds" value={formatNumber(latestDaily?.avg_cloud_cover, "%")} />
        <SummaryMetric label="Peak radiation" value={formatNumber(latestDaily?.peak_radiation, " W/m²")} />
        <SummaryMetric label="Rainfall" value={formatNumber(latestDaily?.total_precipitation, " mm", 2)} />
      </div>

      <Card className="overflow-hidden border-white/10 bg-slate-950/80">
        <CardHeader className="flex-row items-start justify-between gap-3 pb-2">
          <div>
            <CardTitle className="text-[11px] uppercase tracking-[0.24em] text-slate-400">
              Overlay chart
            </CardTitle>
            <p className="mt-1 text-sm text-slate-500">
              Primary axis is solar output. Secondary axis overlays weather signals.
            </p>
          </div>
          <div className="flex shrink-0 flex-wrap items-center gap-1 rounded-2xl border border-white/10 bg-white/[0.03] p-1">
            {LINE_OPTIONS.map((option) => (
              <Button
                key={option.value}
                type="button"
                size="sm"
                variant={visibleLines[option.value] ? "default" : "ghost"}
                className="h-8 px-3 text-[11px]"
                onClick={() =>
                  setVisibleLines((previous) => ({
                    ...previous,
                    [option.value]: !previous[option.value],
                  }))
                }
              >
                {option.label}
              </Button>
            ))}
          </div>
        </CardHeader>
        <CardContent className="pt-0">
          {!loading && overlayData.length === 0 ? (
            <div className="rounded-3xl border border-dashed border-white/10 bg-white/[0.02] px-4 py-10 text-center text-sm text-slate-400">
              No overlapping weather and solar rows yet. Once the relay writes weather snapshots,
              this chart will fill in.
            </div>
          ) : (
            <div className="h-[360px] w-full">
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={overlayData} margin={{ top: 16, right: 12, left: 0, bottom: 0 }}>
                  <CartesianGrid stroke="rgba(148,163,184,0.14)" strokeDasharray="4 4" vertical={false} />
                  <XAxis
                    dataKey="timestamp"
                    tickFormatter={(value) => formatTimeLabel(String(value), rangeHours)}
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
                  />
                  <Tooltip
                    contentStyle={{
                      background: "rgba(2, 6, 23, 0.96)",
                      border: "1px solid rgba(148, 163, 184, 0.16)",
                      borderRadius: "18px",
                      color: "#e2e8f0",
                    }}
                    labelFormatter={(label) => new Date(String(label)).toLocaleString()}
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
                  {visibleLines.radiation ? (
                    <Line
                      yAxisId="right"
                      type="monotone"
                      dataKey="shortwave_radiation"
                      name="Radiation W/m²"
                      stroke="#fb923c"
                      strokeWidth={2}
                      dot={false}
                      connectNulls
                    />
                  ) : null}
                </LineChart>
              </ResponsiveContainer>
            </div>
          )}
        </CardContent>
      </Card>

      <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
        <CorrelationCard
          label="Cloud cover vs output"
          value={cloudCorrelation}
          detail={describeCorrelation(cloudCorrelation)}
        />
        <CorrelationCard
          label="Temperature vs output"
          value={temperatureCorrelation}
          detail={describeCorrelation(temperatureCorrelation)}
        />
      </div>
    </div>
  );
}

function SummaryMetric({ label, value }: { label: string; value: string }) {
  return (
    <Card className="border-white/10 bg-slate-950/80">
      <CardHeader className="pb-2">
        <CardTitle className="text-[11px] uppercase tracking-[0.24em] text-slate-400">
          {label}
        </CardTitle>
      </CardHeader>
      <CardContent className="pt-0">
        <div className="text-2xl font-semibold text-slate-50">{value}</div>
      </CardContent>
    </Card>
  );
}

function CorrelationCard({
  label,
  value,
  detail,
}: {
  label: string;
  value: number | null;
  detail: string;
}) {
  return (
    <Card className="border-white/10 bg-slate-950/80">
      <CardHeader className="pb-2">
        <CardTitle className="text-[11px] uppercase tracking-[0.24em] text-slate-400">
          {label}
        </CardTitle>
      </CardHeader>
      <CardContent className="pt-0">
        <div className="text-4xl font-semibold text-slate-50">
          {value === null ? "—" : value.toFixed(2)}
        </div>
        <p className="mt-2 text-sm text-slate-400">{detail}</p>
      </CardContent>
    </Card>
  );
}
