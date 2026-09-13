import asyncio
import importlib.util
import os
import sys
import types
import unittest
from pathlib import Path
from unittest.mock import patch


BRIDGE_DIR = Path(__file__).parents[1] / "bridge"
RELAY_PATH = BRIDGE_DIR / "modbus_ws_relay.py"


class FakeResponse:
    def __init__(self, status=201, payload=None):
        self.status = status
        self._payload = payload if payload is not None else []

    async def __aenter__(self):
        return self

    async def __aexit__(self, *args):
        return False

    async def text(self):
        return "" if self.status in (200, 201, 204) else "boom"

    async def json(self):
        return self._payload


class FakeSession:
    """Minimal aiohttp stand-in recording every REST call."""

    def __init__(self, fail_url_substrings=()):
        self.calls = []
        self.fail_url_substrings = tuple(fail_url_substrings)

    def _record(self, method, url, **kwargs):
        self.calls.append((method, url, kwargs.get("json")))
        if any(s in url for s in self.fail_url_substrings):
            return FakeResponse(status=500)
        # PostgREST answers GET reads with 200 and POST upserts with 201.
        return FakeResponse(status=200 if method == "GET" else 201)

    def post(self, url, **kwargs):
        return self._record("POST", url, **kwargs)

    def get(self, url, **kwargs):
        return self._record("GET", url, **kwargs)


def _stub_third_party():
    aiohttp = types.ModuleType("aiohttp")
    aiohttp.ClientSession = object
    aiohttp.ClientTimeout = lambda **kwargs: object()  # noqa: E731
    aiohttp.ClientError = type("ClientError", (Exception,), {})
    sys.modules.setdefault("aiohttp", aiohttp)

    websockets = types.ModuleType("websockets")
    ws_server = types.ModuleType("websockets.server")
    ws_server.WebSocketServerProtocol = object
    sys.modules.setdefault("websockets", websockets)
    sys.modules.setdefault("websockets.server", ws_server)

    pymodbus = types.ModuleType("pymodbus")
    pm_client = types.ModuleType("pymodbus.client")
    pm_client.ModbusTcpClient = object
    pm_pdu = types.ModuleType("pymodbus.pdu")
    pm_msg = types.ModuleType("pymodbus.pdu.register_message")
    pm_msg.ReadHoldingRegistersResponse = object
    sys.modules.setdefault("pymodbus", pymodbus)
    sys.modules.setdefault("pymodbus.client", pm_client)
    sys.modules.setdefault("pymodbus.pdu", pm_pdu)
    sys.modules.setdefault("pymodbus.pdu.register_message", pm_msg)

    requests = types.ModuleType("requests")
    requests.get = lambda *args, **kwargs: None
    sys.modules.setdefault("requests", requests)

    ev_stub = types.ModuleType("ev_wall_connector")
    ev_stub.run_ev_poll_loop = lambda **kwargs: None
    ev_stub.describe_ev_sync = lambda: "EV stub"
    sys.modules.setdefault("ev_wall_connector", ev_stub)


def load_relay_module():
    _stub_third_party()
    spec = importlib.util.spec_from_file_location("test_universal_relay_module", RELAY_PATH)
    if spec is None or spec.loader is None:
        raise RuntimeError("Unable to load relay module")
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


DUAL_MODULE_ENV = {
    "HOME_SUPABASE_URL": "https://home.example.supabase.co",
    "HOME_SUPABASE_SERVICE_KEY": "home-key",
    "SOLAR_SUPABASE_URL": "https://solar.example.supabase.co",
    "SOLAR_SUPABASE_SERVICE_KEY": "solar-key",
}


def dual_targets(relay):
    """Patch module-level env constants (read once at import) for dual-write."""
    return patch.multiple(relay, **DUAL_MODULE_ENV)

GATEWAY_KEYS = [
    "bridge_status",
    "timestamp",
    "solar_production_w",
    "net_grid_w",
    "home_consumption_w",
    "phase_a_voltage_v",
    "hoymiles_daily_yield_wh",
    "meter_error",
    "hoymiles_error",
]


