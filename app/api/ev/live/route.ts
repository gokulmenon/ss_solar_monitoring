import { NextResponse } from "next/server";

import { deriveEVStatus } from "@/lib/ev-charging";
import { loadEVLatestSnapshot } from "@/lib/ev-charging-server";

export async function GET() {
  const snapshot = await loadEVLatestSnapshot();
  const status = snapshot
    ? deriveEVStatus({
        contactor_closed: snapshot.contactor_closed,
        vehicle_connected: snapshot.vehicle_connected,
        last_poll_at: snapshot.timestamp,
      })
    : "unknown";

  return NextResponse.json({
    generated_at: new Date().toISOString(),
    status,
    snapshot,
  });
}
