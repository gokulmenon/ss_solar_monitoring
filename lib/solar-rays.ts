export const SOLAR_RAY_COLOR = "#fbbf24";
export const SOLAR_RAY_MAX = 12;

/**
 * Shared pacing for the 2D and 3D sun-ray overlays. Keep the same count and
 * period in both viewports so switching between them does not change the
 * perceived intensity of the daylight.
 */
export function getSolarRayCount(solarW: number): number {
  const watts = Math.max(0, solarW);
  if (watts < 20) return 0;
  return Math.min(SOLAR_RAY_MAX, Math.max(2, Math.round(watts / 850)));
}

export function getSolarRayPeriod(solarW: number): number {
  const normalized = Math.min(Math.max(0, solarW), 20_000) / 20_000;
  return Number((2.7 - normalized * 1.25).toFixed(2));
}
