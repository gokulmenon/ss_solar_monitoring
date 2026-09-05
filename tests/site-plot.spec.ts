import { expect, test } from "@playwright/test";

import { validatePlotInput } from "../lib/site-plot";

test("plot input accepts a full valid payload", () => {
  const result = validatePlotInput({
    area_sqft: 9865,
    shape: "rectangular",
    dimensions_ft: "85x116",
    street_side: "south",
  });
  expect(result.error).toBeUndefined();
  expect(result.plot).toEqual({
    area_sqft: 9865,
    shape: "rectangular",
    dimensions_ft: "85x116",
    street_side: "south",
  });
});

test("plot input coerces blank strings to null and trims shape", () => {
  const result = validatePlotInput({
    area_sqft: 0,
    shape: "  unknown  ",
    dimensions_ft: "   ",
    street_side: null,
  });
  expect(result.error).toBeUndefined();
  expect(result.plot).toEqual({
    area_sqft: 0,
    shape: "unknown",
    dimensions_ft: null,
    street_side: null,
  });
});

test("plot input rejects bad area, empty shape, and oversized strings", () => {
  expect(validatePlotInput({ area_sqft: "9865", shape: "x", dimensions_ft: null, street_side: null }).error).toContain("area_sqft");
  expect(validatePlotInput({ area_sqft: -1, shape: "x", dimensions_ft: null, street_side: null }).error).toContain("area_sqft");
  expect(validatePlotInput({ area_sqft: 1, shape: "  ", dimensions_ft: null, street_side: null }).error).toContain("shape");
  expect(
    validatePlotInput({ area_sqft: 1, shape: "x", dimensions_ft: "y".repeat(41), street_side: null }).error,
  ).toContain("dimensions_ft");
  expect(validatePlotInput(null).error).toContain("object");
});
