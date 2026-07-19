"use client";

import { Activity, Flame, Gauge, SunMedium } from "lucide-react";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { MetricCard } from "@/components/live/metric-card";
import { SeriesAreaCard } from "@/components/charts/series-area-card";
import { useLiveTelemetry } from "@/components/telemetry/use-live-telemetry";
import { PowerFlowVisualizer } from "@/components/live/power-flow-visualizer";

function formatKw(value: number) {
  return `${(value / 1000).toFixed(2)} kW`;
}

function formatWatts(value: number) {
  return `${Math.round(value).toLocaleString()} W`;
}

function formatCurrent(value: number) {
  return `${value.toFixed(1)} A`;
}

export function LiveDashboard() {
  const { telemetry, series, connected } = useLiveTelemetry();
  const homeLoadKw = telemetry.home_consumption_w / 1000;
  const solarKw = telemetry.solar_production_w / 1000;
  const gridKw = telemetry.net_grid_w / 1000;
  const voltageV = telemetry.phase_a_voltage_v ?? 245;
  const estimatedCurrentA = Math.abs(telemetry.net_grid_w) / Math.max(voltageV, 1);

  return (
    <div className="space-y-4">
      <div className="flex items-start justify-between gap-4">
        <div>
          <p className="text-[11px] uppercase tracking-[0.26em] text-slate-400">Live</p>
          <h1 className="mt-1 text-2xl font-semibold tracking-tight text-slate-50">
            Consumption Detail
          </h1>
          <p className="mt-1 text-sm text-slate-400">
            Real-time household load and power exchange over the last 10 minutes.
          </p>
        </div>
        <Badge variant={connected ? "success" : "warning"}>{connected ? "Bridge connected" : "Mock stream"}</Badge>
      </div>

      <Card className="overflow-hidden border-white/10 bg-gradient-to-br from-sky-500/12 via-slate-950/90 to-slate-950">
        <CardHeader className="pb-2">
          <CardTitle className="flex items-center gap-2 text-[11px] uppercase tracking-[0.26em] text-slate-400">
            <Flame className="h-4 w-4 text-orange-300" />
            Power Consumed
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="text-6xl font-semibold tracking-tight text-slate-50">
            {formatKw(homeLoadKw * 1000)}
          </div>
          <p className="mt-3 text-sm text-slate-300">
            Household load currently being drawn from the service panel.
          </p>
        </CardContent>
      </Card>

      <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
        <MetricCard
          label="Grid exchange"
          value={formatKw(Math.abs(gridKw) * 1000)}
          detail={gridKw < 0 ? "Exporting to the grid" : "Importing from the grid"}
          tone={gridKw < 0 ? "green" : "red"}
        />
        <MetricCard
          label="Solar output"
          value={formatKw(solarKw * 1000)}
          detail="Live photovoltaic generation."
          tone="amber"
        />
        <MetricCard
          label="Estimated current"
          value={formatCurrent(estimatedCurrentA)}
          detail={`Based on ${voltageV.toFixed(1)} V phase A voltage.`}
          tone="blue"
        />
      </div>

      <SeriesAreaCard
        title="Last 10 Minutes"
        subtitle="Live household power consumption trend."
        data={series}
        dataKey="home_consumption_w"
        stroke="#38bdf8"
        fill="#60a5fa"
        formatter={(value) => `${Math.round(value).toLocaleString()} W`}
      />

      <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
        <Card className="border-white/10 bg-slate-950/80">
          <CardHeader className="pb-2">
            <CardTitle className="flex items-center gap-2 text-[11px] uppercase tracking-[0.24em] text-slate-400">
              <SunMedium className="h-4 w-4 text-yellow-300" />
              Solar Production
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-3xl font-semibold text-emerald-300">
              {formatWatts(telemetry.solar_production_w)}
            </div>
            <p className="mt-2 text-sm text-slate-400">
              Live solar generation from the bridge feed.
            </p>
          </CardContent>
        </Card>

        <Card className="border-white/10 bg-slate-950/80">
          <CardHeader className="pb-2">
            <CardTitle className="flex items-center gap-2 text-[11px] uppercase tracking-[0.24em] text-slate-400">
              <Gauge className="h-4 w-4 text-violet-300" />
              Phase A Voltage
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-3xl font-semibold text-slate-50">
              {telemetry.phase_a_voltage_v?.toFixed(1) ?? "—"} V
            </div>
            <p className="mt-2 text-sm text-slate-400">
              Voltage from register 8192 when available.
            </p>
          </CardContent>
        </Card>
      </div>

      <PowerFlowVisualizer
        solarProductionW={telemetry.solar_production_w}
        netGridW={telemetry.net_grid_w}
        homeConsumptionW={telemetry.home_consumption_w}
      />
    </div>
  );
}
