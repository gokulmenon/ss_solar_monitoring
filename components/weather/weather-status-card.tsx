"use client";

import { useEffect, useMemo, useState } from "react";

import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import type { WeatherSnapshot } from "@/lib/weather";

type WeatherLatestResponse = {
  provider: string;
  status: "healthy" | "offline";
  latest: WeatherSnapshot | null;
};

function formatTimestamp(timestamp: string | null | undefined) {
  if (!timestamp) return "Never";

  return new Date(timestamp).toLocaleString([], {
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

export function WeatherStatusCard() {
  const [payload, setPayload] = useState<WeatherLatestResponse | null>(null);

  useEffect(() => {
    const controller = new AbortController();

    async function loadStatus() {
      try {
        const response = await fetch("/api/weather/latest", {
          signal: controller.signal,
          cache: "no-store",
        });

        if (!response.ok) return;
        setPayload((await response.json()) as WeatherLatestResponse);
      } catch (error) {
        if ((error as Error).name !== "AbortError") {
          console.error(error);
        }
      }
    }

    void loadStatus();

    return () => controller.abort();
  }, []);

  const ageMinutes = useMemo(() => {
    if (!payload?.latest?.timestamp) return null;

    return Math.max(0, Math.round((Date.now() - new Date(payload.latest.timestamp).getTime()) / 60_000));
  }, [payload?.latest?.timestamp]);
  const healthy = ageMinutes !== null && ageMinutes <= 45;

  return (
    <Card>
      <CardHeader>
        <CardTitle>Weather provider</CardTitle>
        <CardDescription>Read-only Open-Meteo ingestion status from Supabase.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="flex items-center justify-between rounded-2xl border border-white/[0.08] bg-white/[0.03] px-4 py-3 text-sm">
          <span className="text-slate-400">Provider</span>
          <span className="font-medium text-slate-100">{payload?.provider ?? "Open-Meteo"}</span>
        </div>
        <div className="flex items-center justify-between rounded-2xl border border-white/[0.08] bg-white/[0.03] px-4 py-3 text-sm">
          <span className="text-slate-400">Status</span>
          <Badge variant={healthy ? "success" : "danger"}>{healthy ? "Healthy" : "Offline"}</Badge>
        </div>
        <div className="flex items-center justify-between rounded-2xl border border-white/[0.08] bg-white/[0.03] px-4 py-3 text-sm">
          <span className="text-slate-400">Last update</span>
          <span className="font-medium text-slate-100">
            {formatTimestamp(payload?.latest?.timestamp)}
          </span>
        </div>
      </CardContent>
    </Card>
  );
}
