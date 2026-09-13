"""EV charging mirror for the solar bridge (no charger polling).

The home_monitoring relay is the SOLE Wall Connector poller. This module
subscribes to the home relay's WebSocket, persists mirrored session and
snapshot rows into the solar project's own Supabase tables, and re-emits
the live `ev` block on the solar relay's WebSocket payload.

This module opens ZERO HTTP connections to the Wall Connector. It performs
no charger I/O of any kind: the only network peers are the upstream
home-relay WebSocket and this project's Supabase REST endpoint. A
regression test enforces this invariant (the charger's LAN address must
not appear anywhere in this file).

Session backfill: every home broadcast carries the trailing
`recent_closed_sessions` rows. The mirror upserts unseen rows by the shared
`session_id` UUID, so sessions missed during a WS outage land automatically
on reconnect.
"""

from __future__ import annotations

import asyncio
import csv
import json
import logging
import os
import time
from collections import deque
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Awaitable, Callable, Deque, Dict, List, Optional
from urllib import request as urllib_request
from urllib.error import HTTPError, URLError

mirror_logger = logging.getLogger("ev_mirror")

# ---------------------------------------------------------------------------
# Configuration (env-var driven, mirroring bridge conventions)
# ---------------------------------------------------------------------------

EV_UPSTREAM_WS_URL = os.getenv("EV_UPSTREAM_WS_URL", "ws://127.0.0.1:8787").strip()
EV_MIRROR_RECONNECT_S = float(os.getenv("EV_MIRROR_RECONNECT_S", "5"))
EV_MIRROR_RECONNECT_MAX_S = float(os.getenv("EV_MIRROR_RECONNECT_MAX_S", "120"))

EV_MIRROR_SESSIONS_TABLE = os.getenv("EV_MIRROR_SESSIONS_TABLE", "ev_charging_sessions")
EV_MIRROR_SNAPSHOTS_TABLE = os.getenv("EV_MIRROR_SNAPSHOTS_TABLE", "ev_vitals_snapshots")
EV_MIRROR_SUPABASE_URL = os.getenv("NEXT_PUBLIC_SUPABASE_URL", "").strip()
EV_MIRROR_SUPABASE_KEY = os.getenv("SUPABASE_SERVICE_ROLE_KEY", "").strip()
EV_MIRROR_SUPABASE_TIMEOUT_S = float(os.getenv("EV_MIRROR_SUPABASE_TIMEOUT_S", "5"))

EV_MIRROR_CSV_BACKUP_DIR = os.getenv("EV_MIRROR_CSV_BACKUP_DIR", "./logs/ev-backups")
EV_MIRROR_CSV_SESSIONS_PREFIX = os.getenv("EV_MIRROR_CSV_SESSIONS_PREFIX", "ev_sessions")

# Snapshot persistence cadence for this project's own snapshots table.
EV_MIRROR_SNAPSHOT_CHARGING_S = float(os.getenv("EV_MIRROR_SNAPSHOT_CHARGING_S", "60"))
EV_MIRROR_SNAPSHOT_IDLE_S = float(os.getenv("EV_MIRROR_SNAPSHOT_IDLE_S", "900"))

SESSION_CSV_HEADER = [
    "session_id",
    "started_at",
    "ended_at",
    "energy_wh",
    "duration_s",
    "max_current_a",
    "avg_grid_v",
    "max_handle_temp_c",
    "alerts",
]

SESSION_COLUMNS = SESSION_CSV_HEADER


class EVMirrorError(RuntimeError):
    """Raised for mirror persistence failures (logged, never fatal)."""


def _daily_csv_path(prefix: str, now: datetime) -> Path:
    local_day = now.astimezone().strftime("%Y-%m-%d")
    directory = Path(EV_MIRROR_CSV_BACKUP_DIR).expanduser()
    directory.mkdir(parents=True, exist_ok=True)
    return directory / f"{prefix}_{local_day}.csv"


def append_session_csv_row(row: Dict[str, Any], now: datetime) -> None:
    path = _daily_csv_path(EV_MIRROR_CSV_SESSIONS_PREFIX, now)
    needs_header = not path.exists() or path.stat().st_size == 0
    alerts = row.get("alerts")
    values = [row.get(col) for col in SESSION_CSV_HEADER[:-1]]
    values.append(json.dumps(alerts) if not isinstance(alerts, str) else alerts)
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a", newline="", encoding="utf-8") as handle:
        writer = csv.writer(handle)
        if needs_header:
            writer.writerow(SESSION_CSV_HEADER)
        writer.writerow(["" if value is None else value for value in values])


