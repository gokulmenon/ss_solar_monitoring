"""Tesla Wall Connector (Gen 3) EV charging poller for the Universal Relay.

Single-poller design: the Universal Relay is the ONLY process that issues
HTTP requests to the Wall Connector. The Gen 3 ESP32 web server cannot
reliably handle overlapping requests, so this module enforces a strict
one-in-flight-request loop. Each closed session dual-writes to BOTH
Supabase projects (and both CSV archives) with an identical session_id.

Charger facts (read-only LAN API, no auth):
- GET {base}/api/1/vitals    live session data (contactor_closed,
  vehicle_connected, session_s, session_energy_wh, currents, temps).
- GET {base}/api/1/lifetime  cumulative energy_wh / charge_starts /
  charging_time_s counters (reconciliation source of truth).
- session_energy_wh resets to 0 when charging begins, so the final value
  reported at contactor-open IS the session energy (no delta math).

The module is stdlib-only so it imports cleanly wherever the relay runs.
Pure session logic lives in EVSessionTracker (fully unit-testable);
EVWallConnectorPoller adds adaptive polling, Supabase/CSV persistence,
offline handling, and WS block emission.
"""

from __future__ import annotations

import asyncio
import csv
import json
import logging
import os
import time
import uuid
from collections import deque
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Awaitable, Callable, Deque, Dict, List, Optional
from urllib import request as urllib_request
from urllib.error import HTTPError, URLError

poller_logger = logging.getLogger("ev_wall_connector")

# ---------------------------------------------------------------------------
# Configuration (env-var driven, mirroring modbus_ws_relay.py conventions)
# ---------------------------------------------------------------------------

EV_BASE_URL = os.getenv("EV_WALL_CONNECTOR_BASE_URL", "http://192.168.1.246").strip().rstrip("/")
EV_HTTP_TIMEOUT_SECONDS = float(os.getenv("EV_HTTP_TIMEOUT_SECONDS", "5"))

# Adaptive cadence, re-evaluated after every poll.
EV_POLL_CHARGING_S = float(os.getenv("EV_POLL_CHARGING_S", "15"))
EV_POLL_IDLE_S = float(os.getenv("EV_POLL_IDLE_S", "60"))
EV_POLL_UNPLUGGED_S = float(os.getenv("EV_POLL_UNPLUGGED_S", "180"))

EV_LIFETIME_POLL_SECONDS = float(os.getenv("EV_LIFETIME_POLL_SECONDS", "1800"))

# Nuisance-session filter: preconditioning blips and contactor self-tests.
EV_MIN_SESSION_WH = float(os.getenv("EV_MIN_SESSION_WH", "100"))
EV_MIN_SESSION_S = int(os.getenv("EV_MIN_SESSION_S", "60"))

# Close debounce: contactor must read open this many consecutive polls.
EV_CLOSE_DEBOUNCE_POLLS = max(int(os.getenv("EV_CLOSE_DEBOUNCE_POLLS", "2")), 1)

# Offline behavior: 5 s timeout, OFFLINE flag, quiet logs, steady retry.
EV_OFFLINE_RETRY_S = float(os.getenv("EV_OFFLINE_RETRY_S", "60"))
EV_OFFLINE_REMINDER_S = float(os.getenv("EV_OFFLINE_REMINDER_S", "600"))

# Snapshot batching: buffer vitals rows, flush on this cadence + session close.
EV_SNAPSHOT_FLUSH_S = float(os.getenv("EV_SNAPSHOT_FLUSH_S", "300"))

EV_SUPABASE_TIMEOUT_S = float(os.getenv("EV_SUPABASE_TIMEOUT_S", "5"))

# Dual-write sinks. Each sink is one Supabase project plus its local CSV
# archive; the same session row (same session_id) goes to every sink.
# Sinks are built from os.environ at poller start (see build_ev_sinks), so
# import order can never freeze stale credentials. If neither pair is
# configured, persistence is a no-op and the poller still serves the live
# WS block.
EV_CSV_SESSIONS_PREFIX = os.getenv("EV_CSV_SESSIONS_PREFIX", "ev_sessions")
EV_CSV_DISCARDED_PREFIX = os.getenv("EV_CSV_DISCARDED_PREFIX", "ev_discarded")
EV_STATE_PATH = os.getenv("EV_STATE_PATH", "./logs/ev-poller-state.json")


