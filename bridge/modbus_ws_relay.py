"""Hybrid Hoymiles relay: DTU Modbus TCP polling plus passive RS-485 sniffing.

The DTU-Pro-S is the sole RS-485 master and polls the attached Chint DTSU666.
This process opens the USB-RS485 adapter for receive-only byte capture; it
never writes a Modbus frame.  Inverter data continues to come from the DTU's
Ethernet Modbus TCP service.  WebSocket, Supabase, and CSV schemas are kept
compatible with the existing application.
"""

from __future__ import annotations

import asyncio
import csv
import contextlib
import inspect
import json
import logging
import math
import os
import struct
import time
from collections import defaultdict
from dataclasses import asdict, dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Optional
from urllib.parse import urlparse

import aiohttp
import requests
import websockets
from websockets.server import WebSocketServerProtocol

try:
    import serial
except ImportError:  # pragma: no cover - resolved when bridge deps are installed
    serial = None

try:
    from pymodbus.client import ModbusTcpClient
    from pymodbus.pdu.register_message import ReadHoldingRegistersResponse
except ImportError:  # pragma: no cover - resolved when bridge deps are installed
    ModbusTcpClient = None
    ReadHoldingRegistersResponse = None


relay_logger = logging.getLogger("solar_relay")


class AsyncLogQueueHandler(logging.Handler):
    """Copy relay log records into an asyncio queue for live WebSocket clients."""

    def __init__(self, loop: asyncio.AbstractEventLoop, queue: asyncio.Queue[dict[str, str]]) -> None:
        super().__init__(level=logging.INFO)
        self.loop = loop
        self.queue = queue

    def emit(self, record: logging.LogRecord) -> None:
        payload = {
            "type": "server_log",
            "timestamp": datetime.fromtimestamp(record.created, tz=timezone.utc)
            .isoformat()
            .replace("+00:00", "Z"),
            "level": record.levelname,
            "message": record.getMessage(),
        }
        try:
            self.loop.call_soon_threadsafe(self._enqueue, payload)
        except RuntimeError:
            # The event loop is shutting down; there is no client to notify.
            return

    def _enqueue(self, payload: dict[str, str]) -> None:
        if self.queue.full():
            try:
                self.queue.get_nowait()
                self.queue.task_done()
            except asyncio.QueueEmpty:
                pass
        try:
            self.queue.put_nowait(payload)
        except asyncio.QueueFull:
            pass


def configure_logging(loop: asyncio.AbstractEventLoop, queue: asyncio.Queue[dict[str, str]]) -> None:
    """Keep service_out output and add a structured live-log sink."""
    relay_logger.setLevel(logging.INFO)
    relay_logger.propagate = False
    relay_logger.handlers.clear()

    console_handler = logging.StreamHandler()
    console_handler.setFormatter(logging.Formatter("[%(asctime)s] %(message)s", datefmt="%H:%M:%S"))
    relay_logger.addHandler(console_handler)
    relay_logger.addHandler(AsyncLogQueueHandler(loop, queue))


async def broadcast_logs(
    log_queue: asyncio.Queue[dict[str, str]],
    clients: set[WebSocketServerProtocol],
) -> None:
    """Broadcast structured relay logs without changing telemetry messages."""
    while True:
        payload = await log_queue.get()
        try:
            await broadcast(clients, json.dumps(payload))
        finally:
            log_queue.task_done()


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


def first_env_value(*keys: str) -> tuple[Optional[str], Optional[str]]:
    """Return the first non-empty environment variable value plus its key."""
    for key in keys:
        value = os.getenv(key, "").strip()
        if value:
            return value, key
    return None, None


HOST = os.getenv("BRIDGE_HOST", "127.0.0.1")
PORT = int(os.getenv("BRIDGE_PORT", "8787"))
POLL_INTERVAL_SECONDS = float(os.getenv("BRIDGE_POLL_INTERVAL_SECONDS", "5"))

# Passive Chint meter sniffer.  These values configure receive-only pyserial;
# no code path writes to this port.
SERIAL_PORT = os.getenv("SERIAL_PORT", "COM4").strip()
SERIAL_BAUDRATE = int(os.getenv("MODBUS_BAUDRATE", "9600"))
METER_SLAVE_ID = int(os.getenv("MODBUS_SLAVE_ID", "142"))
METER_TOTAL_ACTIVE_POWER_REGISTER = int(os.getenv("METER_TOTAL_ACTIVE_POWER_REGISTER", "8210"))
# The DTU's observed 44-register poll begins before the voltage register.  The
# meter returns Float32 values in tenths, so scale after decoding.
METER_PHASE_A_VOLTAGE_REGISTER = int(os.getenv("METER_PHASE_A_VOLTAGE_REGISTER", "8198"))
METER_POWER_SCALE = float(os.getenv("METER_POWER_SCALE", "0.1"))
METER_VOLTAGE_SCALE = float(os.getenv("METER_VOLTAGE_SCALE", "0.1"))
METER_SNIFFER_STALE_SECONDS = float(os.getenv("METER_SNIFFER_STALE_SECONDS", "15"))

# Hoymiles DTU via Ethernet / Modbus TCP
HOYMILES_MODBUS_HOST = os.getenv("HOYMILES_MODBUS_HOST", "192.168.1.242").strip()
HOYMILES_MODBUS_PORT = int(os.getenv("HOYMILES_MODBUS_PORT", "502"))
HOYMILES_MODBUS_UNIT_ID = int(os.getenv("HOYMILES_MODBUS_UNIT_ID", "1"))
HOYMILES_MODBUS_TIMEOUT_SECONDS = float(os.getenv("HOYMILES_MODBUS_TIMEOUT_SECONDS", "20"))
HOYMILES_INVERTER_BASE_ADDRESS = 0x1000
HOYMILES_INVERTER_REGISTER_COUNT = 20
HOYMILES_INVERTER_REGISTER_STRIDE = 40
HOYMILES_INVERTER_COUNT = int(os.getenv("HOYMILES_INVERTER_COUNT", "12"))
HOYMILES_PORTS_PER_INVERTER = int(os.getenv("HOYMILES_PORTS_PER_INVERTER", "4"))
HOYMILES_PORT_COUNT = int(
    os.getenv("HOYMILES_PORT_COUNT", str(HOYMILES_INVERTER_COUNT * HOYMILES_PORTS_PER_INVERTER))
)
HOYMILES_PORTS_PER_READ = int(os.getenv("HOYMILES_PORTS_PER_READ", "3"))
HOYMILES_CHUNK_DELAY_SECONDS = float(os.getenv("HOYMILES_CHUNK_DELAY_SECONDS", "1"))
HOYMILES_DTU_SERIAL_ADDRESS = 0x2000
HOYMILES_DTU_SERIAL_REGISTER_COUNT = 3
CSV_LOG_PATH = os.getenv("CSV_LOG_PATH")
CSV_BACKUP_DIR = os.getenv("CSV_BACKUP_DIR", "./logs/meter-backups")
CSV_BACKUP_PREFIX = os.getenv("CSV_BACKUP_PREFIX", "meter")
OFFLINE_FAILURE_THRESHOLD = int(os.getenv("BRIDGE_OFFLINE_THRESHOLD", "10"))

NEXT_PUBLIC_SUPABASE_URL = os.getenv("NEXT_PUBLIC_SUPABASE_URL", "").strip()
SUPABASE_SERVICE_ROLE_KEY = os.getenv("SUPABASE_SERVICE_ROLE_KEY", "").strip()
SUPABASE_TABLE_NAME = os.getenv("SUPABASE_TABLE_NAME", "meter_readings")
SUPABASE_DAILY_TABLE_NAME = os.getenv("SUPABASE_DAILY_TABLE_NAME", "daily_energy_summary")
SUPABASE_PORT_TABLE_NAME = os.getenv("SUPABASE_PORT_TABLE_NAME", "inverter_port_readings")
SUPABASE_WEATHER_TABLE_NAME = os.getenv("SUPABASE_WEATHER_TABLE_NAME", "weather_snapshots")
SUPABASE_BATCH_MINUTES = int(os.getenv("SUPABASE_BATCH_MINUTES", "10"))
SUPABASE_SYNC_TIMEOUT_SECONDS = float(os.getenv("SUPABASE_SYNC_TIMEOUT_SECONDS", "5"))

