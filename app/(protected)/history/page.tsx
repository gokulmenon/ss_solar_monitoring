import { HistoryDashboard } from "@/components/history/history-dashboard";
import { CloudHistoryDashboard } from "@/components/history/cloud-history-dashboard";
import { DailyEnergySummaryTable } from "@/components/history/daily-energy-summary-table";
import { WeatherHistorySection } from "@/components/weather/weather-history-section";

export default function HistoryPage() {
  return (
    <div className="space-y-6">
      <HistoryDashboard />
      <CloudHistoryDashboard />
      <DailyEnergySummaryTable />
      <WeatherHistorySection />
    </div>
  );
}
