"use client";

import Image from "next/image";
import { useEffect, useMemo, useState } from "react";
import { CalendarDays, CloudSun, History, Wifi, type LucideIcon } from "lucide-react";

import type { EnergyTotals } from "@/lib/daily-energy";
import {
  formatPowerKw,
  getFlowDuration,
  getGridFlowState,
  getSelfConsumptionPercent,
} from "@/lib/power-flow";

type WeatherResponse = {
  latest: {
    temperature_2m: number | null;
  } | null;
};

type HoymilesFlowVisualizerProps = {
  solarProductionW: number;
  homeConsumptionW: number;
  timestamp?: string;
  todaySolarYieldKwh: number | null;
  energyTotals: EnergyTotals;
  connectionLabel: string;
  plantName?: string;
  capacityKw?: number;
};

const PATH_IDS = {
  lowerSolar: "hoymiles-lower-solar-flow",
  upperSolar: "hoymiles-upper-solar-flow",
  solarTrunk: "hoymiles-solar-trunk-flow",
  gridExport: "hoymiles-grid-export-flow",
  gridImport: "hoymiles-grid-import-flow",
  loads: "hoymiles-loads-flow",
} as const;

function formatTimestamp(timestamp?: string) {
  if (!timestamp) return "Awaiting update";

  return new Date(timestamp).toLocaleTimeString([], {
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
  });
}

function formatEnergy(kwh: number, unit: "kWh" | "MWh") {
  const value = unit === "MWh" ? kwh / 1000 : kwh;
  return `${value.toFixed(2)} ${unit}`;
}

function FlowParticles({
  pathId,
  color,
  duration,
  reverse = false,
}: {
  pathId: string;
  color: string;
  duration: string;
  reverse?: boolean;
}) {
  return (
    <>
      {["0s", "-0.62s", "-1.24s"].map((begin) => (
        <circle key={begin} r="7" fill={color} className="hoymiles-flow-particle">
          <animateMotion
            dur={`${duration}s`}
            begin={begin}
            calcMode="linear"
            keyPoints={reverse ? "1;0" : "0;1"}
            keyTimes="0;1"
            repeatCount="indefinite"
          >
            <mpath href={`#${pathId}`} />
          </animateMotion>
        </circle>
      ))}
    </>
  );
}

function SemiGauge({ value }: { value: number }) {
  const radius = 39;
  const circumference = Math.PI * radius;
  const dashOffset = circumference - (value / 100) * circumference;

  return (
    <svg viewBox="0 0 104 62" className="h-16 w-28" aria-label={`${value.toFixed(0)}% self-consumption`}>
      <path
        d="M13 54 A39 39 0 0 1 91 54"
        fill="none"
        stroke="rgba(148, 163, 184, 0.22)"
        strokeWidth="10"
        strokeLinecap="round"
      />
      <path
        d="M13 54 A39 39 0 0 1 91 54"
        fill="none"
        stroke="#34d399"
        strokeWidth="10"
        strokeLinecap="round"
        strokeDasharray={circumference}
        strokeDashoffset={dashOffset}
        className="transition-[stroke-dashoffset] duration-700"
      />
      <text x="52" y="48" textAnchor="middle" className="fill-white text-[16px] font-semibold">
        {value.toFixed(0)}%
      </text>
    </svg>
  );
}

