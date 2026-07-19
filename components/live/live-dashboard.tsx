"use client";

import { useEffect, useState } from "react";
import useWebSocket, { ReadyState } from "react-use-websocket";

import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { MetricCard } from "@/components/live/metric-card";
import { PowerFlowVisualizer } from "@/components/live/power-flow-visualizer";
import { createMockLiveTelemetry, type LiveTelemetry } from "@/lib/mock-data";

type LiveBridgeTelemetry = Partial<LiveTelemetry> & {
  phase_a_voltage_v?: number;
};

function formatWatts(value: number) {
  return `${Math.round(value).toLocaleString()} W`;
}

function formatGridValue(value: number) {
  const abs = Math.abs(value);
  return abs >= 1000 ? `${(abs / 1000).toFixed(1)} kW` : `${abs.toLocaleString()} W`;
}

export function LiveDashboard() {
  const wsUrl = process.env.NEXT_PUBLIC_LIVE_WS_URL ?? "ws://127.0.0.1:8787";
  const { lastJsonMessage, readyState } = useWebSocket<LiveBridgeTelemetry>(wsUrl, {
    shouldReconnect: () => true,
    reconnectAttempts: Infinity,
    reconnectInterval: 1500,
    retryOnError: true,
    share: false,
  });

  const [mockTelemetry, setMockTelemetry] = useState<LiveTelemetry>(() => createMockLiveTelemetry());
  const [bridgeTelemetry, setBridgeTelemetry] = useState<LiveBridgeTelemetry | null>(null);

  useEffect(() => {
    const interval = window.setInterval(() => {
      setMockTelemetry(createMockLiveTelemetry());
    }, 1000);

    setMockTelemetry(createMockLiveTelemetry());

    return () => window.clearInterval(interval);
  }, []);

  useEffect(() => {
    if (!lastJsonMessage) return;
    setBridgeTelemetry(lastJsonMessage);
  }, [lastJsonMessage]);

  const telemetry = bridgeTelemetry
    ? {
        ...mockTelemetry,
        ...bridgeTelemetry,
        timestamp: bridgeTelemetry.timestamp ?? mockTelemetry.timestamp,
      }
    : mockTelemetry;

  const exporting = telemetry.net_grid_w < 0;
  const importing = telemetry.net_grid_w > 0;
  const connected = readyState === ReadyState.OPEN && bridgeTelemetry !== null;

  return (
    <div className="space-y-4">
      <div className="flex items-start justify-between gap-4">
        <div>
          <p className="text-[11px] uppercase tracking-[0.26em] text-slate-400">Live</p>
          <h1 className="mt-1 text-2xl font-semibold tracking-tight text-slate-50">
            Edge telemetry
          </h1>
          <p className="mt-1 text-sm text-slate-400">
            WebSocket feed for sub-second grid and solar power.
          </p>
        </div>
        <Badge variant={connected ? "success" : "warning"}>{connected ? "Bridge connected" : "Mock stream"}</Badge>
      </div>

      <Card
        className={[
          "overflow-hidden border-white/10 bg-gradient-to-br",
          exporting
            ? "from-emerald-500/20 via-slate-950/90 to-slate-950 shadow-glowGreen"
            : importing
              ? "from-rose-500/20 via-slate-950/90 to-slate-950 shadow-glowRed"
              : "from-sky-500/15 via-slate-950/90 to-slate-950 shadow-glowAmber",
        ].join(" ")}
      >
        <CardHeader className="pb-2">
          <CardTitle className="text-[11px] uppercase tracking-[0.26em] text-slate-400">
            Net grid power
          </CardTitle>
        </CardHeader>
        <CardContent className="pt-0">
          <div
            className={[
              "text-6xl font-semibold tracking-tight sm:text-7xl",
              exporting ? "text-emerald-300 drop-shadow-[0_0_24px_rgba(16,185,129,0.42)]" : "",
              importing ? "text-rose-300 drop-shadow-[0_0_24px_rgba(251,113,133,0.42)]" : "",
            ].join(" ")}
          >
            {telemetry.net_grid_w > 0 ? "+" : ""}
            {formatGridValue(telemetry.net_grid_w)}
          </div>
          <p className="mt-3 text-sm text-slate-300">
            {exporting
              ? `Exporting ${formatGridValue(telemetry.net_grid_w)} to the grid`
              : importing
                ? `Importing ${formatGridValue(telemetry.net_grid_w)} from the grid`
                : "Grid exchange is at equilibrium"}
          </p>
          <p className="mt-2 text-xs text-slate-500">
            Updated at {new Date(telemetry.timestamp).toLocaleTimeString([], {
              hour: "2-digit",
              minute: "2-digit",
              second: "2-digit",
            })}
          </p>
          {typeof bridgeTelemetry?.phase_a_voltage_v === "number" ? (
            <p className="mt-1 text-xs text-slate-500">
              Phase A voltage: {bridgeTelemetry.phase_a_voltage_v.toFixed(1)} V
            </p>
          ) : null}
        </CardContent>
      </Card>

      <div className="grid grid-cols-1 gap-3">
        <MetricCard
          label="Solar production"
          value={formatWatts(telemetry.solar_production_w)}
          detail="Current photovoltaic output from the rooftop array."
          tone="amber"
        />
        <MetricCard
          label="Home consumption"
          value={formatWatts(telemetry.home_consumption_w)}
          detail="Estimated household load measured at the service panel."
          tone="blue"
        />
      </div>

      <PowerFlowVisualizer
        solarProductionW={telemetry.solar_production_w}
        netGridW={telemetry.net_grid_w}
        homeConsumptionW={telemetry.home_consumption_w}
      />
    </div>
  );
}
