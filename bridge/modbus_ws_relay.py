"""
Local Modbus RTU + Hoymiles WiFi relay.

This bridge keeps the Chint DTSU666-CT meter on the shared RS-485 bus and
reads the Hoymiles DTU over its local WiFi/HTTP protocol using the
``hoymiles-wifi`` CLI.

Important behavior:
- RS-485 reads remain sequential and use one shared AsyncModbusSerialClient.
- Hoymiles is polled separately with ``hoymiles-wifi --as-json``.
- If one side fails, the relay keeps broadcasting with null/0 values for that
  device instead of exiting.
- The Chint meter reading still feeds the existing CSV backup and Supabase
  history flow.

Hoymiles mapping notes:
- The relay keeps the Hoymiles payload flexible and parses the JSON response
  from ``hoymiles-wifi`` into inverter totals and per-port readings.
- If you want to inspect or change the device address, polling interval, or
  command path, see the HOYMILES_WIFI_* env vars below.
"""

from __future__ import annotations

import asyncio
import csv
import contextlib
import gc
import json
import os
import shutil
import struct
import urllib.error
import urllib.request
from collections import defaultdict
from dataclasses import asdict, dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Optional
from urllib.parse import urlparse

import websockets
from websockets.server import WebSocketServerProtocol

try:
    from pymodbus.client import AsyncModbusSerialClient
except ImportError:  # pragma: no cover - resolved when bridge deps are installed
    AsyncModbusSerialClient = None


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
POLL_INTERVAL_SECONDS = float(os.getenv("BRIDGE_POLL_INTERVAL_SECONDS", "1"))

# Chint DTSU666-CT
METER_SLAVE_ID = int(os.getenv("MODBUS_SLAVE_ID", "1"))
METER_TOTAL_ACTIVE_POWER_REGISTER = int(os.getenv("METER_TOTAL_ACTIVE_POWER_REGISTER", "8210"))
METER_PHASE_A_VOLTAGE_REGISTER = int(os.getenv("METER_PHASE_A_VOLTAGE_REGISTER", "8192"))
METER_REGISTER_KIND = os.getenv("METER_REGISTER_KIND", "holding").strip().lower()
METER_VOLTAGE_SCALE = float(os.getenv("METER_VOLTAGE_SCALE", "0.1"))

# Hoymiles DTU via local WiFi/protobuf CLI
HOYMILES_WIFI_HOST = os.getenv("HOYMILES_WIFI_HOST", "192.168.1.8")
HOYMILES_WIFI_COMMAND = os.getenv("HOYMILES_WIFI_COMMAND", "hoymiles-wifi")
HOYMILES_WIFI_COMMAND_ARG = os.getenv("HOYMILES_WIFI_COMMAND_ARG", "get-real-data-new")
HOYMILES_WIFI_TIMEOUT_SECONDS = float(os.getenv("HOYMILES_WIFI_TIMEOUT_SECONDS", "20"))
HOYMILES_WIFI_REFRESH_SECONDS = float(os.getenv("HOYMILES_WIFI_REFRESH_SECONDS", "30"))

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
class UnifiedRelayPayload:
    timestamp: str
    bridge_status: str
    meter: "MeterSnapshot"
    hoymiles: "HoymilesSnapshot"
    meter_status: str
    meter_total_active_power_w: Optional[int]
    meter_phase_a_voltage_v: Optional[float]
    meter_error: Optional[str]
    hoymiles_status: str
    hoymiles_error: Optional[str]
    hoymiles_total_active_power_w: Optional[int]
    hoymiles_inverter_count: int
    hoymiles_port_count: int
    net_grid_w: int
    phase_a_voltage_v: Optional[float]
    solar_production_w: int
    home_consumption_w: Optional[int] = None


@dataclass
class MeterSnapshot:
    timestamp: str
    status: str
    total_active_power_w: Optional[int]
    phase_a_voltage_v: Optional[float]
    error: Optional[str] = None


