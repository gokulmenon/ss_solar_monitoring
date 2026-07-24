import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { WeatherStatusCard } from "@/components/weather/weather-status-card";

export default function SettingsPage() {
  return (
    <div className="space-y-4">
      <div>
        <p className="text-[11px] uppercase tracking-[0.26em] text-slate-400">Settings</p>
        <h1 className="mt-1 text-2xl font-semibold tracking-tight text-slate-50">
          Bridge and display
        </h1>
        <p className="mt-1 text-sm text-slate-400">
          Tune the local relay URL, mock mode, and cloud history source.
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Local bridge</CardTitle>
          <CardDescription>WebSocket relay from the hardware daemon on your Mac.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex items-center justify-between rounded-2xl border border-white/[0.08] bg-white/[0.03] px-4 py-3 text-sm">
            <span className="text-slate-400">Endpoint</span>
            <span className="font-medium text-slate-100">ws://127.0.0.1:8787</span>
          </div>
          <div className="flex items-center justify-between rounded-2xl border border-white/[0.08] bg-white/[0.03] px-4 py-3 text-sm">
            <span className="text-slate-400">Mode</span>
            <Badge variant="success">Fallback mock enabled</Badge>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Deployment split</CardTitle>
          <CardDescription>Next.js stays cloud-friendly while the relay remains local.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <p className="text-sm leading-6 text-slate-300">
            The dashboard is ready for Vercel deployment. Keep the hardware bridge on the same LAN
            as the meter, then point the app at the relay with <code className="rounded bg-white/10 px-1.5 py-0.5 text-slate-100">NEXT_PUBLIC_LIVE_WS_URL</code>.
          </p>
          <Button asChild className="w-full">
            <a href="mailto:you@example.com?subject=Solar%20Monitor%20bridge%20status">Share bridge status</a>
          </Button>
        </CardContent>
      </Card>

      <WeatherStatusCard />
    </div>
  );
}
