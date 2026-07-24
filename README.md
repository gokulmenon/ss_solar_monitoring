# ss_solar_monitoring

Mobile-first solar monitoring PWA for an iPhone-style dashboard.

The app is split into two data paths:

- `/` redirects to `/home`.
- `/home` is the main dashboard and adapts into a wider tablet/desktop layout automatically.
- `/live` reads from a local WebSocket relay for low-latency telemetry.
- `/history` is the history page. It renders a CSV-backed dashboard plus a separate Supabase-backed cloud section on the same page.
- On localhost, the CSV panel reads the live `logs/meter-backups/*.csv` files from disk.
- On Vercel, the CSV panel reads a build-generated snapshot derived from the committed `logs/` folder.

The dashboard runs immediately in mock mode, but the relay is ready to connect to your verified Modbus RTU poller.

## Architecture

### Why the relay exists

Next.js on Vercel cannot talk directly to `/dev/cu.usbserial-BH002YZD`. The Mac next to the meter needs to be the hardware bridge:

- Python handles serial + Modbus RTU.
- WebSockets push live readings to the dashboard.
- REST serves the local CSV history, and Supabase stores the batched cloud history.

### Why WebSockets for live data

WebSockets are the best fit for the local telemetry bridge because they give you:

- Low-latency updates without polling overhead.
- A browser-native client with `react-use-websocket`.
- A clean local bridge pattern that can stay on your Mac while the Next.js app is deployed elsewhere.

MQTT would also work, but it adds broker management. A database-first push model is better for history than for sub-second live telemetry.

For the cloud path, the relay samples the meter once per minute and batches those readings into a 15-minute window before inserting a single row into Supabase. That keeps local logging and cloud usage conservative while still preserving useful trend data.

### Current live payload shape

Your verified relay currently publishes the real meter wattage reading as `net_grid_w`, plus `phase_a_voltage_v` when register `8192` is available.

The UI merges that bridge data into the existing mock live snapshot so the app still shows solar and home cards while you wire more registers later.

Example payload:

```json
{
  "timestamp": "2026-07-17T08:45:47Z",
  "net_grid_w": -5000,
  "phase_a_voltage_v": 228.4
}
```

### File map

- `app/layout.tsx`: mobile shell and fixed bottom iOS-style tab bar.
- `app/home/page.tsx`: main dashboard view.
- `app/live/page.tsx`: live telemetry screen.
- `app/history/page.tsx`: chart screen.
- `app/settings/page.tsx`: bridge and deployment placeholders.
- `app/api/history/route.ts`: history endpoint that prefers CSV logs and falls back to mock data.
- `components/history/cloud-history-dashboard.tsx`: cloud-backed history subcomponent.
- `components/live/*`: live dashboard cards and power flow visualizer.
- `components/history/*`: history dashboard and chart.
- `lib/mock-data.ts`: reusable mock generators for both paths.
- `scripts/mock-live-ws.ts`: mock local WebSocket publisher for development.
- `bridge/modbus_ws_relay.py`: Python relay for the real meter.
- `supabase/migrations/*`: table schema for the batched cloud history.
- `tests/navigation.spec.ts`: mobile Playwright navigation test.

## Install

1. Install the Next.js dependencies.

```bash
npm install
```

2. Initialize shadcn/ui if you want to regenerate component primitives later.

```bash
npx shadcn@latest init
```

3. Install Playwright browser binaries.

```bash
npm run playwright:install
```

4. Create a Python virtual environment for the relay and install the bridge dependencies.

```bash
python3 -m venv .venv
source .venv/bin/activate
python3 -m pip install -r bridge/requirements.txt
```

5. Copy the environment file for the Next.js app.

```bash
cp .env.example .env.local
```

Default value:

- `NEXT_PUBLIC_LIVE_WS_URL=ws://127.0.0.1:8787`
- `SUPABASE_URL=` if you are syncing the relay to Supabase locally
- `SUPABASE_SERVICE_ROLE_KEY=` if you are syncing the relay to Supabase locally

The Python relay also auto-loads `bridge/.env` on startup. Fill that file once and you can run `npm run relay` without re-exporting variables every time.

## CSV history by environment

The CSV history path is intentionally split so both environments feel consistent:

- Localhost uses the live relay files from `logs/meter-backups/`.
- Vercel uses a build-generated snapshot, so the deployed app can render the committed CSV history without needing access to your Mac.

