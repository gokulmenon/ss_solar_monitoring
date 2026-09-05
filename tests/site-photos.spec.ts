import { readFileSync } from "node:fs";
import { expect, test } from "@playwright/test";

import { ROOF_SECTIONS } from "../lib/roof-layout";
import {
  photosForSection,
  sectionsForPhoto,
  serialsForPhoto,
  validateManifest,
  type SitePhotoManifest,
} from "../lib/site-photos";

function baseManifest(): SitePhotoManifest {
  return {
    version: 1,
    plot: { area_sqft: 10000, shape: "rectangle", dimensions_ft: null, street_side: null },
    photos: [
      {
        id: "01",
        file: "photos/01-front-corner.jpg",
        standpoint: "front-left plot corner",
        facing: "toward front facade",
        kind: "site",
        shows_sections: ["P1", "P2"],
        landmarks: ["garage-array", "upper-array"],
        captured_at: "2026-09-05",
        notes: "",
      },
      {
        id: "06",
        file: "photos/06-electrical-detail.jpg",
        standpoint: "side wall, close",
        facing: "toward meter wall",
        kind: "detail",
        shows_sections: [],
        landmarks: ["combiner-box", "net-meter"],
        captured_at: "2026-09-05",
        notes: "",
      },
    ],
    derived: [],
  };
}

function readCommittedManifest(): SitePhotoManifest {
  return JSON.parse(
    readFileSync("assets/site-photos/manifest.json", "utf8"),
  ) as SitePhotoManifest;
}

test("committed manifest validates clean", () => {
  expect(validateManifest(readCommittedManifest())).toEqual([]);
});

test("valid manifest passes and helpers resolve sections and serials", () => {
  const manifest = baseManifest();
  expect(validateManifest(manifest)).toEqual([]);
  expect(photosForSection(manifest, "P1").map((photo) => photo.id)).toEqual(["01"]);
  expect(photosForSection(manifest, "S1")).toEqual([]);
  expect(sectionsForPhoto(manifest, "01")).toEqual(["P1", "P2"]);
  expect(sectionsForPhoto(manifest, "06")).toEqual([]);
  expect(sectionsForPhoto(manifest, "missing")).toEqual([]);
  expect(serialsForPhoto(manifest, "01")).toEqual([
    ...ROOF_SECTIONS.P1.inverterSerials,
    ...ROOF_SECTIONS.P2.inverterSerials,
  ]);
  expect(serialsForPhoto(manifest, "missing")).toEqual([]);
});

test("duplicate ids and unknown sections are rejected", () => {
  const duplicate = baseManifest();
  duplicate.photos.push({ ...duplicate.photos[0] });
  expect(validateManifest(duplicate).some((error) => error.includes("duplicates"))).toBe(true);

  const badSection = baseManifest();
  badSection.photos[0] = {
    ...badSection.photos[0],
    shows_sections: ["P9"] as unknown as SitePhotoManifest["photos"][number]["shows_sections"],
  };
  expect(
    validateManifest(badSection).some((error) => error.includes("unknown section")),
  ).toBe(true);
});

test("derived entries must reference known photos", () => {
  const manifest = baseManifest();
  manifest.derived.push({ file: "derived/99.section-mask.png", kind: "section-mask", of: "99", note: "" });
  expect(
    validateManifest(manifest).some((error) => error.includes('unknown photo id "99"')),
  ).toBe(true);
});
