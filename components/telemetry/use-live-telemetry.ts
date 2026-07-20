"use client";

import { useEffect, useMemo, useState } from "react";
import useWebSocket, { ReadyState } from "react-use-websocket";

import { createMockLiveTelemetry, type LiveTelemetry } from "@/lib/mock-data";

export type HoymilesPortReading = {
  serial_number: string;
  port_number: number;
  voltage_v?: number | null;
  power_w?: number | null;
};

export type HoymilesInverterReading = {
  serial_number: string;
  active_power_w?: number | null;
  temperature_c?: number | null;
  ports?: HoymilesPortReading[];
};

export type HoymilesTelemetry = {
  timestamp?: string;
  status?: string;
  total_active_power_w?: number | null;
  inverter_count?: number;
  port_count?: number;
  inverters?: HoymilesInverterReading[];
};

export type LiveBridgeTelemetry = Partial<LiveTelemetry> & {
  phase_a_voltage_v?: number;
  hoymiles?: HoymilesTelemetry;
  hoymiles_status?: string;
  hoymiles_total_active_power_w?: number | null;
  hoymiles_inverter_count?: number;
  hoymiles_port_count?: number;
  status?: "HARDWARE_OFFLINE";
  failures?: number;
  message?: string;
};

export type LiveSeriesPoint = LiveTelemetry & {
  phase_a_voltage_v?: number;
  hoymiles?: HoymilesTelemetry;
};

export type BridgeState = "mock" | "connected" | "hardware_offline";

type LiveSeriesBucket = LiveSeriesPoint & {
  sampleCount: number;
};

const SERIES_LIMIT = 24 * 60;

function hasTelemetryFields(message: LiveBridgeTelemetry) {
  return (
    typeof message.timestamp === "string" ||
    typeof message.solar_production_w === "number" ||
    typeof message.net_grid_w === "number" ||
    typeof message.home_consumption_w === "number" ||
    typeof message.phase_a_voltage_v === "number"
  );
}

function minuteBucketTimestamp(timestamp: string) {
  const date = new Date(timestamp);
  const bucketMs = Math.floor(date.getTime() / 60_000) * 60_000;
  return new Date(bucketMs).toISOString();
}

function mergeTelemetry(
  mockTelemetry: LiveTelemetry,
  bridgeTelemetry: LiveBridgeTelemetry | null,
): LiveSeriesPoint {
  return {
    ...mockTelemetry,
    ...(bridgeTelemetry ?? {}),
    timestamp: bridgeTelemetry?.timestamp ?? mockTelemetry.timestamp,
  };
}

export function useLiveTelemetry() {
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
  const [hardwareOffline, setHardwareOffline] = useState(false);
  const [seriesBuckets, setSeriesBuckets] = useState<LiveSeriesBucket[]>(() => []);

  useEffect(() => {
    if (readyState === ReadyState.OPEN) return undefined;

    const interval = window.setInterval(() => {
      setMockTelemetry(createMockLiveTelemetry());
    }, 1000);

    setMockTelemetry(createMockLiveTelemetry());

    return () => window.clearInterval(interval);
  }, []);

  useEffect(() => {
    if (!lastJsonMessage) return;

    if (lastJsonMessage.status === "HARDWARE_OFFLINE") {
      setHardwareOffline(true);
      return;
    }

    if (hasTelemetryFields(lastJsonMessage)) {
      setHardwareOffline(false);
    }

    setBridgeTelemetry(lastJsonMessage);
  }, [lastJsonMessage]);

  const telemetry = useMemo(
    () => mergeTelemetry(mockTelemetry, bridgeTelemetry),
    [mockTelemetry, bridgeTelemetry],
  );

  useEffect(() => {
    const nextPoint: LiveSeriesBucket = {
      ...telemetry,
      timestamp: minuteBucketTimestamp(telemetry.timestamp),
      sampleCount: 1,
    };

    setSeriesBuckets((previous) => {
      if (previous.length === 0) return [nextPoint];

      const lastPoint = previous[previous.length - 1];
      if (lastPoint.timestamp === nextPoint.timestamp) {
        const sampleCount = lastPoint.sampleCount + 1;
        const averagedPoint: LiveSeriesBucket = {
          ...lastPoint,
          ...nextPoint,
          sampleCount,
          solar_production_w: Math.round(
            (lastPoint.solar_production_w * lastPoint.sampleCount + nextPoint.solar_production_w) /
              sampleCount,
          ),
          net_grid_w: Math.round(
            (lastPoint.net_grid_w * lastPoint.sampleCount + nextPoint.net_grid_w) / sampleCount,
          ),
          home_consumption_w: Math.round(
            (lastPoint.home_consumption_w * lastPoint.sampleCount + nextPoint.home_consumption_w) /
              sampleCount,
          ),
          phase_a_voltage_v:
            typeof nextPoint.phase_a_voltage_v === "number"
              ? Math.round(
                  ((lastPoint.phase_a_voltage_v ?? nextPoint.phase_a_voltage_v) *
                    lastPoint.sampleCount +
                    nextPoint.phase_a_voltage_v) /
                    sampleCount,
                )
              : lastPoint.phase_a_voltage_v,
        };

        return [...previous.slice(0, -1), averagedPoint].slice(-SERIES_LIMIT);
      }

      return [...previous, nextPoint].slice(-SERIES_LIMIT);
    });
  }, [telemetry]);

  const series = useMemo<LiveSeriesPoint[]>(
    () =>
      seriesBuckets.map(({ sampleCount: _sampleCount, ...point }) => point),
    [seriesBuckets],
  );

  return {
    telemetry,
    series,
    bridgeState: hardwareOffline ? "hardware_offline" : readyState === ReadyState.OPEN ? "connected" : "mock",
    readyState,
    wsUrl,
  };
}