The snapshot is generated automatically during `npm run build` by the `prebuild` hook, which writes `public/history-snapshot.json` from the current CSV files in the repo.

If you update the committed logs, push the change and redeploy Vercel to refresh the deployed snapshot.

## Run the Next.js app

### Mock-only development

This is enough to run the dashboard immediately, even with no hardware attached.

```bash
npm run dev
```

In local development, the CSV history panel reads the live files under `logs/meter-backups/`, so new relay writes appear without any redeploy.

### App plus mock WebSocket relay

This starts Next.js and a synthetic live feed together.

```bash
npm run dev:mock
```

## Run the real Modbus relay

Your verified Python poller already proves the USB adapter and meter wiring are working. This relay keeps that exact serial connection and publishes it over WebSocket.

1. Activate the Python environment if it is not already active.

```bash
source .venv/bin/activate
```

2. Start the relay.

```bash
npm run relay
```

Optional environment variables:

- `BRIDGE_HOST=127.0.0.1`
- `BRIDGE_PORT=8787`
- `SERIAL_PORT=/dev/cu.usbserial-BH002YZD`
- `MODBUS_BAUDRATE=9600`
- `BRIDGE_POLL_INTERVAL_SECONDS=60`
- `MODBUS_SLAVE_ID=1`
- `METER_TOTAL_ACTIVE_POWER_REGISTER=8210`
- `METER_PHASE_A_VOLTAGE_REGISTER=8192`
- `METER_REGISTER_KIND=holding`
- `METER_POWER_SCALE=0.1`
- `METER_VOLTAGE_SCALE=0.1`
- `HOYMILES_WIFI_HOST=192.168.1.8`
- `HOYMILES_WIFI_COMMAND=hoymiles-wifi`
- `HOYMILES_WIFI_COMMAND_ARG=get-real-data-new`
- `HOYMILES_WIFI_TIMEOUT_SECONDS=20`
- `HOYMILES_WIFI_REFRESH_SECONDS=900`
- `BRIDGE_OFFLINE_THRESHOLD=10`
- `CSV_BACKUP_DIR=./logs/meter-backups`
- `CSV_BACKUP_PREFIX=meter`
- `CSV_LOG_PATH=./logs/meter_data.csv` for legacy single-file logging
- `SUPABASE_URL=https://ezxqlbdiwysuhabtnaxa.supabase.co`
- `SUPABASE_SERVICE_ROLE_KEY=...`
- `SUPABASE_TABLE_NAME=meter_readings`
- `SUPABASE_DAILY_TABLE_NAME=daily_energy_summary`
- `SUPABASE_BATCH_MINUTES=15`

By default, the relay writes one CSV per day into `./logs/meter-backups`, for example:

```bash
./logs/meter-backups/meter_2026-07-19.csv
```

If you want the old append-only single file behavior, set `CSV_LOG_PATH`.

The relay automatically reads `bridge/.env` first, then falls back to your shell exports if you set them manually. That means you can keep the local relay config in one place and just run `npm run relay`.

The cloud sync path uses the same relay process:

- every 60 seconds: poll the Chint meter, broadcast to the UI, and append to the local CSV backup
- every 15 minutes by default: refresh the Hoymiles JSON snapshot
- every 15 minutes: flush one aggregated grid, voltage, and solar row to Supabase
- every 15 minutes: update one relay-local daily energy summary row in Supabase
- on startup/shutdown: close out any pending cloud batch

The Hoymiles side now uses the local `hoymiles-wifi` CLI instead of RS-485.
That gives you inverter totals plus per-port readings in one JSON response.
The relay parses that JSON into:

- inverter-level totals
- per-port readings grouped by inverter serial number
- an overall total of all inverter active-power totals
- solar production values for the live charts, CSV history, and Supabase history

If the DTU host IP changes, update `HOYMILES_WIFI_HOST`.
If you want to inspect the raw JSON manually, run:

```bash
hoymiles-wifi --host 192.168.1.8 --as-json get-real-data-new
```

Example:

```bash
npm run relay:csv
```

## Deploying to Vercel

### Does the first deploy need an environment variable?

No. The frontend can be imported and deployed to Vercel without `NEXT_PUBLIC_LIVE_WS_URL`, because the app still builds and the live page falls back to mock behavior if the relay is not reachable.