export function HoymilesFlowVisualizer({
  solarProductionW,
  homeConsumptionW,
  timestamp,
  todaySolarYieldKwh,
  energyTotals,
  connectionLabel,
  plantName = "Gokul Menon",
  capacityKw = 20.02,
}: HoymilesFlowVisualizerProps) {
  const [temperatureC, setTemperatureC] = useState<number | null>(null);

  const trueSolarW = Math.max(0, solarProductionW);
  const trueHomeW = Math.abs(homeConsumptionW);
  const trueGridW = trueHomeW - trueSolarW;
  const gridState = getGridFlowState(trueGridW);
  const solarActive = trueSolarW >= 20;
  const loadsActive = trueHomeW > 0;
  const solarDuration = getFlowDuration(trueSolarW);
  const gridDuration = getFlowDuration(trueGridW);
  const loadDuration = getFlowDuration(trueHomeW);
  const selfConsumption = getSelfConsumptionPercent(trueSolarW, trueHomeW);
  const powerRatio = capacityKw > 0 ? (trueSolarW / (capacityKw * 1000)) * 100 : 0;
  const gridTone = gridState === "exporting" ? "text-emerald-300" : gridState === "importing" ? "text-amber-300" : "text-slate-300";
  const gridDotTone = gridState === "exporting" ? "bg-emerald-400" : gridState === "importing" ? "bg-amber-400" : "bg-slate-400";
  const gridLabel = gridState === "exporting" ? "Exporting" : gridState === "importing" ? "Importing" : "Balanced";

  useEffect(() => {
    const controller = new AbortController();

    async function loadTemperature() {
      try {
        const response = await fetch("/api/weather/latest", {
          cache: "no-store",
          signal: controller.signal,
        });
        if (!response.ok) return;

        const payload = (await response.json()) as WeatherResponse;
        setTemperatureC(payload.latest?.temperature_2m ?? null);
      } catch (error) {
        if ((error as Error).name !== "AbortError") console.error(error);
      }
    }

    void loadTemperature();
    const interval = window.setInterval(loadTemperature, 5 * 60 * 1000);

    return () => {
      controller.abort();
      window.clearInterval(interval);
    };
  }, []);

  const temperatureLabel = useMemo(
    () => (typeof temperatureC === "number" ? `${temperatureC.toFixed(0)} °C` : "Weather —"),
    [temperatureC],
  );

  return (
    <section aria-label="Live home energy flow" className="space-y-3">
      <div className="relative mx-auto w-full max-w-xl overflow-hidden rounded-[1.75rem] border border-white/10 bg-slate-950 shadow-[0_28px_80px_rgba(2,6,23,0.6)] aspect-[4/3]">
        <Image
          alt="Isometric view of the home energy system"
          className="object-cover"
          fill
          priority
          sizes="(max-width: 640px) 100vw, 576px"
          src="/images/house-base.webp"
        />
        <div className="absolute inset-0 bg-gradient-to-b from-slate-950/38 via-transparent to-slate-950/20" />

        <svg
          aria-hidden="true"
          className="pointer-events-none absolute inset-0 h-full w-full"
          viewBox="0 0 1000 750"
          preserveAspectRatio="xMidYMid slice"
        >
          <defs>
            <filter id="hoymiles-flow-glow" x="-100%" y="-100%" width="300%" height="300%">
              <feGaussianBlur stdDeviation="9" result="blur" />
              <feMerge>
                <feMergeNode in="blur" />
                <feMergeNode in="SourceGraphic" />
              </feMerge>
            </filter>
          </defs>

          {/* ISOMETRIC CONDUIT PATHS MATCHING ANNOTATION */}
          <g filter="url(#hoymiles-flow-glow)">
            {/* Upper Roof Array: Routes down roof pitch, drops down 2nd story wall, connects to combiner */}
            <path id={PATH_IDS.upperSolar} d="M 680 180 L 580 230 L 580 400 L 440 460 L 380 460 L 380 485" className="hoymiles-energy-line" stroke="#34d399" opacity={solarActive ? 1 : 0.2} />
            
            {/* Lower Roof Array: Traces parallel slope down to combiner */}
            <path id={PATH_IDS.lowerSolar} d="M 260 465 L 320 485 L 380 485" className="hoymiles-energy-line" stroke="#34d399" opacity={solarActive ? 1 : 0.2} />
            <path id={PATH_IDS.solarTrunk} d="M 380 485 L 300 510 L 250 540 L 220 580" className="hoymiles-energy-line hoymiles-energy-collector" stroke="#34d399" opacity={solarActive ? 1 : 0.2} />
            
            {/* Grid leaves the combiner through the exchange point beside the left-wall window. */}
            <path id={PATH_IDS.gridExport} d="M 220 580 L 145 560 L 80 560 L 80 700 L 120 720" className="hoymiles-energy-line" stroke="#10b981" opacity={gridState === "exporting" ? 1 : 0.16} />
            <path id={PATH_IDS.gridImport} d="M 220 580 L 145 560 L 80 560 L 80 700 L 120 720" className="hoymiles-energy-line" stroke="#f59e0b" opacity={gridState === "importing" ? 1 : 0.16} />
            
            {/* Home Loads Path (Sweeps across garage/driveway seam into living room) */}
            <path id={PATH_IDS.loads} d="M 220 580 L 350 630 L 750 460" className="hoymiles-energy-line" stroke="#34d399" opacity={loadsActive ? 1 : 0.18} />
          </g>

          {solarActive ? <FlowParticles pathId={PATH_IDS.lowerSolar} color="#86efac" duration={solarDuration} /> : null}
          {solarActive ? <FlowParticles pathId={PATH_IDS.upperSolar} color="#86efac" duration={solarDuration} /> : null}
          {solarActive ? <FlowParticles pathId={PATH_IDS.solarTrunk} color="#6ee7b7" duration={solarDuration} /> : null}
          {gridState === "exporting" ? <FlowParticles pathId={PATH_IDS.gridExport} color="#34d399" duration={gridDuration} /> : null}
          {gridState === "importing" ? <FlowParticles pathId={PATH_IDS.gridImport} color="#fbbf24" duration={gridDuration} reverse /> : null}
          {loadsActive ? <FlowParticles pathId={PATH_IDS.loads} color="#6ee7b7" duration={loadDuration} /> : null}

          {/* COMBINER JUNCTION BOX ON LEFT WALL */}
          <g filter="url(#hoymiles-flow-glow)">
            <circle cx="380" cy="485" r="7" fill="#d1fae5" stroke="#34d399" strokeWidth="3" />
            <circle cx="220" cy="580" r="18" fill="#082f24" stroke="#6ee7b7" strokeWidth="4" />
            <path d="M219 566 L209 584 H219 L215 595 L231 577 H222 L227 566 Z" fill="#d1fae5" />
            <rect x="64" y="544" width="32" height="32" rx="8" fill="#172554" stroke="#7dd3fc" strokeWidth="3" />
            <path d="M71 555 H88 M85 551 L89 555 L85 559 M90 569 H73 M76 565 L72 569 L76 573" stroke="#e0f2fe" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
            <text x="220" y="607" textAnchor="middle" className="fill-emerald-50 text-[10px] font-semibold">COMBINER</text>
            <text x="80" y="591" textAnchor="middle" className="fill-sky-100 text-[10px] font-semibold">EXCHANGE</text>
          </g>
        </svg>

        <div className="absolute left-3 top-3 max-w-[48%] rounded-xl border border-white/10 bg-slate-950/80 px-3 py-2 shadow-lg backdrop-blur-md">
          <p className="truncate text-sm font-semibold text-white">{plantName}</p>
          <p className="mt-0.5 text-[10px] font-medium text-slate-300">Live · {formatTimestamp(timestamp)}</p>
          <p className="mt-1 text-[10px] text-slate-400">Capacity {capacityKw.toFixed(2)} kW</p>
        </div>

        <div className="absolute right-3 top-3 flex items-center gap-1.5 rounded-xl border border-white/10 bg-slate-950/80 px-2.5 py-2 text-[10px] shadow-lg backdrop-blur-md">
          <Wifi className="h-3.5 w-3.5 text-emerald-300" aria-hidden="true" />
          <span className="hidden text-slate-200 sm:inline">{connectionLabel}</span>
          <span className="h-3.5 w-px bg-white/10" />
          <CloudSun className="h-3.5 w-3.5 text-sky-200" aria-hidden="true" />
          <span className="font-semibold text-white">{temperatureLabel}</span>
        </div>

        <div className="absolute left-1/2 top-[4%] -translate-x-1/2 rounded-2xl border border-white/10 bg-slate-950/82 px-4 py-2 text-center shadow-xl backdrop-blur-md">
          <p data-testid="hero-solar-power" className="whitespace-nowrap text-2xl font-bold tracking-tight text-white sm:text-3xl">{formatPowerKw(trueSolarW)}</p>
          <p className="mt-0.5 whitespace-nowrap text-[10px] font-medium text-slate-300">Power Ratio {Math.max(0, powerRatio).toFixed(1)}%</p>
        </div>

        <div data-testid="grid-flow-badge" className="absolute left-[20%] top-[84%] w-32 -translate-x-1/2 rounded-xl border border-white/10 bg-slate-950/80 p-2.5 shadow-lg backdrop-blur-md">
          <p className="text-[10px] font-medium uppercase tracking-[0.16em] text-slate-400">Grid</p>
          <p className="mt-0.5 text-base font-bold text-white">{formatPowerKw(Math.abs(trueGridW))}</p>
          <p className={`mt-1 flex items-center gap-1 text-[10px] font-semibold ${gridTone}`}>
            <span className={`h-1.5 w-1.5 rounded-full ${gridDotTone}`} />
            {gridLabel}
          </p>
        </div>

        <div data-testid="loads-flow-badge" className="absolute right-3 top-[64%] w-32 rounded-xl border border-white/10 bg-slate-950/80 p-2.5 shadow-lg backdrop-blur-md">
          <p className="text-[10px] font-medium uppercase tracking-[0.16em] text-slate-400">Loads</p>
          <p className="mt-0.5 text-base font-bold text-white">{formatPowerKw(trueHomeW)}</p>
          <p className="mt-1 text-[10px] font-semibold text-emerald-300">Home demand</p>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3 md:grid-cols-3">
        <div data-testid="today-production-card" className="col-span-2 rounded-3xl border border-white/10 bg-slate-950/80 p-4 shadow-lg backdrop-blur-xl md:col-span-1">
          <div className="flex items-start justify-between gap-2">
            <div>
              <p className="text-[11px] uppercase tracking-[0.18em] text-slate-400">Today Production</p>
              <p className="mt-2 text-2xl font-bold tracking-tight text-white">{todaySolarYieldKwh === null ? "No data yet" : formatEnergy(todaySolarYieldKwh, "kWh")}</p>
              <p className="mt-1 text-xs text-slate-400">Live self-consumption</p>
            </div>
            <SemiGauge value={selfConsumption} />
          </div>
        </div>

        <ProductionCard icon={CalendarDays} label="This Month" value={formatEnergy(energyTotals.this_month_solar_kwh, "MWh")} detail="Solar production" />
        <ProductionCard icon={History} label="Lifetime Energy" value={formatEnergy(energyTotals.lifetime_solar_kwh, "MWh")} detail={energyTotals.tracked_day_count > 0 ? `${energyTotals.tracked_day_count} tracked days` : "No data yet"} />
      </div>
    </section>
  );
}

function ProductionCard({
  icon: Icon,
  label,
  value,
  detail,
}: {
  icon: LucideIcon;
  label: string;
  value: string;
  detail: string;
}) {
  return (
    <div className="rounded-3xl border border-white/10 bg-slate-950/80 p-4 shadow-lg backdrop-blur-xl">
      <div className="flex items-start justify-between gap-2">
        <p className="text-[11px] uppercase tracking-[0.18em] text-slate-400">{label}</p>
        <Icon className="h-5 w-5 text-emerald-300" aria-hidden="true" />
      </div>
      <p className="mt-3 text-xl font-bold tracking-tight text-white">{value}</p>
      <p className="mt-1 text-xs text-slate-400">{detail}</p>
    </div>
  );
}
