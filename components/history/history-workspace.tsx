"use client";

import { useState } from "react";

import { CsvPortHistoryDashboard } from "@/components/history/csv-port-history-dashboard";
import { CsvWeatherHistorySection } from "@/components/history/csv-weather-history-section";
import { CloudHistoryDashboard } from "@/components/history/cloud-history-dashboard";
import { DailyEnergySummaryTable } from "@/components/history/daily-energy-summary-table";
import { HistoryDashboard } from "@/components/history/history-dashboard";
import { Button } from "@/components/ui/button";
import { WeatherHistorySection } from "@/components/weather/weather-history-section";

type HistoryTab = "csv" | "supabase";

export function HistoryWorkspace() {
  const [tab, setTab] = useState<HistoryTab>("csv");

  return (
    <div className="space-y-6">
      <div className="space-y-3">
        <div>
          <p className="text-[11px] uppercase tracking-[0.26em] text-slate-400">Energy records</p>
          <h1 className="mt-1 text-2xl font-semibold tracking-tight text-slate-50">History</h1>
          <p className="mt-1 max-w-2xl text-sm text-slate-400">
            CSV archives remain available when cloud history is unavailable; Supabase provides the synced view.
          </p>
        </div>

        <div className="grid grid-cols-2 rounded-2xl border border-white/10 bg-white/[0.03] p-1">
          <Button
            type="button"
            variant={tab === "csv" ? "default" : "ghost"}
            className="h-10"
            onClick={() => setTab("csv")}
          >
            CSV archives
          </Button>
          <Button
            type="button"
            variant={tab === "supabase" ? "default" : "ghost"}
            className="h-10"
            onClick={() => setTab("supabase")}
          >
            Supabase cloud
          </Button>
        </div>
      </div>

      {tab === "csv" ? (
        <div className="space-y-8">
          <HistoryDashboard />
          <CsvPortHistoryDashboard />
          <CsvWeatherHistorySection />
        </div>
      ) : (
        <div className="space-y-8">
          <CloudHistoryDashboard />
          <DailyEnergySummaryTable />
          <WeatherHistorySection />
        </div>
      )}
    </div>
  );
}