If you want the deployed site to talk to a live relay immediately, then yes, add:

- `NEXT_PUBLIC_LIVE_WS_URL`

before or right after the first deploy, and redeploy after setting it.

### What the Vercel env var should be

Use the public `wss://` URL of your tunnel, not `ws://127.0.0.1:8787`.

Examples:

- `wss://your-relay.example.com`
- `wss://abcdef123.trycloudflare.com`

Because this is a `NEXT_PUBLIC_` variable, it is bundled into the client build. After changing it in Vercel, trigger a new deployment so the app picks up the new value.

For the cloud history section, add these server-side environment variables in Vercel:

- `SUPABASE_URL` = your Supabase project URL, for example `https://ezxqlbdiwysuhabtnaxa.supabase.co`
- `SUPABASE_SERVICE_ROLE_KEY` = copy this from Supabase Dashboard -> Settings -> API -> Project API keys
- `SUPABASE_TABLE_NAME` = `meter_readings`
- `SUPABASE_DAILY_TABLE_NAME` = `daily_energy_summary`

The cloud history now expects a nullable `solar_production_w` column. Run this once in
Supabase Dashboard -> SQL Editor before restarting the relay with this version:

```sql
alter table public.meter_readings
  add column if not exists solar_production_w integer;
```

The same SQL is tracked in `supabase/migrations/20260719001000_add_solar_production_to_meter_readings.sql`.

For the long-term daily dashboard path, also create the one-row-per-day aggregate table:

```sql
create table if not exists public.daily_energy_summary (
  day date primary key,
  imported_kwh numeric(12, 3) not null default 0,
  exported_kwh numeric(12, 3) not null default 0,
  solar_kwh numeric(12, 3) not null default 0,
  home_kwh numeric(12, 3) not null default 0,
  sample_count integer not null default 0,
  updated_at timestamptz not null default now()
);

create index if not exists daily_energy_summary_day_idx
  on public.daily_energy_summary (day desc);
```

The relay updates this daily row once per 15-minute Supabase flush, so long-term charts can query daily totals without scanning all interval rows.

For daily historical summaries computed directly from the 15-minute `meter_readings`
rows, create this RPC function as well:

```sql
create or replace function public.get_daily_energy_summary(
  timezone_name text default 'America/New_York',
  day_limit integer default 30
)
returns table (
  day date,
  daily_grid_import_kwh numeric,
  daily_grid_export_kwh numeric,
  daily_solar_kwh numeric,
  daily_home_consumption_kwh numeric,
  sample_count bigint
)
language sql
stable
as $$
  with normalized_readings as (
    select
      (mr.timestamp at time zone timezone_name)::date as day,
      mr.net_grid_w,
      coalesce(mr.solar_production_w, 0) as solar_production_w,
      greatest(coalesce(mr.sample_count, 1), 1) * 60.0 as sample_seconds
    from public.meter_readings mr
    where mr.timestamp >= now() - make_interval(days => greatest(day_limit, 1))
  )
  select
    nr.day,
    round(sum(case when nr.net_grid_w > 0 then nr.net_grid_w * nr.sample_seconds / 3600000.0 else 0 end), 3)
      as daily_grid_import_kwh,
    round(sum(case when nr.net_grid_w < 0 then abs(nr.net_grid_w) * nr.sample_seconds / 3600000.0 else 0 end), 3)
      as daily_grid_export_kwh,
    round(sum(nr.solar_production_w * nr.sample_seconds / 3600000.0), 3)
      as daily_solar_kwh,
    round(sum(greatest(nr.solar_production_w + nr.net_grid_w, 0) * nr.sample_seconds / 3600000.0), 3)
      as daily_home_consumption_kwh,
    sum(nr.sample_seconds / 60.0)::bigint as sample_count
  from normalized_readings nr
  group by nr.day
  order by nr.day desc;
$$;
```

The same SQL is tracked in `supabase/migrations/20260720000000_create_get_daily_energy_summary.sql`.

If the daily table shows home consumption at exactly `10x` while solar looks correct,
you likely have old Supabase `meter_readings.net_grid_w` rows written before
`METER_POWER_SCALE=0.1` was added to the relay. Repair only the affected historical
window, replacing the timestamp below with the moment you deployed the relay scale fix:

