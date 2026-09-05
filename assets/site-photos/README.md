# Site photos — `assets/site-photos/`

Reference photography for the 3D power-flow viewport (M4a). Full frames are
**working-tree only** (gitignored, never committed); this directory versions
the durable harness around them.

## Layout

- `manifest.json` — single source of truth (COMMITTED). Photo → standpoint,
  facing, `kind`, `shows_sections` (S1/P1/S2/P2), landmarks. Filenames are
  convenience labels only.
- `contact-sheet.jpg` — labeled-thumbnails montage ≤500KB (COMMITTED).
  Never include legible address text or the placard frame.
- `photos/` — normalized working JPEGs (GITIGNORED). JPEG sRGB, long edge
  ≤2048px, ≤1MB each. Named `NN-<standpoint-slug>.jpg`.
- `incoming/` — raw drops before normalization (GITIGNORED).
- `derived/` — reusable outputs indexed in `manifest.json` (COMMITTED):
  `<NN>.<kind>.json|png`. Kinds: `section-mask`, `landmarks`, `pose`
  (extend by appending, never renaming).

Only `public/` is ever served — nothing here reaches the production site.

## Capture spec (photographer)

4 plot corners + 4 side midpoints + up to 4 free (combiner/meter close-up,
street context, eave/roof detail, pool–driveway anchor). Landscape, one light
window, ground line in frame. Record standpoint, facing, and visible sections
using the canonical names: S1 back-face strip, P1 upper face, S2 lower-deck
sliver, P2 garage face. Location services OFF for the shoot (or strip EXIF
before drop) — originals never enter `incoming/`.

## Ingest

1. Drop files (any names) into `incoming/`.
2. Normalize to spec (any tool, e.g. batch resize) into `photos/` with
   `NN-<standpoint-slug>.jpg` names.
3. Fill `manifest.json` (`plot` once + one entry per photo) and build
   `contact-sheet.jpg` (address-free).
4. `npx tsx scripts/check-site-photos.ts --strict` must be green before any
   related commit. Default mode (no flag) warns instead of failing on missing
   frames — that is the expected state on machines without the photo pack.

## Privacy

Property photos in git are visible to every collaborator: the repo stays
private, full frames never commit, and the contact sheet carries no legible
address. If the repo ever goes public, keep `contact-sheet.jpg` out (the
manifest alone still works).

## Handoff (fresh machine without the pack)

Re-shoot or re-supply the 11 views per the intake table in
`docs/plans/2026-09-05-3d-power-flow-viewport.md` (## Photo Intake), normalize
to spec, place in `photos/`. The check script reports coverage warnings until
then; chips, backport, and future techniques all work from committed files.