WEATHER_LATITUDE = os.getenv("WEATHER_LATITUDE", "").strip()
WEATHER_LONGITUDE = os.getenv("WEATHER_LONGITUDE", "").strip()
WEATHER_POLL_SECONDS = float(os.getenv("WEATHER_POLL_SECONDS", "900"))
WEATHER_HTTP_TIMEOUT_SECONDS = float(os.getenv("WEATHER_HTTP_TIMEOUT_SECONDS", "10"))
OPEN_METEO_CURRENT_FIELDS = (
    "temperature_2m,cloud_cover,cloud_cover_low,cloud_cover_mid,cloud_cover_high,"
    "shortwave_radiation,direct_radiation,diffuse_radiation,wind_speed_10m,precipitation"
)
DEAD_MANS_SNITCH_URL = "https://hc-ping.com/27ce5d97-4e40-40c9-9576-5545b911141f"
DEAD_MANS_SNITCH_TIMEOUT_SECONDS = float(os.getenv("DEAD_MANS_SNITCH_TIMEOUT_SECONDS", "3"))


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
    hoymiles_daily_yield_wh: Optional[float]
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
    daily_yield_wh: Optional[float]
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
    local_day: str
    sample_count: int = 0
    net_grid_sum_w: int = 0
    solar_sum_w: int = 0
    solar_sample_count: int = 0
    voltage_sum_v: float = 0.0
    voltage_sample_count: int = 0
    imported_wh: float = 0.0
    exported_wh: float = 0.0
    solar_wh: float = 0.0
    home_wh: float = 0.0
    port_rows: list[dict[str, int | float | str]] = field(default_factory=list)
    port_snapshot_timestamp: Optional[str] = None

    def add_sample(
        self,
        net_grid_w: int,
        phase_a_voltage_v: Optional[float],
        solar_production_w: Optional[int],
        home_consumption_w: Optional[int],
    ) -> None:
        self.sample_count += 1
        self.net_grid_sum_w += net_grid_w
        if solar_production_w is not None:
            self.solar_sum_w += solar_production_w
            self.solar_sample_count += 1
            self.solar_wh += max(solar_production_w, 0) / 3600
        if phase_a_voltage_v is not None:
            self.voltage_sum_v += phase_a_voltage_v
            self.voltage_sample_count += 1
        self.imported_wh += max(net_grid_w, 0) / 3600
        self.exported_wh += max(-net_grid_w, 0) / 3600
        if home_consumption_w is not None:
            self.home_wh += max(home_consumption_w, 0) / 3600

    def add_hoymiles_snapshot(self, snapshot: HoymilesSnapshot) -> None:
        """Add one non-zero port snapshot to this cloud batch."""
        if snapshot.status != "OK" or snapshot.timestamp == self.port_snapshot_timestamp:
            return

        for inverter in snapshot.inverters:
            for port in inverter.ports:
                if (
                    port.power_w is None
                    or port.power_w <= 0
                    or port.voltage_v is None
                    or port.energy_daily_raw is None
                ):
                    continue

                self.port_rows.append(
                    {
                        "timestamp": snapshot.timestamp,
                        "inverter_serial": inverter.serial_number,
                        "port_number": port.port_number,
                        "dc_power_w": float(port.power_w),
                        "dc_voltage_v": float(port.voltage_v),
                        "energy_daily_wh": float(port.energy_daily_raw),
                    }
                )

        self.port_snapshot_timestamp = snapshot.timestamp


def decode_float32_be(registers: list[int]) -> float:
    """Decode a big-endian IEEE-754 float32 from two Modbus registers."""
    raw = struct.pack(">HH", registers[0], registers[1])
    return struct.unpack(">f", raw)[0]


if ReadHoldingRegistersResponse is not None:
    class HoymilesReadHoldingRegistersResponse(ReadHoldingRegistersResponse):
        @staticmethod
        def _data_size_fixer(packet: bytes):
            fixed_packet = list(packet)
            fixed_packet[0] = len(fixed_packet[1:])
            return bytes(fixed_packet)

        def decode(self, data: bytes):
            fixed = self._data_size_fixer(data)
            return super().decode(fixed)
else:  # pragma: no cover - only hit when pymodbus is unavailable
    HoymilesReadHoldingRegistersResponse = None


def create_hoymiles_modbus_client():
    if ModbusTcpClient is None:
        raise RuntimeError(
            "pymodbus is not installed. Run: python3 -m pip install -r bridge/requirements.txt"
        )

    client = ModbusTcpClient(
        host=HOYMILES_MODBUS_HOST,
        port=HOYMILES_MODBUS_PORT,
        timeout=HOYMILES_MODBUS_TIMEOUT_SECONDS,
        retries=3,
    )

    if HoymilesReadHoldingRegistersResponse is not None:
        with contextlib.suppress(Exception):
            client.framer.decoder.register(HoymilesReadHoldingRegistersResponse)

    return client


def build_modbus_read_kwargs(reader, *, address: int, count: int, slave_id: int) -> dict[str, int]:
    """
    Pick the Modbus unit-id keyword accepted by the installed pymodbus version.

    Newer pymodbus releases use `device_id`, while older releases use `slave`
    and some older code paths still accept `unit`.
    """
    parameters = inspect.signature(reader).parameters
    kwargs = {"address": address, "count": count}

    if "device_id" in parameters:
        kwargs["device_id"] = slave_id
    elif "slave" in parameters:
        kwargs["slave"] = slave_id
    elif "unit" in parameters:
        kwargs["unit"] = slave_id
    else:
        kwargs["device_id"] = slave_id

    return kwargs


def read_hoymiles_registers(client, *, start_address: int, count: int, unit_id: int) -> list[int]:
    reader = client.read_holding_registers
    response = reader(**build_modbus_read_kwargs(reader, address=start_address, count=count, slave_id=unit_id))

    if response is None:
        raise RuntimeError(f"read_holding_registers returned no response for address {start_address}")
    if response.isError():
        raise RuntimeError(f"read_holding_registers returned Modbus error: {response}")

    registers = getattr(response, "registers", None)
    if not registers or len(registers) < count:
        raise RuntimeError(f"read_holding_registers returned incomplete register data for address {start_address}")

    return registers[:count]


def decode_hoymiles_inverter_block(registers: list[int]) -> HoymilesInverterReading | None:
    """Decode one 40-register Hoymiles port block.

    Hoymiles assigns one 40-register block to each microinverter port. The
    caller groups the resulting port records by serial number to reconstruct
    multi-port inverter objects.
    """
    if len(registers) < HOYMILES_INVERTER_REGISTER_COUNT:
        return None

    raw_bytes = b"".join(struct.pack(">H", register & 0xFFFF) for register in registers[:HOYMILES_INVERTER_REGISTER_COUNT])

    serial_number = raw_bytes[1:7].hex()
    if serial_number == "000000000000":
        return None

    port_number = raw_bytes[7]
    pv_voltage_raw = int.from_bytes(raw_bytes[8:10], byteorder="big", signed=False)
    pv_current_raw = int.from_bytes(raw_bytes[10:12], byteorder="big", signed=False)
    grid_voltage_raw = int.from_bytes(raw_bytes[12:14], byteorder="big", signed=False)
    grid_frequency_raw = int.from_bytes(raw_bytes[14:16], byteorder="big", signed=False)
    pv_power_raw = int.from_bytes(raw_bytes[16:18], byteorder="big", signed=False)
    today_production = int.from_bytes(raw_bytes[18:20], byteorder="big", signed=False)
    total_production = int.from_bytes(raw_bytes[20:24], byteorder="big", signed=False)
    temperature_raw = int.from_bytes(raw_bytes[24:26], byteorder="big", signed=True)
    alarm_code = int.from_bytes(raw_bytes[28:30], byteorder="big", signed=False)
    alarm_count = int.from_bytes(raw_bytes[30:32], byteorder="big", signed=False)
    link_status = raw_bytes[32]

    current_scale = 10.0 if serial_number.startswith("10") else 100.0
    power_w = int(round(pv_power_raw / 10.0))

    return HoymilesInverterReading(
        serial_number=serial_number,
        active_power_w=power_w,
        reactive_power_var=None,
        voltage_v=grid_voltage_raw / 10.0,
        current_a=pv_current_raw / current_scale,
        frequency_hz=grid_frequency_raw / 100.0,
        power_factor=None,
        temperature_c=temperature_raw / 10.0,
        warning_number=alarm_code,
        link_status=link_status,
        power_limit_w=None,
        modulation_index_signal=None,
        ports=[
            HoymilesPortReading(
                serial_number=serial_number,
                port_number=port_number,
                voltage_v=pv_voltage_raw / 10.0,
                current_a=pv_current_raw / current_scale,
                power_w=power_w,
                energy_total_raw=total_production,
                energy_daily_raw=today_production,
                error_code=alarm_code,
            )
        ],
    )


