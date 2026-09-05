import { QUAD_SECTION_ORDER, ROOF_SECTIONS, type SectionId } from "./roof-layout";

export type PhotoKind = "site" | "satellite" | "placard" | "detail";

export const PHOTO_KINDS: readonly PhotoKind[] = ["site", "satellite", "placard", "detail"];

export type SitePhoto = {
  id: string;
  file: string;
  standpoint: string;
  facing: string;
  kind: PhotoKind;
  shows_sections: SectionId[];
  landmarks: string[];
  captured_at: string;
  notes: string;
};

export type PhotoDerived = {
  file: string;
  kind: string;
  of: string;
  note: string;
};

export type SitePhotoManifest = {
  version: number;
  plot: {
    area_sqft: number;
    shape: string;
    dimensions_ft: string | null;
    street_side: string | null;
  };
  photos: SitePhoto[];
  derived: PhotoDerived[];
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

/** Structural validation shared by the check script and the unit spec. */
export function validateManifest(manifest: unknown): string[] {
  const errors: string[] = [];
  if (!isRecord(manifest)) return ["manifest must be an object"];
  if (manifest.version !== 1) {
    errors.push(`manifest.version must be 1 (got ${JSON.stringify(manifest.version) ?? "missing"})`);
  }

  if (!isRecord(manifest.plot)) {
    errors.push("manifest.plot must be an object");
  } else {
    if (typeof manifest.plot.area_sqft !== "number") errors.push("manifest.plot.area_sqft must be a number");
    if (typeof manifest.plot.shape !== "string") errors.push("manifest.plot.shape must be a string");
    for (const key of ["dimensions_ft", "street_side"] as const) {
      const value = manifest.plot[key];
      if (value !== null && typeof value !== "string") {
        errors.push(`manifest.plot.${key} must be a string or null`);
      }
    }
  }

  const photoIds = new Set<string>();
  if (!Array.isArray(manifest.photos)) {
    errors.push("manifest.photos must be an array");
  } else {
    manifest.photos.forEach((photo: unknown, index: number) => {
      const where = `photos[${index}]`;
      if (!isRecord(photo)) {
        errors.push(`${where} must be an object`);
        return;
      }
      if (!isNonEmptyString(photo.id)) {
        errors.push(`${where}.id must be a non-empty string`);
      } else if (photoIds.has(photo.id)) {
        errors.push(`${where}.id duplicates "${photo.id}"`);
      } else {
        photoIds.add(photo.id);
      }
      if (!isNonEmptyString(photo.file)) errors.push(`${where}.file must be a non-empty string`);
      if (typeof photo.standpoint !== "string") errors.push(`${where}.standpoint must be a string`);
      if (typeof photo.facing !== "string") errors.push(`${where}.facing must be a string`);
      if (typeof photo.kind !== "string" || !(PHOTO_KINDS as readonly string[]).includes(photo.kind)) {
        errors.push(`${where}.kind must be one of ${PHOTO_KINDS.join(", ")}`);
      }
      if (!Array.isArray(photo.shows_sections)) {
        errors.push(`${where}.shows_sections must be an array`);
      } else {
        for (const section of photo.shows_sections) {
          if (!(QUAD_SECTION_ORDER as readonly string[]).includes(section as string)) {
            errors.push(`${where}.shows_sections has unknown section ${JSON.stringify(section)}`);
          }
        }
      }
      if (!Array.isArray(photo.landmarks) || !photo.landmarks.every(isNonEmptyString)) {
        errors.push(`${where}.landmarks must be an array of non-empty strings`);
      }
      if (typeof photo.captured_at !== "string") errors.push(`${where}.captured_at must be a string`);
      if (typeof photo.notes !== "string") errors.push(`${where}.notes must be a string`);
    });
  }

  if (!Array.isArray(manifest.derived)) {
    errors.push("manifest.derived must be an array");
  } else {
    manifest.derived.forEach((entry: unknown, index: number) => {
      const where = `derived[${index}]`;
      if (!isRecord(entry)) {
        errors.push(`${where} must be an object`);
        return;
      }
      if (!isNonEmptyString(entry.file)) errors.push(`${where}.file must be a non-empty string`);
      if (!isNonEmptyString(entry.kind)) errors.push(`${where}.kind must be a non-empty string`);
      if (!isNonEmptyString(entry.of)) {
        errors.push(`${where}.of must be a non-empty string`);
      } else if (!photoIds.has(entry.of)) {
        errors.push(`${where}.of references unknown photo id "${entry.of}"`);
      }
      if (typeof entry.note !== "string") errors.push(`${where}.note must be a string`);
    });
  }

  return errors;
}

/** Photos covering a roof section, in manifest order. */
export function photosForSection(manifest: SitePhotoManifest, section: SectionId): SitePhoto[] {
  if (!manifest || !Array.isArray(manifest.photos)) return [];
  return manifest.photos.filter((photo) => photo.shows_sections.includes(section));
}

/** Sections visible in one photo (empty for wall/placard frames). */
export function sectionsForPhoto(manifest: SitePhotoManifest, photoId: string): SectionId[] {
  if (!manifest || !Array.isArray(manifest.photos)) return [];
  const photo = manifest.photos.find((entry) => entry.id === photoId);
  if (!photo || !Array.isArray(photo.shows_sections)) return [];
  return photo.shows_sections.filter((section): section is SectionId =>
    (QUAD_SECTION_ORDER as readonly string[]).includes(section as string),
  );
}

/**
 * Inverter serials visible in one photo: photo → sections → ROOF_SECTIONS.
 * Serials are inverter-level (not per-panel); pixel identity lives in
 * derived section masks.
 */
export function serialsForPhoto(manifest: SitePhotoManifest, photoId: string): string[] {
  return sectionsForPhoto(manifest, photoId).flatMap(
    (section) => ROOF_SECTIONS[section].inverterSerials,
  );
}