def supabase_upsert_sync(table: str, rows: List[Dict[str, Any]], on_conflict: str) -> None:
    """POST rows to this project's Supabase (blocking; run in a thread)."""
    if not rows or not EV_MIRROR_SUPABASE_URL or not EV_MIRROR_SUPABASE_KEY:
        return
    url = f"{EV_MIRROR_SUPABASE_URL.rstrip('/')}/rest/v1/{table}?on_conflict={on_conflict}"
    req = urllib_request.Request(
        url,
        data=json.dumps(rows).encode("utf-8"),
        method="POST",
        headers={
            "apikey": EV_MIRROR_SUPABASE_KEY,
            "Authorization": f"Bearer {EV_MIRROR_SUPABASE_KEY}",
            "Content-Type": "application/json",
            "Prefer": "resolution=merge-duplicates,return=minimal",
        },
    )
    try:
        with urllib_request.urlopen(req, timeout=EV_MIRROR_SUPABASE_TIMEOUT_S) as response:
            if response.status not in (200, 201, 204):
                raise EVMirrorError(f"Supabase upsert to {table} failed: HTTP {response.status}")
    except (HTTPError, URLError, TimeoutError, OSError) as exc:
        raise EVMirrorError(f"Supabase upsert to {table} failed: {exc}") from exc


