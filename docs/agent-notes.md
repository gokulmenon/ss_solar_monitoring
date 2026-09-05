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
- [ ] First on-demand backport per `docs/deprecation-plan.md` §Sync.
- [ ] D4 freeze + D5 shutdown per the deprecation burndown.
