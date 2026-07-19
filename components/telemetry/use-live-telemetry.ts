"use client";

import { useEffect, useMemo, useState } from "react";
import useWebSocket, { ReadyState } from "react-use-websocket";

import { createMockLiveTelemetry, type LiveTelemetry } from "@/lib/mock-data";

export type LiveBridgeTelemetry = Partial<LiveTelemetry> & {
  phase_a_voltage_v?: number;
};

export type LiveSeriesPoint = LiveTelemetry & {
  phase_a_voltage_v?: number;
};

const SERIES_LIMIT = 60;
const SERIES_BUCKET_MS = 10_000;

function bucketTimestamp(timestamp: string) {
  const date = new Date(timestamp);
  const bucketMs = Math.floor(date.getTime() / SERIES_BUCKET_MS) * SERIES_BUCKET_MS;
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
  const [series, setSeries] = useState<LiveSeriesPoint[]>(() => []);

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

  const telemetry = useMemo(
    () => mergeTelemetry(mockTelemetry, bridgeTelemetry),
    [mockTelemetry, bridgeTelemetry],
  );

  useEffect(() => {
    const nextPoint = {
      ...telemetry,
      timestamp: bucketTimestamp(telemetry.timestamp),
    };

    setSeries((previous) => {
      if (previous.length === 0) return [nextPoint];

      const lastPoint = previous[previous.length - 1];
      if (lastPoint.timestamp === nextPoint.timestamp) {
        return [...previous.slice(0, -1), nextPoint].slice(-SERIES_LIMIT);
      }

      return [...previous, nextPoint].slice(-SERIES_LIMIT);
    });
  }, [telemetry]);

  return {
    telemetry,
    series,
    connected: readyState === ReadyState.OPEN,
    readyState,
    wsUrl,
  };
}
