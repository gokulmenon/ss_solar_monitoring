# Agent Notes (continuity for future sessions)

Living checklist: what's known-good, what's broken, what bites. Update it
when any line goes stale. Session-level port/role facts live in project
memory (`coordination.md`); repo milestones in `docs/deprecation-plan.md`.

## Known issues (pre-existing, not ours)

- `npx eslint .` reports 2 errors + 3 warnings on untouched files:
  `middleware.ts` (`any` type), `next-env.d.ts` (triple-slash reference),
  plus warnings in `use-live-telemetry.ts`, `eslint.config.mjs`.
  Judge our diffs with per-file eslint, not the repo-wide gate.
- `npm run lint` still passes `--ext .ts,.tsx`, which eslint v9 (flat config)
  no longer supports — treat that script as suspect until fixed.
- `tsconfig.tsbuildinfo` is tracked in git, so every `tsc --noEmit` dirties
  the tree. Revert it after typechecks (`git checkout -- tsconfig.tsbuildinfo`);
  better fix: `git rm --cached` it and ignore the file.
- `logs/meter-backups/meter_2026-07-25.csv` is untracked user data — never
  stage, commit, or delete it.

## Gotchas learned the hard way

- Next.js dev serves transient 404s on edited routes mid-recompile (with
  `/_not-found` compiles in the log). Retry a few times before assuming the
  route is broken; do not restart the server on the first 404.
- Deleting an `app/` route leaves stale `.next/types` behind → bogus
  `TS2307` errors. `rm -rf .next` (gitignored, regenerable) and re-run tsc.
- `EADDRINUSE` on `:8787` (mock WS) or Next ports: trace ownership with
  `lsof`/`ps` up the PPID chain first. Stale `dev:mock` children from dead
  test runs are safe to clear; live user shells and the other repo's
  processes are not — coordinate instead (`MOCK_WS_PORT` escape hatch exists).
- `echo $?` after a pipe reports the pipe's last command — run `tsc`/`eslint`
  bare when the exit code matters.
- No `setsid` on macOS: background dev servers die with the agent session.
  For user viewings, hand over the exact `npm run dev` command + URL.
- No Playwright browser cache on this machine — screenshot via system Chrome
  (`channel: "chrome"`). Scripts in `/tmp` cannot use bare imports (`sharp`,
  `playwright`); import via absolute path or `createRequire` from the repo.
- Auth-gated pages can't be screenshotted headlessly without a session — use
  a temporary public preview route (e.g. `app/preview-fills/`, since removed)
  with mock props, then delete it before committing.
- Tuner localStorage overrides `INFO_BOX_DEFAULTS`: after changing a default,
  use the tuner's Reset button (or fresh browser) to see it.

## Open items / next up

- [ ] Untrack `tsconfig.tsbuildinfo` (see above).
- [ ] Decide the shared mock-WS port split with the home_monitoring agent
  (`:8787` collides when both stacks run).
- [ ] Mirror the port-convention note in the home_monitoring repo.
- [x] First on-demand backport per `docs/deprecation-plan.md` §Sync — done
  2026-09-06 eve (solar `9181eb5` → home `b267ce8` via `diff -u` +
  `patch -p1`; canvas + house-v40.glb + waypoints only).
- [ ] D4 freeze + D5 shutdown per the deprecation burndown.
- [x] Day/night graphics + sun-ray overlay animation (solar-first pass and
  home backport completed 2026-09-07; solar `9faae94`, home `0d51f54`). Shared
  selector is `telemetry.solarActive`; rays use `lib/solar-rays.ts` in both
  2D and 3D. Keep the static 3D panel outline/grid visible even when the
  solar-active fill is gated off.

## Session 2026-09-06 eve — v40, wiring, backport (committed + pushed)

- `house-v40.glb` (911,940 bytes): lit pale panes + slim flush dividers,
  transparent rear slider, opaque garage door. kW/% labels flipped
  in-plane (`rotation.z = PI`, NOT a Y-flip). Harness
  (`app/preview-3d/`) deleted, `view` prop stripped; `/live` 2D/3D
  toggle is the only wiring (2D default untouched).
- New gotchas: procedural statics hide behind `visible={!modelOn}` —
  diagnose the render layer before editing; Blender binary is
  `/Applications/Blender.app/Contents/MacOS/Blender` (no PATH entry);
  route deletion leaves stale `.next/types` (rm + re-run tsc).

## Session 2026-09-07 — theme/ray polish and front panes

- Solar commits `45d467d` (2D theme/rays) and `096f0c8` (3D theme/rays) are
  the feature base. Follow-up fixes keep 2D window overlays from duplicating
  the source art, use the current-theme sun/moon icon, repair opaque doors and
  model panel materials, and preserve the 3D static panel grid in day and
  night. Production fills remain gated by `solarActive`.
- The v40 GLB remains the source of truth. `ModelHouse` hides the horizontal
  muntin and reconstructs three equally-spaced vertical dividers for the two
  large front windows (four pane columns each) at runtime, so the correction
  backports without a risky binary export. A v41 Blender headless attempt
  exited before producing output; do not replace v40 until a sequential
  factory-startup pass exports and screenshot-verifies successfully.
- Validation covered `tsc --noEmit`, touched-file ESLint, desktop/mobile
  screenshots, and the home backport. Keep docs and source changes scoped;
  do not stage the local meter CSV, intermediate GLBs, build info, or existing
  unrelated worktree edits.
- Final 3D polish keeps the LOADS/GRID board posts connected to the tilted
  panels and replaces the coplanar GLB road with a shared raised dark slab;
  driveway and street now match visually in both model and procedural modes.

## Session 2026-09-07 — roof finish, unburied drop, night-dim edges

- Solar `da40e38`, backported to home `d104eb8` (canvas byte-identical
  again). All three main-house GLB slabs (`Roof_Garage[.001]`, `Roof_Main`)
  retinted `#3f454e` with a runtime running-bond tile texture; procedural
  `GableRoof` shares the canvas. GLB roofs ship POSITION+NORMAL only (no
  UVs), so `repairRoofSurfaces` generates dominant-plane planar UVs at load.
- Upper combiner drop rerouted after a `three.js`-exact clearance probe
  (`/tmp/roof-clearance.mjs`, kept outside the repo): ridge run lay
  half-sunk (0.000) and the corner grazed the eave (0.003). New routing
  rides ~0.2 proud of the crest and rounds the ridge-end (>=0.2 vs roof,
  panels, walls, vent). Lower twin untouched (>=0.17; orb bottoms may graze
  the garage ridge — follow-up if noticed).
- Panel `Edges`/seams were unlit full-bright at night: green highlight is
  now gated on `solarActive` (dim slate idle-day, near-dark night).
- Verification without Playwright browsers: headless system Chrome renders
  WebGL with `--enable-unsafe-swiftshader --use-angle=swiftshader` +
  `--virtual-time-budget=30000`; temp `app/preview-roof/` route (plain
  segment, `?theme=`/`?model=` params), deleted after. Deleting a route
  needs `rm -rf .next` before `tsc` (stale `.next/types`).
- U9 viewport widening landed (solar `85aee82`, home `a54f25b`): card
  `max-w-xl` → `lg:max-w-4xl`, verified 1440px wide + 390px unchanged via
  screenshots. Below-fold stats block intentionally stays `max-w-xl`.
- Ops lesson: `rm -rf .next` under a running dev server wedges it (ENOENT
  manifests, all routes 500, never self-heals) — restart the server instead.
  After deleting a route, `rm -rf .next/types/app/<route>` alone is enough
  for `tsc` and leaves the server healthy.