def bucket_start_for_timestamp(timestamp: str, bucket_minutes: int) -> str:
    """Round a UTC timestamp down to the start of the cloud batch window."""
    date = datetime.fromisoformat(timestamp.replace("Z", "+00:00")).astimezone(timezone.utc)
    bucket_seconds = int(date.timestamp() // (bucket_minutes * 60) * bucket_minutes * 60)
    return datetime.fromtimestamp(bucket_seconds, tz=timezone.utc).isoformat().replace(
        "+00:00", "Z"
    )


def local_day_for_timestamp(timestamp: str) -> str:
    """Return the relay-local calendar day for daily energy rollups."""
    date = datetime.fromisoformat(timestamp.replace("Z", "+00:00")).astimezone()
    return date.date().isoformat()


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


def normalize_serial(value: Any) -> str:
    normalized = coerce_int(value)
    if normalized is not None:
        return str(normalized)
    return str(value).strip()


def parse_hoymiles_port(raw_port: Any) -> HoymilesPortReading | None:
    if not isinstance(raw_port, dict):
        return None

    serial_number = normalize_serial(first_present(raw_port, "serial_number", "serialNumber"))
    port_number = coerce_int(first_present(raw_port, "port_number", "portNumber"))
    if port_number is None:
        return None

    raw_power = coerce_float(first_present(raw_port, "power", "active_power", "activePower"))

    return HoymilesPortReading(
        serial_number=serial_number,
        port_number=port_number,
        voltage_v=scale_tenths(first_present(raw_port, "voltage", "voltage_v", "voltageV")),
        current_a=scale_hundredths(first_present(raw_port, "current", "current_a", "currentA")),
        power_w=int(round(raw_power / 10.0)) if raw_power is not None else None,
        energy_total_raw=coerce_int(first_present(raw_port, "energy_total", "energyTotal")),
        energy_daily_raw=coerce_int(first_present(raw_port, "energy_daily", "energyDaily")),
        error_code=coerce_int(first_present(raw_port, "error_code", "errorCode")),
    )


def parse_legacy_hoymiles_port(raw_port: Any) -> HoymilesPortReading | None:
    """Parse one port row from the older get-real-data payload shape."""
    if not isinstance(raw_port, dict):
        return None

    serial_number = normalize_serial(first_present(raw_port, "pv_sn", "pvSn"))
    port_number = coerce_int(first_present(raw_port, "pv_port", "pvPort"))
    if port_number is None:
        return None

    raw_power = coerce_float(first_present(raw_port, "pv_power", "pvPower"))

    return HoymilesPortReading(
        serial_number=serial_number,
        port_number=port_number,
        voltage_v=scale_tenths(first_present(raw_port, "pv_vol", "pvVol")),
        current_a=scale_hundredths(first_present(raw_port, "pv_cur", "pvCur")),
        power_w=int(round(raw_power / 10.0)) if raw_power is not None else None,
        energy_total_raw=coerce_int(first_present(raw_port, "pv_energy_total", "pvEnergyTotal")),
        energy_daily_raw=coerce_int(first_present(raw_port, "pv_energy", "pvEnergy")),
        error_code=coerce_int(first_present(raw_port, "pv_fault_num", "pvFaultNum")),
    )


def parse_hoymiles_inverter(raw_inverter: Any, ports: list[HoymilesPortReading]) -> HoymilesInverterReading | None:
    if not isinstance(raw_inverter, dict):
        return None

    serial_number = normalize_serial(first_present(raw_inverter, "serial_number", "serialNumber"))
    active_power_raw = coerce_int(first_present(raw_inverter, "active_power", "activePower"))

    return HoymilesInverterReading(
        serial_number=serial_number,
        active_power_w=int(round(active_power_raw / 10.0)) if active_power_raw is not None else None,
        reactive_power_var=coerce_int(first_present(raw_inverter, "reactive_power", "reactivePower")),
        voltage_v=scale_tenths(first_present(raw_inverter, "voltage", "voltage_v", "voltageV")),
        current_a=scale_hundredths(first_present(raw_inverter, "current", "current_a", "currentA")),
        frequency_hz=scale_hundredths(first_present(raw_inverter, "frequency", "frequency_hz", "frequencyHz")),
        power_factor=scale_thousandths(first_present(raw_inverter, "power_factor", "powerFactor")),
        temperature_c=scale_tenths(first_present(raw_inverter, "temperature", "temperature_c", "temperatureC")),
        warning_number=coerce_int(first_present(raw_inverter, "warning_number", "warningNumber")),
        link_status=coerce_int(first_present(raw_inverter, "link_status", "linkStatus")),
        power_limit_w=coerce_int(first_present(raw_inverter, "power_limit", "powerLimit")),
        modulation_index_signal=coerce_int(
            first_present(raw_inverter, "modulation_index_signal", "modulationIndexSignal")
        ),
        ports=ports,
    )


def build_legacy_hoymiles_snapshot(payload: dict[str, Any]) -> HoymilesSnapshot:
    """Build a snapshot from the older get-real-data payload shape."""
    raw_ports = first_present(payload, "pv_data", "pvData") or []
    if not isinstance(raw_ports, list):
        raw_ports = []

    ports_by_serial: dict[str, list[HoymilesPortReading]] = defaultdict(list)
    port_sources_by_serial: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for raw_port in raw_ports:
        port = parse_legacy_hoymiles_port(raw_port)
        if port is None:
            continue
        ports_by_serial[port.serial_number].append(port)
        if isinstance(raw_port, dict):
            port_sources_by_serial[port.serial_number].append(raw_port)

    inverters: list[HoymilesInverterReading] = []
    total_active_power_w = 0
    daily_yield_wh = 0.0
    daily_yield_count = 0

    for serial_number, ports in ports_by_serial.items():
        ordered_ports = sorted(ports, key=lambda item: item.port_number)
        source_rows = port_sources_by_serial[serial_number]

        inverter_power_w = sum(port.power_w or 0 for port in ordered_ports)
        first_row = source_rows[0] if source_rows else {}
        warning_number = coerce_int(first_present(first_row, "pv_warning_cnt", "pvWarningCnt"))
        link_status = coerce_int(first_present(first_row, "pv_link_status", "pvLinkStatus"))
        grid_voltage_v = scale_tenths(first_present(first_row, "grid_vol", "gridVol"))
        grid_current_a = scale_hundredths(first_present(first_row, "grid_i", "gridI"))
        grid_frequency_hz = scale_hundredths(first_present(first_row, "grid_freq", "gridFreq"))
        grid_power_factor = scale_thousandths(first_present(first_row, "grid_pf", "gridPf"))
        pv_temperature_c = scale_tenths(first_present(first_row, "pv_temp", "pvTemp"))
        reactive_power_var = coerce_int(first_present(first_row, "grid_q", "gridQ"))
        modulation_index_signal = coerce_int(first_present(first_row, "mi_signal", "miSignal"))

        for port in ordered_ports:
            if port.energy_daily_raw is not None:
                daily_yield_wh += float(port.energy_daily_raw)
                daily_yield_count += 1

        inverters.append(
            HoymilesInverterReading(
                serial_number=serial_number,
                active_power_w=inverter_power_w if inverter_power_w > 0 else None,
                reactive_power_var=reactive_power_var,
                voltage_v=grid_voltage_v,
                current_a=grid_current_a,
                frequency_hz=grid_frequency_hz,
                power_factor=grid_power_factor,
                temperature_c=pv_temperature_c,
                warning_number=warning_number,
                link_status=link_status,
                power_limit_w=None,
                modulation_index_signal=modulation_index_signal,
                ports=ordered_ports,
            )
        )
        total_active_power_w += inverter_power_w

    timestamp_value = coerce_float(first_present(payload, "timestamp", "time"))
    timestamp = (
        datetime.fromtimestamp(timestamp_value, tz=timezone.utc).isoformat().replace("+00:00", "Z")
        if timestamp_value is not None
        else datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
    )
    device_serial_number = first_present(payload, "dtu_sn", "dtuSn")
    inverter_count = len(inverters)
    port_count = sum(len(inverter.ports) for inverter in inverters)
    root_error = payload.get("error")

    return HoymilesSnapshot(
        timestamp=timestamp,
        device_serial_number=str(device_serial_number) if device_serial_number is not None else None,
        status="OK" if inverter_count > 0 else "OFFLINE",
        error=str(root_error) if root_error else (None if inverter_count > 0 else "Hoymiles response did not include pvData"),
        total_active_power_w=total_active_power_w if inverter_count > 0 else None,
        daily_yield_wh=round(daily_yield_wh, 1) if daily_yield_count > 0 else None,
        inverter_count=inverter_count,
        port_count=port_count,
        inverters=inverters,
    )


def build_hoymiles_snapshot(payload: dict[str, Any]) -> HoymilesSnapshot:
    raw_inverters = first_present(payload, "sgs_data", "sgsData") or []
    raw_ports = first_present(payload, "pv_data", "pvData") or []
    if not raw_inverters and raw_ports:
        return build_legacy_hoymiles_snapshot(payload)
    if not isinstance(raw_inverters, list):
        raw_inverters = []
    if not isinstance(raw_ports, list):
        raw_ports = []
    device_serial_number = first_present(payload, "device_serial_number", "deviceSerialNumber")
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
    daily_yield_wh = 0.0
    daily_yield_count = 0
    inverter_count = 0
    port_count = 0

    for raw_inverter in raw_inverters:
        serial_number = normalize_serial(
            first_present(raw_inverter, "serial_number", "serialNumber")
            if isinstance(raw_inverter, dict)
            else None
        )
        ports = sorted(ports_by_serial.get(serial_number, []), key=lambda item: item.port_number)
        inverter = parse_hoymiles_inverter(raw_inverter, ports)
        if inverter is None:
            continue

        inverter_count += 1
        port_count += len(ports)
        if inverter.active_power_w is not None:
            total_active_power_w += inverter.active_power_w
        for port in ports:
            if port.energy_daily_raw is not None:
                daily_yield_wh += float(port.energy_daily_raw)
                daily_yield_count += 1
        inverters.append(inverter)

    # The DTU reports dtuPower in the same tenths-of-watts scale as inverter
    # activePower. Keep it as a fallback for partial responses.
    dtu_power_raw = coerce_float(first_present(payload, "dtu_power", "dtuPower"))
    if inverter_count == 0 and dtu_power_raw is not None:
        total_active_power_w = int(round(dtu_power_raw / 10.0))

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
        daily_yield_wh=round(daily_yield_wh, 1) if daily_yield_count > 0 else None,
        inverter_count=inverter_count,
        port_count=port_count,
        inverters=inverters,
    )


