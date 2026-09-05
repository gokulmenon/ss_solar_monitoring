import { Cpu, Thermometer, Zap } from "lucide-react";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  ROOF_SECTIONS,
  SECTION_DISPLAY_ORDER,
  getSectionPowerW,
  groupInvertersBySection,
  type SectionId,
} from "@/lib/roof-layout";
import { cn } from "@/lib/utils";
import type { HoymilesInverterReading, HoymilesPortReading } from "@/components/telemetry/use-live-telemetry";

type ArrayVisualizerProps = {
  inverters?: HoymilesInverterReading[];
  lastUpdatedAt?: string;
};

const SECTION_COLUMNS: Record<SectionId, string> = {
  S1: "grid-cols-1",
  P1: "grid-cols-1 sm:grid-cols-2 xl:grid-cols-4",
  S2: "grid-cols-1 sm:grid-cols-2 xl:grid-cols-4",
  P2: "grid-cols-1 sm:grid-cols-3",
};

function powerTone(powerW: number | null | undefined) {
  if (!powerW || powerW <= 0) {
    return "border-slate-700/70 bg-slate-800/70 text-slate-400";
  }

  if (powerW < 60) {
    return "border-amber-900/70 bg-amber-950/90 text-amber-200";
  }

  if (powerW < 140) {
    return "border-amber-800/80 bg-amber-900/90 text-amber-100";
  }

  if (powerW < 240) {
    return "border-amber-600/80 bg-amber-700/90 text-amber-50";
  }

  return "border-amber-300/80 bg-amber-400 text-slate-950";
}

function formatSerial(serialNumber: string | undefined) {
  if (!serialNumber) return "Awaiting inverter";
  return serialNumber.length > 4 ? `...${serialNumber.slice(-4)}` : serialNumber;
}

function shortSerial(serialNumber: string) {
  return serialNumber.length > 4 ? serialNumber.slice(-4) : serialNumber;
}

function formatTimestamp(timestamp: string | undefined) {
  if (!timestamp) return "Awaiting refresh";

  return new Date(timestamp).toLocaleTimeString([], {
    hour: "numeric",
    minute: "2-digit",
  });
}

function findPort(inverter: HoymilesInverterReading | undefined, portNumber: number) {
  return inverter?.ports?.find((port) => port.port_number === portNumber);
}

function PanelBlock({
  port,
  label,
  unused,
}: {
  port?: HoymilesPortReading;
  label: string;
  unused?: boolean;
}) {
  if (unused) {
    return (
      <div className="min-h-[76px] rounded-lg border border-dashed border-white/[0.06] bg-slate-950/35 opacity-40" />
    );
  }

  const powerW = port?.power_w ?? null;
  const voltageV = port?.voltage_v ?? null;

  return (
    <div
      className={cn(
        "min-h-[76px] rounded-lg border p-2 shadow-inner transition-colors",
        powerTone(powerW),
      )}
      title={port ? `${port.serial_number} port ${port.port_number}` : "No live port data yet"}
    >
      <div className="flex items-center justify-between gap-2 text-[10px] uppercase tracking-[0.18em] opacity-80">
        <span>{label}</span>
        <Zap className="h-3 w-3" />
      </div>
      <div className="mt-2 text-lg font-semibold leading-none">
        {typeof powerW === "number" ? `${Math.round(powerW)} W` : "-- W"}
      </div>
      <div className="mt-1 text-xs opacity-75">
        {typeof voltageV === "number" ? `${voltageV.toFixed(1)} V` : "-- V"}
      </div>
    </div>
  );
}

function InverterGroup({
  inverter,
  expectedSerial,
  globalSlotStart,
  activePanelCount,
}: {
  inverter?: HoymilesInverterReading;
  expectedSerial?: string;
  globalSlotStart: number;
  activePanelCount: number;
}) {
  const ports = [1, 2, 3, 4];
  const temperature = inverter?.temperature_c;
  const serialLabel = inverter?.serial_number
    ? formatSerial(inverter.serial_number)
    : expectedSerial
      ? `Awaiting ...${shortSerial(expectedSerial)}`
      : "Awaiting inverter";

  return (
    <div className="rounded-xl border border-white/[0.08] bg-slate-950/50 p-2">
      <div className="mb-2 flex items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-1.5 text-[10px] uppercase tracking-[0.18em] text-slate-500">
          <Cpu className="h-3.5 w-3.5 shrink-0" />
          <span className="truncate">{serialLabel}</span>
        </div>
        <div className="flex shrink-0 items-center gap-1 rounded-full border border-white/[0.08] bg-white/[0.04] px-2 py-0.5 text-[10px] text-slate-300">
          <Thermometer className="h-3 w-3 text-orange-300" />
          {typeof temperature === "number" ? `${temperature.toFixed(1)} C` : "-- C"}
        </div>
      </div>
      <div className="grid grid-cols-2 gap-2">
        {ports.map((portNumber) => {
          const globalSlot = globalSlotStart + portNumber - 1;
          const unused = globalSlot >= activePanelCount;

          return (
            <PanelBlock
              key={portNumber}
              port={findPort(inverter, portNumber)}
              label={`P${portNumber}`}
              unused={unused}
            />
          );
        })}
      </div>
    </div>
  );
}

