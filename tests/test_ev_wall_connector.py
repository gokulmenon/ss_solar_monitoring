import asyncio
import importlib.util
import sys
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest.mock import patch


MODULE_PATH = Path(__file__).parents[1] / "bridge" / "ev_wall_connector.py"


def make_test_sink(csv_dir):
    return evc.EVSink(
        label="test",
        supabase_url="",
        supabase_key="",
        sessions_table="energy_ev_sessions",
        snapshots_table="energy_ev_vitals_snapshots",
        csv_backup_dir=csv_dir,
    )


def load_poller_module():
    spec = importlib.util.spec_from_file_location("test_ev_poller_module", MODULE_PATH)
    if spec is None or spec.loader is None:
        raise RuntimeError("Unable to load poller module")
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


evc = load_poller_module()

REAL_VITALS = {
    "contactor_closed": False, "vehicle_connected": True, "session_s": 46866,
    "grid_v": 242.4, "grid_hz": 59.813, "vehicle_current_a": 0.0,
    "pcba_temp_c": 26.2, "handle_temp_c": 24.9, "mcu_temp_c": 32.5,
    "session_energy_wh": 43120.0, "evse_state": 4, "current_alerts": [],
}

REAL_LIFETIME = {
    "contactor_cycles": 155, "charge_starts": 155, "energy_wh": 1241740,
    "connector_cycles": 78, "uptime_s": 30346114, "charging_time_s": 605770,
}


def charging_vitals(session_s, energy_wh, current=32.0):
    return evc.EVVitals(
        contactor_closed=True, vehicle_connected=True, session_s=session_s,
        session_energy_wh=energy_wh, vehicle_current_a=current,
        grid_v=242.0, handle_temp_c=28.0, pcba_temp_c=30.0,
    )


def idle_vitals():
    return evc.EVVitals(contactor_closed=False, vehicle_connected=True,
                        session_s=0.0, session_energy_wh=0.0)


def unplugged_vitals():
    return evc.EVVitals(contactor_closed=False, vehicle_connected=False)


class ParsingTest(unittest.TestCase):
    def test_real_vitals_sample(self):
        v = evc.parse_vitals(REAL_VITALS)
        self.assertFalse(v.contactor_closed)
        self.assertTrue(v.vehicle_connected)
        self.assertAlmostEqual(v.session_energy_wh, 43120.0)
        self.assertEqual(v.evse_state, 4)

    def test_real_lifetime_sample(self):
        lt = evc.parse_lifetime(REAL_LIFETIME)
        self.assertAlmostEqual(lt.energy_wh, 1241740)

    def test_adaptive_intervals(self):
        self.assertEqual(evc.select_poll_interval(charging_vitals(10, 100)), 15)
        self.assertEqual(evc.select_poll_interval(idle_vitals()), 60)
        self.assertEqual(evc.select_poll_interval(unplugged_vitals()), 180)
        self.assertEqual(evc.select_poll_interval(None), 180)


class TrackerTest(unittest.TestCase):
    def run_session(self, energies, step_s=15):
        tr = evc.EVSessionTracker(debounce_polls=2)
        now = datetime.now(timezone.utc)
        result = None
        for i, energy in enumerate(energies):
            now = now + timedelta(seconds=step_s)
            result = tr.observe(now, charging_vitals(100 + i * step_s, energy))
            self.assertIsNone(result)
        for _ in range(2):
            now = now + timedelta(seconds=step_s)
            out = tr.observe(now, idle_vitals())
            if out is not None:
                result = out
        return result

    def test_final_value_capture(self):
        energies = [i * 180.0 for i in range(1, 31)]
        result = self.run_session(energies)
        self.assertIsNotNone(result)
        self.assertEqual(result.kind, "closed")
        self.assertAlmostEqual(result.session.energy_wh, energies[-1])

    def test_debounce_single_blip(self):
        tr = evc.EVSessionTracker(debounce_polls=2)
        now = datetime.now(timezone.utc)
        tr.observe(now, charging_vitals(100, 5000))
        self.assertIsNone(tr.observe(now + timedelta(seconds=15), idle_vitals()))
        self.assertTrue(tr.in_session)

    def test_nuisance_low_energy(self):
        result = self.run_session([10.0, 20.0, 30.0, 40.0, 50.0])
        self.assertEqual(result.kind, "discarded")
        self.assertIn("Wh", result.reason)

    def test_nuisance_short_duration(self):
        tr = evc.EVSessionTracker(debounce_polls=1)
        now = datetime.now(timezone.utc)
        tr.observe(now, charging_vitals(5, 5000))
        out = tr.observe(now + timedelta(seconds=20), idle_vitals())
        self.assertEqual(out.kind, "discarded")
        self.assertIn("duration", out.reason)

    def test_exact_boundaries_kept(self):
        tr = evc.EVSessionTracker(debounce_polls=1)
        t0 = datetime.now(timezone.utc)
        tr.observe(t0 - timedelta(seconds=61), charging_vitals(1, 100.0))
        out = tr.observe(t0, idle_vitals())
        self.assertEqual(out.kind, "closed")

    def test_restart_mid_session(self):
        tr = evc.EVSessionTracker(debounce_polls=2)
        now = datetime.now(timezone.utc)
        tr.observe(now, charging_vitals(3600, 30000))
        tr.observe(now + timedelta(seconds=15), charging_vitals(3615, 30200))
        tr2 = evc.EVSessionTracker()
        tr2.load_state(tr.to_state())
        self.assertTrue(tr2.in_session)
        later = now + timedelta(seconds=30)
        self.assertIsNone(tr2.observe(later, charging_vitals(3630, 30400)))
        self.assertIsNone(tr2.observe(later + timedelta(seconds=15), idle_vitals()))
        out = tr2.observe(later + timedelta(seconds=30), idle_vitals())
        self.assertEqual(out.kind, "closed")
        self.assertAlmostEqual(out.session.energy_wh, 30400.0)

    def test_charger_reboot_resets_session_s(self):
        tr = evc.EVSessionTracker(debounce_polls=2)
        now = datetime.now(timezone.utc)
        tr.observe(now, charging_vitals(7200, 20000))
        out = tr.observe(now + timedelta(seconds=15), charging_vitals(12, 20100))
        self.assertIsNone(out)
        self.assertTrue(tr.in_session)