def build_offline_hoymiles_snapshot(message: str) -> HoymilesSnapshot:
    return HoymilesSnapshot(
        timestamp=datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
        device_serial_number=None,
        status="HARDWARE_OFFLINE",
        error=message,
        total_active_power_w=None,
        daily_yield_wh=None,
        inverter_count=0,
        port_count=0,
        inverters=[],
    )


def build_offline_meter_snapshot(message: str) -> MeterSnapshot:
    """Build the schema-compatible meter representation for an unavailable DTU."""
    return MeterSnapshot(
        timestamp=datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
        status="HARDWARE_OFFLINE",
        total_active_power_w=None,
        phase_a_voltage_v=None,
        error=message,
    )


def modbus_crc16(frame: bytes) -> int:
    """Return the Modbus RTU CRC-16 for a frame without its trailing CRC."""
    crc = 0xFFFF
    for byte in frame:
        crc ^= byte
        for _ in range(8):
            crc = (crc >> 1) ^ 0xA001 if crc & 1 else crc >> 1
    return crc & 0xFFFF


def valid_modbus_rtu_frame(frame: bytes) -> bool:
    """Validate standard Modbus RTU CRC bytes (low byte, then high byte)."""
    return len(frame) >= 4 and modbus_crc16(frame[:-2]) == int.from_bytes(frame[-2:], "little")


@dataclass
class SniffedMeterRequest:
    register: int
    count: int
    captured_at: float


class ModbusMeterSniffer:
    """Parse read-only Chint request/response frames from a noisy serial stream."""

    def __init__(self, slave_id: int) -> None:
        self.slave_id = slave_id
        self.buffer = bytearray()
        self.pending_requests: list[SniffedMeterRequest] = []
        self.total_active_power_w: Optional[int] = None
        self.phase_a_voltage_v: Optional[float] = None

    def _discard_expired_requests(self, now: float) -> None:
        self.pending_requests = [
            request for request in self.pending_requests if now - request.captured_at <= 2.0
        ]

    def _response_request_index(self, byte_count: int) -> Optional[int]:
        for index, request in enumerate(self.pending_requests):
            if request.count * 2 == byte_count:
                return index
        return None

    def _decode_response(
        self,
        request: SniffedMeterRequest,
        payload: bytes,
    ) -> Optional[MeterSnapshot]:
        """Apply a response payload to every target Float32 covered by its request."""
        updates = 0
        targets = (
            (METER_TOTAL_ACTIVE_POWER_REGISTER, "power"),
            (METER_PHASE_A_VOLTAGE_REGISTER, "voltage"),
        )
        for target_register, target_kind in targets:
            offset = (target_register - request.register) * 2
            if offset < 0 or offset + 4 > len(payload):
                continue
            value = struct.unpack(">f", payload[offset : offset + 4])[0]
            if not math.isfinite(value):
                continue
            if target_kind == "power":
                self.total_active_power_w = int(round(value * METER_POWER_SCALE))
            else:
                self.phase_a_voltage_v = round(value * METER_VOLTAGE_SCALE, 1)
            updates += 1

        if updates == 0:
            return None
        return MeterSnapshot(
            timestamp=datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
            status="OK",
            total_active_power_w=self.total_active_power_w,
            phase_a_voltage_v=self.phase_a_voltage_v,
            error=None,
        )

    def feed(self, chunk: bytes) -> tuple[list[MeterSnapshot], bool]:
        """Consume bytes and return decoded snapshots plus a valid-packet signal."""
        self.buffer.extend(chunk)
        snapshots: list[MeterSnapshot] = []
        saw_valid_packet = False
        now = time.monotonic()
        self._discard_expired_requests(now)

        while True:
            start = self.buffer.find(bytes((self.slave_id, 0x03)))
            if start < 0:
                # Preserve one byte only when it could be the next frame's ID.
                if self.buffer[-1:] == bytes((self.slave_id,)):
                    del self.buffer[:-1]
                else:
                    self.buffer.clear()
                break
            if start > 0:
                del self.buffer[:start]
            if len(self.buffer) < 8:
                break

            # A response can be identified unambiguously when its byte count
            # matches the oldest captured request. Check it before requests:
            # register 0x2000 starts with 0x20 and otherwise resembles a count.
            byte_count = self.buffer[2]
            request_index = self._response_request_index(byte_count)
            response_length = 3 + byte_count + 2
            if request_index is not None:
                # Windows can split a large Modbus response across reads.  A
                # matching request tells us exactly how long the response is,
                # so retain the complete partial frame until the next read.
                if len(self.buffer) < response_length:
                    break
                frame = bytes(self.buffer[:response_length])
                if valid_modbus_rtu_frame(frame):
                    request = self.pending_requests.pop(request_index)
                    del self.buffer[:response_length]
                    saw_valid_packet = True
                    snapshot = self._decode_response(request, frame[3:-2])
                    if snapshot is not None:
                        snapshots.append(snapshot)
                    continue
            request_frame = bytes(self.buffer[:8])
            if valid_modbus_rtu_frame(request_frame):
                register = int.from_bytes(request_frame[2:4], "big")
                count = int.from_bytes(request_frame[4:6], "big")
                if count > 0:
                    self.pending_requests.append(
                        SniffedMeterRequest(register=register, count=count, captured_at=now)
                    )
                    self.pending_requests = self.pending_requests[-8:]
                    saw_valid_packet = True
                    del self.buffer[:8]
                    continue

            # A complete invalid candidate cannot become valid by waiting for
            # more bytes, so move the sliding window forward one byte.
            del self.buffer[0]

        return snapshots, saw_valid_packet


