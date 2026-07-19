export type LiveTelemetry = {
  timestamp: string;
  solar_production_w: number;
  net_grid_w: number;
  home_consumption_w: number;
};

export type HistoryPoint = {
  timestamp: string;
  solar_kwh: number;
  grid_kwh: number;
  home_kwh: number;
};

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

const roundWholeWatts = (value: number) => Math.round(value / 25) * 25;

const roundTwoDecimals = (value: number) => Math.round(value * 100) / 100;

/**
 * Generates a realistic live telemetry snapshot that feels stable on mobile
 * while still moving enough to make the dashboard feel alive.
 */
export function createMockLiveTelemetry(now = new Date()): LiveTelemetry {
  const minutes = now.getHours() * 60 + now.getMinutes() + now.getSeconds() / 60;
  const daylightCurve = clamp(Math.sin(((minutes - 360) / 720) * Math.PI), 0, 1);

  const solarProductionW = roundWholeWatts(
    clamp(
      daylightCurve * 13500 +
        daylightCurve * Math.sin(minutes / 7) * 420 +
        daylightCurve * Math.cos(minutes / 17) * 180,
      0,
      18000,
    ),
  );

  const homeConsumptionW = roundWholeWatts(
    clamp(
      7200 +
        Math.sin((minutes / 1440) * Math.PI * 2 - 1.15) * 2100 +
        Math.cos(minutes / 11) * 250,
      1200,
      15000,
    ),
  );

  const netGridW = roundWholeWatts(homeConsumptionW - solarProductionW);

  return {
    timestamp: now.toISOString(),
    solar_production_w: solarProductionW,
    net_grid_w: netGridW,
    home_consumption_w: homeConsumptionW,
  };
}

/**
 * Builds a full day of cloud-style history data. The chart page consumes this
 * through a standard REST request to mirror the eventual cloud database shape.
 */
export function generateHistorySeries(day = new Date()): HistoryPoint[] {
  const startOfDay = new Date(day);
  startOfDay.setHours(0, 0, 0, 0);

  return Array.from({ length: 24 }, (_, hour) => {
    const timestamp = new Date(startOfDay);
    timestamp.setHours(hour, 0, 0, 0);

    const phase = (hour / 24) * Math.PI * 2;
    const daylightCurve = clamp(Math.sin(((hour - 6) / 12) * Math.PI), 0, 1);

    const solar_kwh = roundTwoDecimals(
      clamp(
        daylightCurve * 3.8 +
          daylightCurve * Math.sin(phase * 2.5) * 0.12 +
          daylightCurve * Math.cos(phase * 3.1) * 0.08,
        0,
        5.2,
      ),
    );

    const home_kwh = roundTwoDecimals(
      clamp(0.85 + Math.sin(phase - 1.05) * 0.55 + Math.cos(phase * 3) * 0.14, 0.3, 2.1),
    );

    const grid_kwh = roundTwoDecimals(home_kwh - solar_kwh);

    return {
      timestamp: timestamp.toISOString(),
      solar_kwh,
      grid_kwh,
      home_kwh,
    };
  });
}
