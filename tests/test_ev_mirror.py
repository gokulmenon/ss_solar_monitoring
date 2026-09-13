import asyncio
import importlib.util
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch


BRIDGE_PATH = Path(__file__).parents[1] / "bridge" / "ev_mirror.py"


def load_mirror_module():
    spec = importlib.util.spec_from_file_location("test_ev_mirror_module", BRIDGE_PATH)
    if spec is None or spec.loader is None:
        raise RuntimeError("Unable to load mirror module")
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


def make_session(session_id, energy_wh=4200.0, duration_s=5400):
    return {
        "session_id": session_id,
        "started_at": "2026-09-13T01:00:00+00:00",
        "ended_at": "2026-09-13T02:30:00+00:00",
        "energy_wh": energy_wh,
        "duration_s": duration_s,
        "max_current_a": 32.0,
        "avg_grid_v": 242.1,
        "max_handle_temp_c": 28.5,
        "alerts": [],
    }


def make_block(sessions=(), charging=False, connected=True):
    return {
        "charger_status": "online",
        "contactor_closed": charging,
        "vehicle_connected": connected,
        "session_energy_wh": 1200.0 if charging else 0.0,
        "vehicle_current_a": 32.0 if charging else 0.0,
        "grid_v": 242.0,
        "handle_temp_c": 27.0,
        "lifetime_energy_wh": 1241740.0,
        "last_poll_at": "2026-09-13T02:00:00+00:00",
        "recent_closed_session_ids": [s["session_id"] for s in sessions],
        "recent_closed_sessions": list(sessions),
    }


class MirrorSourceGuards(unittest.TestCase):
    def test_no_charger_http_references(self):
        source = BRIDGE_PATH.read_text(encoding="utf-8")
        self.assertNotIn("192.168.1.246", source)
        self.assertNotIn("/api/1/vitals", source)
        self.assertNotIn("/api/1/lifetime", source)
        self.assertNotIn("wall_connector", source.lower())

    def test_only_network_peer_is_upstream_ws_and_supabase(self):
        source = BRIDGE_PATH.read_text(encoding="utf-8")
        self.assertIn("EV_UPSTREAM_WS_URL", source)
        # No HTTP client usage outside the Supabase REST upsert helper.
        self.assertNotIn("urllib_request.urlopen", source.split("def supabase_upsert_sync")[0])


class MirrorCoreTest(unittest.TestCase):
    def setUp(self):
        self.module = load_mirror_module()
        self.saved_sessions = []
        self.saved_snapshots = []
        self.blocks = []

        async def save_sessions(rows):
            self.saved_sessions.append(list(rows))

        async def save_snapshots(rows):
            self.saved_snapshots.append(list(rows))

        self.mirror = self.module.EVMirror(
            save_sessions=save_sessions,
            save_snapshots=save_snapshots,
            on_block=self.blocks.append,
        )

    def run_async(self, coro):
        return asyncio.new_event_loop().run_until_complete(coro)

    def test_session_upsert_and_block_forward(self):
        session = make_session("11111111-1111-1111-1111-111111111111")
        block = self.run_async(
            self.mirror.handle_message({"timestamp": "x", "ev": make_block((session,))})
        )
        self.assertIsNotNone(block)
        self.assertEqual(block["charger_status"], "online")
        self.assertEqual(len(self.saved_sessions), 1)
        self.assertEqual(self.saved_sessions[0][0]["session_id"], session["session_id"])
        self.assertEqual(self.blocks[-1]["charger_status"], "online")

    def test_duplicate_broadcasts_upsert_once(self):
        session = make_session("22222222-2222-2222-2222-222222222222")
        message = {"ev": make_block((session,))}
        self.run_async(self.mirror.handle_message(message))
        self.run_async(self.mirror.handle_message(message))
        self.run_async(self.mirror.handle_message(message))
        self.assertEqual(len(self.saved_sessions), 1)

    def test_reconnect_backfill_upserts_missed(self):
        old = make_session("33333333-3333-3333-3333-333333333333", energy_wh=8000.0)
        new = make_session("44444444-4444-4444-4444-444444444444", energy_wh=100.0 + 50.0)
        self.run_async(self.mirror.handle_message({"ev": make_block((old,))}))
        # Outage: mirror misses `new`, then reconnects to a digest with both.
        self.run_async(self.mirror.handle_message({"ev": make_block((old, new))}))
        all_ids = [r["session_id"] for batch in self.saved_sessions for r in batch]
        self.assertEqual(sorted(all_ids), sorted([old["session_id"], new["session_id"]]))

    def test_malformed_entries_skipped(self):
        block = make_block()
        block["recent_closed_sessions"] = [
            {"nope": True},
            {"session_id": "", "started_at": "x", "ended_at": "y"},
            "not-a-dict",
        ]
        self.run_async(self.mirror.handle_message({"ev": block}))
        self.assertEqual(self.saved_sessions, [])

    def test_message_without_ev_ignored(self):
        self.assertIsNone(self.run_async(self.mirror.handle_message({"timestamp": "x"})))
        self.assertIsNone(self.run_async(self.mirror.handle_message({"ev": None})))
        self.assertEqual(self.blocks, [])

    def test_snapshot_throttle(self):
        with patch.object(self.module.time, "time", return_value=1000.0):
            self.run_async(self.mirror.handle_message({"ev": make_block(charging=True)}))
            self.run_async(self.mirror.handle_message({"ev": make_block(charging=True)}))
        snapshots = [r for batch in self.saved_snapshots for r in batch]
        self.assertEqual(len(snapshots), 1)
        self.assertEqual(snapshots[0]["timestamp"], "2026-09-13T02:00:00+00:00")

    def test_session_csv_roundtrip(self):
        session = make_session("66666666-6666-6666-6666-666666666666")
        with tempfile.TemporaryDirectory() as tmp:
            mirror2 = self.module.EVMirror()
            with patch.object(self.module, "EV_MIRROR_CSV_BACKUP_DIR", tmp):
                with patch.object(self.module, "supabase_upsert_sync", return_value=None):
                    self.run_async(mirror2.handle_message({"ev": make_block((session,))}))
            files = list(Path(tmp).glob("ev_sessions_*.csv"))
            self.assertEqual(len(files), 1)
            content = files[0].read_text(encoding="utf-8")
            self.assertIn(session["session_id"], content)
            self.assertTrue(content.startswith("session_id,started_at"))


if __name__ == "__main__":
    unittest.main(verbosity=2)
