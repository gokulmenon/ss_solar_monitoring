import { expect, test } from "@playwright/test";

import {
  PANEL_WATTS,
  QUAD_SECTION_ORDER,
  ROOF_SECTIONS,
  SECTION_DISPLAY_ORDER,
  findSectionForSerial,
  getSectionPowerW,
  getSectionRatio,
  groupInvertersBySection,
  sectionCapacityW,
} from "../lib/roof-layout";

test("roof sections cover all 12 inverters and 45 active panels", () => {
  const serials = QUAD_SECTION_ORDER.flatMap((id) => ROOF_SECTIONS[id].inverterSerials);
  expect(serials).toHaveLength(12);
  expect(new Set(serials).size).toBe(12);

  const panels = QUAD_SECTION_ORDER.reduce((sum, id) => sum + ROOF_SECTIONS[id].activePanels, 0);
  expect(panels).toBe(45);
  expect(PANEL_WATTS).toBe(445);
  expect(
    QUAD_SECTION_ORDER.reduce((sum, id) => sum + sectionCapacityW(id), 0),
  ).toBe(45 * 445);
});

test("display order mirrors the home isometric POV", () => {
  expect(SECTION_DISPLAY_ORDER).toEqual(["S2", "S1", "P2", "P1"]);
  expect([...SECTION_DISPLAY_ORDER].sort()).toEqual([...QUAD_SECTION_ORDER].sort());
});

test("serial lookup is case-insensitive and rejects unknowns", () => {
  expect(findSectionForSerial("1420b0314f85")).toBe("S1");
  expect(findSectionForSerial("1420B0314F85")).toBe("S1");
  expect(findSectionForSerial("1420B03145C2")).toBe("P1");
  expect(findSectionForSerial("1420B03153EC")).toBe("S2");
  expect(findSectionForSerial("1420B0314D25")).toBe("P2");
  expect(findSectionForSerial("unknown-serial")).toBeNull();
  expect(findSectionForSerial("")).toBeNull();
});

test("section power sums port watts and ratio divides by capacity", () => {
  const { sections, unassigned } = groupInvertersBySection([
    {
      serial_number: "1420b0314d19",
      ports: [
        { port_number: 1, power_w: 100 },
        { port_number: 2, power_w: 200 },
        { port_number: 3, power_w: null },
        { port_number: 4, power_w: 0 },
      ],
    },
    { serial_number: "mystery-inverter", ports: [{ port_number: 1, power_w: 50 }] },
  ]);

  expect(sections.P1).toHaveLength(1);
  expect(unassigned).toHaveLength(1);
  expect(getSectionPowerW(sections.P1)).toBe(300);
  expect(getSectionRatio("P1", 300)).toBeCloseTo(300 / (13 * 445), 6);
  expect(getSectionRatio("P1", 99_999)).toBe(1);
  expect(getSectionRatio("S1", 0)).toBe(0);
});