```sql
update public.meter_readings
set net_grid_w = round(net_grid_w * 0.1)::integer
where timestamp < '2026-07-24T00:00:00Z'
  and abs(net_grid_w) >= 10000;
```

After that update, rerun the `get_daily_energy_summary` function definition above in
the Supabase SQL Editor so the frontend daily table integrates with the sample-aware
calculation.

You do not need the raw Postgres password string for the app. If you ever want the direct database connection string for `psql` or a database client, open the Supabase Dashboard and click `Connect`. That is separate from the app runtime and is not required for the `/history` page to read Supabase.

You also do not need the Supabase publishable/anon key for this implementation. The Next.js server route and the local relay use the service-role key server-side, so the cloud read path works even if you did not set up RLS policies yet. Supabase documents that service keys bypass RLS, and they should never be exposed to the browser. If you later want a browser-only Supabase client, then you would add the publishable key and enable RLS policies for that path.

### Recommended tunnel flow

1. Run the local relay on the Mac attached to the meter:

```bash
npm run relay
```

2. Expose port `8787` with your tunnel provider.

3. Copy the tunnel's `wss://` URL into Vercel Project Settings as `NEXT_PUBLIC_LIVE_WS_URL`.

4. Redeploy the Vercel app.

### Permanent Cloudflare tunnel

The current permanent tunnel is named `solar-monitor` and serves the relay through:

```text
solar-monitoring.gokulmenon.com
```

Run it with:

```bash
cloudflared tunnel run solar-monitor
```

Use this Vercel environment variable:

```bash
NEXT_PUBLIC_LIVE_WS_URL=wss://solar-monitoring.gokulmenon.com
```

The local Cloudflare config lives at `~/.cloudflare/config.yaml`:

```yaml
tunnel: 8f5854c2-be35-4e66-94c1-54c1b8833b3a
credentials-file: ${HOME}/.cloudflared/8f5854c2-be35-4e66-94c1-54c1b8833b3a.json

ingress:
  - hostname: solar-monitoring.gokulmenon.com
    service: http://127.0.0.1:8787

  - service: http_status:404
```

Keep the origin service pointed at `http://127.0.0.1:8787`, not `http://localhost:8787`.
On macOS, `localhost` can resolve to IPv6 `::1`, while the relay listens on IPv4
`127.0.0.1` by default.

### Why this works

- Vercel hosts the frontend.
- The Mac hosts the hardware relay.
- The tunnel bridges the browser on Vercel to the local relay machine.

### Can the Vercel app read the CSV logs directly?

It reads the committed CSV snapshot, not the live files on your Mac.

That is the key difference:

- Local development reads the live `./logs/meter-backups` files on your machine.
- Vercel reads the build-generated snapshot from the repo so the deployed CSV history is not empty.

This is why you must push new log files and redeploy if you want Vercel's CSV dashboard to reflect the newest local relay data.

### Good first-deploy checklist

1. Import the Git repo into Vercel.
2. Let the first deploy succeed with the default fallback if you want.
3. Add `NEXT_PUBLIC_LIVE_WS_URL` when your tunnel is ready.
4. Redeploy.

## Playwright E2E

The Playwright config targets WebKit with an iPhone profile so you can verify the mobile shell.

Run the tests in UI mode:

```bash
npm run test:e2e:ui
```

Run headless:

```bash
npm run test:e2e
```

The navigation test checks that:

- `/` redirects to `/home`
- the bottom tab bar is visible
- the History tab navigates to `/history`

## Notes on the current bridge

- The relay reads `8210` for the total active power value you already verified.
- The relay also attempts `8192` for phase A voltage and divides by `10.0`.
- If `8192` is unavailable, the relay keeps running and simply omits that field.
- The live dashboard still uses mock solar and home values until you add more meter/register sources.
- The shell uses CSS breakpoints so phones keep the compact iPhone layout while tablets and desktops get a wider dashboard grid.
- The relay writes daily CSV backups by default, so you get offline historical snapshots even if the tunnel or frontend is unavailable.
- After `BRIDGE_OFFLINE_THRESHOLD` consecutive failures, the relay emits a `HARDWARE_OFFLINE` status message so the UI can show a red bridge warning.

## Real meter integration path

Your current Modbus RTU setup is already the hard part. The remaining step is to let the verified Python poller push JSON messages over the WebSocket bridge.

Once that stream is active, the live page will update automatically.
