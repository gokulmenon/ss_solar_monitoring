"""
Local Modbus RTU -> WebSocket relay.

This is the hardware-side bridge for the Mac that is physically connected to
the DSD TECH USB-to-RS485 adapter and the Chint DTSU666-CT meter.

What it does:
- Connects to the serial meter with the same verified pymodbus settings you
  already proved working.
- Reads the total active power register every second.
- Optionally reads phase A voltage from register 8192.
- Broadcasts the latest reading to any browser client over WebSocket.
- Optionally logs the same readings to CSV.

The Next.js app only needs a WebSocket URL, so it can stay cloud-friendly while
this relay stays on the local Mac.
"""

from __future__ import annotations

import asyncio
import csv
import gc
import json
import os
import struct
import urllib.error
import urllib.request
from urllib.parse import urlparse
from dataclasses import dataclass, asdict
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional

import websockets
from websockets.server import WebSocketServerProtocol

try:
    from pymodbus.client import ModbusSerialClient
except ImportError:  # pragma: no cover - resolved when bridge deps are installed
    ModbusSerialClient = None


def load_env_file(path: Path) -> None:
    """
    Load simple KEY=VALUE pairs from a local .env file.

    Existing shell exports win, so this stays friendly to manual overrides.
    """
    if not path.exists():
        return

    for raw_line in path.read_text().splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#"):
            continue

        if line.startswith("export "):
            line = line[len("export ") :].strip()

        if "=" not in line:
            continue

        key, value = line.split("=", 1)
        key = key.strip()
        value = value.strip().strip('"').strip("'")

        if key and key not in os.environ:
            os.environ[key] = value


load_env_file(Path(__file__).with_name(".env"))


HOST = os.getenv("BRIDGE_HOST", "127.0.0.1")
PORT = int(os.getenv("BRIDGE_PORT", "8787"))
SERIAL_PORT = os.getenv("SERIAL_PORT", "/dev/cu.usbserial-BH002YZD")
BAUDRATE = int(os.getenv("MODBUS_BAUDRATE", "9600"))
SLAVE_ID = int(os.getenv("MODBUS_SLAVE_ID", "1"))
CSV_LOG_PATH = os.getenv("CSV_LOG_PATH")
CSV_BACKUP_DIR = os.getenv("CSV_BACKUP_DIR", "./logs/meter-backups")
CSV_BACKUP_PREFIX = os.getenv("CSV_BACKUP_PREFIX", "meter")
OFFLINE_FAILURE_THRESHOLD = int(os.getenv("BRIDGE_OFFLINE_THRESHOLD", "10"))
SUPABASE_URL = os.getenv("SUPABASE_URL", "").strip()
SUPABASE_SERVICE_ROLE_KEY = os.getenv("SUPABASE_SERVICE_ROLE_KEY", "").strip()
SUPABASE_TABLE_NAME = os.getenv("SUPABASE_TABLE_NAME", "meter_readings")
SUPABASE_BATCH_MINUTES = int(os.getenv("SUPABASE_BATCH_MINUTES", "15"))
SUPABASE_SYNC_TIMEOUT_SECONDS = float(os.getenv("SUPABASE_SYNC_TIMEOUT_SECONDS", "5"))


@dataclass
class RelayPayload:
    timestamp: str
    net_grid_w: int
    phase_a_voltage_v: Optional[float] = None


@dataclass
class RelayStatusPayload:
    timestamp: str
    status: str
    failures: int
    message: Optional[str] = None


@dataclass
class CloudBatchState:
    bucket_start: str
    sample_count: int = 0
    net_grid_sum_w: int = 0
    voltage_sum_v: float = 0.0
    voltage_sample_count: int = 0

    def add_sample(self, payload: RelayPayload) -> None:
        self.sample_count += 1
        self.net_grid_sum_w += payload.net_grid_w
        if payload.phase_a_voltage_v is not None:
            self.voltage_sum_v += payload.phase_a_voltage_v
            self.voltage_sample_count += 1