@dataclass
class HoymilesPortReading:
    serial_number: str
    port_number: int
    voltage_v: Optional[float] = None
    current_a: Optional[float] = None
    power_w: Optional[int] = None
    energy_total_raw: Optional[int] = None
    energy_daily_raw: Optional[int] = None
    error_code: Optional[int] = None


@dataclass
class HoymilesInverterReading:
    serial_number: str
    active_power_w: Optional[int] = None
    reactive_power_var: Optional[int] = None
    voltage_v: Optional[float] = None
    current_a: Optional[float] = None
    frequency_hz: Optional[float] = None
    power_factor: Optional[float] = None
    temperature_c: Optional[float] = None
    warning_number: Optional[int] = None
    link_status: Optional[int] = None
    power_limit_w: Optional[int] = None
    modulation_index_signal: Optional[int] = None
    ports: list[HoymilesPortReading] = field(default_factory=list)


@dataclass
class HoymilesSnapshot:
    timestamp: str
    device_serial_number: Optional[str]
    status: str
    error: Optional[str]
    total_active_power_w: Optional[int]
    inverter_count: int
    port_count: int
    inverters: list[HoymilesInverterReading] = field(default_factory=list)


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

    def add_sample(self, net_grid_w: int, phase_a_voltage_v: Optional[float]) -> None:
        self.sample_count += 1
        self.net_grid_sum_w += net_grid_w
        if phase_a_voltage_v is not None:
            self.voltage_sum_v += phase_a_voltage_v
            self.voltage_sample_count += 1


def decode_float32_be(registers: list[int]) -> float:
    """Decode a big-endian IEEE-754 float32 from two Modbus registers."""
    raw = struct.pack(">HH", registers[0], registers[1])
    return struct.unpack(">f", raw)[0]


def create_modbus_client():
    if AsyncModbusSerialClient is None:
        raise RuntimeError(
            "pymodbus is not installed. Run: python3 -m pip install -r bridge/requirements.txt"
        )

    return AsyncModbusSerialClient(
        port=SERIAL_PORT,
        baudrate=BAUDRATE,
        bytesize=8,
        parity="N",
        stopbits=1,
        timeout=1,
        retries=0,
    )


async def ensure_modbus_connected(client) -> None:
    """Keep retrying until the serial client opens successfully."""
    while True:
        try:
            if await client.connect() and client.connected:
                return
        except Exception as exc:
            print(
                f"[{datetime.now().strftime('%H:%M:%S')}] "
                f"Modbus connect failed: {exc}"
            )

        print(
            f"[{datetime.now().strftime('%H:%M:%S')}] "
            f"Modbus reconnect retry in 1s..."
        )
        await asyncio.sleep(1)


async def reconnect_modbus_client(client) -> None:
    """Close and reopen the same shared AsyncModbusSerialClient instance."""
    try:
        client.close()
    except Exception:
        pass

    gc.collect()
    await asyncio.sleep(1)
    await ensure_modbus_connected(client)


async def read_float_register(
    client,
    *,
    slave_id: int,
    address: int,
    register_kind: str,
    label: str,
    scale: float = 1.0,
) -> tuple[Optional[float], Optional[str]]:
    """
    Read a two-register float from the selected slave.

    The Modbus bus is half-duplex, so callers must await these reads
    sequentially instead of launching them concurrently.
    """
    reader = client.read_input_registers if register_kind == "input" else client.read_holding_registers

    try:
        response = await reader(address=address, count=2, slave=slave_id)
        if response is None:
            raise RuntimeError(f"{label} returned no response")
        if response.isError():
            raise RuntimeError(f"{label} returned Modbus error: {response}")

        registers = getattr(response, "registers", None)
        if not registers or len(registers) < 2:
            raise RuntimeError(f"{label} returned incomplete register data")

        return decode_float32_be(registers) * scale, None
    except Exception as exc:
        return None, f"{label} read failed: {exc}"


