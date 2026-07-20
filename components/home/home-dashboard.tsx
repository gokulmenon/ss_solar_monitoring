"use client";

import { Activity, Home, SunMedium, WifiHigh } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { SeriesAreaCard } from "@/components/charts/series-area-card";
import { useLiveTelemetry } from "@/components/telemetry/use-live-telemetry";
import { PowerFlowVisualizer } from "@/components/live/power-flow-visualizer";

function formatKw(value: number) {
  return `${value.toFixed(2)} kW`;
}

function formatVoltage(value: number) {
  return `${value.toFixed(1)} V`;
}

export function HomeDashboard() {
  const { telemetry, series, bridgeState } = useLiveTelemetry();

  const activePowerKw = Math.abs(telemetry.net_grid_w) / 1000;
  const voltageV = telemetry.phase_a_voltage_v ?? 245;
  const homeLoadKw = telemetry.home_consumption_w / 1000;
  const solarKw = telemetry.solar_production_w / 1000;
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
          <p className="text-[11px] uppercase tracking-[0.26em] text-slate-400">Live Monitoring</p>
          <h1 className="mt-1 text-2xl font-semibold tracking-tight text-slate-50">
            Solar Overview
          </h1>
          <p className="mt-1 text-sm text-slate-400">
            Executive summary from the meter, Hoymiles DTU, and local relay.
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
          <span className="mr-2 inline-flex h-2.5 w-2.5 rounded-full bg-current" />
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
              The relay has reported repeated Modbus failures. Displaying the last good reading
              until the bridge recovers.
            </p>
          </CardContent>
        </Card>
      ) : null}

      <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
        <Card className="border-white/10 bg-slate-950/80">
          <CardHeader className="flex flex-row items-center justify-between gap-3 pb-2">
            <CardTitle className="text-lg text-slate-400">Home Load</CardTitle>
            <Home className="h-6 w-6 text-emerald-300" />
          </CardHeader>
          <CardContent>
            <div className="flex items-end gap-2">
              <div className="text-5xl font-semibold tracking-tight text-slate-50">
                {formatKw(homeLoadKw)}
              </div>
            </div>
          </CardContent>
        </Card>

        <Card className="border-white/10 bg-slate-950/80">
          <CardHeader className="flex flex-row items-center justify-between gap-3 pb-2">
            <CardTitle className="text-lg text-slate-400">Solar Output</CardTitle>
            <SunMedium className="h-6 w-6 text-amber-300" />
          </CardHeader>
          <CardContent>
            <div className="text-5xl font-semibold tracking-tight text-slate-50">
              {formatKw(solarKw)}
            </div>
          </CardContent>
        </Card>

        <Card className="border-white/10 bg-slate-950/80">
          <CardHeader className="flex flex-row items-center justify-between gap-3 pb-2">
            <CardTitle className="text-lg text-slate-400">Grid Exchange</CardTitle>
            <Activity className="h-6 w-6 text-sky-400" />
          </CardHeader>
          <CardContent>
            <div className="text-5xl font-semibold tracking-tight text-slate-50">
              {formatKw(activePowerKw)}
            </div>
            <p className="mt-2 text-sm text-slate-400">
              {telemetry.net_grid_w < 0 ? "Exporting surplus energy." : "Importing from the grid."}
            </p>
          </CardContent>
        </Card>
      </div>

      <PowerFlowVisualizer
        solarProductionW={telemetry.solar_production_w}
        netGridW={telemetry.net_grid_w}
        homeConsumptionW={telemetry.home_consumption_w}
      />

      <SeriesAreaCard
        title="Live grid trend"
        subtitle="Net grid exchange based on the live bridge feed. Switch between 10m, 6h, and 24h."
        data={series}
        dataKey="net_grid_w"
        stroke="#3b82f6"
        fill="#60a5fa"
        formatter={(value) => `${Math.round(value).toLocaleString()} W`}
        defaultRange="6h"
      />

      <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
        <Card className="border-white/10 bg-slate-950/80">
          <CardHeader className="pb-2">
            <CardTitle className="text-[11px] uppercase tracking-[0.24em] text-slate-400">
              Phase A voltage
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-3xl font-semibold text-amber-300">
              {formatVoltage(voltageV)}
            </div>
            <p className="mt-2 text-sm text-slate-400">
              Chint register 8192 with relay scaling applied.
            </p>
          </CardContent>
        </Card>

        <Card className="border-white/10 bg-slate-950/80">
          <CardHeader className="pb-2">
            <CardTitle className="text-[11px] uppercase tracking-[0.24em] text-slate-400">
              Bridge status
            </CardTitle>
          </CardHeader>
          <CardContent className="flex items-center gap-3">
            <WifiHigh className="h-8 w-8 text-sky-300" />
            <div>
              <div className="text-2xl font-semibold text-slate-50">Connected</div>
              <p className="text-sm text-slate-400">WebSocket relay is feeding the app.</p>
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
