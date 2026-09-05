export type SectionId = "S1" | "P1" | "S2" | "P2";

export const QUAD_SECTION_ORDER: SectionId[] = ["S1", "P1", "S2", "P2"];

// Display order for the /live array grid, mirroring the /home isometric POV:
// S2 upper-left, S1 upper-right, P2 lower-left, P1 lower-right.
export const SECTION_DISPLAY_ORDER: SectionId[] = ["S2", "S1", "P2", "P1"];

export const PANEL_WATTS = 445;

export type SectionPort = {
  port_number: number;
  power_w?: number | null;
};

export type SectionInverter = {
  serial_number: string;
  ports?: SectionPort[] | null;
};

type SectionConfig = {
  label: string;
  inverterSerials: string[];
  activePanels: number;
};

// Physical roof layout: each quad id is a bucket key holding the inverters
// whose panels sit on that roof section. Serials are matched case-insensitively
// (relay reports lowercase hex, stickers read uppercase).
export const ROOF_SECTIONS: Record<SectionId, SectionConfig> = {
  S1: {
    label: "Back-face strip",
    inverterSerials: ["1420B0314F85"],
    activePanels: 4,
  },
  P1: {
    label: "Upper face",
    inverterSerials: ["1420B0314D19", "1420B03146BB", "1420B0314DF9", "1420B03145C2"],
    activePanels: 13,
  },
  S2: {
    label: "Lower-deck sliver",
    inverterSerials: ["1420B0314618", "1420B0315189", "1420B03150A1", "1420B03153EC"],
    activePanels: 16,
  },
  P2: {
    label: "Garage face",
    inverterSerials: ["1420B0314CF5", "1420B0314D25", "1420B03146FC"],
    activePanels: 12,
  },
};

export function normalizeInverterSerial(serial: string | null | undefined): string {
  return (serial ?? "").trim().toUpperCase();
}

export function findSectionForSerial(serial: string | null | undefined): SectionId | null {
  const normalized = normalizeInverterSerial(serial);
  if (!normalized) return null;

  for (const id of QUAD_SECTION_ORDER) {
    if (ROOF_SECTIONS[id].inverterSerials.some((known) => known.toUpperCase() === normalized)) {
      return id;
    }
  }
  return null;
}

export function groupInvertersBySection<T extends SectionInverter>(inverters: T[]): {
  sections: Record<SectionId, T[]>;
  unassigned: T[];
} {
  const sections: Record<SectionId, T[]> = { S1: [], P1: [], S2: [], P2: [] };
  const unassigned: T[] = [];

  for (const inverter of inverters) {
    const section = findSectionForSerial(inverter.serial_number);
    if (section) sections[section].push(inverter);
    else unassigned.push(inverter);
  }

  for (const id of QUAD_SECTION_ORDER) {
    sections[id].sort((a, b) => normalizeInverterSerial(a.serial_number).localeCompare(normalizeInverterSerial(b.serial_number)));
  }

  return { sections, unassigned };
}

export function sectionCapacityW(section: SectionId): number {
  return ROOF_SECTIONS[section].activePanels * PANEL_WATTS;
}

export function getSectionPowerW<T extends SectionInverter>(inverters: T[]): number {
  let total = 0;
  for (const inverter of inverters) {
    for (const port of inverter.ports ?? []) {
      total += Math.max(0, port.power_w ?? 0);
    }
  }
  return total;
}

export function getSectionRatio(section: SectionId, sectionPowerW: number): number {
  const capacity = sectionCapacityW(section);
  if (capacity <= 0) return 0;
  return Math.min(1, Math.max(0, sectionPowerW / capacity));
}
