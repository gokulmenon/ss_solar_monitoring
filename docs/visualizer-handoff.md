# Visualizer Handoff: ss_solar_monitoring → home_monitoring

Backport target: `home_monitoring/components/live/power-flow-visualizer.tsx`
(and its `/live` array visualizer). Reference implementation: this repo, main
branch as of the "section battery fills" commit.

## 1. S1 quad resize

`QUAD_OVERLAYS` entry for S1 changed (smaller strip, 1 inverter / 4 panels):

```
S1: 465,201 618,142 715,128 528,202
```

i.e. `[[465, 201], [618, 142], [715, 128], [528, 202]]`. P1/S2/P2 unchanged.

## 2. New shared module (`lib/roof-layout.ts` in this repo — port as-is)

- `SectionId = "S1" | "P1" | "S2" | "P2"`, `QUAD_SECTION_ORDER = ["S1","P1","S2","P2"]`
- `SECTION_DISPLAY_ORDER = ["S2","S1","P2","P1"]` (/live grid order, mirrors /home POV)
- `PANEL_WATTS = 445`
- `ROOF_SECTIONS`: S1 ← `1420B0314F85` (4 panels); P1 ← `1420B0314D19`,
  `1420B03146BB`, `1420B0314DF9`, `1420B03145C2` (13 panels, 3 ghost ports);
  S2 ← `1420B0314618`, `1420B0315189`, `1420B03150A1`, `1420B03153EC` (16 panels);
  P2 ← `1420B0314CF5`, `1420B0314D25`, `1420B03146FC` (12 panels). 12 inverters,
  45 active panels total.
- Helpers: `normalizeInverterSerial` (case-insensitive; relay reports lowercase
  hex, stickers read uppercase), `findSectionForSerial`,
  `groupInvertersBySection`, `sectionCapacityW` (panels × 445),
  `getSectionPowerW` (sums `port.power_w`, negatives/nulls as 0),
  `getSectionRatio` (power ÷ capacity, clamped 0–1).

## 3. Battery fills + labels (all 4 quads)

- `quadFillGeometry(corners, ratio, fromTop)`: strip growing from one long edge
  toward the other so the fill surface stays parallel to the eave. P1/P2 use
  `fromTop = false` (rise from bottom long edge); S1/S2 use `fromTop = true`
  (descend from top long edge). Corners are paired by strip end (projection
  onto the long axis) — never by edge order, which bowties into triangles on
  the tapered S1/S2 slivers.
- `quadBottomEdgeAngle(corners)`: label lean from the bottom long edge,
  left-to-right. S2's label borrows P2's edge angle (same lower deck; S2's own
  eave is nearly flat at ≈ −7° vs ≈ −20° elsewhere).
- Labels: white 16-unit semibold text `"<kW> kW <pct>%"` (e.g. `3.12 kW 54%`),
  dark outline (`paintOrder="stroke"`), group `opacity="0.85"`, fill polygon
  `rgba(52,211,153,0.35)`. P1/P2 labels ride above the fill line
  (`mid − 30`); S1/S2 use fixed anchors `SECTION_LABEL_ANCHOR`
  (viewBox units): S1 `[445, 245]` (below hero, left of trunk, on black roof),
  S2 `[110, 422]` (below pool). Nothing renders below ratio 0.005.
- Fills follow `QUAD_OVERLAYS` order so slivers tuck like the base quads, and
  derive from live tuner points so tuner moves carry them.
- Adaptation: home_monitoring's component is `PowerFlowVisualizer` with a
  `netGridW` prop (`trueGridW = netGridW`, not home − solar), local
  `EnergyTotals` type, weather at `/api/energy/weather/latest`, optional
  `capacityKw` (no default), and conditional Today/energy cards. Add an
  `inverters` prop (port list with `serial_number`/`port_number`/`power_w`)
  and have the parent pass live inverter readings; keep everything else.

## 4. Source dots removed

The 4 black `src-*` circles were deleted; only upperMid/lowerMid/junction
dots, the combiner badge, and EXCHANGE remain — particles now read as flowing
from the panels into the lines.

## 5. /live array visualizer → serial-keyed sections

Replaced positional `inverters.slice(offset)` (`Roof 1–4`) with sections keyed
by the serial map above, rendered in `SECTION_DISPLAY_ORDER`, each header
showing live section kW. Ghost-slot logic preserved per section (P1 keeps the
"three ghosted slots" note). Cards show last-4 serial suffixes
(`...4F85`); empty slots show `Awaiting ...4F85` with the expected serial;
serials matching nothing render an amber "not mapped to a roof section" banner.

## 6. Overlay-editor flag (optional backport)

`lib/overlay-editor.ts` (localStorage flag, default off) +
`components/admin/overlay-editor-toggle.tsx` ("enable overlay editor ux" card
in /settings, admin-only) gate the 3 tuner pill buttons behind
`isAdmin && flag`; with the flag off the visualizer stays centered
(`lg:mx-0` and the side grid apply only when tools show).

## 7. Validation gates (home_monitoring)

`npx tsc --noEmit`, `npx eslint components/live/power-flow-visualizer.tsx`,
a `tests/roof-layout.spec.ts`-style spec (12 serials / 45 panels, case-insensitive
lookup, power-sum + ratio math, display order), and a sharp composite of the
new S1 over `public/images/house-base.webp`.

---

## Paste-ready prompt for a home_monitoring session

> Port the section battery-fill feature from ss_solar_monitoring (main) into
> home_monitoring's `components/live/power-flow-visualizer.tsx`. Reference:
> ss_solar_monitoring `lib/roof-layout.ts` (copy verbatim), the fill/label
> block in its `components/live/hoymiles-flow-visualizer.tsx` (search
> `quadFillGeometry`, `SECTION_LABEL_ANCHOR`, `fill-`), and its
> `components/live/array-visualizer.tsx` for the serial-keyed /live sections.
>
> Requirements: (1) resize S1 in `QUAD_OVERLAYS` to
> `[[465,201],[618,142],[715,128],[528,202]]`; (2) add an `inverters` prop
> (serial_number/port_number/power_w per port) and pass live readings from the
> parent — keep the existing `netGridW` wiring, local `EnergyTotals` type,
> `/api/energy/weather/latest` endpoint, and conditional Today/cards;
> (3) render per-section fills for all four quads — P1/P2 from the bottom long
> edge up, S1/S2 from the top long edge down — pairing corners by strip end
> (projection onto the long axis), never by edge order; (4) white 16-unit
> `"<kW> kW <pct>%"` labels: P1/P2 above the fill line, S1 at `[445,245]`,
> S2 at `[110,422]`, S2 rotated with P2's edge angle; (5) delete the 4 black
> source dots, keep node/junction/combiner markers; (6) rework the /live array
> visualizer to serial-keyed S1/P1/S2/P2 sections in display order
> S2,S1,P2,P1 with live section kW, last-4 serials, `Awaiting ...XXXX`
> placeholders, and an unmapped-inverter banner. Section map: S1=`4F85`
> (4 panels); P1=`4D19,46BB,4DF9,45C2` (13); S2=`4618,5189,50A1,53EC` (16);
> P2=`4CF5,4D25,46FC` (12); full serials carry prefix `1420B0`, match
> case-insensitively, 445W per panel. Validate with `npx tsc --noEmit`,
> `npx eslint` on the touched files, a roof-layout spec mirroring
> ss_solar_monitoring's, and a screenshot compositing the new S1 over the
> house art before finishing.
