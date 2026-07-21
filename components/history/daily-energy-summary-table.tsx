"use client";

import { useEffect, useState } from "react";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import type { DailyEnergySummaryPoint } from "@/lib/daily-energy";

type DailyEnergyResponse = {
  generated_at: string;
  points: DailyEnergySummaryPoint[];
};

function formatDay(day: string) {
  return new Date(`${day}T12:00:00`).toLocaleDateString([], {
    month: "short",
    day: "numeric",
    weekday: "short",
  });
}

function formatKwh(value: number) {
  return value.toFixed(2);
}

export function DailyEnergySummaryTable() {
  const [points, setPoints] = useState<DailyEnergySummaryPoint[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const controller = new AbortController();

    async function loadRows() {
      try {
        const response = await fetch("/api/daily-energy?days=30", {
          signal: controller.signal,
          cache: "no-store",
        });

        if (!response.ok) {
          throw new Error(`Daily energy request failed: ${response.status}`);
        }

        const payload = (await response.json()) as DailyEnergyResponse;
        setPoints(payload.points);
      } catch (error) {
        if ((error as Error).name !== "AbortError") {
          console.error(error);
        }
      } finally {
        setLoading(false);
      }
    }

    void loadRows();

    return () => controller.abort();
  }, []);

  return (
    <Card className="border-white/10 bg-slate-950/80">
      <CardHeader className="pb-2">
        <CardTitle className="text-[11px] uppercase tracking-[0.24em] text-slate-400">
          Daily energy summary
        </CardTitle>
      </CardHeader>
      <CardContent className="pt-0">
        {loading ? (
          <div className="rounded-2xl border border-white/[0.08] bg-white/[0.03] p-4 text-sm text-slate-400">
            Loading daily totals...
          </div>
        ) : points.length === 0 ? (
          <div className="rounded-2xl border border-dashed border-white/10 bg-white/[0.02] p-6 text-center text-sm text-slate-400">
            No daily Supabase summary rows found yet.
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[680px] text-left text-sm">
              <thead className="text-[11px] uppercase tracking-[0.18em] text-slate-500">
                <tr className="border-b border-white/10">
                  <th className="py-3 pr-4 font-medium">Day</th>
                  <th className="px-4 py-3 font-medium">Import</th>
                  <th className="px-4 py-3 font-medium">Export</th>
                  <th className="px-4 py-3 font-medium">Solar</th>
                  <th className="px-4 py-3 font-medium">Home</th>
                  <th className="py-3 pl-4 text-right font-medium">Samples</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-white/[0.06] text-slate-300">
                {points.map((point) => (
                  <tr key={point.day}>
                    <td className="py-3 pr-4 font-medium text-slate-100">{formatDay(point.day)}</td>
                    <td className="px-4 py-3 text-amber-300">{formatKwh(point.daily_grid_import_kwh)} kWh</td>
                    <td className="px-4 py-3 text-emerald-300">{formatKwh(point.daily_grid_export_kwh)} kWh</td>
                    <td className="px-4 py-3 text-yellow-300">{formatKwh(point.daily_solar_kwh)} kWh</td>
                    <td className="px-4 py-3 text-sky-300">{formatKwh(point.daily_home_consumption_kwh)} kWh</td>
                    <td className="py-3 pl-4 text-right text-slate-400">
                      {point.sample_count.toLocaleString()}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