def session_row_from_block(entry: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    """Validate one trailing session entry; None when malformed."""
    try:
        session_id = str(entry["session_id"])
        started_at = str(entry["started_at"])
        ended_at = str(entry["ended_at"])
        energy_wh = float(entry.get("energy_wh", 0) or 0)
        duration_s = int(float(entry.get("duration_s", 0) or 0))
    except (KeyError, TypeError, ValueError):
        return None
    if not session_id or not started_at or not ended_at:
        return None
    return {
        "session_id": session_id,
        "started_at": started_at,
        "ended_at": ended_at,
        "energy_wh": energy_wh,
        "duration_s": duration_s,
        "max_current_a": entry.get("max_current_a"),
        "avg_grid_v": entry.get("avg_grid_v"),
        "max_handle_temp_c": entry.get("max_handle_temp_c"),
        "alerts": entry.get("alerts") if isinstance(entry.get("alerts"), list) else [],
    }


SaveSessions = Callable[[List[Dict[str, Any]]], Awaitable[None]]
SaveSnapshots = Callable[[List[Dict[str, Any]]], Awaitable[None]]


async def _default_save_sessions(rows: List[Dict[str, Any]]) -> None:
    if not rows:
        return
    try:
        await asyncio.to_thread(
            supabase_upsert_sync, EV_MIRROR_SESSIONS_TABLE, rows, "session_id"
        )
    except EVMirrorError as exc:
        mirror_logger.error("EV mirror session upsert failed: %s", exc)
    try:
        now = datetime.now(timezone.utc)
        for row in rows:
            await asyncio.to_thread(append_session_csv_row, row, now)
    except OSError as exc:
        mirror_logger.error("EV mirror session CSV write failed: %s", exc)


async def _default_save_snapshots(rows: List[Dict[str, Any]]) -> None:
    if not rows:
        return
    try:
        await asyncio.to_thread(
            supabase_upsert_sync, EV_MIRROR_SNAPSHOTS_TABLE, rows, "timestamp"
        )
    except EVMirrorError as exc:
        mirror_logger.error("EV mirror snapshot upsert failed (%d rows): %s", len(rows), exc)


class EVMirror:
    """Transport-free mirror core: upstream payload dict in, actions out.

    Feed each parsed home-relay WebSocket message to handle_message(). New
    trailing sessions are upserted (idempotent on session_id), the live ev
    block is forwarded via on_block, and vitals snapshots persist on a
    throttled cadence. Never raises; never touches the charger.
    """

    def __init__(
        self,
        *,
        save_sessions: SaveSessions = _default_save_sessions,
        save_snapshots: SaveSnapshots = _default_save_snapshots,
        on_block: Optional[Callable[[Dict[str, Any]], None]] = None,
    ) -> None:
        self.save_sessions = save_sessions
        self.save_snapshots = save_snapshots
        self.on_block = on_block
        self.seen_session_ids: Deque[str] = deque(maxlen=256)
        self.seen_set: set = set()
        self.latest_block: Optional[Dict[str, Any]] = None
        self.last_snapshot_at = 0.0

    def _remember(self, session_id: str) -> None:
        if len(self.seen_session_ids) == self.seen_session_ids.maxlen:
            evicted = self.seen_session_ids.popleft()
            self.seen_set.discard(evicted)
        self.seen_session_ids.append(session_id)
        self.seen_set.add(session_id)

    async def handle_message(self, message: Dict[str, Any]) -> Optional[Dict[str, Any]]:
        """Process one upstream payload; returns the live ev block or None."""
        if not isinstance(message, dict):
            return None
        block = message.get("ev")
        if not isinstance(block, dict):
            return None
        self.latest_block = block

        fresh: List[Dict[str, Any]] = []
        trailing = block.get("recent_closed_sessions")
        if isinstance(trailing, list):
            for entry in trailing:
                if not isinstance(entry, dict):
                    continue
                row = session_row_from_block(entry)
                if row is None or row["session_id"] in self.seen_set:
                    continue
                self._remember(row["session_id"])
                fresh.append(row)
        if fresh:
            mirror_logger.info("EV mirror upserting %d session(s)", len(fresh))
            try:
                await self.save_sessions(fresh)
            except Exception as exc:  # a custom saver must never break mirroring
                mirror_logger.error("EV mirror save_sessions failed: %s", exc)

        await self._maybe_snapshot(block)

        if self.on_block is not None:
            try:
                self.on_block(block)
            except Exception as exc:
                mirror_logger.error("EV mirror block consumer failed: %s", exc)
        return block

    async def _maybe_snapshot(self, block: Dict[str, Any]) -> None:
        charging = bool(block.get("contactor_closed"))
        cadence = EV_MIRROR_SNAPSHOT_CHARGING_S if charging else EV_MIRROR_SNAPSHOT_IDLE_S
        now = time.time()
        if now - self.last_snapshot_at < cadence:
            return
        self.last_snapshot_at = now
        timestamp = block.get("last_poll_at")
        row = {
            "timestamp": timestamp
            if isinstance(timestamp, str) and timestamp
            else datetime.now(timezone.utc).isoformat(),
            "contactor_closed": block.get("contactor_closed"),
            "vehicle_connected": block.get("vehicle_connected"),
            "session_energy_wh": block.get("session_energy_wh"),
            "vehicle_current_a": block.get("vehicle_current_a"),
            "grid_v": block.get("grid_v"),
            "handle_temp_c": block.get("handle_temp_c"),
            "pcba_temp_c": block.get("pcba_temp_c"),
            "lifetime_energy_wh": block.get("lifetime_energy_wh"),
        }
        try:
            await self.save_snapshots([row])
        except Exception as exc:
            mirror_logger.error("EV mirror save_snapshots failed: %s", exc)


async def run_mirror_forever(
    mirror: EVMirror,
    url: str = EV_UPSTREAM_WS_URL,
) -> None:
    """Subscribe to the home relay WS with reconnect backoff. Never raises."""
    try:
        import websockets
    except ImportError:
        mirror_logger.error("EV mirror disabled: websockets package is not installed")
        return

    mirror_logger.info("EV mirror subscribing to %s", url)
    backoff = EV_MIRROR_RECONNECT_S
    while True:
        try:
            async with websockets.connect(url, max_size=4 * 1024 * 1024) as socket:
                mirror_logger.info("EV mirror connected to upstream relay")
                backoff = EV_MIRROR_RECONNECT_S
                async for raw in socket:
                    try:
                        message = json.loads(raw)
                    except (json.JSONDecodeError, TypeError):
                        continue
                    try:
                        await mirror.handle_message(message)
                    except Exception as exc:  # defensive: core never raises
                        mirror_logger.error("EV mirror message handling failed: %s", exc)
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            mirror_logger.warning(
                "EV mirror upstream unreachable (%s); retry in %.0fs", exc, backoff
            )
            await asyncio.sleep(backoff)
            backoff = min(backoff * 2, EV_MIRROR_RECONNECT_MAX_S)


async def run_ev_mirror_loop(on_block: Optional[Callable[[Dict[str, Any]], None]] = None) -> None:
    """Entry point for the solar bridge: mirror the home relay forever."""
    await run_mirror_forever(EVMirror(on_block=on_block))


def describe_ev_mirror() -> str:
    return (
        f"EV mirror -> upstream {EV_UPSTREAM_WS_URL} "
        f"(tables {EV_MIRROR_SESSIONS_TABLE}/{EV_MIRROR_SNAPSHOTS_TABLE}, "
        "no charger polling)"
    )