def bucket_start_for_timestamp(timestamp: str, bucket_minutes: int) -> str:
    """Round a UTC timestamp down to the start of the cloud batch window."""
    date = datetime.fromisoformat(timestamp.replace("Z", "+00:00")).astimezone(timezone.utc)
    bucket_seconds = int(date.timestamp() // (bucket_minutes * 60) * bucket_minutes * 60)
    return datetime.fromtimestamp(bucket_seconds, tz=timezone.utc).isoformat().replace(
        "+00:00", "Z"
    )


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


async def read_meter_snapshot(client) -> MeterSnapshot:
    """Poll the Chint meter sequentially and return the live values plus any errors."""
    errors: list[str] = []

    total_active_power_w, power_error = await read_float_register(
        client,
        slave_id=METER_SLAVE_ID,
        address=METER_TOTAL_ACTIVE_POWER_REGISTER,
        register_kind=METER_REGISTER_KIND,
        label=f"Chint meter active power (slave {METER_SLAVE_ID}, reg {METER_TOTAL_ACTIVE_POWER_REGISTER})",
    )
    if power_error:
        errors.append(power_error)

    phase_a_voltage_v, voltage_error = await read_float_register(
        client,
        slave_id=METER_SLAVE_ID,
        address=METER_PHASE_A_VOLTAGE_REGISTER,
        register_kind=METER_REGISTER_KIND,
        label=f"Chint meter phase A voltage (slave {METER_SLAVE_ID}, reg {METER_PHASE_A_VOLTAGE_REGISTER})",
        scale=METER_VOLTAGE_SCALE,
    )
    if voltage_error:
        errors.append(voltage_error)

    return MeterSnapshot(
        timestamp=datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
        status="OK" if total_active_power_w is not None or phase_a_voltage_v is not None else "OFFLINE",
        total_active_power_w=int(round(total_active_power_w)) if total_active_power_w is not None else None,
        phase_a_voltage_v=round(phase_a_voltage_v, 1) if phase_a_voltage_v is not None else None,
        error="; ".join(errors) if errors else None,
    )


def coerce_int(value: Any) -> Optional[int]:
    if value is None:
        return None
    if isinstance(value, bool):
        return int(value)
    if isinstance(value, int):
        return value
    if isinstance(value, float):
        return int(round(value))
    if isinstance(value, str):
        try:
            return int(round(float(value.strip())))
        except ValueError:
            return None
    return None


def coerce_float(value: Any) -> Optional[float]:
    if value is None:
        return None
    if isinstance(value, bool):
        return float(value)
    if isinstance(value, (int, float)):
        return float(value)
    if isinstance(value, str):
        try:
            return float(value.strip())
        except ValueError:
            return None
    return None


def scale_tenths(value: Any) -> Optional[float]:
    number = coerce_float(value)
    return None if number is None else number / 10.0


def scale_hundredths(value: Any) -> Optional[float]:
    number = coerce_float(value)
    return None if number is None else number / 100.0


def scale_thousandths(value: Any) -> Optional[float]:
    number = coerce_float(value)
    return None if number is None else number / 1000.0


def extract_json_payload(text: str) -> dict[str, Any]:
    """
    Parse JSON from hoymiles-wifi stdout.

    The CLI normally emits JSON with --as-json, but this function also tolerates
    any short prefix/suffix text by extracting the first balanced object.
    """
    stripped = text.strip()
    if not stripped:
        raise ValueError("empty Hoymiles output")

    try:
        loaded = json.loads(stripped)
    except json.JSONDecodeError:
        start = stripped.find("{")
        end = stripped.rfind("}")
        if start < 0 or end <= start:
            raise
        loaded = json.loads(stripped[start : end + 1])

    if not isinstance(loaded, dict):
        raise ValueError("Hoymiles JSON response was not an object")

    return loaded


def normalize_serial(value: Any) -> str:
    normalized = coerce_int(value)
    if normalized is not None:
        return str(normalized)
    return str(value).strip()


def parse_hoymiles_port(raw_port: Any) -> HoymilesPortReading | None:
    if not isinstance(raw_port, dict):
        return None

    serial_number = normalize_serial(raw_port.get("serial_number") or raw_port.get("serialNumber"))
    port_number = coerce_int(raw_port.get("port_number") or raw_port.get("portNumber"))
    if port_number is None:
        return None

    return HoymilesPortReading(
        serial_number=serial_number,
        port_number=port_number,
        voltage_v=scale_tenths(raw_port.get("voltage")),
        current_a=scale_hundredths(raw_port.get("current")),
        power_w=(
            int(round(coerce_float(raw_port.get("power")) / 10.0))
            if coerce_float(raw_port.get("power")) is not None
            else None
        ),
        energy_total_raw=coerce_int(raw_port.get("energy_total")),
        energy_daily_raw=coerce_int(raw_port.get("energy_daily")),
        error_code=coerce_int(raw_port.get("error_code")),
    )


def parse_hoymiles_inverter(raw_inverter: Any, ports: list[HoymilesPortReading]) -> HoymilesInverterReading | None:
    if not isinstance(raw_inverter, dict):
        return None

    serial_number = normalize_serial(raw_inverter.get("serial_number") or raw_inverter.get("serialNumber"))
    active_power_raw = coerce_int(raw_inverter.get("active_power"))

    return HoymilesInverterReading(
        serial_number=serial_number,
        active_power_w=int(round(active_power_raw / 10.0)) if active_power_raw is not None else None,
        reactive_power_var=coerce_int(raw_inverter.get("reactive_power")),
        voltage_v=scale_tenths(raw_inverter.get("voltage")),
        current_a=scale_hundredths(raw_inverter.get("current")),
        frequency_hz=scale_hundredths(raw_inverter.get("frequency")),
        power_factor=scale_thousandths(raw_inverter.get("power_factor")),
        temperature_c=scale_tenths(raw_inverter.get("temperature")),
        warning_number=coerce_int(raw_inverter.get("warning_number")),
        link_status=coerce_int(raw_inverter.get("link_status")),
        power_limit_w=coerce_int(raw_inverter.get("power_limit")),
        modulation_index_signal=coerce_int(raw_inverter.get("modulation_index_signal")),
        ports=ports,
    )


def build_hoymiles_snapshot(payload: dict[str, Any]) -> HoymilesSnapshot:
    raw_inverters = payload.get("sgs_data") or []
    raw_ports = payload.get("pv_data") or []
    if not isinstance(raw_inverters, list):
        raw_inverters = []
    if not isinstance(raw_ports, list):
        raw_ports = []
    device_serial_number = payload.get("device_serial_number")
    timestamp_raw = payload.get("timestamp")
    root_error = payload.get("error")

    ports_by_serial: dict[str, list[HoymilesPortReading]] = defaultdict(list)
    for raw_port in raw_ports:
        port = parse_hoymiles_port(raw_port)
        if port is None:
            continue
        ports_by_serial[port.serial_number].append(port)

    inverters: list[HoymilesInverterReading] = []
    total_active_power_w = 0
    inverter_count = 0
    port_count = 0

    for raw_inverter in raw_inverters:
        serial_number = normalize_serial(
            raw_inverter.get("serial_number") if isinstance(raw_inverter, dict) else None
        )
        ports = sorted(ports_by_serial.get(serial_number, []), key=lambda item: item.port_number)
        inverter = parse_hoymiles_inverter(raw_inverter, ports)
        if inverter is None:
            continue

        inverter_count += 1
        port_count += len(ports)
        if inverter.active_power_w is not None:
            total_active_power_w += inverter.active_power_w
        inverters.append(inverter)

    status = "OK" if inverter_count > 0 else "OFFLINE"
    timestamp_value = coerce_float(timestamp_raw)
    timestamp = (
        datetime.fromtimestamp(timestamp_value, tz=timezone.utc).isoformat().replace("+00:00", "Z")
        if timestamp_value is not None
        else datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
    )

    return HoymilesSnapshot(
        timestamp=timestamp,
        device_serial_number=str(device_serial_number) if device_serial_number is not None else None,
        status=status,
        error=str(root_error) if root_error else (None if inverter_count > 0 else "Hoymiles response did not include inverter data"),
        total_active_power_w=total_active_power_w if inverter_count > 0 else None,
        inverter_count=inverter_count,
        port_count=port_count,
        inverters=inverters,
    )


def build_offline_hoymiles_snapshot(message: str) -> HoymilesSnapshot:
    return HoymilesSnapshot(
        timestamp=datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
        device_serial_number=None,
        status="OFFLINE",
        error=message,
        total_active_power_w=None,
        inverter_count=0,
        port_count=0,
        inverters=[],
    )


async def read_hoymiles_snapshot() -> HoymilesSnapshot:
    """Run hoymiles-wifi as JSON and convert its response into a structured snapshot."""
    command = [
        HOYMILES_WIFI_COMMAND,
        "--host",
        HOYMILES_WIFI_HOST,
        "--as-json",
        "--disable-interactive",
    ]

    timeout_value = int(round(HOYMILES_WIFI_TIMEOUT_SECONDS))
    if timeout_value > 0:
        command.extend(["--timeout", str(timeout_value)])
    command.append(HOYMILES_WIFI_COMMAND_ARG)

    executable = shutil.which(command[0])
    if executable is None:
        return build_offline_hoymiles_snapshot(
            f"{HOYMILES_WIFI_COMMAND} command was not found on PATH"
        )

    try:
        process = await asyncio.create_subprocess_exec(
            executable,
            *command[1:],
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        stdout, stderr = await asyncio.wait_for(process.communicate(), timeout=HOYMILES_WIFI_TIMEOUT_SECONDS + 5)
    except asyncio.TimeoutError:
        with contextlib.suppress(ProcessLookupError):
            process.kill()
        with contextlib.suppress(Exception):
            await process.wait()
        return build_offline_hoymiles_snapshot(
            f"Hoymiles CLI timed out after {HOYMILES_WIFI_TIMEOUT_SECONDS} seconds"
        )
    except Exception as exc:
        return build_offline_hoymiles_snapshot(f"Hoymiles CLI failed to start: {exc}")

    if process.returncode != 0:
        stderr_text = stderr.decode("utf-8", errors="replace").strip()
        return build_offline_hoymiles_snapshot(
            f"Hoymiles CLI exited with {process.returncode}: {stderr_text or 'no stderr'}"
        )

    try:
        payload = extract_json_payload(stdout.decode("utf-8", errors="replace"))
        snapshot = build_hoymiles_snapshot(payload)
        return snapshot
    except Exception as exc:
        return build_offline_hoymiles_snapshot(f"Failed to parse Hoymiles JSON: {exc}")


def build_unified_payload(
    meter_snapshot: MeterSnapshot,
    hoymiles_snapshot: HoymilesSnapshot,
) -> UnifiedRelayPayload:
    """Merge the Chint meter and Hoymiles inverter snapshots into one payload."""
    meter_total_active_power_w = meter_snapshot.total_active_power_w
    meter_phase_a_voltage_v = meter_snapshot.phase_a_voltage_v
    hoymiles_total_active_power_w = hoymiles_snapshot.total_active_power_w

    meter_online = meter_snapshot.status == "OK"
    hoymiles_online = hoymiles_snapshot.status == "OK"

    if meter_online and hoymiles_online:
        bridge_status = "OK"
    elif meter_online or hoymiles_online:
        bridge_status = "DEGRADED"
    else:
        bridge_status = "HARDWARE_OFFLINE"

    solar_production_w = hoymiles_total_active_power_w if hoymiles_total_active_power_w is not None else 0
    net_grid_w = meter_total_active_power_w if meter_total_active_power_w is not None else 0

    return UnifiedRelayPayload(
        timestamp=datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
        bridge_status=bridge_status,
        meter=meter_snapshot,
        hoymiles=hoymiles_snapshot,
        meter_status=meter_snapshot.status,
        meter_total_active_power_w=meter_total_active_power_w,
        meter_phase_a_voltage_v=meter_phase_a_voltage_v,
        meter_error=meter_snapshot.error,
        hoymiles_status=hoymiles_snapshot.status,
        hoymiles_error=hoymiles_snapshot.error,
        hoymiles_total_active_power_w=hoymiles_total_active_power_w,
        hoymiles_inverter_count=hoymiles_snapshot.inverter_count,
        hoymiles_port_count=hoymiles_snapshot.port_count,
        net_grid_w=net_grid_w,
        phase_a_voltage_v=meter_phase_a_voltage_v,
        solar_production_w=solar_production_w,
        home_consumption_w=None,
    )


def write_csv_row(payload: UnifiedRelayPayload) -> None:
    """
    Optional CSV sink for offline backups.

    Behavior:
    - If CSV_LOG_PATH is set, keep the legacy single-file append mode.
    - Otherwise, write one CSV per local calendar day inside CSV_BACKUP_DIR.

    The first three columns stay compatible with the existing history parser.
    Additional columns carry the merged Hoymiles data.
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
                    "Hoymiles Active Power (W)",
                    "Bridge Status",
                    "Meter Status",
                    "Hoymiles Status",
                ]
            )

        writer.writerow(
            [
                payload.timestamp,
                payload.net_grid_w,
                payload.phase_a_voltage_v,
                payload.hoymiles_total_active_power_w,
                payload.bridge_status,
                payload.meter_status,
                payload.hoymiles_status,
            ]
        )


def build_supabase_batch_row(payload: UnifiedRelayPayload) -> dict[str, int | float | str | None] | None:
    """Convert the meter portion of the merged payload into a Supabase row."""
    if payload.meter_total_active_power_w is None:
        return None

    return {
        "timestamp": payload.timestamp,
        "sample_count": 1,
        "net_grid_w": payload.meter_total_active_power_w,
        "phase_a_voltage_v": payload.meter_phase_a_voltage_v,
    }


def sync_supabase_batch(batch: CloudBatchState) -> None:
    """POST one aggregated batch row to Supabase."""
    if not SUPABASE_URL or not SUPABASE_SERVICE_ROLE_KEY:
        return

    average_watts = int(round(batch.net_grid_sum_w / max(batch.sample_count, 1)))
    average_voltage = (
        round(batch.voltage_sum_v / batch.voltage_sample_count, 1)
        if batch.voltage_sample_count > 0
        else None
    )

    row = {
        "timestamp": batch.bucket_start,
        "sample_count": batch.sample_count,
        "net_grid_w": average_watts,
        "phase_a_voltage_v": average_voltage,
    }

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


def build_payload_message(
    meter_snapshot: MeterSnapshot,
    hoymiles_snapshot: HoymilesSnapshot,
) -> tuple[UnifiedRelayPayload, str]:
    payload = build_unified_payload(meter_snapshot, hoymiles_snapshot)
    return payload, payload_to_json(payload)


async def publish_current_payload(
    *,
    latest_message: dict[str, str | None],
    connected_clients: set[WebSocketServerProtocol],
    meter_snapshot: MeterSnapshot | None,
    hoymiles_snapshot: HoymilesSnapshot | None,
) -> UnifiedRelayPayload | None:
    if meter_snapshot is None:
        return None

    effective_hoymiles = hoymiles_snapshot or build_offline_hoymiles_snapshot("Hoymiles not polled yet")
    payload, message = build_payload_message(meter_snapshot, effective_hoymiles)
    latest_message["value"] = message
    await broadcast(connected_clients, message)
    return payload


async def hoymiles_refresh_loop(
    *,
    latest_message: dict[str, str | None],
    connected_clients: set[WebSocketServerProtocol],
    state_lock: asyncio.Lock,
    latest_meter_snapshot: dict[str, MeterSnapshot | None],
    latest_hoymiles_snapshot: dict[str, HoymilesSnapshot | None],
) -> None:
    while True:
        snapshot = await read_hoymiles_snapshot()
        async with state_lock:
            latest_hoymiles_snapshot["value"] = snapshot
            meter_snapshot = latest_meter_snapshot["value"]

        await publish_current_payload(
            latest_message=latest_message,
            connected_clients=connected_clients,
            meter_snapshot=meter_snapshot,
            hoymiles_snapshot=snapshot,
        )
        await asyncio.sleep(HOYMILES_WIFI_REFRESH_SECONDS)


async def advance_cloud_batch(
    current_batch: Optional[CloudBatchState],
    payload: UnifiedRelayPayload,
) -> CloudBatchState | None:
    """
    Aggregate the Chint meter readings into a cloud batch.

    The cloud path intentionally stays meter-centric so the Supabase table can
    keep its existing shape.
    """
    if not SUPABASE_URL or not SUPABASE_SERVICE_ROLE_KEY:
        return current_batch

    if payload.meter_total_active_power_w is None:
        return current_batch

    bucket_start = bucket_start_for_timestamp(payload.timestamp, SUPABASE_BATCH_MINUTES)
    batch = current_batch

    if batch is None:
        batch = CloudBatchState(bucket_start=bucket_start)
    elif batch.bucket_start != bucket_start:
        await flush_cloud_batch(batch)
        batch = CloudBatchState(bucket_start=bucket_start)

    batch.add_sample(payload.meter_total_active_power_w, payload.meter_phase_a_voltage_v)
    return batch


def payload_to_json(payload: UnifiedRelayPayload) -> str:
    """Serialize the merged payload and keep explicit nulls for offline values."""
    return json.dumps(asdict(payload))


def status_payload_to_json(payload: RelayStatusPayload) -> str:
    """Serialize a bridge status message."""
    return json.dumps(asdict(payload))


def build_offline_status_payload(failures: int) -> RelayStatusPayload:
    return RelayStatusPayload(
        timestamp=datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
        status="HARDWARE_OFFLINE",
        failures=failures,
        message=(
            "Both RS-485 devices are offline. "
            "Check the USB adapter, serial bus, meter power, and DTU power."
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
    if AsyncModbusSerialClient is None:
        raise RuntimeError("pymodbus is missing. Install bridge dependencies first.")

    client = create_modbus_client()
    await ensure_modbus_connected(client)

    connected_clients: set[WebSocketServerProtocol] = set()
    latest_message: dict[str, str | None] = {"value": None}
    failure_count = 0
    pending_cloud_batch: Optional[CloudBatchState] = None
    state_lock = asyncio.Lock()
    latest_meter_snapshot: dict[str, MeterSnapshot | None] = {"value": None}
    latest_hoymiles_snapshot: dict[str, HoymilesSnapshot | None] = {
        "value": build_offline_hoymiles_snapshot("Awaiting first Hoymiles poll")
    }

    async def handler(websocket: WebSocketServerProtocol) -> None:
        await client_handler(websocket, connected_clients, latest_message)

    async with websockets.serve(handler, HOST, PORT):
        print(
            f"Modbus relay listening on ws://{HOST}:{PORT} "
            f"(serial: {SERIAL_PORT}, baud: {BAUDRATE})"
        )
        print(
            f"[{datetime.now().strftime('%H:%M:%S')}] "
            f"Chint meter -> slave {METER_SLAVE_ID}, power reg {METER_TOTAL_ACTIVE_POWER_REGISTER} "
            f"({METER_REGISTER_KIND}), voltage reg {METER_PHASE_A_VOLTAGE_REGISTER} "
            f"({METER_REGISTER_KIND})"
        )
        print(
            f"[{datetime.now().strftime('%H:%M:%S')}] "
            f"Hoymiles WiFi -> host {HOYMILES_WIFI_HOST}, command {HOYMILES_WIFI_COMMAND} "
            f"{HOYMILES_WIFI_COMMAND_ARG}, refresh {HOYMILES_WIFI_REFRESH_SECONDS:.0f}s"
        )
        print(f"[{datetime.now().strftime('%H:%M:%S')}] {describe_cloud_sync()}")
        print(f"[{datetime.now().strftime('%H:%M:%S')}] {describe_csv_logging()}")

        hoymiles_task = asyncio.create_task(
            hoymiles_refresh_loop(
                latest_message=latest_message,
                connected_clients=connected_clients,
                state_lock=state_lock,
                latest_meter_snapshot=latest_meter_snapshot,
                latest_hoymiles_snapshot=latest_hoymiles_snapshot,
            )
        )

        try:
            while True:
                try:
                    meter_snapshot = await read_meter_snapshot(client)
                    async with state_lock:
                        latest_meter_snapshot["value"] = meter_snapshot
                        hoymiles_snapshot = latest_hoymiles_snapshot["value"]

                    payload = await publish_current_payload(
                        latest_message=latest_message,
                        connected_clients=connected_clients,
                        meter_snapshot=meter_snapshot,
                        hoymiles_snapshot=hoymiles_snapshot,
                    )
                    if payload is None:
                        continue

                    write_csv_row(payload)
                    pending_cloud_batch = await advance_cloud_batch(pending_cloud_batch, payload)

                    if payload.bridge_status == "HARDWARE_OFFLINE":
                        failure_count += 1
                    else:
                        failure_count = 0
                    print(
                        f"[{datetime.now().strftime('%H:%M:%S')}] "
                        f"meter {payload.net_grid_w} W"
                        + (
                            f" | hoymiles total {payload.solar_production_w} W"
                            if payload.hoymiles_status == "OK"
                            else " | hoymiles offline"
                        )
                        + (
                            f" | inverters {payload.hoymiles_inverter_count}"
                            if payload.hoymiles_status == "OK"
                            else ""
                        )
                        + (
                            f" | phase A {payload.phase_a_voltage_v:.1f} V"
                            if payload.phase_a_voltage_v is not None
                            else ""
                        )
                    )

                    if payload.bridge_status == "HARDWARE_OFFLINE" and failure_count >= OFFLINE_FAILURE_THRESHOLD:
                        offline_message = status_payload_to_json(
                            build_offline_status_payload(failure_count)
                        )
                        latest_message["value"] = offline_message
                        await broadcast(connected_clients, offline_message)
                        await reconnect_modbus_client(client)
                        failure_count = 0

                except Exception as exc:
                    failure_count += 1
                    print(f"[{datetime.now().strftime('%H:%M:%S')}] Relay hiccup: {exc}")
                    if failure_count >= OFFLINE_FAILURE_THRESHOLD:
                        offline_message = status_payload_to_json(
                            build_offline_status_payload(failure_count)
                        )
                        latest_message["value"] = offline_message
                        await broadcast(connected_clients, offline_message)
                        await reconnect_modbus_client(client)
                        failure_count = 0

                await asyncio.sleep(POLL_INTERVAL_SECONDS)
        finally:
            hoymiles_task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await hoymiles_task
            await flush_cloud_batch(pending_cloud_batch)
            try:
                client.close()
            finally:
                gc.collect()


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        print("\nRelay stopped by user.")