@dataclass
class EVSink:
    """One persistence target: a Supabase project plus its CSV archive."""

    label: str
    supabase_url: str
    supabase_key: str
    sessions_table: str
    snapshots_table: str
    csv_backup_dir: str

    @property
    def cloud_enabled(self) -> bool:
        return bool(self.supabase_url and self.supabase_key)


def build_ev_sinks() -> List["EVSink"]:
    """Build the configured dual-write sinks (home + solar, whichever exists).

    Reads os.environ at CALL time, not import time, so this module sees
    credentials however late the host process makes them available.
    """
    sinks: List["EVSink"] = []
    home_url = os.getenv("HOME_SUPABASE_URL", "").strip()
    home_key = os.getenv("HOME_SUPABASE_SERVICE_KEY", "").strip()
    if home_url or home_key:
        sinks.append(
            EVSink(
                label="home",
                supabase_url=home_url,
                supabase_key=home_key,
                sessions_table=os.getenv("EV_HOME_SESSIONS_TABLE", "energy_ev_sessions"),
                snapshots_table=os.getenv("EV_HOME_SNAPSHOTS_TABLE", "energy_ev_vitals_snapshots"),
                csv_backup_dir=os.getenv("EV_HOME_CSV_BACKUP_DIR", "./logs/home-ev-backups"),
            )
        )
    solar_url = os.getenv("SOLAR_SUPABASE_URL", "").strip()
    solar_key = os.getenv("SOLAR_SUPABASE_SERVICE_KEY", "").strip()
    if solar_url or solar_key:
        sinks.append(
            EVSink(
                label="solar",
                supabase_url=solar_url,
                supabase_key=solar_key,
                sessions_table=os.getenv("EV_SOLAR_SESSIONS_TABLE", "ev_charging_sessions"),
                snapshots_table=os.getenv("EV_SOLAR_SNAPSHOTS_TABLE", "ev_vitals_snapshots"),
                csv_backup_dir=os.getenv("EV_SOLAR_CSV_BACKUP_DIR", "./logs/ev-backups"),
            )
        )
    return sinks


def describe_sink_env_presence() -> str:
    """Presence-only diagnostic (names, never values) for startup logs."""
    seen = {
        name: ("set" if os.getenv(name) else "MISSING")
        for name in ("HOME_SUPABASE_URL", "HOME_SUPABASE_SERVICE_KEY",
                     "SOLAR_SUPABASE_URL", "SOLAR_SUPABASE_SERVICE_KEY")
    }
    return "sink env at runtime: " + ", ".join(f"{name}={state}" for name, state in seen.items())

CHARGER_ONLINE = "online"
CHARGER_OFFLINE = "offline"


# ---------------------------------------------------------------------------
# HTTP + parsing helpers
# ---------------------------------------------------------------------------

def _extract_json(text: str) -> Dict[str, Any]:
    """Parse a JSON object, tolerating wrapper text around the payload."""
    stripped = text.strip()
    if not stripped:
        raise ValueError("empty charger response")
    try:
        loaded = json.loads(stripped)
    except json.JSONDecodeError:
        start = stripped.find("{")
        end = stripped.rfind("}")
        if start < 0 or end <= start:
            raise
        loaded = json.loads(stripped[start : end + 1])
    if not isinstance(loaded, dict):
        raise ValueError("charger JSON response was not an object")
    return loaded


def http_get_json_sync(url: str, timeout_s: float) -> Dict[str, Any]:
    """Blocking GET returning the decoded JSON object (run in a thread)."""
    req = urllib_request.Request(
        url,
        method="GET",
        headers={"Accept": "application/json", "User-Agent": "home-monitoring-ev-poller/1.0"},
    )
    try:
        with urllib_request.urlopen(req, timeout=timeout_s) as response:
            return _extract_json(response.read().decode("utf-8", "replace"))
    except (HTTPError, URLError, TimeoutError, ValueError, OSError) as exc:
        raise EVChargerError(f"GET {url} failed: {exc}") from exc


class EVChargerError(RuntimeError):
    """Raised when the Wall Connector cannot be reached or parsed."""