export function ArrayVisualizer({ inverters = [], lastUpdatedAt }: ArrayVisualizerProps) {
  const onlineInverters = inverters.filter((inverter) => inverter.serial_number);
  const totalPowerW = onlineInverters.reduce(
    (sum, inverter) => sum + Math.max(0, inverter.active_power_w ?? 0),
    0,
  );
  const { sections, unassigned } = groupInvertersBySection(inverters);

  return (
    <Card className="overflow-hidden border-white/10 bg-slate-950/80">
      <CardHeader className="pb-2">
        <div className="flex items-start justify-between gap-4">
          <div>
            <CardTitle className="text-[11px] uppercase tracking-[0.24em] text-slate-400">
              Solar Array Visualizer
            </CardTitle>
            <p className="mt-2 text-sm text-slate-400">
              45 panels across 12 Hoymiles microinverters and 4 roof sections.
            </p>
            <p className="mt-1 text-xs uppercase tracking-[0.18em] text-slate-500">
              Last solar refresh {formatTimestamp(lastUpdatedAt)}
            </p>
          </div>
          <div className="rounded-full border border-amber-300/20 bg-amber-300/10 px-3 py-1 text-sm font-semibold text-amber-200">
            {(totalPowerW / 1000).toFixed(2)} kW
          </div>
        </div>
      </CardHeader>
      <CardContent className="pt-0">
        <div className="grid gap-3 lg:grid-cols-2">
          {SECTION_DISPLAY_ORDER.map((sectionId) => {
            const section = ROOF_SECTIONS[sectionId];
            const sectionInverters = sections[sectionId];
            const sectionPowerW = getSectionPowerW(sectionInverters);

            return (
              <section
                key={sectionId}
                className="rounded-xl border border-white/10 bg-slate-900/50 p-3"
              >
                <div className="mb-3 flex items-center justify-between gap-3">
                  <div>
                    <h2 className="text-sm font-semibold text-slate-100">{sectionId}</h2>
                    <p className="text-xs text-slate-500">{section.label}</p>
                  </div>
                  <div className="text-right text-xs text-slate-400">
                    <div>{section.activePanels} panels</div>
                    <div>{section.inverterSerials.length} inverters</div>
                    <div className="font-semibold text-emerald-300">
                      {(sectionPowerW / 1000).toFixed(2)} kW
                    </div>
                  </div>
                </div>
                <div className={cn("grid gap-2", SECTION_COLUMNS[sectionId])}>
                  {section.inverterSerials.map((serial, index) => (
                    <InverterGroup
                      key={`${sectionId}-${serial}`}
                      inverter={sectionInverters.find(
                        (candidate) =>
                          candidate.serial_number.trim().toUpperCase() === serial.toUpperCase(),
                      )}
                      expectedSerial={serial}
                      globalSlotStart={(index * 4)}
                      activePanelCount={section.activePanels}
                    />
                  ))}
                </div>
                {sectionId === "P1" ? (
                  <p className="mt-3 text-xs text-slate-500">
                    Three ghosted slots are reserved for unused inverter ports.
                  </p>
                ) : null}
              </section>
            );
          })}
        </div>
        {unassigned.length > 0 ? (
          <div className="mt-3 rounded-xl border border-dashed border-amber-300/30 bg-amber-300/[0.04] px-4 py-3 text-sm text-amber-200/90">
            {unassigned.length} inverter{unassigned.length === 1 ? "" : "s"} not mapped to a roof
            section: {unassigned.map((inverter) => formatSerial(inverter.serial_number)).join(", ")}
          </div>
        ) : null}
        {onlineInverters.length === 0 ? (
          <div className="mt-3 rounded-xl border border-dashed border-white/10 bg-white/[0.02] px-4 py-6 text-center text-sm text-slate-400">
            Waiting for the next Hoymiles refresh from the relay.
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}
