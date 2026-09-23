# ss_solar_monitoring — DEPRECATED 2026-09-22, shutdown in progress

Status: deprecated. The energy relay cutover to `home_monitoring` completed
2026-09-21 (Plan B: HomeRelay sole writer on COM4 since 14:33 UTC, burn-in
green across two midnight rollovers, 24h data check green). Gap backfill
verified 2026-09-22 (daily 56/56, meter 7,149/7,149, weather 4,718/4,718,
ports 457,948/457,948). Gate B (stop this site, no deletion) is executing;
Gate C (delete solar Supabase project, archive this repo) follows with a
separate sign-off. Do not restart the host relay or re-enable writes —
COM4 belongs to HomeRelay and dual-write would corrupt both histories.
Milestone labels (M1–M7) mirror
`home_monitoring/docs/plans/2026-09-05-home-release-parity.md`.

## Burndown (styled to the home_monitoring milestones)

- [x] D0 visualizer parity backported to home_monitoring (`fbfda67`: serial
  sections, fills, editor flag). Reverse pointer: `docs/visualizer-handoff.md`.
- [x] D1 maintenance window open: solar upgrades land in home_monitoring
  `/home`, `/energy/live`, `/energy/history`, `/energy/settings` and are
  backported here on demand (procedure below). This 2026-09-07 theme/ray
  polish is the final solar-first pass before its home backport; no new
  features originate here after the sync.
- [ ] D2 M1 gate + M2 backend land over there → no action here (confirm this
  site still builds green).
- [ ] D3 M3 auth/invites verified over there → no action here.
- [ ] D4 home_monitoring M4 deployed and smoke-tested (Milestone 1 release) →
  freeze this repo: `main` locked except critical relay/data fixes; start the
  shutdown soak clock (proposed: 14 days with both sites live).
- [ ] D5 soak clean (no critical fixes needed here) → shut down: point DNS /
  landing at the new site, stop the local bridge writes to this project's
  Supabase, export `meter_readings` + `inverter_port_readings` CSV backups to
  `logs/meter-backups/`, archive this repo read-only.

> Amendment 2026-09-20 (homeowner decision, from the home side): the energy
> relay cutover runs ahead of D4 as a dual-write comparison — home relay and
> this repo's relay both writing, 2-day comparison soak with a 5-day cap —
> instead of the 14-day clock above. Plan:
> `home_monitoring/docs/plans/2026-09-20-energy-relay-cutover.md` (under
> review, no implementation yet). No action required here until the home side
> posts its step-0 courtesy notice; in particular, do NOT stop or restart the
> host relay on the basis of this note. Shutdown criteria below are unchanged
> and still gate D5.

## Sync on demand (backport procedure)

Trigger: a solar-specific upgrade merges to home_monitoring `main` under
`/home` or `/energy/*` (visualizer, array layout, tuners, energy APIs).

1. Identify the source files (usually `components/live/*`, `lib/roof-layout.ts`,
   `lib/power-flow.ts`, `lib/overlay-editor.ts`, `app/(protected)/energy/*`).
2. Map to this repo's equivalents and apply the known adaptations:
   `HoymilesFlowVisualizer` keeps derived grid (`home − solar`, no `netGridW`
   prop), `EnergyTotals` imports from `@/lib/daily-energy`, weather stays at
   `/api/weather/latest`, `capacityKw` defaults to `20.02`, card copy stays
   unconditional. Only `*_DEFAULTS` constants change for tuner payloads —
   never tuner state, storage keys, or topology (see
   `.agents/skills/overlay-clipboard/SKILL.md`).
3. Validate: `npx tsc --noEmit`, `npx eslint` on touched files, affected
   Playwright spec (`tests/roof-layout.spec.ts`,
   `tests/power-flow-helpers.spec.ts`, `tests/home-power-hero.spec.ts`), and a
   screenshot compositing quads over `public/images/house-base.webp` for any
   geometry change.
4. Commit + push to `main` (explicit ask each time). Do not restart the local
   relay for frontend-only changes; relay-code changes take effect only after
   the bridge process restarts.

## Handoff inventory for the new app

Already ported (home_monitoring `main`): quad overlays + tuners, `roof-layout`
section map + fills, /live serial sections, overlay-editor flag, auth/invite
flow, Supabase helpers. Still reusable on request:

| Asset here | Use over there |
|---|---|
| `bridge/modbus_ws_relay.py` port-bucket dedupe + `tests/test_hoymiles_relay.py` | `relays/energy/modbus_ws_relay.py` cloud batching |
| `lib/daily-energy.ts`, energy RPC/migrations in `supabase/` | energy totals/history backend (they apply migrations via dashboard SQL editor) |
| `scripts/mock-live-ws.ts`, `scripts/generate-history-snapshot.mjs` | mock stream + prebuild snapshot |
| `lib/weather.ts`, `components/weather/*` | weather panels and cards |
| `tests/home-power-hero.spec.ts`, `tests/navigation.spec.ts` | e2e patterns for `/home`, `/energy/*` |
| `.agents/skills/overlay-clipboard/SKILL.md` | tuner-payload → defaults workflow (already mirrored there) |

## Shutdown criteria (all must hold)

1. home_monitoring M4 smoke test green on production URLs.
2. 14-day soak with zero critical fixes required here.
3. CSV backups of meter + port tables stored under `logs/meter-backups/`.
4. DNS/landing redirect verified, bridge writes to the old project stopped.

## Progress tracker

- [x] Maintenance-only declared; backport procedure written.
- [x] First on-demand backport completed using §Sync (v40, 2026-09-06).
- [x] Theme/ray + front-window pane correction backport completed using §Sync
  (solar `9faae94` → home `0d51f54`, 2026-09-07).
- [x] Roof/pipe/edge polish backport completed using §Sync (solar `da40e38`
  → home `d104eb8`, 2026-09-07): tiled `#3f454e` roofs, unburied upper drop,
  night-dim panel edges. Canvas byte-identical post-backport.
- [x] Cutover superseded D4: Plan B executed 2026-09-21 (home relay sole
  writer, solar relay stopped + set to manual; repo frozen except this
  deprecation note).
- [x] Gap backfill verified 2026-09-22 — Gate B executing (Vercel deployment
  stop, tunnel ingress removal; no deletion).
- [ ] Gate C: delete solar Supabase project + archive this repo (≥48h after
  Gate B, separate owner sign-off).