def decode_float32_be(registers: list[int]) -> float:
    """Decode a big-endian IEEE-754 float32 from two Modbus registers."""
    raw = struct.pack(">HH", registers[0], registers[1])
    return struct.unpack(">f", raw)[0]


def create_modbus_client():
    if ModbusSerialClient is None:
        raise RuntimeError(
            "pymodbus is not installed. Run: python3 -m pip install -r bridge/requirements.txt"
        )

    return ModbusSerialClient(
        port=SERIAL_PORT,
        baudrate=BAUDRATE,
        bytesize=8,
        parity="N",
        stopbits=1,
        timeout=1,
    )


def release_modbus_client(client) -> None:
    """Close the Modbus client and force the serial port handle to release."""
    if client is None:
        return

    try:
        client.close()
    finally:
        del client
        gc.collect()


def read_float_register(client, address: int) -> float:
    """Read a two-register float from the meter and return the decoded value."""
    result = client.read_holding_registers(address=address, count=2, slave=SLAVE_ID)
    if result.isError():
        raise RuntimeError(f"Modbus error while reading register {address}")

    return decode_float32_be(result.registers)


def bucket_start_for_timestamp(timestamp: str, bucket_minutes: int) -> str:
    """Round a UTC timestamp down to the start of the cloud batch window."""
    date = datetime.fromisoformat(timestamp.replace("Z", "+00:00")).astimezone(timezone.utc)
    bucket_seconds = int(date.timestamp() // (bucket_minutes * 60) * bucket_minutes * 60)
    return datetime.fromtimestamp(bucket_seconds, tz=timezone.utc).isoformat().replace("+00:00", "Z")


def resolve_csv_sink() -> tuple[Path | None, bool]:
    """
    Resolve the CSV target.

    Returns:
    - (path, True) for daily directory-backed CSV backups
    - (path, False) for a legacy single CSV file
    - (None, False) if CSV logging is disabled
    """
    if CSV_LOG_PATH:
        candidate = Path(CSV_LOG_PATH).expanduser()
        if candidate.suffix.lower() == ".csv":
            return candidate, False
        return candidate, True

    if CSV_BACKUP_DIR:
        return Path(CSV_BACKUP_DIR).expanduser(), True

    return None, False


def build_payload(client) -> RelayPayload:
    """Collect one live meter snapshot."""
    total_active_power_w = read_float_register(client, 8210)

    voltage_v = None
    try:
        voltage_v = read_float_register(client, 8192) / 10.0
    except Exception as exc:
        print(f"[{datetime.now().strftime('%H:%M:%S')}] Voltage read skipped: {exc}")

    return RelayPayload(
        timestamp=datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
        net_grid_w=int(round(total_active_power_w)),
        phase_a_voltage_v=round(voltage_v, 1) if voltage_v is not None else None,
    )


def write_csv_row(payload: RelayPayload) -> None:
    """
    Optional CSV sink for offline backups.

    Behavior:
    - If CSV_LOG_PATH is set, keep the legacy single-file append mode.
    - Otherwise, write one CSV per local calendar day inside CSV_BACKUP_DIR.
    """
    path, is_daily_directory = resolve_csv_sink()
    if path is None:
        return

    if is_daily_directory:
        local_day = datetime.now().astimezone().strftime("%Y-%m-%d")
        path = path / f"{CSV_BACKUP_PREFIX}_{local_day}.csv"

    path.parent.mkdir(parents=True, exist_ok=True)

    write_header = not path.exists() or path.stat().st_size == 0
    with path.open("a", newline="") as file:
        writer = csv.writer(file)
        if write_header:
            writer.writerow(
                [
                    "Timestamp (UTC)",
                    "Net Grid Power (W)",
                    "Phase A Voltage (V)",
                ]
            )
        writer.writerow([payload.timestamp, payload.net_grid_w, payload.phase_a_voltage_v])


def build_supabase_batch_row(batch: CloudBatchState) -> dict[str, int | float | str | None]:
    """Convert the in-memory batch into a Supabase row."""
    average_watts = int(round(batch.net_grid_sum_w / max(batch.sample_count, 1)))
    average_voltage = (
        round(batch.voltage_sum_v / batch.voltage_sample_count, 1)
        if batch.voltage_sample_count > 0
        else None
    )

    return {
        "timestamp": batch.bucket_start,
        "sample_count": batch.sample_count,
        "net_grid_w": average_watts,
        "phase_a_voltage_v": average_voltage,
    }


def sync_supabase_batch(batch: CloudBatchState) -> None:
    """POST one aggregated batch row to Supabase."""
    if not SUPABASE_URL or not SUPABASE_SERVICE_ROLE_KEY:
        return

    row = build_supabase_batch_row(batch)
    url = f"{SUPABASE_URL.rstrip('/')}/rest/v1/{SUPABASE_TABLE_NAME}?on_conflict=timestamp"
    body = json.dumps(row).encode("utf-8")
    request = urllib.request.Request(
        url,
        data=body,
        method="POST",
        headers={
            "apikey": SUPABASE_SERVICE_ROLE_KEY,
            "Authorization": f"Bearer {SUPABASE_SERVICE_ROLE_KEY}",
            "Content-Type": "application/json",
            "Prefer": "resolution=merge-duplicates,return=minimal",
        },
    )

    try:
        print(
            f"[{datetime.now().strftime('%H:%M:%S')}] "
            f"Supabase batch flush {batch.bucket_start} ({batch.sample_count} samples)..."
        )
        with urllib.request.urlopen(request, timeout=SUPABASE_SYNC_TIMEOUT_SECONDS) as response:
            if response.status not in {200, 201, 204}:
                raise RuntimeError(f"Unexpected Supabase status {response.status}")
        print(
            f"[{datetime.now().strftime('%H:%M:%S')}] "
            f"Supabase batch ok {batch.bucket_start} ({batch.sample_count} samples)"
        )
    except urllib.error.URLError as exc:
        print(
            f"[{datetime.now().strftime('%H:%M:%S')}] "
            f"Supabase batch failed {batch.bucket_start}: {exc}"
        )


async def flush_cloud_batch(batch: Optional[CloudBatchState]) -> None:
    if batch is None or batch.sample_count == 0:
        return

    await asyncio.to_thread(sync_supabase_batch, batch)


async def advance_cloud_batch(
    current_batch: Optional[CloudBatchState],
    payload: RelayPayload,
) -> CloudBatchState | None:
    """Aggregate the current reading into a 15-minute cloud batch."""
    if not SUPABASE_URL or not SUPABASE_SERVICE_ROLE_KEY:
        return current_batch

    bucket_start = bucket_start_for_timestamp(payload.timestamp, SUPABASE_BATCH_MINUTES)
    batch = current_batch

    if batch is None:
        batch = CloudBatchState(bucket_start=bucket_start)
    elif batch.bucket_start != bucket_start:
        await flush_cloud_batch(batch)
        batch = CloudBatchState(bucket_start=bucket_start)

    batch.add_sample(payload)
    return batch


def payload_to_json(payload: RelayPayload) -> str:
    """Serialize the payload and omit any empty optional values."""
    data = asdict(payload)
    return json.dumps({key: value for key, value in data.items() if value is not None})


def status_payload_to_json(payload: RelayStatusPayload) -> str:
    """Serialize a bridge status message."""
    data = asdict(payload)
    return json.dumps({key: value for key, value in data.items() if value is not None})


def build_offline_status_payload(failures: int) -> RelayStatusPayload:
    return RelayStatusPayload(
        timestamp=datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
        status="HARDWARE_OFFLINE",
        failures=failures,
        message=(
            "Modbus hardware is offline. "
            "Check the USB adapter, serial cable, and meter power."
        ),
    )


def describe_cloud_sync() -> str:
    """Return a short human-readable cloud sync status for startup logs."""
    if not SUPABASE_URL or not SUPABASE_SERVICE_ROLE_KEY:
        return "Cloud sync disabled"

    host = urlparse(SUPABASE_URL).netloc or SUPABASE_URL
    return (
        f"Cloud sync enabled -> host {host}, table {SUPABASE_TABLE_NAME}, "
        f"batch {SUPABASE_BATCH_MINUTES}m"
    )


def describe_csv_logging() -> str:
    """Return a short human-readable CSV backup status for startup logs."""
    path, is_daily_directory = resolve_csv_sink()
    if path is None:
        return "CSV backup disabled"

    if is_daily_directory:
        return f"CSV backup enabled -> daily files in {path}"

    return f"CSV backup enabled -> single file {path}"


async def broadcast(clients: set[WebSocketServerProtocol], message: str) -> None:
    """Push the latest payload to every connected browser client."""
    stale_clients: list[WebSocketServerProtocol] = []
    for client in clients:
        try:
            await client.send(message)
        except Exception:
            stale_clients.append(client)

    for client in stale_clients:
        clients.discard(client)


async def client_handler(
    websocket: WebSocketServerProtocol,
    clients: set[WebSocketServerProtocol],
    latest_message: dict[str, str | None],
) -> None:
    """Register a browser client and send the latest reading immediately."""
    clients.add(websocket)
    try:
        if latest_message["value"]:
            await websocket.send(latest_message["value"])
        await websocket.wait_closed()
    finally:
        clients.discard(websocket)


async def main() -> None:
    if ModbusSerialClient is None:
        raise RuntimeError("pymodbus is missing. Install bridge dependencies first.")

    client = create_modbus_client()
    if not client.connect():
        raise RuntimeError(f"Failed to connect to {SERIAL_PORT}")

    connected_clients: set[WebSocketServerProtocol] = set()
    latest_message: dict[str, str | None] = {"value": None}
    failure_count = 0
    pending_cloud_batch: Optional[CloudBatchState] = None

    async def handler(websocket: WebSocketServerProtocol) -> None:
        await client_handler(websocket, connected_clients, latest_message)

    async with websockets.serve(handler, HOST, PORT):
        print(
            f"Modbus relay listening on ws://{HOST}:{PORT} "
            f"(serial: {SERIAL_PORT}, baud: {BAUDRATE}, slave: {SLAVE_ID})"
        )
        print(f"[{datetime.now().strftime('%H:%M:%S')}] {describe_cloud_sync()}")
        print(f"[{datetime.now().strftime('%H:%M:%S')}] {describe_csv_logging()}")

        try:
            while True:
                try:
                    payload = await asyncio.to_thread(build_payload, client)
                    message = payload_to_json(payload)
                    latest_message["value"] = message
                    failure_count = 0
                    write_csv_row(payload)
                    pending_cloud_batch = await advance_cloud_batch(pending_cloud_batch, payload)
                    await broadcast(connected_clients, message)
                    print(
                        f"[{datetime.now().strftime('%H:%M:%S')}] "
                        f"{payload.net_grid_w} W"
                        + (
                            f" | phase A {payload.phase_a_voltage_v:.1f} V"
                            if payload.phase_a_voltage_v is not None
                            else ""
                        )
                        )
                except Exception as exc:
                    failure_count += 1
                    print(f"[{datetime.now().strftime('%H:%M:%S')}] Relay hiccup: {exc}")
                    if failure_count >= OFFLINE_FAILURE_THRESHOLD:
                        offline_message = status_payload_to_json(
                            build_offline_status_payload(failure_count)
                        )
                        latest_message["value"] = offline_message
                        await broadcast(connected_clients, offline_message)

                    release_modbus_client(client)
                    await asyncio.sleep(1)
                    client = create_modbus_client()
                    if not client.connect():
                        print(
                            f"[{datetime.now().strftime('%H:%M:%S')}] "
                            f"Reconnection failed. Retrying in 1s..."
                        )
                        release_modbus_client(client)
                        await asyncio.sleep(1)
                        continue

                await asyncio.sleep(1)
        finally:
            await flush_cloud_batch(pending_cloud_batch)
            release_modbus_client(client)


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        print("\nRelay stopped by user.")
