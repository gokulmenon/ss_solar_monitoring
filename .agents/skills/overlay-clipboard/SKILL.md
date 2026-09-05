---
name: overlay-clipboard
description: Translate overlay tuner clipboard payloads into hoymiles-flow-visualizer source edits.
---

# Overlay Clipboard

Apply coordinates copied from the on-screen overlay tuners
(`components/live/hoymiles-flow-visualizer.tsx`, under `/home`,
admin role only with the "enable overlay editor ux" settings flag on)
back into the source defaults they came from.

## Payloads and targets

All edits go in `components/live/hoymiles-flow-visualizer.tsx`.

1. **Quad tuner, per-quad Copy** — one line such as
   `554,210 836,107 908,198 618,301`, or the Copy-all form
   `P1: 554,210 836,107 908,198 618,301` (one line per quad:
   S1, P1, S2, P2). Each `x,y` pair is a viewBox corner
   (viewBox `0 0 1000 750`, y grows down; image px × 0.9766 = units),
   running around the perimeter. Rewrite the matching entry of
   `QUAD_OVERLAYS` as `[[x, y], [x, y], [x, y], [x, y]]`, preserving
   corner order.

2. **Pipe tuner, Copy all** — a JSON object shaped like
   `{"nodes": {...}, "sources": {...}, "via": {...}, "ends": {...}}`.
   Copy each section into its default, preserving key order:
   `nodes.*` → `PIPE_NODE_DEFAULTS`, `sources.*` → `PIPE_SOURCE_DEFAULTS`,
   `via.*` → `PIPE_VIA_DEFAULTS`, `ends.*` → `PIPE_END_DEFAULTS`.
   Points stay `[x, y]` viewBox pairs; empty `via` arrays stay empty.

3. **Box tuner, Copy all** — a JSON object shaped like
   `{"title": {"x": 2, "y": 3, "scale": 100}, ...}` for the ids
   title, status, hero, grid, loads. Copy each entry into
   `INFO_BOX_DEFAULTS` verbatim. `x`/`y` are % from the anchored
   edge (left or right per `INFO_BOX_ANCHOR`) and top; `scale` is %.

## Rules

- Never invent coordinates: every number in the edit must come from
  the pasted payload. Reject payloads with missing keys, wrong-length
  point lists, or non-finite numbers, and say which entry failed.
- Never touch tuner state, storage keys, path topology, or component
  wiring — only the `*_DEFAULTS` constants named above.
- After editing, run `npx tsc --noEmit` and
  `npx eslint components/live/hoymiles-flow-visualizer.tsx`; both must pass.
- Confirm visually with a quick `/home` screenshot for quad/pipe/box changes,
  checking the green quads sit on the roof faces and pipes run source → node → trunk → combiner.
