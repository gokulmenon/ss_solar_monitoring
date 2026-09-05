# Local Server Setup

Multi-agent port convention (do not collide): this solar app serves its
Next.js dev server on **port 4000**; the home_monitoring app keeps **port
3000**. E2E in this repo (`playwright.config.ts`) targets `:4000`.

## Port map

| Service | Port | Source |
|---|---|---|
| This repo: Next.js dev (`npm run dev`, `npm run dev:mock`) | 4000 | baked into `package.json` |
| home_monitoring: Next.js dev | 3000 | their repo owns it |
| Mock live WebSocket (`npm run mock:live`) | 8787 | `MOCK_WS_PORT` env, default `8787` |

Known collision risk: both repos' mock relays default to WS `:8787`. If the
other stack holds it, `dev:mock`/e2e here fails with `EADDRINUSE` and
`concurrently -k` tears the whole stack down. Escape hatch (e2e/local only,
do not commit env changes for this):

```bash
MOCK_WS_PORT=8788 NEXT_PUBLIC_LIVE_WS_URL=ws://127.0.0.1:8788 npm run dev:mock
```

The app reads the WS URL from `NEXT_PUBLIC_LIVE_WS_URL`, so both sides must
match. Never kill another agent's or user's processes to free a port — find
the owner (`lsof -i :<port>`) and coordinate instead.

## Install

```bash
npm install
python3 -m venv .venv
source .venv/bin/activate
pip install -r bridge/requirements.txt
npx playwright install --with-deps   # only if you run the browser specs
```

Copy `.env.example` to `.env.local` and fill in the Supabase + relay values.

## Run

```bash
npm run dev          # Next.js only, http://127.0.0.1:4000
npm run dev:mock     # Next.js + synthetic live feed (needs :4000 and :8787 free)
npm run relay        # real Modbus relay (needs USB adapter + .venv)
npm run test:e2e     # Playwright suite, boots dev:mock on :4000
```

Production: `npm run build` (runs the history-snapshot prebuild) then
`npm run start`.