def coerce_float(value: Any) -> Optional[float]:
    try:
        parsed = float(value)
    except (TypeError, ValueError):
        return None
    return parsed if parsed == parsed and parsed not in (float("inf"), float("-inf")) else None


def coerce_bool(value: Any) -> bool:
    if isinstance(value, bool):
        return value
    if isinstance(value, (int, float)):
        return value != 0
    if isinstance(value, str):
        return value.strip().lower() in ("1", "true", "yes", "closed", "on")
    return False


@dataclass
class EVVitals:
    contactor_closed: bool = False
    vehicle_connected: bool = False
    session_s: Optional[float] = None
    session_energy_wh: Optional[float] = None
    vehicle_current_a: Optional[float] = None
    grid_v: Optional[float] = None
    grid_hz: Optional[float] = None
    pcba_temp_c: Optional[float] = None
    handle_temp_c: Optional[float] = None
    mcu_temp_c: Optional[float] = None
    evse_state: Optional[int] = None
    alerts: List[Any] = field(default_factory=list)


def parse_vitals(payload: Dict[str, Any]) -> EVVitals:
    alerts = payload.get("current_alerts")
    evse_state = coerce_float(payload.get("evse_state"))
    return EVVitals(
        contactor_closed=coerce_bool(payload.get("contactor_closed")),
        vehicle_connected=coerce_bool(payload.get("vehicle_connected")),
        session_s=coerce_float(payload.get("session_s")),
        session_energy_wh=coerce_float(payload.get("session_energy_wh")),
        vehicle_current_a=coerce_float(payload.get("vehicle_current_a")),
        grid_v=coerce_float(payload.get("grid_v")),
        grid_hz=coerce_float(payload.get("grid_hz")),
        pcba_temp_c=coerce_float(payload.get("pcba_temp_c")),
        handle_temp_c=coerce_float(payload.get("handle_temp_c")),
        mcu_temp_c=coerce_float(payload.get("mcu_temp_c")),
        evse_state=int(evse_state) if evse_state is not None else None,
        alerts=list(alerts) if isinstance(alerts, list) else [],
    )


@dataclass
class EVLifetime:
    energy_wh: Optional[float] = None
    charge_starts: Optional[float] = None
    charging_time_s: Optional[float] = None
    contactor_cycles: Optional[float] = None
    connector_cycles: Optional[float] = None
    uptime_s: Optional[float] = None


def parse_lifetime(payload: Dict[str, Any]) -> EVLifetime:
    return EVLifetime(
        energy_wh=coerce_float(payload.get("energy_wh")),
        charge_starts=coerce_float(payload.get("charge_starts")),
        charging_time_s=coerce_float(payload.get("charging_time_s")),
        contactor_cycles=coerce_float(payload.get("contactor_cycles")),
        connector_cycles=coerce_float(payload.get("connector_cycles")),
        uptime_s=coerce_float(payload.get("uptime_s")),
    )


def select_poll_interval(vitals: Optional[EVVitals]) -> float:
    """Adaptive cadence: 15 s charging, 60 s plugged-idle, 180 s unplugged."""
    if vitals is not None and vitals.contactor_closed:
        return EV_POLL_CHARGING_S
    if vitals is not None and vitals.vehicle_connected:
        return EV_POLL_IDLE_S
    return EV_POLL_UNPLUGGED_S


# ---------------------------------------------------------------------------
# Session tracking (pure logic, no I/O)
# ---------------------------------------------------------------------------

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

DISCARDED_CSV_HEADER = SESSION_CSV_HEADER + ["discard_reason"]


@dataclass
class EVSessionRecord:
    session_id: str
    started_at: datetime
    ended_at: datetime
    energy_wh: float
    duration_s: int
    max_current_a: Optional[float] = None
    avg_grid_v: Optional[float] = None
    max_handle_temp_c: Optional[float] = None
    alerts: List[Any] = field(default_factory=list)

    def to_supabase_row(self) -> Dict[str, Any]:
        return {
            "session_id": self.session_id,
            "started_at": self.started_at.isoformat(),
            "ended_at": self.ended_at.isoformat(),
            "energy_wh": round(self.energy_wh, 3),
            "duration_s": self.duration_s,
            "max_current_a": self.max_current_a,
            "avg_grid_v": self.avg_grid_v,
            "max_handle_temp_c": self.max_handle_temp_c,
            "alerts": self.alerts,
        }

    def to_csv_row(self) -> List[Any]:
        return [
            self.session_id,
            self.started_at.isoformat(),
            self.ended_at.isoformat(),
            round(self.energy_wh, 3),
            self.duration_s,
            self.max_current_a,
            self.avg_grid_v,
            self.max_handle_temp_c,
            json.dumps(self.alerts),
        ]


