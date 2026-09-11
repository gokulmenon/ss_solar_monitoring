"use client";

import { useCallback, useMemo, useState } from "react";
import { WifiHigh } from "lucide-react";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { useLiveTelemetry } from "@/components/telemetry/use-live-telemetry";
import { HoymilesFlowVisualizer } from "@/components/live/hoymiles-flow-visualizer";
import { useVisiblePoll } from "@/components/hooks/use-visible-poll";
import type { DailyEnergySummaryPoint, EnergyTotals } from "@/lib/daily-energy";

const EMPTY_ENERGY_TOTALS: EnergyTotals = {
  this_month_solar_kwh: 0,
  this_month_home_consumption_kwh: 0,
  lifetime_solar_kwh: 0,
  lifetime_home_consumption_kwh: 0,
  tracked_day_count: 0,
};

export function HomeDashboard({ isAdmin = false }: { isAdmin?: boolean }) {
  const { telemetry, bridgeState } = useLiveTelemetry();
  const [dailyEnergy, setDailyEnergy] = useState<DailyEnergySummaryPoint[]>([]);
  const [energyTotals, setEnergyTotals] = useState<EnergyTotals>(EMPTY_ENERGY_TOTALS);

  const loadDailyEnergy = useCallback(async (signal: AbortSignal) => {
    try {
      const response = await fetch("/api/daily-energy?days=7", { signal });
      if (!response.ok) return;

      const payload = (await response.json()) as { points: DailyEnergySummaryPoint[] };
      setDailyEnergy(payload.points);
    } catch (error) {
      if ((error as Error).name !== "AbortError") console.error(error);
    }
  }, []);

  const loadEnergyTotals = useCallback(async (signal: AbortSignal) => {
    try {
      const response = await fetch("/api/energy-totals", { signal });
      if (!response.ok) return;
      setEnergyTotals((await response.json()) as EnergyTotals);
    } catch (error) {
      if ((error as Error).name !== "AbortError") console.error(error);
    }
  }, []);

  // The relay only refreshes these summaries every 15 minutes. Pausing hidden
  // tabs prevents unattended browsers from consuming function invocations.
  useVisiblePoll(loadDailyEnergy, 15 * 60 * 1000);
  useVisiblePoll(loadEnergyTotals, 15 * 60 * 1000);

  const todayKey = useMemo(
    () => new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York" }).format(new Date()),
    [],
  );
  const todaySummary = dailyEnergy.find((point) => point.day === todayKey);
  const liveTodaySolarWh = telemetry.hoymiles_daily_yield_wh ?? telemetry.hoymiles?.daily_yield_wh;
  const todaySolarYieldKwh =
    typeof liveTodaySolarWh === "number" ? liveTodaySolarWh / 1000 : todaySummary?.daily_solar_kwh ?? null;
  const todayConsumptionKwh = todaySummary?.daily_home_consumption_kwh ?? null;
  const todayNetGridKwh =
    todaySolarYieldKwh !== null && todayConsumptionKwh !== null
      ? todaySolarYieldKwh - todayConsumptionKwh
      : null;
  const bridgeLabel =
    bridgeState === "connected"
      ? "System Online"
      : bridgeState === "degraded"
        ? "System Degraded"
        : bridgeState === "hardware_offline"
          ? "Hardware Offline"
          : "System Offline";
  const bridgeDescription =
    bridgeState === "connected"
      ? "WebSocket relay is feeding the app."
      : bridgeState === "degraded"
        ? "WebSocket is online, but the relay reported degraded hardware."
        : bridgeState === "hardware_offline"
          ? "The relay reported repeated Modbus failures."
          : "The browser is reconnecting to the live WebSocket relay.";
  const bridgeTone =
    bridgeState === "connected"
      ? "text-emerald-300"
      : bridgeState === "degraded"
        ? "text-amber-300"
        : "text-rose-300";

  return (
    <div className="space-y-4">
      <HoymilesFlowVisualizer
        solarProductionW={telemetry.solar_production_w}
        homeConsumptionW={telemetry.home_consumption_w}
        timestamp={telemetry.timestamp}
        todaySolarYieldKwh={todaySolarYieldKwh}
        todayConsumptionKwh={todayConsumptionKwh}
        todayNetGridKwh={todayNetGridKwh}
        energyTotals={energyTotals}
        connectionLabel={bridgeLabel}
        isAdmin={isAdmin}
        inverters={telemetry.hoymiles?.inverters}
      />

      {bridgeState === "hardware_offline" || bridgeState === "socket_offline" ? (
        <Card className="border-rose-500/30 bg-rose-500/10">
          <CardHeader className="pb-2">
            <CardTitle className="text-[11px] uppercase tracking-[0.24em] text-rose-200">
              {bridgeState === "socket_offline" ? "WebSocket Offline" : "Bridge Offline"}
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-sm text-rose-100/90">
              {bridgeDescription} Displaying the last good reading until the connection recovers.
            </p>
          </CardContent>
        </Card>
      ) : null}

      <div className="grid grid-cols-1 gap-3">
        <Card className="border-white/10 bg-slate-950/80">
          <CardHeader className="pb-2">
            <CardTitle className="text-[11px] uppercase tracking-[0.24em] text-slate-400">
              Bridge status
            </CardTitle>
          </CardHeader>
          <CardContent className="flex items-center gap-3">
            <WifiHigh className={`h-8 w-8 ${bridgeTone}`} />
            <div>
              <div className="text-2xl font-semibold text-slate-50">{bridgeLabel}</div>
              <p className="text-sm text-slate-400">{bridgeDescription}</p>
            </div>
          </CardContent>
        </Card>
      </div>

    </div>
  );
}
