"use client";

import { Activity, Bolt, Cpu, WifiHigh } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { SeriesAreaCard } from "@/components/charts/series-area-card";
import { useLiveTelemetry } from "@/components/telemetry/use-live-telemetry";

function formatKw(value: number) {
  return `${value.toFixed(2)} kW`;
}

function formatVoltage(value: number) {
  return `${value.toFixed(1)} V`;
}

function formatCurrent(value: number) {
  return `${value.toFixed(1)} A`;
}

export function HomeDashboard() {
  const { telemetry, series, connected } = useLiveTelemetry();

  const activePowerKw = Math.abs(telemetry.net_grid_w) / 1000;
  const voltageV = telemetry.phase_a_voltage_v ?? 245;
  const estimatedCurrentA = activePowerKw > 0 ? (activePowerKw * 1000) / Math.max(voltageV, 1) : 0;
  const homeLoadKw = telemetry.home_consumption_w / 1000;

  return (
    <div className="space-y-4">
      <div className="flex items-start justify-between gap-4">
        <div>
          <p className="text-[11px] uppercase tracking-[0.26em] text-slate-400">Live Monitoring</p>
          <h1 className="mt-1 text-2xl font-semibold tracking-tight text-slate-50">
            Chint DTSU666-CT
          </h1>
          <p className="mt-1 text-sm text-slate-400">Local bridge telemetry on the Mac relay.</p>
        </div>
        <Badge variant={connected ? "success" : "warning"}>
          <span className="mr-2 inline-flex h-2.5 w-2.5 rounded-full bg-current" />
          {connected ? "System Online" : "Mock Stream"}
        </Badge>
      </div>

      <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
        <Card className="border-white/10 bg-slate-950/80">
          <CardHeader className="flex flex-row items-center justify-between gap-3 pb-2">
            <CardTitle className="text-lg text-slate-400">Total Active Power</CardTitle>
            <Activity className="h-6 w-6 text-sky-400" />
          </CardHeader>
          <CardContent>
            <div className="flex items-end gap-2">
              <div className="text-5xl font-semibold tracking-tight text-slate-50">
                {formatKw(activePowerKw)}
              </div>
            </div>
          </CardContent>
        </Card>

        <Card className="border-white/10 bg-slate-950/80">
          <CardHeader className="flex flex-row items-center justify-between gap-3 pb-2">
            <CardTitle className="text-lg text-slate-400">Phase A Voltage</CardTitle>
            <Bolt className="h-6 w-6 text-amber-400" />
          </CardHeader>
          <CardContent>
            <div className="text-5xl font-semibold tracking-tight text-slate-50">
              {formatVoltage(voltageV)}
            </div>
          </CardContent>
        </Card>

        <Card className="border-white/10 bg-slate-950/80">
          <CardHeader className="flex flex-row items-center justify-between gap-3 pb-2">
            <CardTitle className="text-lg text-slate-400">Estimated Current</CardTitle>
            <Cpu className="h-6 w-6 text-violet-400" />
          </CardHeader>
          <CardContent>
            <div className="text-5xl font-semibold tracking-tight text-slate-50">
              {formatCurrent(estimatedCurrentA)}
            </div>
          </CardContent>
        </Card>
      </div>

      <SeriesAreaCard
        title="Last 10 Minutes"
        subtitle="Net grid exchange based on the live bridge feed."
        data={series}
        dataKey="net_grid_w"
        stroke="#3b82f6"
        fill="#60a5fa"
        formatter={(value) => `${Math.round(value).toLocaleString()} W`}
      />

      <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
        <Card className="border-white/10 bg-slate-950/80">
          <CardHeader className="pb-2">
            <CardTitle className="text-[11px] uppercase tracking-[0.24em] text-slate-400">
              Power consumed
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-3xl font-semibold text-emerald-300">
              {formatKw(homeLoadKw)}
            </div>
            <p className="mt-2 text-sm text-slate-400">
              Estimated household load from the live telemetry stream.
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
