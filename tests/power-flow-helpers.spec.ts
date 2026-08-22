import { expect, test } from "@playwright/test";

import {
  formatPowerKw,
  getFlowDuration,
  getGridFlowState,
  getSelfConsumptionPercent,
} from "../lib/power-flow";

test("power-flow helpers handle grid direction, formatting, and zero-safe self consumption", () => {
  expect(getGridFlowState(-1600)).toBe("exporting");
  expect(getGridFlowState(1600)).toBe("importing");
  expect(getGridFlowState(0)).toBe("idle");
  expect(formatPowerKw(-1600)).toBe("1.60 kW");
  expect(getSelfConsumptionPercent(0, 7850)).toBe(0);
  expect(getSelfConsumptionPercent(13_880, -4670)).toBe(0);
  expect(getSelfConsumptionPercent(2000, 7850)).toBe(100);
  expect(getSelfConsumptionPercent(8000, 6000)).toBe(75);
  expect(Number(getFlowDuration(12_000))).toBeLessThan(Number(getFlowDuration(1_000)));
});
