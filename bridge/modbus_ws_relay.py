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
import json
import os
import struct
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


HOST = os.getenv("BRIDGE_HOST", "127.0.0.1")
PORT = int(os.getenv("BRIDGE_PORT", "8787"))
SERIAL_PORT = os.getenv("SERIAL_PORT", "/dev/cu.usbserial-BH002YZD")
BAUDRATE = int(os.getenv("MODBUS_BAUDRATE", "9600"))
SLAVE_ID = int(os.getenv("MODBUS_SLAVE_ID", "1"))
CSV_LOG_PATH = os.getenv("CSV_LOG_PATH")


@dataclass
class RelayPayload:
    timestamp: str
    net_grid_w: int
    phase_a_voltage_v: Optional[float] = None


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


def read_float_register(client, address: int) -> float:
    """Read a two-register float from the meter and return the decoded value."""
    result = client.read_holding_registers(address=address, count=2, slave=SLAVE_ID)
    if result.isError():
        raise RuntimeError(f"Modbus error while reading register {address}")

    return decode_float32_be(result.registers)


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
    """Optional CSV sink that mirrors your original logging script."""
    if not CSV_LOG_PATH:
        return

    path = Path(CSV_LOG_PATH)
    path.parent.mkdir(parents=True, exist_ok=True)

    write_header = not path.exists() or path.stat().st_size == 0
    with path.open("a", newline="") as file:
        writer = csv.writer(file)
        if write_header:
            writer.writerow(["Timestamp", "Net Grid Power (W)", "Phase A Voltage (V)"])
        writer.writerow([payload.timestamp, payload.net_grid_w, payload.phase_a_voltage_v])


def payload_to_json(payload: RelayPayload) -> str:
    """Serialize the payload and omit any empty optional values."""
    data = asdict(payload)
    return json.dumps({key: value for key, value in data.items() if value is not None})


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

    async def handler(websocket: WebSocketServerProtocol) -> None:
        await client_handler(websocket, connected_clients, latest_message)

    async with websockets.serve(handler, HOST, PORT):
        print(
            f"Modbus relay listening on ws://{HOST}:{PORT} "
            f"(serial: {SERIAL_PORT}, baud: {BAUDRATE}, slave: {SLAVE_ID})"
        )

        try:
            while True:
                try:
                    payload = await asyncio.to_thread(build_payload, client)
                    message = payload_to_json(payload)
                    latest_message["value"] = message
                    write_csv_row(payload)
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
                    print(f"[{datetime.now().strftime('%H:%M:%S')}] Relay hiccup: {exc}")
                    client.close()
                    await asyncio.sleep(1)
                    client = create_modbus_client()
                    if not client.connect():
                        print(
                            f"[{datetime.now().strftime('%H:%M:%S')}] "
                            f"Reconnection failed. Retrying in 1s..."
                        )
                        await asyncio.sleep(1)
                        continue

                await asyncio.sleep(1)
        finally:
            client.close()


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        print("\nRelay stopped by user.")