@dataclass
class EVSessionResult:
    kind: str  # "closed" | "discarded"
    session: EVSessionRecord
    reason: Optional[str] = None


def is_nuisance(session: EVSessionRecord) -> Optional[str]:
    """Return the discard reason, or None when the session is worth keeping."""
    if session.energy_wh < EV_MIN_SESSION_WH:
        return f"energy {session.energy_wh:.1f} Wh < {EV_MIN_SESSION_WH:.0f} Wh minimum"
    if session.duration_s < EV_MIN_SESSION_S:
        return f"duration {session.duration_s}s < {EV_MIN_SESSION_S}s minimum"
    return None


class EVSessionTracker:
    """Contactor-edge session detector with debounce and restart-safe state.

    Energy comes from the charger's final session_energy_wh value directly
    (the connector resets it to 0 at charge start). While the contactor is
    closed the latest reported value is remembered; on a debounced open edge
    that remembered value becomes the session energy.
    """

    def __init__(self, debounce_polls: int = EV_CLOSE_DEBOUNCE_POLLS) -> None:
        self.debounce_polls = max(debounce_polls, 1)
        self.in_session = False
        self.opened_at: Optional[datetime] = None
        self.max_current_a: Optional[float] = None
        self.grid_v_sum = 0.0
        self.grid_v_count = 0
        self.max_handle_temp_c: Optional[float] = None
        self.alerts: List[Any] = []
        self.close_pending = 0
        self.last_closed_energy_wh: Optional[float] = None

    # -- persistence ------------------------------------------------------

    def to_state(self) -> Dict[str, Any]:
        return {
            "in_session": self.in_session,
            "opened_at": self.opened_at.isoformat() if self.opened_at else None,
            "max_current_a": self.max_current_a,
            "grid_v_sum": self.grid_v_sum,
            "grid_v_count": self.grid_v_count,
            "max_handle_temp_c": self.max_handle_temp_c,
            "alerts": self.alerts,
            "close_pending": self.close_pending,
            "last_closed_energy_wh": self.last_closed_energy_wh,
        }

    def load_state(self, state: Dict[str, Any]) -> None:
        self.in_session = bool(state.get("in_session", False))
        opened = state.get("opened_at")
        try:
            self.opened_at = datetime.fromisoformat(opened) if opened else None
        except (TypeError, ValueError):
            self.opened_at = None
        if self.opened_at is not None and self.opened_at.tzinfo is None:
            self.opened_at = self.opened_at.replace(tzinfo=timezone.utc)
        current = coerce_float(state.get("max_current_a"))
        self.max_current_a = current
        grid_sum = coerce_float(state.get("grid_v_sum"))
        self.grid_v_sum = grid_sum if grid_sum is not None else 0.0
        grid_count = state.get("grid_v_count")
        self.grid_v_count = grid_count if isinstance(grid_count, int) and grid_count >= 0 else 0
        handle = coerce_float(state.get("max_handle_temp_c"))
        self.max_handle_temp_c = handle
        alerts = state.get("alerts")
        self.alerts = list(alerts) if isinstance(alerts, list) else []
        pending = state.get("close_pending")
        self.close_pending = pending if isinstance(pending, int) and pending >= 0 else 0
        energy = coerce_float(state.get("last_closed_energy_wh"))
        self.last_closed_energy_wh = energy
        if not self.in_session:
            self.opened_at = None
            self.close_pending = 0

    # -- observation ------------------------------------------------------

    def observe(self, now: datetime, vitals: EVVitals) -> Optional[EVSessionResult]:
        if vitals.contactor_closed:
            self.close_pending = 0
            if not self.in_session:
                self.in_session = True
                self.opened_at = self._estimate_start(now, vitals.session_s)
                self.max_current_a = None
                self.grid_v_sum = 0.0
                self.grid_v_count = 0
                self.max_handle_temp_c = None
                self.alerts = []
                self.last_closed_energy_wh = None
            self._accumulate(vitals)
            if vitals.session_energy_wh is not None:
                self.last_closed_energy_wh = vitals.session_energy_wh
            return None

        if not self.in_session:
            return None

        self.close_pending += 1
        if self.close_pending < self.debounce_polls:
            return None
        return self._close(now)

    def _estimate_start(self, now: datetime, session_s: Optional[float]) -> datetime:
        if session_s is None or session_s < 0:
            return now
        started = now.timestamp() - session_s
        return datetime.fromtimestamp(started, tz=timezone.utc)

    def _accumulate(self, vitals: EVVitals) -> None:
        if vitals.vehicle_current_a is not None:
            if self.max_current_a is None or vitals.vehicle_current_a > self.max_current_a:
                self.max_current_a = vitals.vehicle_current_a
        if vitals.grid_v is not None:
            self.grid_v_sum += vitals.grid_v
            self.grid_v_count += 1
        if vitals.handle_temp_c is not None:
            if self.max_handle_temp_c is None or vitals.handle_temp_c > self.max_handle_temp_c:
                self.max_handle_temp_c = vitals.handle_temp_c
        if vitals.alerts:
            self.alerts = list(vitals.alerts)

    def _close(self, now: datetime) -> EVSessionResult:
        opened_at = self.opened_at or now
        energy = self.last_closed_energy_wh
        session = EVSessionRecord(
            session_id=str(uuid.uuid4()),
            started_at=opened_at,
            ended_at=now,
            energy_wh=max(energy or 0.0, 0.0),
            duration_s=max(int((now - opened_at).total_seconds()), 0),
            max_current_a=self.max_current_a,
            avg_grid_v=(
                round(self.grid_v_sum / self.grid_v_count, 1) if self.grid_v_count > 0 else None
            ),
            max_handle_temp_c=self.max_handle_temp_c,
            alerts=self.alerts,
        )
        self.in_session = False
        self.opened_at = None
        self.close_pending = 0
        self.last_closed_energy_wh = None
        reason = is_nuisance(session)
        if reason is not None:
            return EVSessionResult(kind="discarded", session=session, reason=reason)
        return EVSessionResult(kind="closed", session=session)


