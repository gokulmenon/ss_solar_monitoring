"use client";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import type { ServerLog } from "@/components/telemetry/use-live-telemetry";

function levelClass(level: string) {
  switch (level.toUpperCase()) {
    case "ERROR":
    case "CRITICAL":
      return "text-rose-300";
    case "WARN":
    case "WARNING":
      return "text-yellow-300";
    default:
      return "text-slate-300";
  }
}

function formatLogTime(timestamp: string) {
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return timestamp;

  return date.toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

export function AdminLogs({ logs }: { logs: ServerLog[] }) {
  return (
    <Card className="border-white/10 bg-slate-950/90">
      <CardHeader className="pb-2">
        <CardTitle className="text-[11px] uppercase tracking-[0.24em] text-slate-400">
          Relay service logs
        </CardTitle>
      </CardHeader>
      <CardContent>
        <div
          className="max-h-[360px] min-h-24 overflow-y-auto rounded-xl border border-white/10 bg-black/70 p-3 font-mono text-xs leading-5"
          aria-label="Live relay service logs"
        >
          {logs.length === 0 ? (
            <p className="text-slate-500">Waiting for relay logs…</p>
          ) : (
            logs.map((log, index) => (
              <div className="break-words" key={`${log.timestamp}-${index}`}>
                <span className="text-slate-500">{formatLogTime(log.timestamp)}</span>{" "}
                <span className={levelClass(log.level)}>{log.level.padEnd(8)}</span>{" "}
                <span className="text-slate-200">{log.message}</span>
              </div>
            ))
          )}
        </div>
      </CardContent>
    </Card>
  );
}
