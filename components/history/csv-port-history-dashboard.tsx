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

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { csvHistoryUrl } from "@/lib/csv-history-client";
import type { PortHistoryPoint, PortHistoryResponse } from "@/lib/port-history";

type HistoryRange = "6h" | "1d" | "7d" | "30d";

const RANGE_OPTIONS: Array<{ label: string; value: HistoryRange; hours: number }> = [
  { label: "6h", value: "6h", hours: 6 },
  { label: "1d", value: "1d", hours: 24 },
  { label: "7d", value: "7d", hours: 7 * 24 },
  { label: "30d", value: "30d", hours: 30 * 24 },
];

function formatPower(value: number) {
  return value >= 1000 ? `${(value / 1000).toFixed(2)} kW` : `${Math.round(value)} W`;
}

function formatEnergy(value: number) {
  return value >= 1000 ? `${(value / 1000).toFixed(2)} kWh` : `${Math.round(value)} Wh`;
}

function formatTime(timestamp: string, hours: number) {
  if (hours > 24) {
    return new Date(timestamp).toLocaleDateString([], { month: "short", day: "numeric" });
  }
  return new Date(timestamp).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

function latestPower(point: PortHistoryPoint) {
  return point.dc_power_w > 0 ? "text-emerald-300" : "text-slate-400";
}

export function CsvPortHistoryDashboard() {
  const [history, setHistory] = useState<PortHistoryResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [range, setRange] = useState<HistoryRange>("30d");

  useEffect(() => {
    const controller = new AbortController();

    async function loadHistory() {
      try {
        const response = await fetch(csvHistoryUrl("/api/history/ports", "/port-history-snapshot.json"), {
          signal: controller.signal,
        });
        if (!response.ok) throw new Error(`Port archive request failed: ${response.status}`);
        setHistory((await response.json()) as PortHistoryResponse);
      } catch (error) {
        if ((error as Error).name !== "AbortError") console.error(error);
      } finally {
        setLoading(false);
      }
    }

    void loadHistory();
    return () => controller.abort();
  }, []);

  const rangeHours = RANGE_OPTIONS.find((option) => option.value === range)?.hours ?? 30 * 24;
  const cutoff = Date.now() - rangeHours * 60 * 60 * 1000;
  const chartData = useMemo(() => {
    const buckets = new Map<string, { timestamp: string; total_dc_power_w: number; active_port_count: number }>();

    for (const point of history?.points ?? []) {
      if (new Date(point.timestamp).getTime() < cutoff) continue;
      const current = buckets.get(point.timestamp) ?? {
        timestamp: point.timestamp,
        total_dc_power_w: 0,
        active_port_count: 0,
      };
      current.total_dc_power_w += point.dc_power_w;
      current.active_port_count += point.dc_power_w > 0 ? 1 : 0;
      buckets.set(point.timestamp, current);
    }

    return Array.from(buckets.values()).sort(
      (left, right) => new Date(left.timestamp).getTime() - new Date(right.timestamp).getTime(),
    );
  }, [cutoff, history?.points]);

  const latestRows = useMemo(
    () => [...(history?.latest ?? [])].sort((left, right) => right.dc_power_w - left.dc_power_w),
    [history?.latest],
  );
  const summary = history?.summary;
  const hasData = chartData.length > 0 || latestRows.length > 0;

  return (
    <section className="space-y-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <p className="text-[11px] uppercase tracking-[0.26em] text-slate-400">CSV archive</p>
          <h2 className="mt-1 text-xl font-semibold tracking-tight text-slate-50">PV array health</h2>
          <p className="mt-1 text-sm text-slate-400">
            Per-string DC readings archived by the relay every ten minutes.
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

      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Metric label="Active strings" value={loading ? "…" : `${summary?.active_port_count ?? 0}/${summary?.tracked_port_count ?? 0}`} tone="text-emerald-300" />
        <Metric label="Array DC now" value={loading ? "…" : formatPower(summary?.total_dc_power_w ?? 0)} tone="text-emerald-300" />
        <Metric label="Strongest string" value={loading ? "…" : formatPower(summary?.peak_port_power_w ?? 0)} tone="text-sky-300" />
        <Metric label="Today across strings" value={loading ? "…" : formatEnergy(summary?.total_daily_energy_wh ?? 0)} tone="text-yellow-300" />
      </div>

      <Card className="overflow-hidden border-white/10 bg-slate-950/80">
        <CardHeader className="pb-2">
          <CardTitle className="text-[11px] uppercase tracking-[0.24em] text-slate-400">
            Total DC output
          </CardTitle>
        </CardHeader>
        <CardContent className="pt-0">
          {!loading && !hasData ? (
            <EmptyState message="No inverter-port CSV archive has been recorded yet. The relay will add the first batch after a completed ten-minute window." />
          ) : (
            <div className="h-[300px] w-full">
              <ResponsiveContainer width="100%" height="100%">
                <ComposedChart data={chartData} margin={{ top: 16, right: 16, left: 0, bottom: 0 }}>
                  <CartesianGrid stroke="rgba(148,163,184,0.14)" strokeDasharray="4 4" vertical={false} />
                  <XAxis
                    dataKey="timestamp"
                    tickFormatter={(value) => formatTime(String(value), rangeHours)}
                    tickLine={false}
                    axisLine={false}
                    interval={Math.max(1, Math.floor(Math.max(chartData.length, 1) / 7))}
                    tick={{ fill: "#94a3b8", fontSize: 11 }}
                  />
                  <YAxis
                    tickLine={false}
                    axisLine={false}
                    width={54}
                    tick={{ fill: "#94a3b8", fontSize: 11 }}
                    tickFormatter={(value) => formatPower(Number(value))}
                  />
                  <Tooltip
                    contentStyle={{
                      background: "rgba(2, 6, 23, 0.96)",
                      border: "1px solid rgba(148, 163, 184, 0.16)",
                      borderRadius: "18px",
                      color: "#e2e8f0",
                    }}
                    labelFormatter={(label) => new Date(String(label)).toLocaleString()}
                    formatter={(value: number, name: string) => [
                      name === "total_dc_power_w" ? formatPower(value) : value,
                      name === "total_dc_power_w" ? "Array DC" : "Active strings",
                    ]}
                  />
                  <Area
                    type="monotone"
                    dataKey="total_dc_power_w"
                    stroke="#34d399"
                    fill="rgba(52, 211, 153, 0.18)"
                    strokeWidth={3}
                    activeDot={{ r: 6, stroke: "#34d399", fill: "#0f172a" }}
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
            Latest string readings
          </CardTitle>
        </CardHeader>
        <CardContent className="pt-0">
          {!loading && latestRows.length === 0 ? (
            <EmptyState message="Latest port readings will appear here after the relay writes its first archive batch." />
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[720px] text-left text-sm">
                <thead className="border-b border-white/10 text-[11px] uppercase tracking-[0.18em] text-slate-500">
                  <tr>
                    <th className="py-3 pr-4 font-medium">Inverter</th>
                    <th className="px-4 py-3 font-medium">Port</th>
                    <th className="px-4 py-3 font-medium">DC power</th>
                    <th className="px-4 py-3 font-medium">Voltage</th>
                    <th className="px-4 py-3 font-medium">Today</th>
                    <th className="py-3 pl-4 text-right font-medium">Sample</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-white/[0.06] text-slate-300">
                  {latestRows.map((point) => (
                    <tr key={`${point.inverter_serial}:${point.port_number}`}>
                      <td className="py-3 pr-4 font-mono text-xs text-slate-200">{point.inverter_serial}</td>
                      <td className="px-4 py-3">{point.port_number}</td>
                      <td className={`px-4 py-3 font-semibold ${latestPower(point)}`}>{formatPower(point.dc_power_w)}</td>
                      <td className="px-4 py-3">{point.dc_voltage_v.toFixed(1)} V</td>
                      <td className="px-4 py-3 text-yellow-300">{formatEnergy(point.energy_daily_wh)}</td>
                      <td className="py-3 pl-4 text-right text-xs text-slate-400">{formatTime(point.timestamp, 6)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
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

function EmptyState({ message }: { message: string }) {
  return (
    <div className="rounded-2xl border border-dashed border-white/10 bg-white/[0.02] px-4 py-8 text-center text-sm text-slate-400">
      {message}
    </div>
  );
}
