"use client";

import { useEffect, useMemo, useState } from "react";
import {
  Area,
  Bar,
  CartesianGrid,
  ComposedChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import type { HistoryPoint } from "@/lib/mock-data";

function formatHour(timestamp: string) {
  return new Date(timestamp).toLocaleTimeString([], {
    hour: "numeric",
  });
}

function formatKwh(value: number) {
  return `${value >= 0 ? "" : "-"}${Math.abs(value).toFixed(2)} kWh`;
}

export function HistoryDashboard() {
  const [data, setData] = useState<HistoryPoint[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const controller = new AbortController();

    async function loadHistory() {
      try {
        const response = await fetch("/api/history", {
          signal: controller.signal,
          cache: "no-store",
        });

        if (!response.ok) {
          throw new Error(`History request failed: ${response.status}`);
        }

        const payload = (await response.json()) as HistoryPoint[];
        setData(payload);
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

  const summary = useMemo(() => {
    const totals = data.reduce(
      (acc, point) => ({
        solar: acc.solar + point.solar_kwh,
        home: acc.home + point.home_kwh,
        grid: acc.grid + point.grid_kwh,
      }),
      { solar: 0, home: 0, grid: 0 },
    );

    const peakSolar = data.reduce((max, point) => Math.max(max, point.solar_kwh), 0);
    const peakExport = data.reduce(
      (max, point) => Math.max(max, Math.abs(Math.min(point.grid_kwh, 0))),
      0,
    );

    return {
      totals,
      peakSolar,
      peakExport,
    };
  }, [data]);

  return (
    <div className="space-y-4">
      <div className="flex items-start justify-between gap-4">
        <div>
          <p className="text-[11px] uppercase tracking-[0.26em] text-slate-400">History</p>
          <h1 className="mt-1 text-2xl font-semibold tracking-tight text-slate-50">
            Daily yield
          </h1>
          <p className="mt-1 text-sm text-slate-400">
            Cloud REST data aggregated into a touch-friendly chart.
          </p>
        </div>
        <Badge variant="secondary">REST / fetch</Badge>
      </div>

      <div className="grid grid-cols-2 gap-3">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-[11px] uppercase tracking-[0.24em] text-slate-400">
              Solar today
            </CardTitle>
          </CardHeader>
          <CardContent className="pt-0">
            <div className="text-2xl font-semibold text-emerald-300">
              {loading ? "..." : `${summary.totals.solar.toFixed(2)} kWh`}
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-[11px] uppercase tracking-[0.24em] text-slate-400">
              Peak export
            </CardTitle>
          </CardHeader>
          <CardContent className="pt-0">
            <div className="text-2xl font-semibold text-sky-300">
              {loading ? "..." : `${summary.peakExport.toFixed(2)} kWh`}
            </div>
          </CardContent>
        </Card>
      </div>

      <Card className="overflow-hidden">
        <CardHeader className="pb-2">
          <CardTitle className="text-[11px] uppercase tracking-[0.24em] text-slate-400">
            24 hour panel view
          </CardTitle>
        </CardHeader>
        <CardContent className="pt-0">
          <div className="h-[320px] w-full">
            <ResponsiveContainer width="100%" height="100%">
              <ComposedChart data={data} margin={{ top: 16, right: 12, left: -8, bottom: 0 }}>
                <CartesianGrid stroke="rgba(148,163,184,0.14)" strokeDasharray="4 4" vertical={false} />
                <XAxis
                  dataKey="timestamp"
                  tickFormatter={formatHour}
                  tickLine={false}
                  axisLine={false}
                  interval={2}
                  tick={{ fill: "#94a3b8", fontSize: 11 }}
                />
                <YAxis
                  tickLine={false}
                  axisLine={false}
                  tick={{ fill: "#94a3b8", fontSize: 11 }}
                  width={36}
                />
                <Tooltip
                  contentStyle={{
                    background: "rgba(2, 6, 23, 0.96)",
                    border: "1px solid rgba(148, 163, 184, 0.16)",
                    borderRadius: "18px",
                    color: "#e2e8f0",
                    boxShadow: "0 20px 80px rgba(2, 6, 23, 0.5)",
                  }}
                  labelFormatter={(label) => new Date(String(label)).toLocaleString([], {
                    hour: "numeric",
                    minute: "2-digit",
                  })}
                  formatter={(value: number, name: string) => {
                    if (name === "solar_kwh") return [formatKwh(value), "Solar"];
                    if (name === "home_kwh") return [formatKwh(value), "Home"];
                    return [formatKwh(value), "Grid"];
                  }}
                />
                <Area
                  type="monotone"
                  dataKey="home_kwh"
                  stroke="#38bdf8"
                  fill="rgba(56, 189, 248, 0.16)"
                  strokeWidth={2.25}
                />
                <Bar
                  dataKey="solar_kwh"
                  fill="rgba(52, 211, 153, 0.88)"
                  radius={[12, 12, 4, 4]}
                  barSize={24}
                />
                <Bar
                  dataKey="grid_kwh"
                  fill="rgba(251, 191, 36, 0.62)"
                  radius={[12, 12, 4, 4]}
                  barSize={14}
                />
              </ComposedChart>
            </ResponsiveContainer>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-[11px] uppercase tracking-[0.24em] text-slate-400">
            Readout
          </CardTitle>
        </CardHeader>
        <CardContent className="grid grid-cols-2 gap-3 pt-0 text-sm text-slate-300">
          <div className="rounded-2xl border border-white/[0.08] bg-white/[0.03] p-3">
            <div className="text-slate-500">Total home load</div>
            <div className="mt-1 text-lg font-semibold text-slate-100">
              {loading ? "..." : `${summary.totals.home.toFixed(2)} kWh`}
            </div>
          </div>
          <div className="rounded-2xl border border-white/[0.08] bg-white/[0.03] p-3">
            <div className="text-slate-500">Net grid exchange</div>
            <div className="mt-1 text-lg font-semibold text-slate-100">
              {loading ? "..." : `${summary.totals.grid.toFixed(2)} kWh`}
            </div>
          </div>
          <div className="rounded-2xl border border-white/[0.08] bg-white/[0.03] p-3">
            <div className="text-slate-500">Peak solar hour</div>
            <div className="mt-1 text-lg font-semibold text-slate-100">
              {loading ? "..." : `${summary.peakSolar.toFixed(2)} kWh`}
            </div>
          </div>
          <div className="rounded-2xl border border-white/[0.08] bg-white/[0.03] p-3">
            <div className="text-slate-500">Source</div>
            <div className="mt-1 text-lg font-semibold text-slate-100">Cloud REST mock</div>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
