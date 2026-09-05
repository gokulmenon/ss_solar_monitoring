"use client";

import { useEffect, useMemo, useState } from "react";
import {
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import type { CsvWeatherHistoryResponse } from "@/lib/csv-weather-history";
import type { HistoryResponse } from "@/lib/history";

function formatTime(timestamp: string) {
  return new Date(timestamp).toLocaleDateString([], { month: "short", day: "numeric", hour: "numeric" });
}

function formatValue(value: number | null | undefined, suffix: string, digits = 0) {
  return typeof value === "number" && Number.isFinite(value) ? `${value.toFixed(digits)}${suffix}` : "—";
}

function nearestSolar(timestamp: string, history: HistoryResponse | null) {
  const target = new Date(timestamp).getTime();
  let closest = null as HistoryResponse["points"][number] | null;
  let closestDelta = Number.POSITIVE_INFINITY;

  for (const point of history?.points ?? []) {
    const delta = Math.abs(new Date(point.timestamp).getTime() - target);
    if (delta < closestDelta) {
      closest = point;
      closestDelta = delta;
    }
  }

  return closestDelta <= 90 * 60 * 1000 ? closest?.solar_production_w ?? null : null;
}

export function CsvWeatherHistorySection() {
  const [weather, setWeather] = useState<CsvWeatherHistoryResponse | null>(null);
  const [meterHistory, setMeterHistory] = useState<HistoryResponse | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const controller = new AbortController();

    async function loadData() {
      try {
        const [weatherResponse, meterResponse] = await Promise.all([
          fetch("/api/history/weather", { signal: controller.signal, cache: "no-store" }),
          fetch("/api/history?source=csv", { signal: controller.signal, cache: "no-store" }),
        ]);

        if (weatherResponse.ok) setWeather((await weatherResponse.json()) as CsvWeatherHistoryResponse);
        if (meterResponse.ok) setMeterHistory((await meterResponse.json()) as HistoryResponse);
      } catch (error) {
        if ((error as Error).name !== "AbortError") console.error(error);
      } finally {
        setLoading(false);
      }
    }

    void loadData();
    return () => controller.abort();
  }, []);

  const chartData = useMemo(
    () =>
      (weather?.points ?? []).map((point) => ({
        ...point,
        solar_production_w: nearestSolar(point.timestamp, meterHistory),
      })),
    [meterHistory, weather?.points],
  );
  const latest = weather?.points.at(-1);

  return (
    <section className="space-y-4">
      <div>
        <p className="text-[11px] uppercase tracking-[0.26em] text-slate-400">CSV archive</p>
        <h2 className="mt-1 text-xl font-semibold tracking-tight text-slate-50">Weather and solar</h2>
        <p className="mt-1 text-sm text-slate-400">
          Relay-local weather readings aligned with the CSV solar archive.
        </p>
      </div>

      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Metric label="Temperature" value={loading ? "…" : formatValue(latest?.temperature_2m, "°C", 1)} tone="text-sky-300" />
        <Metric label="Cloud cover" value={loading ? "…" : formatValue(latest?.cloud_cover, "%")} tone="text-slate-200" />
        <Metric label="Solar radiation" value={loading ? "…" : formatValue(latest?.shortwave_radiation, " W/m²")} tone="text-amber-300" />
        <Metric label="Wind" value={loading ? "…" : formatValue(latest?.wind_speed_10m, " km/h", 1)} tone="text-cyan-300" />
      </div>

      <Card className="overflow-hidden border-white/10 bg-slate-950/80">
        <CardHeader className="pb-2">
          <CardTitle className="text-[11px] uppercase tracking-[0.24em] text-slate-400">
            Weather / solar overlay
          </CardTitle>
        </CardHeader>
        <CardContent className="pt-0">
          {!loading && chartData.length === 0 ? (
            <div className="rounded-2xl border border-dashed border-white/10 bg-white/[0.02] px-4 py-8 text-center text-sm text-slate-400">
              No weather CSV archive has been recorded yet. The relay writes a row after each successful weather poll.
            </div>
          ) : (
            <div className="h-[300px] w-full">
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={chartData} margin={{ top: 16, right: 12, left: 0, bottom: 0 }}>
                  <CartesianGrid stroke="rgba(148,163,184,0.14)" strokeDasharray="4 4" vertical={false} />
                  <XAxis
                    dataKey="timestamp"
                    tickFormatter={(value) => formatTime(String(value))}
                    tickLine={false}
                    axisLine={false}
                    tick={{ fill: "#94a3b8", fontSize: 11 }}
                  />
                  <YAxis
                    yAxisId="solar"
                    tickLine={false}
                    axisLine={false}
                    width={50}
                    tick={{ fill: "#facc15", fontSize: 11 }}
                    tickFormatter={(value) => `${Math.round(Number(value) / 1000)}k`}
                  />
                  <YAxis
                    yAxisId="weather"
                    orientation="right"
                    tickLine={false}
                    axisLine={false}
                    tick={{ fill: "#7dd3fc", fontSize: 11 }}
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
                  <Line yAxisId="solar" type="monotone" dataKey="solar_production_w" name="Solar W" stroke="#facc15" strokeWidth={3} dot={false} connectNulls />
                  <Line yAxisId="weather" type="monotone" dataKey="temperature_2m" name="Temp °C" stroke="#38bdf8" strokeWidth={2} dot={false} connectNulls />
                  <Line yAxisId="weather" type="monotone" dataKey="cloud_cover" name="Cloud %" stroke="#cbd5e1" strokeWidth={2} dot={false} connectNulls />
                  <Line yAxisId="weather" type="monotone" dataKey="shortwave_radiation" name="Radiation W/m²" stroke="#fb923c" strokeWidth={2} dot={false} connectNulls />
                </LineChart>
              </ResponsiveContainer>
            </div>
          )}
        </CardContent>
      </Card>
    </section>
  );
}

function Metric({ label, value, tone }: { label: string; value: string; tone: string }) {
  return (
    <Card className="border-white/10 bg-slate-950/80">
      <CardHeader className="pb-2">
        <CardTitle className="text-[11px] uppercase tracking-[0.2em] text-slate-400">{label}</CardTitle>
      </CardHeader>
      <CardContent className="pt-0">
        <div className={`text-xl font-semibold ${tone}`}>{value}</div>
      </CardContent>
    </Card>
  );
}
