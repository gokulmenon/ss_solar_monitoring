"use client";

import { useState } from "react";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import type { SitePlot } from "@/lib/site-plot";

const inputClassName =
  "w-40 rounded-xl border border-white/10 bg-white/[0.04] px-3 py-1.5 text-sm text-slate-100 placeholder:text-slate-500 focus:border-emerald-300/50 focus:outline-none";

export function SitePlotEditor({ initialPlot }: { initialPlot: SitePlot | null }) {
  const [area, setArea] = useState(initialPlot ? String(initialPlot.area_sqft) : "");
  const [shape, setShape] = useState(initialPlot?.shape ?? "");
  const [dimensions, setDimensions] = useState(initialPlot?.dimensions_ft ?? "");
  const [streetSide, setStreetSide] = useState(initialPlot?.street_side ?? "");
  const [status, setStatus] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  if (!initialPlot) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Site plot</CardTitle>
          <CardDescription>Lot dimensions from the site-photo manifest.</CardDescription>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-slate-400">Manifest unavailable on this server.</p>
        </CardContent>
      </Card>
    );
  }

  async function save() {
    setSaving(true);
    setStatus(null);
    try {
      const response = await fetch("/api/site-plot", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          area_sqft: Number(area),
          shape,
          dimensions_ft: dimensions.trim().length > 0 ? dimensions : null,
          street_side: streetSide.trim().length > 0 ? streetSide : null,
        }),
      });
      const payload = (await response.json()) as { plot?: SitePlot; error?: string };
      if (!response.ok) {
        setStatus(payload.error ?? "Save failed.");
        return;
      }
      setStatus("Saved. Commit the worktree to keep it.");
    } catch (error) {
      setStatus((error as Error).message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Site plot</CardTitle>
        <CardDescription>
          Lot dimensions from the site-photo manifest. Open to all signed-in users during
          milestone 1; will be admin-only after. Saved to the server worktree — commit to keep.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <label className="flex items-center justify-between gap-3 text-sm">
          <span className="text-slate-400">Area (sqft)</span>
          <input
            className={inputClassName}
            inputMode="decimal"
            value={area}
            onChange={(event) => setArea(event.target.value)}
            placeholder="9865"
          />
        </label>
        <label className="flex items-center justify-between gap-3 text-sm">
          <span className="text-slate-400">Shape</span>
          <input
            className={inputClassName}
            value={shape}
            onChange={(event) => setShape(event.target.value)}
            placeholder="rectangular"
          />
        </label>
        <label className="flex items-center justify-between gap-3 text-sm">
          <span className="text-slate-400">Dimensions (ft)</span>
          <input
            className={inputClassName}
            value={dimensions}
            onChange={(event) => setDimensions(event.target.value)}
            placeholder="85x116"
          />
        </label>
        <label className="flex items-center justify-between gap-3 text-sm">
          <span className="text-slate-400">Street side</span>
          <input
            className={inputClassName}
            value={streetSide}
            onChange={(event) => setStreetSide(event.target.value)}
            placeholder="south"
          />
        </label>
        <Button className="w-full" disabled={saving} onClick={save}>
          {saving ? "Saving…" : "Save plot"}
        </Button>
        {status ? <p className="text-sm text-slate-300">{status}</p> : null}
      </CardContent>
    </Card>
  );
}
