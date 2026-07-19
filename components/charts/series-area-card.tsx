"use client";

import {
  Area,
  AreaChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import type { LiveSeriesPoint } from "@/components/telemetry/use-live-telemetry";

type SeriesAreaCardProps = {
  title: string;
  subtitle?: string;
  data: LiveSeriesPoint[];
  dataKey: keyof LiveSeriesPoint;
  stroke: string;
  fill: string;
  formatter: (value: number) => string;
};

function relativeTickFormatter(value: string, index: number, total: number) {
  if (index === 0) return "-10m";
  if (index === Math.floor(total / 2)) return "-5m";
  if (index === total - 1) return "Now";
  return "";
}

export function SeriesAreaCard({
  title,
  subtitle,
  data,
  dataKey,
  stroke,
  fill,
  formatter,
}: SeriesAreaCardProps) {
  const totalTicks = data.length;

  return (
    <Card className="overflow-hidden border-white/10 bg-slate-950/80">
      <CardHeader className="pb-2">
        <CardTitle className="text-[11px] uppercase tracking-[0.26em] text-slate-400">
          {title}
        </CardTitle>
        {subtitle ? <p className="text-sm text-slate-400">{subtitle}</p> : null}
      </CardHeader>
      <CardContent className="pt-0">
        <div className="h-[280px] w-full md:h-[360px]">
          <ResponsiveContainer width="100%" height="100%">
            <AreaChart data={data} margin={{ top: 12, right: 8, left: 0, bottom: 0 }}>
              <defs>
                <linearGradient id={`gradient-${dataKey}`} x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor={fill} stopOpacity={0.35} />
                  <stop offset="95%" stopColor={fill} stopOpacity={0.02} />
                </linearGradient>
              </defs>
              <CartesianGrid stroke="rgba(148,163,184,0.16)" strokeDasharray="4 4" vertical={false} />
              <XAxis
                dataKey="timestamp"
                tickLine={false}
                axisLine={false}
                minTickGap={28}
                interval={0}
                tickFormatter={(_, index) => relativeTickFormatter("", index, totalTicks)}
                tick={{ fill: "#94a3b8", fontSize: 11 }}
              />
              <YAxis
                tickLine={false}
                axisLine={false}
                width={42}
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
                labelFormatter={(label) =>
                  new Date(String(label)).toLocaleTimeString([], {
                    hour: "2-digit",
                    minute: "2-digit",
                    second: "2-digit",
                  })
                }
                formatter={(value: number) => [formatter(value), title]}
              />
              <Area
                type="monotone"
                dataKey={dataKey}
                stroke={stroke}
                strokeWidth={3}
                fill={`url(#gradient-${dataKey})`}
                activeDot={{ r: 7, strokeWidth: 2, stroke: stroke, fill: "#0f172a" }}
              />
            </AreaChart>
          </ResponsiveContainer>
        </div>
      </CardContent>
    </Card>
  );
}
