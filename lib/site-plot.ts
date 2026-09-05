import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { SitePhotoManifest } from "./site-photos";

export type SitePlot = SitePhotoManifest["plot"];

// TEMPORARY (M1): the plot editor renders for every signed-in user and the
// PUT route skips the admin check, so the estimated dimensions can be
// corrected while milestone-1 work runs in parallel. Re-gate by flipping
// this to true (the route then 403s and the settings page hides the section
// for non-admins).
export const PLOT_EDITOR_REQUIRE_ADMIN = false;

const MANIFEST_PATH = join(process.cwd(), "assets", "site-photos", "manifest.json");

/** Pure validation shared by the route and the unit spec. */
export function validatePlotInput(value: unknown): { plot?: SitePlot; error?: string } {
  if (typeof value !== "object" || value === null) {
    return { error: "Body must be an object." };
  }
  const { area_sqft, shape, dimensions_ft, street_side } = value as Record<string, unknown>;
  if (typeof area_sqft !== "number" || !Number.isFinite(area_sqft) || area_sqft < 0) {
    return { error: "area_sqft must be a non-negative number." };
  }
  if (typeof shape !== "string" || shape.trim().length === 0 || shape.length > 120) {
    return { error: "shape must be a non-empty string (at most 120 chars)." };
  }
  for (const [key, entry] of [
    ["dimensions_ft", dimensions_ft],
    ["street_side", street_side],
  ] as const) {
    if (entry !== null && (typeof entry !== "string" || entry.length > 40)) {
      return { error: `${key} must be a string (at most 40 chars) or null.` };
    }
  }
  return {
    plot: {
      area_sqft,
      shape: shape.trim(),
      dimensions_ft:
        typeof dimensions_ft === "string" && dimensions_ft.trim().length > 0
          ? dimensions_ft.trim()
          : null,
      street_side:
        typeof street_side === "string" && street_side.trim().length > 0
          ? street_side.trim()
          : null,
    },
  };
}

export async function readSitePlot(): Promise<SitePlot> {
  const manifest = JSON.parse(await readFile(MANIFEST_PATH, "utf8")) as SitePhotoManifest;
  return manifest.plot;
}

/** Read-modify-write of the plot key only; photos/derived pass through untouched. */
export async function updateSitePlot(plot: SitePlot): Promise<SitePlot> {
  const manifest = JSON.parse(await readFile(MANIFEST_PATH, "utf8")) as SitePhotoManifest;
  manifest.plot = plot;
  await writeFile(MANIFEST_PATH, JSON.stringify(manifest, null, 2) + "\n");
  return plot;
}
