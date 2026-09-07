# ss_solar_monitoring — Progress to Deprecation

Status: maintenance-only. Active solar development moved to `home_monitoring`;
this site stays up until home_monitoring Milestone 1 releases, then shuts down.
Milestone labels (M1–M7) mirror
`home_monitoring/docs/plans/2026-09-05-home-release-parity.md`; Milestone 1
release = their M4 production-deploy smoke test.

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
- [ ] D4 freeze declared after their M4 release.
- [ ] D5 shutdown executed and repo archived.
