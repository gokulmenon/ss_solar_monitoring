"use client";

import { useMemo, useState } from "react";

import {
  Area,
  AreaChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import type { LiveSeriesPoint } from "@/components/telemetry/use-live-telemetry";

type TimeRange = "10m" | "6h" | "24h" | "7d";

type SeriesAreaCardProps = {
  title: string;
  subtitle?: string;
  data: LiveSeriesPoint[];
  dataKey: keyof LiveSeriesPoint;
  stroke: string;
  fill: string;
  formatter: (value: number) => string;
  defaultRange?: TimeRange;
};

const RANGE_OPTIONS: Array<{ label: string; value: TimeRange }> = [
  { label: "10m", value: "10m" },
  { label: "6h", value: "6h" },
  { label: "24h", value: "24h" },
  { label: "7d", value: "7d" },
];

const WINDOW_MINUTES: Record<TimeRange, number> = {
  "10m": 10,
  "6h": 6 * 60,
  "24h": 24 * 60,
  "7d": 7 * 24 * 60,
};

function formatAxisTick(timestamp: string, range: TimeRange) {
  const date = new Date(timestamp);

  if (range === "10m") {
    return date.toLocaleTimeString([], {
      minute: "2-digit",
      second: "2-digit",
    });
  }

  if (range === "24h" || range === "7d") {
    return date.toLocaleTimeString([], {
      month: range === "7d" ? "short" : undefined,
      day: range === "7d" ? "numeric" : undefined,
      hour: range === "7d" ? undefined : "numeric",
    });
  }

  return date.toLocaleTimeString([], {
    hour: "numeric",
    minute: "2-digit",
  });
}

function formatTooltipLabel(timestamp: string, range: TimeRange) {
  return new Date(timestamp).toLocaleString([], {
    weekday: range === "24h" ? "short" : undefined,
    month: range === "24h" || range === "7d" ? "short" : undefined,
    day: range === "24h" || range === "7d" ? "numeric" : undefined,
    hour: "numeric",
    minute: "2-digit",
  });
}

export function SeriesAreaCard({
  title,
  subtitle,
  data,
  dataKey,
  stroke,
  fill,
  formatter,
  defaultRange = "6h",
}: SeriesAreaCardProps) {
  const [range, setRange] = useState<TimeRange>(defaultRange);

  const filteredData = useMemo(
    () => data.slice(-WINDOW_MINUTES[range]),
    [data, range],
  );

  const axisInterval = useMemo(() => {
    if (filteredData.length <= 10) return 0;
    return range === "10m" ? 0 : Math.max(1, Math.floor(filteredData.length / 8));
  }, [filteredData.length, range]);

  return (
    <Card className="overflow-hidden border-white/10 bg-slate-950/80">
      <CardHeader className="flex-row items-start justify-between gap-3 pb-2">
        <div className="min-w-0">
          <CardTitle className="text-[11px] uppercase tracking-[0.26em] text-slate-400">
            {title}
          </CardTitle>
          {subtitle ? <p className="mt-1 text-sm text-slate-400">{subtitle}</p> : null}
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
      </CardHeader>

      <CardContent className="pt-0">
        <div className="h-[280px] w-full md:h-[360px]">
          <ResponsiveContainer width="100%" height="100%">
            <AreaChart data={filteredData} margin={{ top: 12, right: 8, left: 0, bottom: 0 }}>
              <defs>
                <linearGradient id={`gradient-${String(dataKey)}`} x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor={fill} stopOpacity={0.35} />
                  <stop offset="95%" stopColor={fill} stopOpacity={0.02} />
                </linearGradient>
              </defs>

              <CartesianGrid
                stroke="rgba(148,163,184,0.16)"
                strokeDasharray="4 4"
                vertical={false}
              />

              <XAxis
                dataKey="timestamp"
                tickLine={false}
                axisLine={false}
                minTickGap={28}
                interval={axisInterval}
                tickFormatter={(value) => formatAxisTick(String(value), range)}
                tick={{ fill: "#94a3b8", fontSize: 11 }}
              />

              <YAxis
                tickLine={false}
                axisLine={false}
                width={52}
                tick={{ fill: "#94a3b8", fontSize: 11 }}
              />

              <Tooltip
                cursor={{ stroke: "rgba(148,163,184,0.28)", strokeWidth: 1 }}
                contentStyle={{
                  background: "rgba(2, 6, 23, 0.96)",
                  border: "1px solid rgba(148, 163, 184, 0.16)",
                  borderRadius: "18px",
                  color: "#e2e8f0",
                  boxShadow: "0 20px 80px rgba(2, 6, 23, 0.5)",
                }}
                labelFormatter={(label) => formatTooltipLabel(String(label), range)}
                formatter={(value: number) => [formatter(value), title]}
              />

              <Area
                type="monotone"
                dataKey={dataKey}
                stroke={stroke}
                strokeWidth={3}
                fill={`url(#gradient-${String(dataKey)})`}
                activeDot={{ r: 7, strokeWidth: 2, stroke, fill: "#0f172a" }}
              />
            </AreaChart>
          </ResponsiveContainer>
        </div>
      </CardContent>
    </Card>
  );
}
