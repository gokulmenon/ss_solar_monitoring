/**
 * Gate for assets/site-photos/: manifest schema, file presence, size caps,
 * embedded location metadata, section coverage, contact sheet.
 *
 * Default mode warns on missing frames / empty coverage (expected on machines
 * without the photo pack) and fails only on structural errors. `--strict`
 * requires full coverage for ingest commits.
 *
 * Usage: npx tsx scripts/check-site-photos.ts [--strict]
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { QUAD_SECTION_ORDER } from "../lib/roof-layout";
import {
  photosForSection,
  validateManifest,
  type SitePhotoManifest,
} from "../lib/site-photos";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PHOTOS_DIR = join(ROOT, "assets", "site-photos");
const CONTACT_SHEET = join(PHOTOS_DIR, "contact-sheet.jpg");

const MAX_FRAME_BYTES = 1_000_000;
const MAX_SHEET_BYTES = 500_000;
const MIN_PHOTOS_STRICT = 8;

let failures = 0;
let warnings = 0;
const strict = process.argv.includes("--strict");

function fail(message: string) {
  failures += 1;
  console.error(`FAIL ${message}`);
}

function warn(message: string) {
  if (strict) {
    fail(message);
  } else {
    warnings += 1;
    console.log(`WARN ${message}`);
  }
}

function pass(message: string) {
  console.log(`PASS ${message}`);
}

/**
 * Minimal JPEG scan for an EXIF GPS IFD pointer (tag 0x8825): finds
 * "Exif\\0\\0", reads TIFF endianness, walks IFD0 entries. No image decode.
 */
function jpegHasGpsTag(buffer: Buffer): boolean {
  const exifHeader = buffer.indexOf(Buffer.from([0x45, 0x78, 0x69, 0x66, 0x00, 0x00]));
  if (exifHeader === -1) return false;
  const tiffStart = exifHeader + 6;
  if (tiffStart + 8 > buffer.length) return false;
  const little = buffer[tiffStart] === 0x49 && buffer[tiffStart + 1] === 0x49;
  const big = buffer[tiffStart] === 0x4d && buffer[tiffStart + 1] === 0x4d;
  if (!little && !big) return false;
  const readU16 = (offset: number) =>
    little ? buffer.readUInt16LE(offset) : buffer.readUInt16BE(offset);
  const readU32 = (offset: number) =>
    little ? buffer.readUInt32LE(offset) : buffer.readUInt32BE(offset);
  const ifdOffset = tiffStart + readU32(tiffStart + 4);
  if (ifdOffset + 2 > buffer.length) return false;
  const entries = readU16(ifdOffset);
  for (let i = 0; i < entries; i += 1) {
    const entry = ifdOffset + 2 + i * 12;
    if (entry + 12 > buffer.length) return false;
    if (readU16(entry) === 0x8825) return true;
  }
  return false;
}

function checkFile(path: string, capBytes: number, label: string): Buffer | null {
  if (!existsSync(path)) {
    warn(`missing ${label}: ${path}`);
    return null;
  }
  const buffer = readFileSync(path);
  if (buffer.length > capBytes) {
    warn(`${label} exceeds cap (${buffer.length} > ${capBytes} bytes): ${path}`);
  }
  if (/\.(jpe?g)$/i.test(path) && jpegHasGpsTag(buffer)) {
    warn(`${label} carries embedded GPS metadata (strip location before ingest): ${path}`);
  }
  return buffer;
}

let manifest: SitePhotoManifest;
try {
  manifest = JSON.parse(
    readFileSync(join(PHOTOS_DIR, "manifest.json"), "utf8"),
  ) as SitePhotoManifest;
} catch (error) {
  fail(`manifest.json unreadable: ${(error as Error).message}`);
  process.exit(1);
}

const structural = validateManifest(manifest);
if (structural.length > 0) {
  for (const error of structural) fail(`manifest: ${error}`);
} else {
  pass("manifest schema valid");
}

let presentFrames = 0;
for (const photo of manifest.photos) {
  const buffer = checkFile(join(PHOTOS_DIR, photo.file), MAX_FRAME_BYTES, `photo ${photo.id}`);
  if (buffer) presentFrames += 1;
}

let presentDerived = 0;
for (const entry of manifest.derived) {
  if (checkFile(join(PHOTOS_DIR, entry.file), MAX_FRAME_BYTES, `derived ${entry.of}`)) {
    presentDerived += 1;
  }
}

const uncovered = QUAD_SECTION_ORDER.filter((section) => {
  const covering = photosForSection(manifest, section).filter((photo) =>
    existsSync(join(PHOTOS_DIR, photo.file)),
  );
  return covering.length === 0;
});
if (uncovered.length > 0) {
  warn(`sections without a present covering photo: ${uncovered.join(", ")}`);
} else if (manifest.photos.length > 0) {
  pass("every section S1/P1/S2/P2 is covered by a present photo");
} else {
  warn("manifest has no photos yet (pre-ingest state)");
}

if (strict && manifest.photos.length < MIN_PHOTOS_STRICT) {
  fail(`strict mode needs ≥${MIN_PHOTOS_STRICT} manifest photos (got ${manifest.photos.length})`);
}

const sheet = checkFile(CONTACT_SHEET, MAX_SHEET_BYTES, "contact sheet");
if (sheet && failures === 0) pass("contact sheet present within cap");

console.log(
  `photos ${presentFrames}/${manifest.photos.length} present, ` +
    `derived ${presentDerived}/${manifest.derived.length} present` +
    (strict ? " (strict)" : ` (${warnings} warnings)`) +
    `, ${failures} failures`,
);
process.exit(failures > 0 ? 1 : 0);
