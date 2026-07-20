"use client";

import { Flame, Gauge, SunMedium } from "lucide-react";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { MetricCard } from "@/components/live/metric-card";
import { SeriesAreaCard } from "@/components/charts/series-area-card";
import { useLiveTelemetry } from "@/components/telemetry/use-live-telemetry";
import { ArrayVisualizer } from "@/components/live/array-visualizer";

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
  const { telemetry, series, bridgeState } = useLiveTelemetry();
  const homeLoadKw = telemetry.home_consumption_w / 1000;
  const solarKw = telemetry.solar_production_w / 1000;
  const gridKw = telemetry.net_grid_w / 1000;
  const voltageV = telemetry.phase_a_voltage_v ?? 245;
  const estimatedCurrentA = Math.abs(telemetry.net_grid_w) / Math.max(voltageV, 1);
  const bridgeLabel =
    bridgeState === "hardware_offline"
      ? "Bridge Disconnected"
      : bridgeState === "connected"
        ? "System Online"
        : "Mock Stream";

  return (
    <div className="space-y-4">
      <div className="flex items-start justify-between gap-4">
        <div>
          <p className="text-[11px] uppercase tracking-[0.26em] text-slate-400">Live</p>
          <h1 className="mt-1 text-2xl font-semibold tracking-tight text-slate-50">
            Technical Detail
          </h1>
          <p className="mt-1 text-sm text-slate-400">
            Real-time inverter telemetry, household load, and array-level diagnostics.
          </p>
        </div>
        <Badge
          variant={
            bridgeState === "hardware_offline"
              ? "danger"
              : bridgeState === "connected"
                ? "success"
                : "warning"
          }
        >
          {bridgeLabel}
        </Badge>
      </div>

      {bridgeState === "hardware_offline" ? (
        <Card className="border-rose-500/30 bg-rose-500/10">
          <CardHeader className="pb-2">
            <CardTitle className="text-[11px] uppercase tracking-[0.24em] text-rose-200">
              Bridge Offline
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-sm text-rose-100/90">
              The relay has reported repeated Modbus failures. Check the USB adapter, serial cable,
              and meter power.
            </p>
          </CardContent>
        </Card>
      ) : null}

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
          detail={`Approximate breaker current based on ${voltageV.toFixed(1)} V and total wattage.`}
          tone="blue"
        />
      </div>

      <SeriesAreaCard
        title="Live household trend"
        subtitle="Real-time household power consumption. Switch between 10m, 6h, and 24h."
        data={series}
        dataKey="home_consumption_w"
        stroke="#38bdf8"
        fill="#60a5fa"
        formatter={(value) => `${Math.round(value).toLocaleString()} W`}
        defaultRange="6h"
      />

      <SeriesAreaCard
        title="Live solar trend"
        subtitle="Hoymiles production from the relay. Solar refreshes less often than grid readings."
        data={series}
        dataKey="solar_production_w"
        stroke="#facc15"
        fill="#fde047"
        formatter={(value) => `${Math.round(value).toLocaleString()} W`}
        defaultRange="6h"
      />

      <ArrayVisualizer inverters={telemetry.hoymiles?.inverters} />

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

    </div>
  );
}
