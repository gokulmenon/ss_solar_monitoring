"use client";

import { useEffect, useState } from "react";

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import {
  OVERLAY_EDITOR_CHANGED_EVENT,
  readOverlayEditorEnabled,
  writeOverlayEditorEnabled,
} from "@/lib/overlay-editor";

export function OverlayEditorToggle() {
  const [enabled, setEnabled] = useState(false);

  useEffect(() => {
    setEnabled(readOverlayEditorEnabled());

    function sync() {
      setEnabled(readOverlayEditorEnabled());
    }

    window.addEventListener("storage", sync);
    window.addEventListener(OVERLAY_EDITOR_CHANGED_EVENT, sync);
    return () => {
      window.removeEventListener("storage", sync);
      window.removeEventListener(OVERLAY_EDITOR_CHANGED_EVENT, sync);
    };
  }, []);

  function toggle() {
    const next = !enabled;
    setEnabled(next);
    writeOverlayEditorEnabled(next);
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>enable overlay editor ux</CardTitle>
        <CardDescription>
          Show the overlay, pipe, and box editor pills on the home energy visualizer.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <div className="flex items-center justify-between rounded-2xl border border-white/[0.08] bg-white/[0.03] px-4 py-3 text-sm">
          <span className="text-slate-400">Overlay editor pills</span>
          <button
            type="button"
            role="switch"
            aria-checked={enabled}
            aria-label="enable overlay editor ux"
            onClick={toggle}
            className={cn(
              "relative h-6 w-11 shrink-0 rounded-full transition-colors",
              enabled ? "bg-emerald-400/80" : "bg-slate-700",
            )}
          >
            <span
              className={cn(
                "absolute top-0.5 h-5 w-5 rounded-full bg-white shadow transition-all",
                enabled ? "left-[22px]" : "left-0.5",
              )}
            />
          </button>
        </div>
      </CardContent>
    </Card>
  );
}
