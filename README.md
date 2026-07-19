# ss_solar_monitoring

Mobile-first solar monitoring PWA for an iPhone-style dashboard.

The app is split into two data paths:

- `/live` reads from a local WebSocket relay for low-latency telemetry.
- `/history` reads batched time-series data over REST, which mirrors the future cloud database path.

The dashboard runs immediately in mock mode, but the relay is ready to connect to your verified Modbus RTU poller.

## Architecture

### Why the relay exists

Next.js on Vercel cannot talk directly to `/dev/cu.usbserial-BH002YZD`. The Mac next to the meter needs to be the hardware bridge:

- Python handles serial + Modbus RTU.
- WebSockets push live readings to the dashboard.
- REST handles historical data.

### Why WebSockets for live data

WebSockets are the best fit for the local telemetry bridge because they give you:

- Low-latency updates without polling overhead.
- A browser-native client with `react-use-websocket`.
- A clean local bridge pattern that can stay on your Mac while the Next.js app is deployed elsewhere.

MQTT would also work, but it adds broker management. A database-first push model is better for history than for sub-second live telemetry.

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
- `app/live/page.tsx`: live telemetry screen.
- `app/history/page.tsx`: chart screen.
- `app/settings/page.tsx`: bridge and deployment placeholders.
- `app/api/history/route.ts`: mock REST endpoint for history data.
- `components/live/*`: live dashboard cards and power flow visualizer.
- `components/history/*`: history dashboard and chart.
- `lib/mock-data.ts`: reusable mock generators for both paths.
- `scripts/mock-live-ws.ts`: mock local WebSocket publisher for development.
- `bridge/modbus_ws_relay.py`: Python relay for the real meter.
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

## Run the Next.js app

### Mock-only development

This is enough to run the dashboard immediately, even with no hardware attached.

```bash
npm run dev
```

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
python3 bridge/modbus_ws_relay.py
```

Optional environment variables:

- `BRIDGE_HOST=127.0.0.1`
- `BRIDGE_PORT=8787`
- `SERIAL_PORT=/dev/cu.usbserial-BH002YZD`
- `MODBUS_BAUDRATE=9600`
- `MODBUS_SLAVE_ID=1`
- `CSV_LOG_PATH=./logs/meter_data.csv`

If you want CSV logging alongside the WebSocket relay, set `CSV_LOG_PATH`.

Example:

```bash
CSV_LOG_PATH=./logs/meter_data.csv python3 bridge/modbus_ws_relay.py
```

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

- `/` redirects to `/live`
- the bottom tab bar is visible
- the History tab navigates to `/history`

## Notes on the current bridge

- The relay reads `8210` for the total active power value you already verified.
- The relay also attempts `8192` for phase A voltage and divides by `10.0`.
- If `8192` is unavailable, the relay keeps running and simply omits that field.
- The dashboard still uses mock solar and home values until you add more meter/register sources.

## Real meter integration path

Your current Modbus RTU setup is already the hard part. The remaining step is to let the verified Python poller push JSON messages over the WebSocket bridge.

Once that stream is active, the live page will update automatically.
