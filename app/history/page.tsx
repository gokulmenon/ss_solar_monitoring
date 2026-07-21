import { HistoryDashboard } from "@/components/history/history-dashboard";
import { CloudHistoryDashboard } from "@/components/history/cloud-history-dashboard";
import { DailyEnergySummaryTable } from "@/components/history/daily-energy-summary-table";

export default function HistoryPage() {
  return (
    <div className="space-y-6">
      <HistoryDashboard />
      <CloudHistoryDashboard />
      <DailyEnergySummaryTable />
    </div>
  );
}