async def meter_sniffer_loop(
    serial_port: str,
    baudrate: int,
    state_dict: dict[str, Any],
) -> None:
    """Continuously receive DTU↔meter traffic without ever writing to RS-485."""
    if serial is None:
        state_dict["value"] = build_offline_meter_snapshot("pyserial is not installed")
        relay_logger.error("Meter sniffer unavailable: pyserial is not installed")
        return

    parser = ModbusMeterSniffer(METER_SLAVE_ID)
    last_valid_packet_at = 0.0
    last_diagnostic_at = 0.0
    raw_byte_count = 0
    raw_sample = bytearray()
    stale_reported = False
    while True:
        port = None
        try:
            # timeout keeps read() bounded; no write is performed anywhere in
            # this loop, leaving the DTU as the only electrical bus master.
            port = serial.Serial(
                port=serial_port,
                baudrate=baudrate,
                bytesize=serial.EIGHTBITS,
                parity=serial.PARITY_NONE,
                stopbits=serial.STOPBITS_ONE,
                timeout=0.25,
                write_timeout=0,
            )
            relay_logger.info(
                "Passive meter sniffer listening on %s at %s-8N1 for slave %s",
                serial_port,
                baudrate,
                METER_SLAVE_ID,
            )
            while True:
                chunk = await asyncio.to_thread(port.read, max(port.in_waiting, 1))
                now = time.monotonic()
                if chunk:
                    raw_byte_count += len(chunk)
                    if len(raw_sample) < 96:
                        raw_sample.extend(chunk[: 96 - len(raw_sample)])
                    snapshots, saw_valid_packet = parser.feed(chunk)
                    if saw_valid_packet:
                        last_valid_packet_at = now
                        stale_reported = False
                    if snapshots:
                        state_dict["value"] = snapshots[-1]
                if raw_byte_count and now - last_diagnostic_at >= 10:
                    if now - last_valid_packet_at > 0.5:
                        relay_logger.warning(
                            "Passive sniffer received %s unrecognised RS-485 bytes; sample: %s",
                            raw_byte_count,
                            raw_sample.hex(" "),
                        )
                    raw_byte_count = 0
                    raw_sample.clear()
                    last_diagnostic_at = now
                if now - last_valid_packet_at > METER_SNIFFER_STALE_SECONDS:
                    previous = state_dict.get("value")
                    if previous is None or previous.status != "OFFLINE":
                        state_dict["value"] = MeterSnapshot(
                            timestamp=datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
                            status="OFFLINE",
                            total_active_power_w=None,
                            phase_a_voltage_v=None,
                            error=(
                                f"No valid Modbus RTU traffic from meter slave {METER_SLAVE_ID} "
                                f"for {METER_SNIFFER_STALE_SECONDS:.0f}s"
                            ),
                        )
                    if not stale_reported:
                        relay_logger.warning(
                            "Passive sniffer has not seen a valid request/response from slave %s in %.0fs",
                            METER_SLAVE_ID,
                            METER_SNIFFER_STALE_SECONDS,
                        )
                        stale_reported = True
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            state_dict["value"] = MeterSnapshot(
                timestamp=datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
                status="OFFLINE",
                total_active_power_w=None,
                phase_a_voltage_v=None,
                error=f"Passive meter sniffer error: {exc}",
            )
            relay_logger.error("Passive meter sniffer error: %s; retrying in 2s", exc)
            await asyncio.sleep(2)
        finally:
            if port is not None:
                with contextlib.suppress(Exception):
                    port.close()


def read_hoymiles_snapshot_sync(client=None) -> HoymilesSnapshot:
    """Read the Hoymiles DTU directly over Modbus TCP and build a structured snapshot."""
    owns_client = client is None
    if owns_client:
        client = create_hoymiles_modbus_client()
    try:
        if not getattr(client, "connected", False) and not client.connect():
            return build_offline_hoymiles_snapshot(
                f"Unable to connect to Hoymiles DTU at {HOYMILES_MODBUS_HOST}:{HOYMILES_MODBUS_PORT}"
            )

        errors: list[str] = []
        device_serial_number: Optional[str] = None

        try:
            dtu_registers = read_hoymiles_registers(
                client,
                start_address=HOYMILES_DTU_SERIAL_ADDRESS,
                count=HOYMILES_DTU_SERIAL_REGISTER_COUNT,
                unit_id=HOYMILES_MODBUS_UNIT_ID,
            )
            device_serial_number = b"".join(
                struct.pack(">H", register & 0xFFFF) for register in dtu_registers
            ).hex()
        except Exception as exc:
            errors.append(f"Hoymiles DTU serial read failed: {exc}")

        port_readings: list[HoymilesInverterReading] = []

        for chunk_start_port_index in range(0, HOYMILES_PORT_COUNT, HOYMILES_PORTS_PER_READ):
            chunk_port_count = min(
                HOYMILES_PORTS_PER_READ,
                HOYMILES_PORT_COUNT - chunk_start_port_index,
            )
            start_address = (
                HOYMILES_INVERTER_BASE_ADDRESS
                + chunk_start_port_index * HOYMILES_INVERTER_REGISTER_STRIDE
            )
            register_count = chunk_port_count * HOYMILES_INVERTER_REGISTER_STRIDE

            try:
                registers = read_hoymiles_registers(
                    client,
                    start_address=start_address,
                    count=register_count,
                    unit_id=HOYMILES_MODBUS_UNIT_ID,
                )
            except Exception as exc:
                if chunk_start_port_index == 0:
                    return build_offline_hoymiles_snapshot(
                        f"Hoymiles Modbus read failed at 0x{start_address:04X}: {exc}"
                    )
                errors.append(
                    f"Hoymiles Modbus read stopped at port {chunk_start_port_index + 1}: {exc}"
                )
                break

            for chunk_offset in range(chunk_port_count):
                block_start = chunk_offset * HOYMILES_INVERTER_REGISTER_STRIDE
                block_end = block_start + HOYMILES_INVERTER_REGISTER_STRIDE
                port_reading = decode_hoymiles_inverter_block(registers[block_start:block_end])
                if port_reading is None:
                    if not port_readings:
                        return build_offline_hoymiles_snapshot(
                            "Hoymiles Modbus response did not include port data"
                        )
                    break

                port_readings.append(port_reading)

            if len(port_readings) < chunk_start_port_index + chunk_port_count:
                break

            if chunk_start_port_index + chunk_port_count < HOYMILES_PORT_COUNT:
                time.sleep(max(0.0, HOYMILES_CHUNK_DELAY_SECONDS))

        inverters_by_serial: dict[str, HoymilesInverterReading] = {}
        for port_reading in port_readings:
            serial_number = port_reading.serial_number
            inverter = inverters_by_serial.get(serial_number)
            if inverter is None:
                inverter = HoymilesInverterReading(
                    serial_number=serial_number,
                    active_power_w=0,
                    reactive_power_var=port_reading.reactive_power_var,
                    voltage_v=port_reading.voltage_v,
                    current_a=port_reading.current_a,
                    frequency_hz=port_reading.frequency_hz,
                    power_factor=port_reading.power_factor,
                    temperature_c=port_reading.temperature_c,
                    warning_number=port_reading.warning_number,
                    link_status=port_reading.link_status,
                    power_limit_w=port_reading.power_limit_w,
                    modulation_index_signal=port_reading.modulation_index_signal,
                    ports=[],
                )
                inverters_by_serial[serial_number] = inverter

            inverter.active_power_w = (inverter.active_power_w or 0) + sum(
                port.power_w or 0 for port in port_reading.ports
            )
            inverter.link_status = max(inverter.link_status or 0, port_reading.link_status or 0)
            inverter.ports.extend(port_reading.ports)

        inverters = list(inverters_by_serial.values())
        total_active_power_w = sum(inverter.active_power_w or 0 for inverter in inverters)
        daily_yield_values = [
            port.energy_daily_raw
            for inverter in inverters
            for port in inverter.ports
            if port.energy_daily_raw is not None
        ]
        daily_yield_wh = sum(daily_yield_values)
        daily_yield_count = len(daily_yield_values)
        inverter_count = len(inverters)
        port_count = sum(len(inverter.ports) for inverter in inverters)
        error_message = "; ".join(errors) if errors else None

        return HoymilesSnapshot(
            timestamp=datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
            device_serial_number=device_serial_number,
            status="OK" if inverter_count > 0 else "OFFLINE",
            error=error_message if inverter_count > 0 else (
                error_message or "Hoymiles Modbus response did not include inverter data"
            ),
            total_active_power_w=total_active_power_w if inverter_count > 0 else None,
            daily_yield_wh=round(daily_yield_wh, 1) if daily_yield_count > 0 else None,
            inverter_count=inverter_count,
            port_count=port_count,
            inverters=inverters,
        )
    finally:
        if owns_client:
            with contextlib.suppress(Exception):
                client.close()