class DualWriteTest(unittest.TestCase):
    def run_async(self, coro):
        loop = asyncio.new_event_loop()
        try:
            return loop.run_until_complete(coro)
        finally:
            loop.close()

    def test_table_maps(self):
        relay = load_relay_module()
        with dual_targets(relay):
            targets = relay.build_cloud_targets()
        by_name = {t.name: t for t in targets}
        self.assertEqual(
            (by_name["home"].meter_table, by_name["home"].daily_table,
             by_name["home"].port_table, by_name["home"].weather_table),
            ("energy_meter_readings", "energy_daily_summary",
             "energy_inverter_port_readings", "energy_weather_snapshots"),
        )
        self.assertEqual(
            (by_name["solar"].meter_table, by_name["solar"].daily_table,
             by_name["solar"].port_table, by_name["solar"].weather_table),
            ("meter_readings", "daily_energy_summary",
             "inverter_port_readings", "weather_snapshots"),
        )

    def test_batch_fans_out_to_both_projects(self):
        relay = load_relay_module()
        with dual_targets(relay):
            targets = relay.build_cloud_targets()
        session = FakeSession()
        batch = relay.CloudBatchState(bucket_start="2026-09-13T10:00:00Z", local_day="2026-09-13")
        batch.add_sample(1200, 242.0, 3000, 4200)
        self.run_async(relay.sync_supabase_batch(session, targets[0], batch, with_daily=False))
        self.run_async(relay.sync_supabase_batch(session, targets[1], batch, with_daily=False))
        posted = [url for method, url, _ in session.calls if method == "POST"]
        self.assertTrue(any("home.example" in url and "energy_meter_readings" in url for url in posted))
        self.assertTrue(any("solar.example" in url and "/meter_readings" in url for url in posted))

    def test_one_target_failing_leaves_other_intact(self):
        relay = load_relay_module()
        with dual_targets(relay):
            targets = relay.build_cloud_targets()
        session = FakeSession(fail_url_substrings=("home.example",))
        batch = relay.CloudBatchState(bucket_start="2026-09-13T10:00:00Z", local_day="2026-09-13")
        batch.add_sample(1200, 242.0, 3000, 4200)
        # Must not raise: per-target isolation keeps the solar write alive.
        self.run_async(relay.flush_cloud_batch(session, targets, batch))
        posted = [url for method, url, _ in session.calls if method == "POST"]
        self.assertTrue(any("solar.example" in url for url in posted))

    def test_shadow_mode_skips_solar_daily_rollup(self):
        relay = load_relay_module()
        with dual_targets(relay):
            targets = relay.build_cloud_targets()
        session = FakeSession()
        batch = relay.CloudBatchState(bucket_start="2026-09-13T10:00:00Z", local_day="2026-09-13")
        batch.add_sample(1200, 242.0, 3000, 4200)
        with patch.object(relay, "UNIVERSAL_SHADOW_MODE", True):
            self.run_async(relay.flush_cloud_batch(session, targets, batch))
        gets = [url for method, url, _ in session.calls if method == "GET"]
        self.assertTrue(any("home.example" in url and "energy_daily_summary" in url for url in gets))
        self.assertFalse(any("solar.example" in url and "daily_energy_summary" in url for url in gets))


class PayloadCompatTest(unittest.TestCase):
    def test_universal_payload_serves_gateway_and_hooks(self):
        relay = load_relay_module()
        meter = relay.build_offline_meter_snapshot("test")
        hoymiles = relay.build_offline_hoymiles_snapshot("test")
        payload, message = relay.build_payload_message(
            meter, hoymiles, ev_block={"charger_status": "online"}
        )
        import json

        merged = json.loads(message)
        for key in GATEWAY_KEYS:
            self.assertIn(key, merged, f"gateway/hook key missing: {key}")
        self.assertEqual(merged["ev"], {"charger_status": "online"})


class HardwareDisciplineTest(unittest.TestCase):
    def test_no_active_serial_client(self):
        source = RELAY_PATH.read_text(encoding="utf-8")
        self.assertNotIn("AsyncModbusSerialClient", source)
        self.assertIn("class ModbusMeterSniffer", source)

    def test_charger_http_only_in_poller(self):
        for path in BRIDGE_DIR.glob("*.py"):
            source = path.read_text(encoding="utf-8")
            if path.name == "ev_wall_connector.py":
                continue
            self.assertNotIn("/api/1/vitals", source, path.name)
            self.assertNotIn("/api/1/lifetime", source, path.name)

    def test_legacy_single_pair_credentials_unread(self):
        source = RELAY_PATH.read_text(encoding="utf-8")
        self.assertNotIn('os.getenv("NEXT_PUBLIC_SUPABASE_URL"', source)
        self.assertNotIn('os.getenv("SUPABASE_SERVICE_ROLE_KEY"', source)


if __name__ == "__main__":
    unittest.main(verbosity=2)