# ---------------------------------------------------------------------------
# Persistence: CSV backups, tracker state file, Supabase upserts
# ---------------------------------------------------------------------------

def _daily_csv_path(backup_dir: str, prefix: str, now: datetime) -> Path:
    local_day = now.astimezone().strftime("%Y-%m-%d")
    directory = Path(backup_dir).expanduser()
    directory.mkdir(parents=True, exist_ok=True)
    return directory / f"{prefix}_{local_day}.csv"


def append_csv_row(path: Path, header: List[str], row: List[Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    needs_header = not path.exists() or path.stat().st_size == 0
    with path.open("a", newline="", encoding="utf-8") as handle:
        writer = csv.writer(handle)
        if needs_header:
            writer.writerow(header)
        writer.writerow(["" if value is None else value for value in row])


def load_tracker_state_file(path: str = EV_STATE_PATH) -> Dict[str, Any]:
    try:
        raw = Path(path).expanduser().read_text(encoding="utf-8")
    except OSError:
        return {}
    try:
        loaded = json.loads(raw)
    except json.JSONDecodeError:
        return {}
    return loaded if isinstance(loaded, dict) else {}


def save_tracker_state_file(state: Dict[str, Any], path: str = EV_STATE_PATH) -> None:
    target = Path(path).expanduser()
    target.parent.mkdir(parents=True, exist_ok=True)
    tmp = target.with_suffix(".tmp")
    tmp.write_text(json.dumps(state), encoding="utf-8")
    tmp.replace(target)


def supabase_upsert_sync(
    sink: EVSink, table: str, rows: List[Dict[str, Any]], on_conflict: str
) -> None:
    """POST rows to one sink's Supabase with merge-duplicates semantics (blocking)."""
    if not rows or not sink.cloud_enabled:
        return
    url = f"{sink.supabase_url.rstrip('/')}/rest/v1/{table}?on_conflict={on_conflict}"
    req = urllib_request.Request(
        url,
        data=json.dumps(rows).encode("utf-8"),
        method="POST",
        headers={
            "apikey": sink.supabase_key,
            "Authorization": f"Bearer {sink.supabase_key}",
            "Content-Type": "application/json",
            "Prefer": "resolution=merge-duplicates,return=minimal",
        },
    )
    try:
        with urllib_request.urlopen(req, timeout=EV_SUPABASE_TIMEOUT_S) as response:
            if response.status not in (200, 201, 204):
                raise EVChargerError(
                    f"Supabase upsert to {sink.label}.{table} failed: HTTP {response.status}"
                )
    except (HTTPError, URLError, TimeoutError, OSError) as exc:
        raise EVChargerError(f"Supabase upsert to {sink.label}.{table} failed: {exc}") from exc


# ---------------------------------------------------------------------------
# Async poller (sole charger poller; one in-flight request at a time)
# ---------------------------------------------------------------------------

FetchJson = Callable[[str], Awaitable[Dict[str, Any]]]


async def _default_fetch_json(url: str) -> Dict[str, Any]:
    return await asyncio.to_thread(http_get_json_sync, url, EV_HTTP_TIMEOUT_SECONDS)


class EVWallConnectorPoller:
    """Adaptive Wall Connector poll loop with session persistence + WS block.

    Each poll awaits its HTTP response before the next is scheduled, so at
    most one request is ever in flight against the ESP32 web server.
    All persistence failures are logged, never raised into the relay loop.
    """

    def __init__(
        self,
        *,
        base_url: str = EV_BASE_URL,
        fetch_json: FetchJson = _default_fetch_json,
        on_block: Optional[Callable[[Dict[str, Any]], None]] = None,
        state_path: str = EV_STATE_PATH,
        clock: Callable[[], float] = time.time,
        sinks: Optional[List[EVSink]] = None,
    ) -> None:
        self.base_url = base_url.rstrip("/")
        self.fetch_json = fetch_json
        self.on_block = on_block
        self.state_path = state_path
        self.clock = clock
        self.sinks = sinks if sinks is not None else build_ev_sinks()
        self.tracker = EVSessionTracker()
        self.tracker.load_state(load_tracker_state_file(state_path))
        self.last_vitals: Optional[EVVitals] = None
        self.lifetime: Optional[EVLifetime] = None
        self.charger_status = CHARGER_ONLINE
        self.consecutive_failures = 0
        self.last_failure_at: Optional[float] = None
        self.last_poll_at: Optional[datetime] = None
        self.last_lifetime_poll_at = 0.0
        self.snapshot_buffer: List[Dict[str, Any]] = []
        self.last_snapshot_flush_at = 0.0
        # Trailing digest of closed session IDs for downstream mirror backfill.
        self.recent_closed_ids: Deque[str] = deque(maxlen=10)
        # Trailing full session rows (Supabase shape) so the solar mirror can
        # upsert sessions it missed during a WS outage — no charger HTTP,
        # no cross-database reads.
        self.recent_closed: Deque[Dict[str, Any]] = deque(maxlen=10)
        # Structural single-poller guard: even if run_forever were started
        # twice, charger fetches serialize behind this lock.
        self._fetch_lock = asyncio.Lock()

    # -- block ------------------------------------------------------------

    def build_block(self) -> Dict[str, Any]:
        vitals = self.last_vitals
        return {
            "charger_status": self.charger_status,
            "contactor_closed": vitals.contactor_closed if vitals else False,
            "vehicle_connected": vitals.vehicle_connected if vitals else False,
            "session_energy_wh": vitals.session_energy_wh if vitals else None,
            "vehicle_current_a": vitals.vehicle_current_a if vitals else None,
            "grid_v": vitals.grid_v if vitals else None,
            "pcba_temp_c": vitals.pcba_temp_c if vitals else None,
            "handle_temp_c": vitals.handle_temp_c if vitals else None,
            "lifetime_energy_wh": self.lifetime.energy_wh if self.lifetime else None,
            "lifetime_charge_starts": self.lifetime.charge_starts if self.lifetime else None,
            "lifetime_charging_time_s": self.lifetime.charging_time_s if self.lifetime else None,
            "last_poll_at": self.last_poll_at.isoformat() if self.last_poll_at else None,
            "recent_closed_session_ids": list(self.recent_closed_ids),
            "recent_closed_sessions": list(self.recent_closed),
        }

    def _emit_block(self) -> None:
        if self.on_block is not None:
            try:
                self.on_block(self.build_block())
            except Exception as exc:  # never break polling on a consumer error
                poller_logger.error("EV block consumer failed: %s", exc)

    # -- polling ----------------------------------------------------------

    async def poll_once(self) -> Dict[str, Any]:
        """Run one poll cycle; returns the current WS block. Never raises."""
        async with self._fetch_lock:
            return await self._poll_locked()

    async def _poll_locked(self) -> Dict[str, Any]:
        now = datetime.now(timezone.utc)
        try:
            vitals_payload = await self.fetch_json(f"{self.base_url}/api/1/vitals")
        except Exception as exc:
            self._record_failure(exc)
            self._emit_block()
            return self.build_block()

        vitals = parse_vitals(vitals_payload)
        self.last_vitals = vitals
        self.last_poll_at = now
        self.consecutive_failures = 0
        self.charger_status = CHARGER_ONLINE

        result = self.tracker.observe(now, vitals)
        if result is not None:
            await self._handle_session_result(result, now)

        await self._maybe_poll_lifetime(now)
        self._buffer_snapshot(now, vitals)
        await self._maybe_flush_snapshots(now, force=result is not None)
        self._persist_state()
        self._emit_block()
        return self.build_block()

    def next_interval(self) -> float:
        if self.charger_status == CHARGER_OFFLINE:
            return EV_OFFLINE_RETRY_S
        return select_poll_interval(self.last_vitals)

    async def run_forever(self) -> None:
        poller_logger.info(
            "EV poller started -> %s (charging %.0fs / idle %.0fs / unplugged %.0fs, timeout %.0fs)",
            self.base_url,
            EV_POLL_CHARGING_S,
            EV_POLL_IDLE_S,
            EV_POLL_UNPLUGGED_S,
            EV_HTTP_TIMEOUT_SECONDS,
        )
        poller_logger.info(describe_sink_env_presence())
        cloud_sinks = [sink.label for sink in self.sinks if sink.cloud_enabled]
        if len(cloud_sinks) < 2:
            poller_logger.warning(
                "EV dual-write DEGRADED: cloud sinks configured: %s. "
                "Set both HOME_SUPABASE_* and SOLAR_SUPABASE_* pairs for full dual-write.",
                cloud_sinks or "none (CSV + WS only)",
            )
        else:
            poller_logger.info("EV dual-write targets: %s", ", ".join(cloud_sinks))
        while True:
            await self.poll_once()
            await asyncio.sleep(self.next_interval())

    # -- failures ---------------------------------------------------------

    def _record_failure(self, exc: Exception) -> None:
        self.consecutive_failures += 1
        self.charger_status = CHARGER_OFFLINE
        now_mono = self.clock()
        first = self.consecutive_failures == 1
        reminder_due = (
            self.last_failure_at is None or now_mono - self.last_failure_at >= EV_OFFLINE_REMINDER_S
        )
        if first or reminder_due:
            self.last_failure_at = now_mono
            poller_logger.warning(
                "Wall Connector %s (failures: %d): %s",
                "unreachable" if first else "still unreachable",
                self.consecutive_failures,
                exc,
            )

    # -- lifetime ---------------------------------------------------------

    async def _maybe_poll_lifetime(self, now: datetime, force: bool = False) -> None:
        if not force and now.timestamp() - self.last_lifetime_poll_at < EV_LIFETIME_POLL_SECONDS:
            return
        try:
            payload = await self.fetch_json(f"{self.base_url}/api/1/lifetime")
        except Exception as exc:
            poller_logger.warning("EV lifetime poll failed: %s", exc)
            return
        self.lifetime = parse_lifetime(payload)
        self.last_lifetime_poll_at = now.timestamp()

    # -- sessions ---------------------------------------------------------

    async def _handle_session_result(self, result: EVSessionResult, now: datetime) -> None:
        session = result.session
        if result.kind == "discarded":
            poller_logger.info("EV session discarded (%s): %s", result.reason, session.session_id)
            for sink in self.sinks:
                try:
                    await asyncio.to_thread(
                        append_csv_row,
                        _daily_csv_path(sink.csv_backup_dir, EV_CSV_DISCARDED_PREFIX, now),
                        DISCARDED_CSV_HEADER,
                        session.to_csv_row() + [result.reason],
                    )
                except OSError as exc:
                    poller_logger.error("EV discarded-CSV write failed (%s): %s", sink.label, exc)
            return

        self.recent_closed_ids.append(session.session_id)
        self.recent_closed.append(session.to_supabase_row())
        poller_logger.info(
            "EV session closed: %.1f Wh in %ds (id %s)",
            session.energy_wh,
            session.duration_s,
            session.session_id,
        )
        for sink in self.sinks:
            try:
                await asyncio.to_thread(
                    append_csv_row,
                    _daily_csv_path(sink.csv_backup_dir, EV_CSV_SESSIONS_PREFIX, now),
                    SESSION_CSV_HEADER,
                    session.to_csv_row(),
                )
            except OSError as exc:
                poller_logger.error("EV session CSV write failed (%s): %s", sink.label, exc)
            # One project's outage must never block the other sink.
            try:
                await asyncio.to_thread(
                    supabase_upsert_sync,
                    sink,
                    sink.sessions_table,
                    [session.to_supabase_row()],
                    "session_id",
                )
            except EVChargerError as exc:
                poller_logger.error("EV session Supabase upsert failed (%s): %s", sink.label, exc)

    # -- snapshots --------------------------------------------------------

    def _buffer_snapshot(self, now: datetime, vitals: EVVitals) -> None:
        self.snapshot_buffer.append(
            {
                "timestamp": now.isoformat(),
                "contactor_closed": vitals.contactor_closed,
                "vehicle_connected": vitals.vehicle_connected,
                "session_energy_wh": vitals.session_energy_wh,
                "vehicle_current_a": vitals.vehicle_current_a,
                "grid_v": vitals.grid_v,
                "handle_temp_c": vitals.handle_temp_c,
                "pcba_temp_c": vitals.pcba_temp_c,
                "lifetime_energy_wh": self.lifetime.energy_wh if self.lifetime else None,
            }
        )

    async def _maybe_flush_snapshots(self, now: datetime, force: bool = False) -> None:
        if not self.snapshot_buffer:
            return
        due = now.timestamp() - self.last_snapshot_flush_at >= EV_SNAPSHOT_FLUSH_S
        if not (force or due):
            return
        rows, self.snapshot_buffer = self.snapshot_buffer, []
        self.last_snapshot_flush_at = now.timestamp()
        for sink in self.sinks:
            try:
                await asyncio.to_thread(
                    supabase_upsert_sync, sink, sink.snapshots_table, rows, "timestamp"
                )
            except EVChargerError as exc:
                poller_logger.error(
                    "EV snapshot Supabase upsert failed (%s, %d rows): %s",
                    sink.label,
                    len(rows),
                    exc,
                )

    # -- state ------------------------------------------------------------

    def _persist_state(self) -> None:
        try:
            save_tracker_state_file(self.tracker.to_state(), self.state_path)
        except OSError as exc:
            poller_logger.error("EV tracker state save failed: %s", exc)


async def run_ev_poll_loop(
    on_block: Optional[Callable[[Dict[str, Any]], None]] = None,
    sinks: Optional[List[EVSink]] = None,
) -> None:
    """Entry point for the relay: run the sole charger poll loop forever."""
    await EVWallConnectorPoller(on_block=on_block, sinks=sinks).run_forever()


def describe_ev_sync() -> str:
    sinks = build_ev_sinks()
    targets = (
        ", ".join(
            f"{sink.label}({sink.sessions_table}/{sink.snapshots_table})" for sink in sinks
        )
        or "no sinks (WS block only)"
    )
    return (
        f"EV Wall Connector -> {EV_BASE_URL} "
        f"(charging {EV_POLL_CHARGING_S:.0f}s / idle {EV_POLL_IDLE_S:.0f}s / "
        f"unplugged {EV_POLL_UNPLUGGED_S:.0f}s, timeout {EV_HTTP_TIMEOUT_SECONDS:.0f}s, "
        f"sinks {targets})"
    )