async def read_hoymiles_snapshot() -> HoymilesSnapshot:
    return await asyncio.to_thread(read_hoymiles_snapshot_sync)


async def hoymiles_refresh_loop(state_dict: dict[str, Any]) -> None:
    """Refresh only inverter data over Modbus TCP; meter data never uses TCP here."""
    while True:
        snapshot = await read_hoymiles_snapshot()
        state_dict["value"] = snapshot
        if snapshot.status == "OK":
            relay_logger.info(
                "Hoymiles Modbus TCP refresh -> %s W, %s inverters, %s ports",
                snapshot.total_active_power_w,
                snapshot.inverter_count,
                snapshot.port_count,
            )
        else:
            relay_logger.warning("Hoymiles Modbus TCP offline -> %s", snapshot.error or "unknown error")
        await asyncio.sleep(POLL_INTERVAL_SECONDS)


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
    home_consumption_w = solar_production_w + net_grid_w

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
        hoymiles_daily_yield_wh=hoymiles_snapshot.daily_yield_wh,
        hoymiles_inverter_count=hoymiles_snapshot.inverter_count,
        hoymiles_port_count=hoymiles_snapshot.port_count,
        net_grid_w=net_grid_w,
        phase_a_voltage_v=meter_phase_a_voltage_v,
        solar_production_w=solar_production_w,
        home_consumption_w=home_consumption_w,
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
        "solar_production_w": payload.solar_production_w,
        "phase_a_voltage_v": payload.meter_phase_a_voltage_v,
    }


def supabase_headers(prefer: str = "return=representation") -> dict[str, str]:
    """Return the common headers used by every Supabase REST request."""
    return {
        "apikey": SUPABASE_SERVICE_ROLE_KEY,
        "Authorization": f"Bearer {SUPABASE_SERVICE_ROLE_KEY}",
        "Content-Type": "application/json",
        "Accept": "application/json",
        "Prefer": prefer,
    }


def build_open_meteo_url() -> str:
    """Create the Open-Meteo current weather URL from local env coordinates."""
    return (
        "https://api.open-meteo.com/v1/forecast"
        f"?latitude={WEATHER_LATITUDE}"
        f"&longitude={WEATHER_LONGITUDE}"
        f"&current={OPEN_METEO_CURRENT_FIELDS}"
        "&timezone=UTC"
    )


def normalize_open_meteo_timestamp(value: Any) -> str:
    """Return a UTC ISO timestamp suitable for the Supabase primary key."""
    if not value:
        return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")

    text = str(value)
    if text.endswith("Z"):
        return text

    try:
        parsed = datetime.fromisoformat(text.replace("Z", "+00:00"))
        if parsed.tzinfo is None:
            parsed = parsed.replace(tzinfo=timezone.utc)
        return parsed.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")
    except ValueError:
        return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def build_weather_row(payload: dict[str, Any]) -> dict[str, int | float | str | None]:
    """Map Open-Meteo's current payload into the weather_snapshots row shape."""
    current = payload.get("current")
    if not isinstance(current, dict):
        raise ValueError("Open-Meteo response did not include current weather data")

    return {
        "timestamp": normalize_open_meteo_timestamp(current.get("time")),
        "temperature_2m": coerce_float(current.get("temperature_2m")),
        "cloud_cover": coerce_float(current.get("cloud_cover")),
        "cloud_cover_low": coerce_float(current.get("cloud_cover_low")),
        "cloud_cover_mid": coerce_float(current.get("cloud_cover_mid")),
        "cloud_cover_high": coerce_float(current.get("cloud_cover_high")),
        "shortwave_radiation": coerce_float(current.get("shortwave_radiation")),
        "direct_radiation": coerce_float(current.get("direct_radiation")),
        "diffuse_radiation": coerce_float(current.get("diffuse_radiation")),
        "wind_speed_10m": coerce_float(current.get("wind_speed_10m")),
        "precipitation": coerce_float(current.get("precipitation")),
    }


async def upsert_weather_snapshot(session: aiohttp.ClientSession, row: dict[str, int | float | str | None]) -> None:
    """Persist a single weather snapshot into Supabase without blocking Modbus reads."""
    if not NEXT_PUBLIC_SUPABASE_URL or not SUPABASE_SERVICE_ROLE_KEY:
        return

    url = (
        f"{NEXT_PUBLIC_SUPABASE_URL.rstrip('/')}/rest/v1/{SUPABASE_WEATHER_TABLE_NAME}"
        "?on_conflict=timestamp"
    )
    async with session.post(
        url,
        json=row,
        headers=supabase_headers("resolution=merge-duplicates,return=minimal"),
        timeout=aiohttp.ClientTimeout(total=SUPABASE_SYNC_TIMEOUT_SECONDS),
    ) as response:
        if response.status not in {200, 201, 204}:
            detail = await response.text()
            raise RuntimeError(f"Supabase weather upsert failed with {response.status}: {detail}")


async def poll_weather_once(session: aiohttp.ClientSession) -> dict[str, int | float | str | None]:
    """Fetch current weather from Open-Meteo and store it in Supabase."""
    if not WEATHER_LATITUDE or not WEATHER_LONGITUDE:
        raise RuntimeError("WEATHER_LATITUDE and WEATHER_LONGITUDE must be set to enable weather polling")

    async with session.get(
        build_open_meteo_url(),
        timeout=aiohttp.ClientTimeout(total=WEATHER_HTTP_TIMEOUT_SECONDS),
    ) as response:
        if response.status != 200:
            detail = await response.text()
            raise RuntimeError(f"Open-Meteo returned {response.status}: {detail}")
        payload = await response.json()

    row = build_weather_row(payload)
    await upsert_weather_snapshot(session, row)
    return row


