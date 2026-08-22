export type GridFlowState = "exporting" | "importing" | "idle";

export function getGridFlowState(netGridW: number): GridFlowState {
  if (netGridW < -10) return "exporting";
  if (netGridW > 10) return "importing";
  return "idle";
}

export function formatPowerKw(watts: number) {
  return `${(Math.abs(watts) / 1000).toFixed(2)} kW`;
}

export function getFlowDuration(watts: number) {
  const normalizedPower = Math.min(Math.abs(watts), 20_000) / 20_000;
  return (2.45 - normalizedPower * 1.6).toFixed(2);
}

export function getSelfConsumptionPercent(solarProductionW: number, homeConsumptionW: number) {
  if (solarProductionW <= 0) return 0;
  return Math.min(100, Math.max(0, (homeConsumptionW / solarProductionW) * 100));
}
