import { HistoryDashboard } from "@/components/history/history-dashboard";
import { CloudHistoryDashboard } from "@/components/history/cloud-history-dashboard";

export default function HistoryPage() {
  return (
    <div className="space-y-6">
      <HistoryDashboard />
      <div className="rounded-[2rem] border border-white/10 bg-white/[0.02] p-3 md:p-4">
        <CloudHistoryDashboard />
      </div>
    </div>
  );
}