async def weather_poll_loop(session: aiohttp.ClientSession) -> None:
    """Poll Open-Meteo every 15 minutes in a fully independent asyncio task."""
    if not WEATHER_LATITUDE or not WEATHER_LONGITUDE:
        relay_logger.warning("Weather polling disabled -> set WEATHER_LATITUDE and WEATHER_LONGITUDE")
        return

    if not NEXT_PUBLIC_SUPABASE_URL or not SUPABASE_SERVICE_ROLE_KEY:
        relay_logger.warning("Weather polling disabled -> Supabase credentials are missing")
        return

    while True:
        try:
            row = await poll_weather_once(session)
            relay_logger.info(
                "Weather sync ok %s -> %s C, clouds %s%%",
                row["timestamp"],
                row["temperature_2m"],
                row["cloud_cover"],
            )
        except Exception as exc:
            relay_logger.error("Weather sync failed: %s", exc)

        await asyncio.sleep(WEATHER_POLL_SECONDS)


def ping_dead_mans_snitch() -> None:
    """Best-effort heartbeat ping for the local relay process."""
    try:
        requests.get(DEAD_MANS_SNITCH_URL, timeout=DEAD_MANS_SNITCH_TIMEOUT_SECONDS)
    except Exception as exc:
        relay_logger.error("Dead Man's Snitch ping failed: %s", exc)


async def fetch_daily_summary(session: aiohttp.ClientSession, day: str) -> dict[str, Any] | None:
    url = f"{NEXT_PUBLIC_SUPABASE_URL.rstrip('/')}/rest/v1/{SUPABASE_DAILY_TABLE_NAME}"
    query = f"{url}?day=eq.{day}&select=day,imported_kwh,exported_kwh,solar_kwh,home_kwh,sample_count"
    async with session.get(
        query,
        headers=supabase_headers(),
        timeout=aiohttp.ClientTimeout(total=SUPABASE_SYNC_TIMEOUT_SECONDS),
    ) as response:
        if response.status != 200:
            detail = await response.text()
            raise RuntimeError(f"Supabase daily summary lookup failed with {response.status}: {detail}")
        payload = await response.json()

    if isinstance(payload, list) and payload:
        return payload[0]

    return None


async def sync_supabase_daily_summary(session: aiohttp.ClientSession, batch: CloudBatchState) -> None:
    """Update one relay-local daily aggregate row after each cloud batch flush."""
    existing = await fetch_daily_summary(session, batch.local_day)

    def existing_number(key: str) -> float:
        value = existing.get(key) if existing else None
        parsed = coerce_float(value)
        return parsed if parsed is not None else 0.0

    def existing_int(key: str) -> int:
        value = existing.get(key) if existing else None
        parsed = coerce_int(value)
        return parsed if parsed is not None else 0

    row = {
        "day": batch.local_day,
        "imported_kwh": round(existing_number("imported_kwh") + batch.imported_wh / 1000, 3),
        "exported_kwh": round(existing_number("exported_kwh") + batch.exported_wh / 1000, 3),
        "solar_kwh": round(existing_number("solar_kwh") + batch.solar_wh / 1000, 3),
        "home_kwh": round(existing_number("home_kwh") + batch.home_wh / 1000, 3),
        "sample_count": existing_int("sample_count") + batch.sample_count,
        "updated_at": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
    }

    url = f"{NEXT_PUBLIC_SUPABASE_URL.rstrip('/')}/rest/v1/{SUPABASE_DAILY_TABLE_NAME}?on_conflict=day"
    async with session.post(
        url,
        json=row,
        headers=supabase_headers("resolution=merge-duplicates,return=minimal"),
        timeout=aiohttp.ClientTimeout(total=SUPABASE_SYNC_TIMEOUT_SECONDS),
    ) as response:
        if response.status not in {200, 201, 204}:
            detail = await response.text()
            raise RuntimeError(f"Supabase daily summary upsert failed with {response.status}: {detail}")


async def sync_supabase_batch(session: aiohttp.ClientSession, batch: CloudBatchState) -> None:
    """POST one aggregated batch row to Supabase."""
    if not NEXT_PUBLIC_SUPABASE_URL or not SUPABASE_SERVICE_ROLE_KEY:
        return

    average_watts = int(round(batch.net_grid_sum_w / max(batch.sample_count, 1)))
    average_solar_watts = (
        int(round(batch.solar_sum_w / batch.solar_sample_count))
        if batch.solar_sample_count > 0
        else None
    )
    average_voltage = (
        round(batch.voltage_sum_v / batch.voltage_sample_count, 1)
        if batch.voltage_sample_count > 0
        else None
    )

    row = {
        "timestamp": batch.bucket_start,
        "sample_count": batch.sample_count,
        "net_grid_w": average_watts,
        "solar_production_w": average_solar_watts,
        "phase_a_voltage_v": average_voltage,
    }

    batch_url = f"{NEXT_PUBLIC_SUPABASE_URL.rstrip('/')}/rest/v1/{SUPABASE_TABLE_NAME}?on_conflict=timestamp"

    try:
        relay_logger.info(
            "Supabase batch flush %s (%s samples)...",
            batch.bucket_start,
            batch.sample_count,
        )
        async with session.post(
            batch_url,
            json=row,
            headers=supabase_headers("resolution=merge-duplicates,return=minimal"),
            timeout=aiohttp.ClientTimeout(total=SUPABASE_SYNC_TIMEOUT_SECONDS),
        ) as response:
            if response.status not in {200, 201, 204}:
                detail = await response.text()
                raise RuntimeError(f"Supabase batch upsert failed with {response.status}: {detail}")
        await sync_supabase_daily_summary(session, batch)
        relay_logger.info(
            "Supabase batch ok %s (%s samples)",
            batch.bucket_start,
            batch.sample_count,
        )
    except (aiohttp.ClientError, asyncio.TimeoutError, RuntimeError) as exc:
        relay_logger.error("Supabase batch failed %s: %s", batch.bucket_start, exc)


async def sync_supabase_port_rows(
    session: aiohttp.ClientSession,
    rows: list[dict[str, int | float | str]],
) -> None:
    """Upsert non-zero Hoymiles port telemetry for one cloud batch."""
    if not rows or not NEXT_PUBLIC_SUPABASE_URL or not SUPABASE_SERVICE_ROLE_KEY:
        return

    port_url = (
        f"{NEXT_PUBLIC_SUPABASE_URL.rstrip('/')}/rest/v1/{SUPABASE_PORT_TABLE_NAME}"
        "?on_conflict=timestamp,inverter_serial,port_number"
    )

    try:
        async with session.post(
            port_url,
            json=rows,
            headers=supabase_headers("resolution=merge-duplicates,return=minimal"),
            timeout=aiohttp.ClientTimeout(total=SUPABASE_SYNC_TIMEOUT_SECONDS),
        ) as response:
            if response.status not in {200, 201, 204}:
                detail = await response.text()
                raise RuntimeError(
                    f"Supabase port telemetry upsert failed with status {response.status}: {detail}"
                )

        relay_logger.info("Supabase port telemetry ok (%s rows)", len(rows))
    except (aiohttp.ClientError, asyncio.TimeoutError, RuntimeError) as exc:
        relay_logger.error("Supabase port telemetry failed: %s", exc)


async def flush_cloud_batch(session: aiohttp.ClientSession, batch: Optional[CloudBatchState]) -> None:
    if batch is None or (batch.sample_count == 0 and not batch.port_rows):
        return

    if batch.sample_count > 0:
        await sync_supabase_batch(session, batch)
    await sync_supabase_port_rows(session, batch.port_rows)


