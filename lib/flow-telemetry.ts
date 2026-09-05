import {
  getFlowDuration,
  getGridFlowState,
  getSelfConsumptionPercent,
  type GridFlowState,
} from "./power-flow";

export type FlowTelemetry = {
  trueSolarW: number;
  trueHomeW: number;
  trueGridW: number;
  gridState: GridFlowState;
  solarActive: boolean;
  loadsActive: boolean;
  solarDuration: string;
  gridDuration: string;
  loadDuration: string;
  selfConsumption: number;
  powerRatio: number;
};

export type FlowTelemetryInput = {
  solarW: number;
  homeW: number;
  /** Solar-repo adaptation: no metered net-grid prop — grid is derived. */
  capacityKw?: number;
};

const DEFAULT_CAPACITY_KW = 20.02;

/**
 * Single computation point for derived flow values. Sync adaptation of the
 * home selector: grid is derived (`home − solar`, positive = importing)
 * because this repo has no `netGridW` prop; `capacityKw` defaults to 20.02
 * per §Sync. The 2D SVG block and the 3D canvas both consume this so the two
 * views can never drift apart.
 */
export function getFlowTelemetry(input: FlowTelemetryInput): FlowTelemetry {
  const trueSolarW = Math.max(0, input.solarW);
  const trueHomeW = Math.abs(input.homeW);
  const trueGridW = trueHomeW - trueSolarW;
  const capacityKw = input.capacityKw ?? DEFAULT_CAPACITY_KW;
  return {
    trueSolarW,
    trueHomeW,
    trueGridW,
    gridState: getGridFlowState(trueGridW),
    solarActive: trueSolarW >= 20,
    loadsActive: trueHomeW > 0,
    solarDuration: getFlowDuration(trueSolarW),
    gridDuration: getFlowDuration(trueGridW),
    loadDuration: getFlowDuration(trueHomeW),
    selfConsumption: getSelfConsumptionPercent(trueSolarW, trueHomeW),
    powerRatio: capacityKw > 0 ? (trueSolarW / (capacityKw * 1000)) * 100 : 0,
  };
}
