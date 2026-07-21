"use client";

import { useEffect, useMemo, useState } from "react";
import {
  Area,
  CartesianGrid,
  ComposedChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import type { HistoryPoint, HistoryResponse } from "@/lib/history";

type HistoryRange = "6h" | "1d" | "7d" | "30d";

const RANGE_OPTIONS: Array<{ label: string; value: HistoryRange; hours: number }> = [
  { label: "6h", value: "6h", hours: 6 },
  { label: "1d", value: "1d", hours: 24 },
  { label: "7d", value: "7d", hours: 7 * 24 },
  { label: "30d", value: "30d", hours: 30 * 24 },
];

function formatTimeLabel(timestamp: string, windowHours: number) {
  if (windowHours > 24) {
    return new Date(timestamp).toLocaleDateString([], {
      month: "short",
      day: "numeric",
    });
  }

  return new Date(timestamp).toLocaleTimeString([], {
    hour: "numeric",
    minute: windowHours <= 6 ? "2-digit" : undefined,
  });
}

function formatWattage(value: number) {
  return `${value >= 0 ? "" : "-"}${Math.abs(Math.round(value)).toLocaleString()} W`;
}

function formatEnergy(value: number) {
  return `${value.toFixed(2)} kWh`;
}

function formatWindowLabel(windowHours: number) {
  if (windowHours >= 24 && windowHours % 24 === 0) {
    return `${windowHours / 24}-day`;
  }

  return `${windowHours}-hour`;
}

export function HistoryDashboard() {
  const [history, setHistory] = useState<HistoryResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [sourceLabel, setSourceLabel] = useState("Local CSV logs");
  const [range, setRange] = useState<HistoryRange>("30d");

  useEffect(() => {
    const controller = new AbortController();

    async function loadHistory() {
      try {
        const response = await fetch("/api/history?source=csv", {
          signal: controller.signal,
          cache: "no-store",
        });

        if (!response.ok) {
          throw new Error(`History request failed: ${response.status}`);
        }

        const csvSource = response.headers.get("x-history-csv-source");
        setSourceLabel(
          csvSource === "deployed-snapshot" ? "Deployed CSV snapshot" : "Local CSV logs",
        );

        const payload = (await response.json()) as HistoryResponse;
        setHistory(payload);
      } catch (error) {
        if ((error as Error).name !== "AbortError") {
          console.error(error);
        }
      } finally {
        setLoading(false);
      }
    }

    void loadHistory();

    return () => controller.abort();
  }, []);

  const rangeHours = RANGE_OPTIONS.find((option) => option.value === range)?.hours ?? 30 * 24;
  const data = useMemo<HistoryPoint[]>(() => {
    const points = history?.points ?? [];
    const cutoff = Date.now() - rangeHours * 60 * 60 * 1000;

    return points.filter((point) => new Date(point.timestamp).getTime() >= cutoff);
  }, [history?.points, rangeHours]);
  const summary = history?.summary;
  const windowHours = rangeHours;
  const hasData = data.length > 0;

  const stats = useMemo(
    () => [
      {
        label: "Imported energy",
        value: loading ? "..." : hasData ? formatEnergy(summary?.imported_kwh ?? 0) : "—",
        tone: "text-amber-300",
      },
      {
        label: "Exported energy",
        value: loading ? "..." : hasData ? formatEnergy(summary?.exported_kwh ?? 0) : "—",
        tone: "text-emerald-300",
      },
      {
        label: "Solar yield",
        value: loading ? "..." : hasData ? formatEnergy(summary?.solar_kwh ?? 0) : "—",
        tone: "text-yellow-300",
      },
      {
        label: "Peak import",
        value: loading ? "..." : hasData ? formatWattage(summary?.peak_import_w ?? 0) : "—",
        tone: "text-rose-300",
      },
    ],
    [loading, summary, hasData],
  );

  return (
    <div className="space-y-4">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <p className="text-[11px] uppercase tracking-[0.26em] text-slate-400">History</p>
          <h1 className="mt-1 text-2xl font-semibold tracking-tight text-slate-50">
            Log-backed grid history
          </h1>
          <p className="mt-1 text-sm text-slate-400">
            This view reads live CSV logs on localhost and the deployed CSV snapshot on Vercel.
          </p>
        </div>
        <Badge variant="secondary">{sourceLabel}</Badge>
      </div>

      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        {stats.map((item) => (
          <Card key={item.label} className="border-white/10 bg-slate-950/80">
            <CardHeader className="pb-2">
              <CardTitle className="text-[11px] uppercase tracking-[0.24em] text-slate-400">
                {item.label}
              </CardTitle>
            </CardHeader>
            <CardContent className="pt-0">
              <div className={`text-2xl font-semibold ${item.tone}`}>{item.value}</div>
            </CardContent>
          </Card>
        ))}
      </div>

      <Card className="overflow-hidden border-white/10 bg-slate-950/80">
        <CardHeader className="flex-row items-start justify-between gap-3 pb-2">
          <CardTitle className="text-[11px] uppercase tracking-[0.24em] text-slate-400">
            {formatWindowLabel(windowHours)} CSV history
          </CardTitle>
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
        </CardHeader>
        <CardContent className="pt-0">
          {!loading && !hasData ? (
            <div className="rounded-3xl border border-dashed border-white/10 bg-white/[0.02] px-4 py-10 text-center text-sm text-slate-400">
              {sourceLabel === "Deployed CSV snapshot"
                ? "No deployed CSV snapshot found yet. Commit the logs folder and rebuild Vercel to populate this view."
                : "No local CSV logs found yet. Start the relay with CSV logging enabled and this view will fill in automatically."}
            </div>
          ) : (
            <div className="h-[340px] w-full md:h-[380px]">
              <ResponsiveContainer width="100%" height="100%">
                <ComposedChart data={data} margin={{ top: 16, right: 20, left: 0, bottom: 0 }}>
                  <CartesianGrid
                    stroke="rgba(148,163,184,0.14)"
                    strokeDasharray="4 4"
                    vertical={false}
                  />
                  <XAxis
                    dataKey="timestamp"
                    tickFormatter={(value) => formatTimeLabel(String(value), windowHours)}
                    tickLine={false}
                    axisLine={false}
                    interval={Math.max(1, Math.floor(Math.max(data.length, 1) / 8))}
                    tick={{ fill: "#94a3b8", fontSize: 11 }}
                  />
                  <YAxis
                    yAxisId="left"
                    tickLine={false}
                    axisLine={false}
                    tick={{ fill: "#94a3b8", fontSize: 11 }}
                    width={56}
                    tickFormatter={(value) => formatWattage(Number(value))}
                  />
                  <Tooltip
                    contentStyle={{
                      background: "rgba(2, 6, 23, 0.96)",
                      border: "1px solid rgba(148, 163, 184, 0.16)",
                      borderRadius: "18px",
                      color: "#e2e8f0",
                      boxShadow: "0 20px 80px rgba(2, 6, 23, 0.5)",
                    }}
                    labelFormatter={(label) =>
                      new Date(String(label)).toLocaleString([], {
                        weekday: windowHours >= 24 ? "short" : undefined,
                        month: windowHours > 24 ? "short" : undefined,
                        day: windowHours > 24 ? "numeric" : undefined,
                        hour: "numeric",
                        minute: "2-digit",
                      })
                    }
                    formatter={(value: number, name: string) => {
                      if (name === "solar_production_w") {
                        return [formatWattage(value), "Solar Production"];
                      }

                      return [formatWattage(value), "Net Grid Power"];
                    }}
                  />
                  <Area
                    yAxisId="left"
                    type="monotone"
                    dataKey="solar_production_w"
                    stroke="#facc15"
                    fill="rgba(250, 204, 21, 0.16)"
                    strokeWidth={3}
                    connectNulls
                    activeDot={{ r: 7, strokeWidth: 2, stroke: "#facc15", fill: "#0f172a" }}
                  />
                  <Area
                    yAxisId="left"
                    type="monotone"
                    dataKey="net_grid_w"
                    stroke="#60a5fa"
                    fill="rgba(96, 165, 250, 0.20)"
                    strokeWidth={3}
                    activeDot={{ r: 7, strokeWidth: 2, stroke: "#60a5fa", fill: "#0f172a" }}
                  />
                </ComposedChart>
              </ResponsiveContainer>
            </div>
          )}
        </CardContent>
      </Card>

      <Card className="border-white/10 bg-slate-950/80">
        <CardHeader className="pb-2">
          <CardTitle className="text-[11px] uppercase tracking-[0.24em] text-slate-400">
            Readout
          </CardTitle>
        </CardHeader>
        <CardContent className="grid grid-cols-2 gap-3 pt-0 text-sm text-slate-300 md:grid-cols-4">
          <div className="rounded-2xl border border-white/[0.08] bg-white/[0.03] p-3">
            <div className="text-slate-500">Peak export</div>
            <div className="mt-1 text-lg font-semibold text-slate-100">
              {loading ? "..." : hasData ? formatWattage(summary?.peak_export_w ?? 0) : "—"}
            </div>
          </div>
          <div className="rounded-2xl border border-white/[0.08] bg-white/[0.03] p-3">
            <div className="text-slate-500">Peak solar</div>
            <div className="mt-1 text-lg font-semibold text-slate-100">
              {loading ? "..." : hasData ? formatWattage(summary?.peak_solar_w ?? 0) : "—"}
            </div>
          </div>
          <div className="rounded-2xl border border-white/[0.08] bg-white/[0.03] p-3">
            <div className="text-slate-500">Data source</div>
            <div className="mt-1 text-lg font-semibold text-slate-100">
              {loading ? "..." : sourceLabel}
            </div>
          </div>
          <div className="rounded-2xl border border-white/[0.08] bg-white/[0.03] p-3">
            <div className="text-slate-500">Window</div>
            <div className="mt-1 text-lg font-semibold text-slate-100">
              {loading ? "..." : hasData ? formatWindowLabel(windowHours) : "—"}
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