def queue_cloud_batch_flush(
    session: aiohttp.ClientSession,
    batch: CloudBatchState,
    pending_tasks: set[asyncio.Task[None]],
) -> None:
    """Upload a completed batch without delaying the Modbus polling loop."""
    task = asyncio.create_task(flush_cloud_batch(session, batch))
    pending_tasks.add(task)
    task.add_done_callback(pending_tasks.discard)


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


def advance_cloud_batch(
    session: aiohttp.ClientSession,
    current_batch: Optional[CloudBatchState],
    payload: UnifiedRelayPayload,
    hoymiles_snapshot: HoymilesSnapshot | None,
    pending_sync_tasks: set[asyncio.Task[None]],
) -> CloudBatchState | None:
    """Aggregate grid, voltage, and solar readings into a cloud batch."""
    if not NEXT_PUBLIC_SUPABASE_URL or not SUPABASE_SERVICE_ROLE_KEY:
        return current_batch

    if payload.meter_total_active_power_w is None:
        return current_batch

    bucket_start = bucket_start_for_timestamp(payload.timestamp, SUPABASE_BATCH_MINUTES)
    local_day = local_day_for_timestamp(payload.timestamp)
    batch = current_batch

    if batch is None:
        batch = CloudBatchState(bucket_start=bucket_start, local_day=local_day)
    elif batch.bucket_start != bucket_start:
        queue_cloud_batch_flush(session, batch, pending_sync_tasks)
        batch = CloudBatchState(bucket_start=bucket_start, local_day=local_day)

    batch.add_sample(
        payload.meter_total_active_power_w,
        payload.meter_phase_a_voltage_v,
        payload.solar_production_w,
        payload.home_consumption_w,
    )
    if hoymiles_snapshot is not None:
        batch.add_hoymiles_snapshot(hoymiles_snapshot)
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
            "The Hoymiles DTU is offline or its attached meter is unavailable. "
            "Check DTU Ethernet connectivity, DTU power, and the DTU-to-meter RS-485 link."
        ),
    )


def describe_cloud_sync() -> str:
    """Return a short human-readable cloud sync status for startup logs."""
    if not NEXT_PUBLIC_SUPABASE_URL or not SUPABASE_SERVICE_ROLE_KEY:
        return "Cloud sync disabled"

    host = urlparse(NEXT_PUBLIC_SUPABASE_URL).netloc or NEXT_PUBLIC_SUPABASE_URL
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


def describe_weather_sync() -> str:
    """Return a short human-readable weather sync status for startup logs."""
    if not WEATHER_LATITUDE or not WEATHER_LONGITUDE:
        return "Weather sync disabled -> set WEATHER_LATITUDE and WEATHER_LONGITUDE"
    if not NEXT_PUBLIC_SUPABASE_URL or not SUPABASE_SERVICE_ROLE_KEY:
        return "Weather sync disabled -> Supabase credentials are missing"

    return (
        f"Weather sync enabled -> provider api.open-meteo.com, "
        f"table {SUPABASE_WEATHER_TABLE_NAME}, poll {WEATHER_POLL_SECONDS:.0f}s"
    )


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
    if ModbusTcpClient is None:
        raise RuntimeError("pymodbus is missing. Install bridge dependencies first.")

    connected_clients: set[WebSocketServerProtocol] = set()
    log_queue: asyncio.Queue[dict[str, str]] = asyncio.Queue(maxsize=100)
    configure_logging(asyncio.get_running_loop(), log_queue)

    latest_message: dict[str, str | None] = {"value": None}
    failure_count = 0
    pending_cloud_batch: Optional[CloudBatchState] = None
    pending_cloud_sync_tasks: set[asyncio.Task[None]] = set()
    latest_meter_snapshot: dict[str, MeterSnapshot] = {
        "value": build_offline_meter_snapshot("Awaiting passive RS-485 meter traffic")
    }
    latest_hoymiles_snapshot: dict[str, HoymilesSnapshot] = {
        "value": build_offline_hoymiles_snapshot("Awaiting first Modbus TCP poll")
    }

    async def handler(websocket: WebSocketServerProtocol) -> None:
        await client_handler(websocket, connected_clients, latest_message)

    async with websockets.serve(handler, HOST, PORT):
        http_session = aiohttp.ClientSession()
        relay_logger.info(
            "DTU Modbus TCP relay listening on ws://%s:%s",
            HOST,
            PORT,
        )
        relay_logger.info(
            "Hoymiles DTU TCP -> %s:%s, unit %s, poll %.1fs",
            HOYMILES_MODBUS_HOST,
            HOYMILES_MODBUS_PORT,
            HOYMILES_MODBUS_UNIT_ID,
            POLL_INTERVAL_SECONDS,
        )
        relay_logger.info(
            "Chint meter -> passive-only RS-485 capture on %s at %s-8N1, slave %s",
            SERIAL_PORT,
            SERIAL_BAUDRATE,
            METER_SLAVE_ID,
        )
        relay_logger.info(describe_cloud_sync())
        relay_logger.info(describe_csv_logging())
        relay_logger.info(describe_weather_sync())

        log_task = asyncio.create_task(broadcast_logs(log_queue, connected_clients))
        meter_sniffer_task = asyncio.create_task(
            meter_sniffer_loop(SERIAL_PORT, SERIAL_BAUDRATE, latest_meter_snapshot)
        )
        hoymiles_task = asyncio.create_task(hoymiles_refresh_loop(latest_hoymiles_snapshot))
        weather_task = asyncio.create_task(weather_poll_loop(http_session))

        try:
            while True:
                try:
                    meter_snapshot = latest_meter_snapshot["value"]
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
                    pending_cloud_batch = advance_cloud_batch(
                        http_session,
                        pending_cloud_batch,
                        payload,
                        hoymiles_snapshot,
                        pending_cloud_sync_tasks,
                    )

                    if payload.bridge_status == "HARDWARE_OFFLINE":
                        failure_count += 1
                    else:
                        failure_count = 0
                    relay_logger.info(
                        "meter %s W%s%s%s",
                        payload.net_grid_w,
                        (
                            f" | hoymiles total {payload.solar_production_w} W"
                            if payload.hoymiles_status == "OK"
                            else " | hoymiles offline"
                        ),
                        (
                            f" | inverters {payload.hoymiles_inverter_count}"
                            if payload.hoymiles_status == "OK"
                            else ""
                        ),
                        (
                            f" | phase A {payload.phase_a_voltage_v:.1f} V"
                            if payload.phase_a_voltage_v is not None
                            else ""
                        ),
                    )
                    await asyncio.to_thread(ping_dead_mans_snitch)

                    if payload.bridge_status == "HARDWARE_OFFLINE" and failure_count >= OFFLINE_FAILURE_THRESHOLD:
                        offline_message = status_payload_to_json(
                            build_offline_status_payload(failure_count)
                        )
                        latest_message["value"] = offline_message
                        await broadcast(connected_clients, offline_message)
                        failure_count = 0

                except Exception as exc:
                    failure_count += 1
                    relay_logger.error("Relay hiccup: %s", exc)
                    if failure_count >= OFFLINE_FAILURE_THRESHOLD:
                        offline_message = status_payload_to_json(
                            build_offline_status_payload(failure_count)
                        )
                        latest_message["value"] = offline_message
                        await broadcast(connected_clients, offline_message)
                        failure_count = 0

                await asyncio.sleep(POLL_INTERVAL_SECONDS)
        finally:
            log_task.cancel()
            meter_sniffer_task.cancel()
            hoymiles_task.cancel()
            weather_task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await log_task
            with contextlib.suppress(asyncio.CancelledError):
                await meter_sniffer_task
            with contextlib.suppress(asyncio.CancelledError):
                await hoymiles_task
            with contextlib.suppress(asyncio.CancelledError):
                await weather_task
            if pending_cloud_sync_tasks:
                await asyncio.gather(*pending_cloud_sync_tasks)
            await flush_cloud_batch(http_session, pending_cloud_batch)
            await http_session.close()


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        relay_logger.info("Relay stopped by user.")