class PollerTest(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)

    def make_poller(self, fetch_json, **kwargs):
        kwargs.setdefault("state_path", str(Path(self.tmp.name) / "state.json"))
        kwargs.setdefault(
            "sinks", [make_test_sink(str(Path(self.tmp.name) / "csv"))]
        )
        return evc.EVWallConnectorPoller(fetch_json=fetch_json, **kwargs)

    async def test_offline_flag_and_quiet_logs(self):
        async def boom(url):
            raise evc.EVChargerError("timeout")

        with self.assertLogs("ev_wall_connector", level="WARNING") as logs:
            poller = self.make_poller(boom)
            b1 = await poller.poll_once()
            b2 = await poller.poll_once()
        self.assertEqual(b1["charger_status"], "offline")
        self.assertEqual(b2["charger_status"], "offline")
        warnings = [r for r in logs.records if r.levelno >= 30]
        self.assertEqual(len(warnings), 1)
        self.assertEqual(poller.next_interval(), 60)

    async def test_full_session_flow_block_rows_and_csv(self):
        script = [
            {"contactor_closed": True, "vehicle_connected": True,
             "session_s": 60 + i * 15, "session_energy_wh": 500.0 * (i + 1),
             "vehicle_current_a": 32.0, "grid_v": 242.0, "handle_temp_c": 27.0}
            for i in range(8)
        ]
        script += [{"contactor_closed": False, "vehicle_connected": True}] * 2
        it = iter(script)

        async def fake(url):
            if url.endswith("/vitals"):
                return next(it)
            return dict(REAL_LIFETIME)

        blocks = []
        poller = self.make_poller(fake, on_block=blocks.append)
        for _ in range(len(script)):
            await poller.poll_once()
        last = blocks[-1]
        self.assertEqual(last["charger_status"], "online")
        self.assertEqual(len(last["recent_closed_session_ids"]), 1)
        self.assertEqual(len(last["recent_closed_sessions"]), 1)
        row = last["recent_closed_sessions"][0]
        self.assertAlmostEqual(row["energy_wh"], 4000.0)
        self.assertEqual(row["session_id"], last["recent_closed_session_ids"][0])
        csv_files = list((Path(self.tmp.name) / "csv").glob("ev_sessions_*.csv"))
        self.assertEqual(len(csv_files), 1)

    async def test_single_in_flight(self):
        active = 0
        peak = 0

        async def fake(url):
            nonlocal active, peak
            active += 1
            peak = max(peak, active)
            await asyncio.sleep(0.01)
            active -= 1
            return dict(REAL_VITALS)

        poller = self.make_poller(fake)
        await asyncio.gather(*[poller.poll_once() for _ in range(5)])
        self.assertEqual(peak, 1)


class DualSinkTest(unittest.IsolatedAsyncioTestCase):
    async def test_session_fans_out_with_shared_id_and_isolated_failure(self):
        with tempfile.TemporaryDirectory() as tmp:
            home_csv = str(Path(tmp) / "home-csv")
            solar_csv = str(Path(tmp) / "solar-csv")
            sinks = [
                evc.EVSink("home", "", "", "energy_ev_sessions",
                           "energy_ev_vitals_snapshots", home_csv),
                evc.EVSink("solar", "", "", "ev_charging_sessions",
                           "ev_vitals_snapshots", solar_csv),
            ]
            posted = []

            async def fake_fetch(url):
                return {"contactor_closed": False, "vehicle_connected": True}

            poller = evc.EVWallConnectorPoller(
                fetch_json=fake_fetch,
                state_path=str(Path(tmp) / "state.json"),
                sinks=sinks,
            )
            now = datetime.now(timezone.utc)
            session = evc.EVSessionRecord(
                session_id="aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
                started_at=now - timedelta(hours=3),
                ended_at=now,
                energy_wh=11000.0,
                duration_s=10800,
            )
            def flaky_upsert(sink, table, rows, on_conflict):
                posted.append((sink.label, table))
                if sink.label == "home":
                    raise evc.EVChargerError("home project 500")

            with patch.object(evc, "supabase_upsert_sync", side_effect=flaky_upsert):
                await poller._handle_session_result(
                    evc.EVSessionResult(kind="closed", session=session), now
                )
            # Solar sink still posted despite the home failure.
            self.assertIn(("solar", "ev_charging_sessions"), posted)
            # Both CSV archives carry the identical session_id.
            for csv_dir in (home_csv, solar_csv):
                files = list(Path(csv_dir).glob("ev_sessions_*.csv"))
                self.assertEqual(len(files), 1)
                self.assertIn(session.session_id, files[0].read_text(encoding="utf-8"))
            self.assertEqual(len(poller.recent_closed), 1)


if __name__ == "__main__":
    unittest.main(verbosity=2)
