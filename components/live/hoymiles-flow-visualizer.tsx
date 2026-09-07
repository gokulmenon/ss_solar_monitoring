"use client";

import Image from "next/image";
import dynamic from "next/dynamic";
import { Component, useEffect, useMemo, useState, type ReactNode } from "react";
import { Box, CalendarDays, CloudSun, History, Moon, SlidersHorizontal, Sun, Wifi, type LucideIcon } from "lucide-react";

import manifestJson from "@/assets/site-photos/manifest.json";
import type { EnergyTotals } from "@/lib/daily-energy";
import { getFlowTelemetry } from "@/lib/flow-telemetry";
import { photosForSection, type SitePhotoManifest } from "@/lib/site-photos";
import { getSolarRayCount, getSolarRayPeriod, SOLAR_RAY_COLOR } from "@/lib/solar-rays";
import {
  OVERLAY_EDITOR_CHANGED_EVENT,
  readOverlayEditorEnabled,
} from "@/lib/overlay-editor";
import {
  getSectionPowerW,
  getSectionRatio,
  groupInvertersBySection,
  type SectionInverter,
} from "@/lib/roof-layout";
import { formatPowerKw } from "@/lib/power-flow";

const PowerFlow3DCanvas = dynamic(
  () => import("./hoymiles-flow-3d-canvas").then((mod) => mod.PowerFlow3DCanvas),
  {
    ssr: false,
    loading: () => (
      <div className="absolute inset-0 flex items-center justify-center bg-slate-950 text-xs text-slate-400">
        Loading 3D…
      </div>
    ),
  },
);

const SITE_PHOTO_MANIFEST = manifestJson as SitePhotoManifest;

/**
 * WebGL-failure fallback: if the 3D canvas throws (no WebGL, driver block),
 * drop back to the 2D view instead of blanking the card.
 */
class ThreeErrorBoundary extends Component<{ onFail: () => void; children: ReactNode }> {
  state = { failed: false };

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }

  componentDidCatch(): void {
    this.props.onFail();
  }

  override render(): ReactNode {
    return this.state.failed ? null : this.props.children;
  }
}

type WeatherResponse = {
  latest: {
    temperature_2m: number | null;
  } | null;
};

type HoymilesFlowVisualizerProps = {
  solarProductionW: number;
  homeConsumptionW: number;
  timestamp?: string;
  todaySolarYieldKwh: number | null;
  todayConsumptionKwh: number | null;
  todayNetGridKwh: number | null;
  energyTotals: EnergyTotals;
  connectionLabel: string;
  plantName?: string;
  capacityKw?: number;
  isAdmin?: boolean;
  inverters?: SectionInverter[];
};

type QuadId = "S1" | "P1" | "S2" | "P2";

type QuadPoint = [number, number];

// Panel-string overlay quads (viewBox 0 0 1000 750, y grows down; points run
// around the perimeter). Edit these numbers to move the green overlays — or
// use the on-screen overlay tuner and copy the values back here.
const QUAD_OVERLAYS: { id: QuadId; label: string; points: QuadPoint[] }[] = [
  { id: "S1", label: "Back-face strip", points: [[465, 201], [618, 142], [715, 128], [528, 202]] },
  { id: "P1", label: "Upper face", points: [[548, 208], [832, 95], [922, 184], [643, 302]] },
  { id: "S2", label: "Lower-left eave", points: [[96, 440], [224, 409], [136, 445], [49, 455]] },
  { id: "P2", label: "Garage face", points: [[152, 451], [506, 317], [579, 392], [215, 522]] },
];

const QUAD_TUNER_STORAGE_KEY = "hoymiles-quad-overlays";

// 2D/3D view-mode toggle. A dedicated key (never a reused tuner key) so
// returning browsers pick up the mode without disturbing tuned geometry.
const VIEW_MODE_STORAGE_KEY = "power-flow-3d-mode";
const THEME_STORAGE_KEY = "power-flow-theme-mode";

type FlowTheme = "day" | "night";

function readThemeOverride(): FlowTheme | null {
  try {
    const value = window.localStorage.getItem(THEME_STORAGE_KEY);
    return value === "day" || value === "night" ? value : null;
  } catch {
    return null;
  }
}

/**
 * Synchronous WebGL probe. Error boundaries cannot catch renderer-creation
 * failures that surface outside the render phase, so the toggle is gated on
 * this probe instead of relying on the boundary alone.
 */
function isWebGLAvailable(): boolean {
  try {
    if (typeof document === "undefined") return false;
    const canvas = document.createElement("canvas");
    return !!canvas.getContext("webgl2") || !!canvas.getContext("webgl");
  } catch {
    return false;
  }
}

function defaultQuadPoints(): Record<QuadId, QuadPoint[]> {
  return Object.fromEntries(
    QUAD_OVERLAYS.map((quad) => [quad.id, quad.points.map((point) => [...point] as QuadPoint)]),
  ) as Record<QuadId, QuadPoint[]>;
}

function quadPointsToString(points: QuadPoint[]) {
  return points.map(([x, y]) => `${Math.round(x)},${Math.round(y)}`).join(" ");
}

type FillGeometry = {
  points: string;
  midX: number;
  midY: number;
  angle: number;
};

// Fixed label anchors (viewBox units) for sections whose text sits away from
// the quad: S2 below the swimming pool, S1 above the roof right of the hero.
const SECTION_LABEL_ANCHOR: Partial<Record<QuadId, QuadPoint>> = {
  S1: [445, 245],
  S2: [110, 422],
};

// Battery fill for a slanted quad: a strip growing from one long edge toward
// the other, so the fill surface stays parallel to the eave. P1/P2 fill from
// the bottom edge upward; S1/S2 fill from the top edge downward.
function quadFillGeometry(corners: QuadPoint[], ratio: number, fromTop = false): FillGeometry | null {
  if (corners.length !== 4 || ratio <= 0.005) return null;

  const edges = corners.map((a, i) => ({ a, b: corners[(i + 1) % corners.length] }));
  const length = (edge: { a: QuadPoint; b: QuadPoint }) =>
    Math.hypot(edge.b[0] - edge.a[0], edge.b[1] - edge.a[1]);
  let longest = 0;
  edges.forEach((edge, i) => {
    if (length(edge) > length(edges[longest])) longest = i;
  });
  const opposite = (longest + 2) % edges.length;
  const avgY = (edge: { a: QuadPoint; b: QuadPoint }) => (edge.a[1] + edge.b[1]) / 2;
  const bottom = avgY(edges[longest]) >= avgY(edges[opposite]) ? edges[longest] : edges[opposite];
  const top = bottom === edges[longest] ? edges[opposite] : edges[longest];

  const lerp = (p: QuadPoint, q: QuadPoint): QuadPoint => [
    p[0] + (q[0] - p[0]) * ratio,
    p[1] + (q[1] - p[1]) * ratio,
  ];
  // Pair corners by strip end (projection onto the long axis) instead of edge
  // order: on tapered slivers the short edges run nearly parallel to the long
  // direction, so order-based pairing bowties into triangles. End-based
  // pairing keeps the fill a simple band hugging the fixed edge.
  const axisDx = edges[longest].b[0] - edges[longest].a[0];
  const axisDy = edges[longest].b[1] - edges[longest].a[1];
  const axisLen = Math.hypot(axisDx, axisDy) || 1;
  const project = (p: QuadPoint) => (p[0] * axisDx + p[1] * axisDy) / axisLen;
  const [B0, B1] = project(bottom.a) <= project(bottom.b) ? [bottom.a, bottom.b] : [bottom.b, bottom.a];
  const [T0, T1] = project(top.a) <= project(top.b) ? [top.a, top.b] : [top.b, top.a];
  const lineA = fromTop ? lerp(T0, B0) : lerp(B0, T0);
  const lineB = fromTop ? lerp(T1, B1) : lerp(B1, T1);
  const fixed = fromTop ? [T0, T1] : [B0, B1];
  const points = [fixed[0], fixed[1], lineB, lineA]
    .map(([x, y]) => `${Math.round(x)},${Math.round(y)}`)
    .join(" ");

  const midX = (lineA[0] + lineB[0]) / 2;
  const midY = (lineA[1] + lineB[1]) / 2;
  return { points, midX, midY, angle: quadBottomEdgeAngle(corners) };
}

// Lean of a quad's bottom long edge in degrees, left-to-right. Used for label
// rotation; S2 borrows P2's edge since they share the lower deck and S2's own
// eave is nearly flat.
function quadBottomEdgeAngle(corners: QuadPoint[]): number {
  if (corners.length !== 4) return 0;

  const edges = corners.map((a, i) => ({ a, b: corners[(i + 1) % corners.length] }));
  const length = (edge: { a: QuadPoint; b: QuadPoint }) =>
    Math.hypot(edge.b[0] - edge.a[0], edge.b[1] - edge.a[1]);
  let longest = 0;
  edges.forEach((edge, i) => {
    if (length(edge) > length(edges[longest])) longest = i;
  });
  const opposite = (longest + 2) % edges.length;
  const avgY = (edge: { a: QuadPoint; b: QuadPoint }) => (edge.a[1] + edge.b[1]) / 2;
  const bottom = avgY(edges[longest]) >= avgY(edges[opposite]) ? edges[longest] : edges[opposite];
  const [left, right] = bottom.a[0] <= bottom.b[0] ? [bottom.a, bottom.b] : [bottom.b, bottom.a];
  return (Math.atan2(right[1] - left[1], right[0] - left[0]) * 180) / Math.PI;
}

function loadQuadTunerState(): Record<QuadId, QuadPoint[]> | null {
  try {
    if (typeof window === "undefined") return null;
    const raw = window.localStorage.getItem(QUAD_TUNER_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Record<QuadId, QuadPoint[]>;
    for (const quad of QUAD_OVERLAYS) {
      const points = parsed[quad.id];
      if (
        !Array.isArray(points) ||
        points.length !== 4 ||
        points.some(
          (point) =>
            !Array.isArray(point) ||
            point.length !== 2 ||
            point.some((axis) => typeof axis !== "number" || Number.isNaN(axis)),
        )
      ) {
        return null;
      }
    }
    return parsed;
  } catch {
    return null;
  }
}

const PATH_IDS = {
  runS1: "hoymiles-run-s1-flow",
  runP1: "hoymiles-run-p1-flow",
  runS2: "hoymiles-run-s2-flow",
  runP2: "hoymiles-run-p2-flow",
  trunkUpper: "hoymiles-trunk-upper-flow",
  trunkLower: "hoymiles-trunk-lower-flow",
  gridExport: "hoymiles-grid-export-flow",
  gridImport: "hoymiles-grid-import-flow",
  loads: "hoymiles-loads-flow",
} as const;

type PipeNodeId = "upperMid" | "lowerMid" | "junction" | "combiner";

// One source point per quad; each run flows source -> shared node -> trunk -> combiner.
const RUN_END_NODES: Record<QuadId, "upperMid" | "lowerMid"> = {
  S1: "upperMid",
  P1: "upperMid",
  S2: "lowerMid",
  P2: "lowerMid",
};

const PIPE_NODE_DEFAULTS: Record<PipeNodeId, QuadPoint> = {
  upperMid: [694, 139],
  lowerMid: [340, 378],
  junction: [134, 453],
  combiner: [202, 580],
};

const PIPE_SOURCE_DEFAULTS: Record<QuadId, QuadPoint> = {
  S1: [653, 152],
  P1: [678, 151],
  S2: [179, 426],
  P2: [351, 382],
};

type PipeViaKey = "runS1" | "runP1" | "runS2" | "runP2" | "trunkUpper" | "trunkLower" | "grid" | "loads";

const PIPE_VIA_DEFAULTS: Record<PipeViaKey, QuadPoint[]> = {
  runS1: [],
  runP1: [],
  runS2: [[202, 425], [246, 410]],
  runP2: [],
  trunkUpper: [[525, 209], [520, 308]],
  trunkLower: [[129, 519], [174, 539]],
  grid: [[145, 595], [80, 560], [80, 700]],
  loads: [[259, 558]],
};

const PIPE_END_DEFAULTS: Record<"grid" | "loads", QuadPoint> = {
  grid: [-1, 720],
  loads: [354, 525],
};

type PipeState = {
  nodes: Record<PipeNodeId, QuadPoint>;
  sources: Record<QuadId, QuadPoint>;
  via: Record<PipeViaKey, QuadPoint[]>;
  ends: Record<"grid" | "loads", QuadPoint>;
};

const PIPE_TUNER_STORAGE_KEY = "hoymiles-pipe-routes-v2";

function copyPipePoints(points: QuadPoint[]): QuadPoint[] {
  return points.map((point) => [...point] as QuadPoint);
}

function defaultPipeState(): PipeState {
  return {
    nodes: Object.fromEntries(
      Object.entries(PIPE_NODE_DEFAULTS).map(([id, point]) => [id, [...point] as QuadPoint]),
    ) as Record<PipeNodeId, QuadPoint>,
    sources: Object.fromEntries(
      Object.entries(PIPE_SOURCE_DEFAULTS).map(([id, point]) => [id, [...point] as QuadPoint]),
    ) as Record<QuadId, QuadPoint>,
    via: Object.fromEntries(
      Object.entries(PIPE_VIA_DEFAULTS).map(([id, points]) => [id, copyPipePoints(points)]),
    ) as Record<PipeViaKey, QuadPoint[]>,
    ends: Object.fromEntries(
      Object.entries(PIPE_END_DEFAULTS).map(([id, point]) => [id, [...point] as QuadPoint]),
    ) as Record<"grid" | "loads", QuadPoint>,
  };
}

function buildPipeD(points: QuadPoint[]) {
  return points.map(([x, y], index) => `${index === 0 ? "M" : "L"} ${Math.round(x)} ${Math.round(y)}`).join(" ");
}

function isQuadPoint(value: unknown): value is QuadPoint {
  return (
    Array.isArray(value) &&
    value.length === 2 &&
    value.every((axis) => typeof axis === "number" && Number.isFinite(axis))
  );
}

function loadPipeTunerState(): PipeState | null {
  try {
    if (typeof window === "undefined") return null;
    const raw = window.localStorage.getItem(PIPE_TUNER_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<PipeState>;
    if (!parsed || typeof parsed !== "object") return null;
    const { nodes, sources, via, ends } = parsed;
    if (!nodes || !sources || !via || !ends) return null;
    const nodeIds: PipeNodeId[] = ["upperMid", "lowerMid", "junction", "combiner"];
    const quadIds: QuadId[] = ["S1", "P1", "S2", "P2"];
    const viaKeys = Object.keys(PIPE_VIA_DEFAULTS) as PipeViaKey[];
    if (
      !nodeIds.every((id) => isQuadPoint(nodes[id])) ||
      !quadIds.every((id) => isQuadPoint(sources[id])) ||
      !viaKeys.every((key) => Array.isArray(via[key]) && via[key].every(isQuadPoint)) ||
      !isQuadPoint(ends.grid) ||
      !isQuadPoint(ends.loads)
    ) {
      return null;
    }
    return { nodes, sources, via, ends } as PipeState;
  } catch {
    return null;
  }
}

type InfoBoxId = "title" | "status" | "hero" | "grid" | "loads";

type InfoBox = { x: number; y: number; scale: number };

const INFO_BOX_ANCHOR: Record<InfoBoxId, "left" | "right"> = {
  title: "left",
  status: "right",
  hero: "left",
  grid: "left",
  loads: "right",
};

const INFO_BOX_LABELS: Record<InfoBoxId, string> = {
  title: "Title card",
  status: "Gateway + weather",
  hero: "Hero power + ratio",
  grid: "Grid badge",
  loads: "Loads badge",
};

// x/y are % from the anchored edge (left/right) and top; scale is %. Defaults
// reproduce the current layout exactly.
const INFO_BOX_DEFAULTS: Record<InfoBoxId, InfoBox> = {
  title: { x: 2, y: 3, scale: 100 },
  status: { x: 2, y: 3, scale: 100 },
  hero: { x: 42, y: 7, scale: 73 },
  grid: { x: 15, y: 88, scale: 80 },
  loads: { x: 51, y: 63, scale: 80 },
};

const INFO_BOX_STORAGE_KEY = "hoymiles-infobox-layout-v1";

function defaultInfoBoxes(): Record<InfoBoxId, InfoBox> {
  return Object.fromEntries(
    Object.entries(INFO_BOX_DEFAULTS).map(([id, box]) => [id, { ...box }]),
  ) as Record<InfoBoxId, InfoBox>;
}

function loadInfoBoxState(): Record<InfoBoxId, InfoBox> | null {
  try {
    if (typeof window === "undefined") return null;
    const raw = window.localStorage.getItem(INFO_BOX_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<Record<InfoBoxId, InfoBox>>;
    if (!parsed || typeof parsed !== "object") return null;
    const ids: InfoBoxId[] = ["title", "status", "hero", "grid", "loads"];
    if (
      !ids.every(
        (id) =>
          parsed[id] &&
          typeof parsed[id].x === "number" &&
          Number.isFinite(parsed[id].x) &&
          typeof parsed[id].y === "number" &&
          Number.isFinite(parsed[id].y) &&
          typeof parsed[id].scale === "number" &&
          Number.isFinite(parsed[id].scale) &&
          parsed[id].scale > 0,
      )
    ) {
      return null;
    }
    return parsed as Record<InfoBoxId, InfoBox>;
  } catch {
    return null;
  }
}

function formatTimestamp(timestamp?: string) {
  if (!timestamp) return "Awaiting update";

  return new Date(timestamp).toLocaleTimeString([], {
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
  });
}

function formatEnergy(kwh: number, unit: "kWh" | "MWh") {
  const value = unit === "MWh" ? kwh / 1000 : kwh;
  return `${value.toFixed(2)} ${unit}`;
}

function FlowParticles({
  pathId,
  color,
  duration,
  reverse = false,
}: {
  pathId: string;
  color: string;
  duration: string;
  reverse?: boolean;
}) {
  return (
    <>
      {["0s", "-0.62s", "-1.24s"].map((begin) => (
        <circle key={begin} r="7" fill={color} className="hoymiles-flow-particle">
          <animateMotion
            dur={`${duration}s`}
            begin={begin}
            calcMode="linear"
            keyPoints={reverse ? "1;0" : "0;1"}
            keyTimes="0;1"
            repeatCount="indefinite"
          >
            <mpath href={`#${pathId}`} />
          </animateMotion>
        </circle>
      ))}
    </>
  );
}

const SOLAR_RAY_LANES = [
  { fromX: 185, fromY: 34, toX: 250, toY: 404 },
  { fromX: 270, fromY: 26, toX: 330, toY: 368 },
  { fromX: 365, fromY: 38, toX: 430, toY: 333 },
  { fromX: 468, fromY: 22, toX: 535, toY: 292 },
  { fromX: 565, fromY: 28, toX: 612, toY: 234 },
  { fromX: 654, fromY: 20, toX: 704, toY: 218 },
  { fromX: 752, fromY: 34, toX: 790, toY: 183 },
  { fromX: 842, fromY: 24, toX: 852, toY: 161 },
  { fromX: 160, fromY: 104, toX: 205, toY: 480 },
  { fromX: 355, fromY: 95, toX: 385, toY: 522 },
  { fromX: 548, fromY: 92, toX: 575, toY: 578 },
  { fromX: 744, fromY: 105, toX: 700, toY: 614 },
  { fromX: 910, fromY: 90, toX: 820, toY: 552 },
  { fromX: 965, fromY: 148, toX: 890, toY: 620 },
] as const;

function usePrefersReducedMotion() {
  const [reduced, setReduced] = useState(false);

  useEffect(() => {
    const query = window.matchMedia("(prefers-reduced-motion: reduce)");
    setReduced(query.matches);
    const onChange = (event: MediaQueryListEvent) => setReduced(event.matches);
    query.addEventListener("change", onChange);
    return () => query.removeEventListener("change", onChange);
  }, []);

  return reduced;
}

function SolarRayOverlay({ solarW, active }: { solarW: number; active: boolean }) {
  const reducedMotion = usePrefersReducedMotion();
  const count = getSolarRayCount(active ? solarW : 0);
  const period = getSolarRayPeriod(solarW);

  if (count === 0) return null;

  return (
    <g aria-hidden="true" filter="url(#hoymiles-flow-glow)">
      {SOLAR_RAY_LANES.slice(0, count).map((ray, index) => (
        <circle
          key={`${ray.fromX}-${ray.toX}`}
          cx={ray.fromX}
          cy={reducedMotion ? ray.toY : ray.fromY}
          r="5.5"
          fill={SOLAR_RAY_COLOR}
          fillOpacity="0.68"
        >
          {!reducedMotion ? (
            <>
              <animate
                attributeName="cy"
                values={`${ray.fromY};${ray.toY};${ray.fromY}`}
                dur={`${period}s`}
                begin={`-${((index * period) / count).toFixed(2)}s`}
                repeatCount="indefinite"
                calcMode="ease-in-out"
              />
              <animate
                attributeName="opacity"
                values="0.25;0.9;0.25"
                dur={`${period}s`}
                begin={`-${((index * period) / count).toFixed(2)}s`}
                repeatCount="indefinite"
              />
            </>
          ) : null}
        </circle>
      ))}
    </g>
  );
}

const NIGHT_WINDOW_GLOWS = [
  { x: 117, y: 529, width: 32, height: 51 },
  { x: 452, y: 247, width: 22, height: 40 },
  { x: 592, y: 321, width: 25, height: 44 },
  { x: 711, y: 281, width: 57, height: 59 },
  { x: 862, y: 226, width: 58, height: 69 },
  { x: 470, y: 451, width: 89, height: 78 },
  { x: 671, y: 389, width: 145, height: 51 },
] as const;

function NightWindowOverlay({ active }: { active: boolean }) {
  return (
    <g
      aria-hidden="true"
      opacity={active ? 1 : 0}
      style={{ transition: "opacity 700ms ease" }}
    >
      {NIGHT_WINDOW_GLOWS.map((window) => (
        <rect
          key={`${window.x}-${window.y}`}
          x={window.x}
          y={window.y}
          width={window.width}
          height={window.height}
          rx="3"
          fill="#ffd97a"
          fillOpacity="0.34"
        />
      ))}
    </g>
  );
}

function DayWindowToneOverlay({ active }: { active: boolean }) {
  return (
    <g aria-hidden="true" opacity={active ? 0.16 : 0} style={{ transition: "opacity 700ms ease" }}>
      {NIGHT_WINDOW_GLOWS.map((window) => (
        <rect
          key={`${window.x}-${window.y}`}
          x={window.x}
          y={window.y}
          width={window.width}
          height={window.height}
          rx="3"
          fill="#0f172a"
        />
      ))}
    </g>
  );
}

function SemiGauge({ value, label }: { value: number; label: string }) {
  const radius = 39;
  const circumference = Math.PI * radius;
  const dashOffset = circumference - (value / 100) * circumference;

  return (
    <div className="shrink-0 text-center">
      <svg viewBox="0 0 104 62" className="h-16 w-28" aria-label={`${value.toFixed(0)}% self-consumption`}>
        <path d="M13 54 A39 39 0 0 1 91 54" fill="none" stroke="rgba(148, 163, 184, 0.22)" strokeWidth="10" strokeLinecap="round" />
        <path d="M13 54 A39 39 0 0 1 91 54" fill="none" stroke="#34d399" strokeWidth="10" strokeLinecap="round" strokeDasharray={circumference} strokeDashoffset={dashOffset} className="transition-[stroke-dashoffset] duration-700" />
        <text x="52" y="48" textAnchor="middle" className="fill-white text-[16px] font-semibold">{value.toFixed(0)}%</text>
      </svg>
      <p className="-mt-1 text-[9px] uppercase tracking-[0.12em] text-slate-400">{label}</p>
    </div>
  );
}

function XyInput({
  label,
  point,
  onChange,
}: {
  label: string;
  point: QuadPoint;
  onChange: (axis: 0 | 1, value: number) => void;
}) {
  const [x, y] = point;
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-1">
      <span className="shrink-0 text-[10px] text-slate-500">{label}</span>
      <input
        type="number"
        value={Math.round(x)}
        onChange={(event) => {
          const value = event.target.value === "" ? NaN : Number(event.target.value);
          if (!Number.isNaN(value)) onChange(0, value);
        }}
        className="w-14 shrink-0 rounded-md border border-white/10 bg-slate-950 px-1.5 py-1 text-xs text-white"
        aria-label={`${label} x`}
      />
      <input
        type="number"
        value={Math.round(y)}
        onChange={(event) => {
          const value = event.target.value === "" ? NaN : Number(event.target.value);
          if (!Number.isNaN(value)) onChange(1, value);
        }}
        className="w-14 shrink-0 rounded-md border border-white/10 bg-slate-950 px-1.5 py-1 text-xs text-white"
        aria-label={`${label} y`}
      />
    </div>
  );
}

function ViaPointList({
  title,
  hint,
  points,
  anchor,
  onChange,
}: {
  title: string;
  hint: string;
  points: QuadPoint[];
  anchor: QuadPoint;
  onChange: (next: QuadPoint[]) => void;
}) {
  return (
    <div className="rounded-xl border border-white/10 bg-slate-900/50 p-2">
      <div className="mb-2 flex items-center justify-between gap-2">
        <p className="text-xs font-semibold text-slate-200">
          {title} <span className="font-normal text-slate-500">{hint}</span>
        </p>
        <button
          type="button"
          onClick={() => onChange([...points, [...(points[points.length - 1] ?? anchor)] as QuadPoint])}
          className="rounded-full border border-white/10 bg-white/[0.04] px-2 py-0.5 text-[10px] text-slate-300"
        >
          + Point
        </button>
      </div>
      {points.length === 0 ? (
        <p className="text-[10px] text-slate-500">Direct run — no midpoints. Add one to bend the pipe.</p>
      ) : (
        <div className="grid grid-cols-1 gap-2">
          {points.map(([x, y], index) => (
            <div key={index} className="flex items-center gap-1">
              <XyInput
                label={`${title} J${index + 1}`}
                point={[x, y]}
                onChange={(axis, value) =>
                  onChange(points.map((p, i) => (i === index ? ([axis === 0 ? value : p[0], axis === 1 ? value : p[1]] as QuadPoint) : p)))
                }
              />
              <button
                type="button"
                onClick={() => onChange(points.filter((_, i) => i !== index))}
                className="rounded-full border border-white/10 bg-white/[0.04] px-1.5 py-0.5 text-[10px] text-slate-400"
                aria-label={`Remove ${title} point ${index + 1}`}
              >
                ×
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export function HoymilesFlowVisualizer({
  solarProductionW,
  homeConsumptionW,
  timestamp,
  todaySolarYieldKwh,
  todayConsumptionKwh,
  todayNetGridKwh,
  energyTotals,
  connectionLabel,
  plantName = "Gokul Menon",
  capacityKw = 20.02,
  isAdmin = false,
  inverters = [],
}: HoymilesFlowVisualizerProps) {
  const [temperatureC, setTemperatureC] = useState<number | null>(null);
  const [overlayEditorEnabled, setOverlayEditorEnabled] = useState(false);
  const showEditorTools = isAdmin && overlayEditorEnabled;

  useEffect(() => {
    setOverlayEditorEnabled(readOverlayEditorEnabled());

    function sync() {
      setOverlayEditorEnabled(readOverlayEditorEnabled());
    }

    window.addEventListener("storage", sync);
    window.addEventListener(OVERLAY_EDITOR_CHANGED_EVENT, sync);
    return () => {
      window.removeEventListener("storage", sync);
      window.removeEventListener(OVERLAY_EDITOR_CHANGED_EVENT, sync);
    };
  }, []);

  const [is3DMode, setIs3DMode] = useState(false);

  const [webglBlocked, setWebglBlocked] = useState(false);

  useEffect(() => {
    try {
      if (window.localStorage.getItem(VIEW_MODE_STORAGE_KEY) !== "1") return;
      if (!isWebGLAvailable()) {
        setWebglBlocked(true);
        return;
      }
      setIs3DMode(true);
    } catch {
      // Storage unavailable — default to the 2D view.
    }
  }, []);

  useEffect(() => {
    try {
      window.localStorage.setItem(VIEW_MODE_STORAGE_KEY, is3DMode ? "1" : "0");
    } catch {
      // Storage unavailable — the toggle still works for the session.
    }
  }, [is3DMode]);

  const [tunerOpen, setTunerOpen] = useState(false);
  const [quadPoints, setQuadPoints] = useState<Record<QuadId, QuadPoint[]>>(defaultQuadPoints);
  const [copiedQuad, setCopiedQuad] = useState<string | null>(null);

  useEffect(() => {
    const saved = loadQuadTunerState();
    if (saved) setQuadPoints(saved);
  }, []);

  useEffect(() => {
    try {
      window.localStorage.setItem(QUAD_TUNER_STORAGE_KEY, JSON.stringify(quadPoints));
    } catch {
      // Storage unavailable (private mode, etc.) — tuner still works for the session.
    }
  }, [quadPoints]);

  function setQuadPoint(id: QuadId, index: number, axis: 0 | 1, value: number) {
    if (Number.isNaN(value)) return;
    setQuadPoints((prev) => {
      const next = { ...prev, [id]: prev[id].map((point) => [...point] as QuadPoint) };
      next[id][index][axis] = value;
      return next;
    });
  }

  function resetQuadPoints() {
    setQuadPoints(defaultQuadPoints());
    try {
      window.localStorage.removeItem(QUAD_TUNER_STORAGE_KEY);
    } catch {
      // Ignore storage failures; state reset is what matters.
    }
  }

  const [pipeTunerOpen, setPipeTunerOpen] = useState(false);
  const [pipes, setPipes] = useState<PipeState>(defaultPipeState);

  useEffect(() => {
    const saved = loadPipeTunerState();
    if (saved) setPipes(saved);
  }, []);

  useEffect(() => {
    try {
      window.localStorage.setItem(PIPE_TUNER_STORAGE_KEY, JSON.stringify(pipes));
    } catch {
      // Storage unavailable — pipe tuner still works for the session.
    }
  }, [pipes]);

  function runLine(id: QuadId): QuadPoint[] {
    return [pipes.sources[id], ...pipes.via[`run${id}` as PipeViaKey], pipes.nodes[RUN_END_NODES[id]]];
  }

  const trunkUpperLine: QuadPoint[] = [
    pipes.nodes.upperMid,
    ...pipes.via.trunkUpper,
    pipes.nodes.lowerMid,
    pipes.nodes.junction,
  ];
  const trunkLowerLine: QuadPoint[] = [
    pipes.nodes.junction,
    ...pipes.via.trunkLower,
    pipes.nodes.combiner,
  ];
  const gridLine: QuadPoint[] = [pipes.nodes.combiner, ...pipes.via.grid, pipes.ends.grid];
  const loadsLine: QuadPoint[] = [pipes.nodes.combiner, ...pipes.via.loads, pipes.ends.loads];

  function setPipeNode(id: PipeNodeId, axis: 0 | 1, value: number) {
    setPipes((prev) => ({
      ...prev,
      nodes: { ...prev.nodes, [id]: [axis === 0 ? value : prev.nodes[id][0], axis === 1 ? value : prev.nodes[id][1]] as QuadPoint },
    }));
  }

  function setPipeSource(id: QuadId, axis: 0 | 1, value: number) {
    setPipes((prev) => ({
      ...prev,
      sources: { ...prev.sources, [id]: [axis === 0 ? value : prev.sources[id][0], axis === 1 ? value : prev.sources[id][1]] as QuadPoint },
    }));
  }

  function setPipeVia(key: PipeViaKey, next: QuadPoint[]) {
    setPipes((prev) => ({ ...prev, via: { ...prev.via, [key]: next } }));
  }

  function setPipeEnd(key: "grid" | "loads", axis: 0 | 1, value: number) {
    setPipes((prev) => ({
      ...prev,
      ends: { ...prev.ends, [key]: [axis === 0 ? value : prev.ends[key][0], axis === 1 ? value : prev.ends[key][1]] as QuadPoint },
    }));
  }

  function resetPipes() {
    setPipes(defaultPipeState());
    try {
      window.localStorage.removeItem(PIPE_TUNER_STORAGE_KEY);
    } catch {
      // Ignore storage failures; state reset is what matters.
    }
  }

  const [boxTunerOpen, setBoxTunerOpen] = useState(false);
  const [infoBoxes, setInfoBoxes] = useState<Record<InfoBoxId, InfoBox>>(defaultInfoBoxes);

  useEffect(() => {
    const saved = loadInfoBoxState();
    if (saved) setInfoBoxes(saved);
  }, []);

  useEffect(() => {
    try {
      window.localStorage.setItem(INFO_BOX_STORAGE_KEY, JSON.stringify(infoBoxes));
    } catch {
      // Storage unavailable — box tuner still works for the session.
    }
  }, [infoBoxes]);

  function infoStyle(id: InfoBoxId) {
    const box = infoBoxes[id];
    return {
      ...(INFO_BOX_ANCHOR[id] === "left" ? { left: `${box.x}%` } : { right: `${box.x}%` }),
      top: `${box.y}%`,
      scale: `${box.scale / 100}`,
    };
  }

  function setInfoBox(id: InfoBoxId, field: "x" | "y" | "scale", value: number) {
    if (Number.isNaN(value) || (field === "scale" && value <= 0)) return;
    setInfoBoxes((prev) => ({ ...prev, [id]: { ...prev[id], [field]: value } }));
  }

  function resetInfoBoxes() {
    setInfoBoxes(defaultInfoBoxes());
    try {
      window.localStorage.removeItem(INFO_BOX_STORAGE_KEY);
    } catch {
      // Ignore storage failures; state reset is what matters.
    }
  }

  function copyQuadText(text: string, tag: string) {
    const done = () => {
      setCopiedQuad(tag);
      window.setTimeout(() => {
        setCopiedQuad((current) => (current === tag ? null : current));
      }, 1500);
    };
    const legacyCopy = () => {
      const area = document.createElement("textarea");
      area.value = text;
      document.body.appendChild(area);
      area.select();
      document.execCommand("copy");
      area.remove();
      done();
    };
    if (navigator.clipboard?.writeText) {
      navigator.clipboard.writeText(text).then(done, legacyCopy);
    } else {
      legacyCopy();
    }
  }

  // Sync adaptation: grid is derived (home − solar), capacityKw → 20.02.
  const flow = getFlowTelemetry({
    solarW: solarProductionW,
    homeW: homeConsumptionW,
    capacityKw,
  });
  const {
    trueSolarW,
    trueHomeW,
    trueGridW,
    gridState,
    solarActive,
    loadsActive,
    solarDuration,
    gridDuration,
    loadDuration,
    selfConsumption,
    powerRatio,
  } = flow;
  // Solar telemetry is the automatic theme source: any meaningful panel
  // output is daytime, and zero output is nighttime. A user toggle persists
  // an explicit override until they choose the other theme.
  const [themeOverride, setThemeOverride] = useState<FlowTheme | null>(null);
  const activeTheme = themeOverride ?? (solarActive ? "day" : "night");
  const nightMode = activeTheme === "night";

  useEffect(() => {
    setThemeOverride(readThemeOverride());
  }, []);

  function toggleTheme() {
    const nextTheme: FlowTheme = nightMode ? "day" : "night";
    setThemeOverride(nextTheme);
    try {
      window.localStorage.setItem(THEME_STORAGE_KEY, nextTheme);
    } catch {
      // Storage unavailable — the toggle still works for the session.
    }
  }
  const gridTone = gridState === "exporting" ? "text-emerald-300" : gridState === "importing" ? "text-amber-300" : "text-slate-300";
  const gridDotTone = gridState === "exporting" ? "bg-emerald-400" : gridState === "importing" ? "bg-amber-400" : "bg-slate-400";
  const gridLabel = gridState === "exporting" ? "Exporting" : gridState === "importing" ? "Importing" : "Balanced";
  const todayGridLabel =
    typeof todayNetGridKwh !== "number"
      ? "Net grid"
      : todayNetGridKwh > 0.001
        ? "Net export"
        : todayNetGridKwh < -0.001
          ? "Net consumption"
          : "Net grid";

  useEffect(() => {
    const controller = new AbortController();

    async function loadTemperature() {
      try {
        const response = await fetch("/api/weather/latest", {
          cache: "no-store",
          signal: controller.signal,
        });
        if (!response.ok) return;

        const payload = (await response.json()) as WeatherResponse;
        setTemperatureC(payload.latest?.temperature_2m ?? null);
      } catch (error) {
        if ((error as Error).name !== "AbortError") console.error(error);
      }
    }

    void loadTemperature();
    const interval = window.setInterval(loadTemperature, 5 * 60 * 1000);

    return () => {
      controller.abort();
      window.clearInterval(interval);
    };
  }, []);

  const temperatureLabel = useMemo(
    () => (typeof temperatureC === "number" ? `${temperatureC.toFixed(0)} °C` : "Weather —"),
    [temperatureC],
  );

  // Per-section power drives the P1/P2 battery-style quad fills.
  const sectionPowerW = useMemo(() => {
    const { sections } = groupInvertersBySection(inverters);
    return {
      S1: getSectionPowerW(sections.S1),
      P1: getSectionPowerW(sections.P1),
      S2: getSectionPowerW(sections.S2),
      P2: getSectionPowerW(sections.P2),
    };
  }, [inverters]);

  const sectionRatios = useMemo(
    () => ({
      S1: getSectionRatio("S1", sectionPowerW.S1),
      P1: getSectionRatio("P1", sectionPowerW.P1),
      S2: getSectionRatio("S2", sectionPowerW.S2),
      P2: getSectionRatio("P2", sectionPowerW.P2),
    }),
    [sectionPowerW],
  );

  return (
    <section aria-label="Live home energy flow" className="space-y-3">
      <div className={showEditorTools ? "grid gap-3 lg:grid-cols-[minmax(0,34rem)_minmax(20rem,1fr)] lg:items-start" : ""}>
      <div className={showEditorTools ? "relative mx-auto w-full max-w-xl overflow-hidden rounded-[1.75rem] border border-white/10 bg-slate-950 shadow-[0_28px_80px_rgba(2,6,23,0.6)] aspect-[4/3] lg:mx-0" : "relative mx-auto w-full max-w-xl overflow-hidden rounded-[1.75rem] border border-white/10 bg-slate-950 shadow-[0_28px_80px_rgba(2,6,23,0.6)] aspect-[4/3]"}>
        {is3DMode ? (
          <ThreeErrorBoundary
            onFail={() => {
              setWebglBlocked(true);
              setIs3DMode(false);
            }}
          >
            <PowerFlow3DCanvas
              telemetry={flow}
              sectionPowerW={sectionPowerW}
              sectionRatios={sectionRatios}
              nightMode={nightMode}
            />
          </ThreeErrorBoundary>
        ) : (
          <>
        <Image
          alt="Isometric view of the home energy system"
          className="object-cover transition-[filter] duration-700"
          fill
          priority
          sizes="(max-width: 640px) 100vw, 576px"
          src="/images/house-base.webp"
          style={{
            filter: nightMode
              ? "brightness(0.48) saturate(0.72) hue-rotate(8deg)"
              : "brightness(1.08) saturate(0.96)",
          }}
        />
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-0 transition-opacity duration-700"
          style={{
            background: "linear-gradient(180deg, rgba(7, 21, 43, 0.64), rgba(2, 6, 23, 0.28) 48%, rgba(3, 7, 18, 0.72))",
            mixBlendMode: "multiply",
            opacity: nightMode ? 1 : 0,
          }}
        />
        <div className="absolute inset-0 bg-gradient-to-b from-slate-950/38 via-transparent to-slate-950/20" />

        <svg
          aria-hidden="true"
          className="pointer-events-none absolute inset-0 h-full w-full"
          viewBox="0 0 1000 750"
          preserveAspectRatio="xMidYMid slice"
        >
          <defs>
            <filter id="hoymiles-flow-glow" x="-100%" y="-100%" width="300%" height="300%">
              <feGaussianBlur stdDeviation="9" result="blur" />
              <feMerge>
                <feMergeNode in="blur" />
                <feMergeNode in="SourceGraphic" />
              </feMerge>
            </filter>
          </defs>

          <DayWindowToneOverlay active={!nightMode} />
          <NightWindowOverlay active={nightMode} />
          <SolarRayOverlay solarW={trueSolarW} active={solarActive} />

          {/* PANEL STRING OVERLAYS spanning the full roof faces, hip corner
              to eave corner (img px * 0.9766 = viewBox). P1 covers the
              whole upper front face; P2 the whole garage face. The S1
              (back-face strip along the far eave) and S2 (lower-left
              eave run) slivers are drawn first so they tuck behind
              the big faces. */}
          <g>
            {QUAD_OVERLAYS.map((quad) => (
              <polygon
                key={quad.id}
                points={quadPointsToString(quadPoints[quad.id])}
                fill="rgba(52,211,153,0.20)"
                stroke="#6ee7b7"
                strokeWidth="2.5"
                strokeLinejoin="round"
                opacity={solarActive ? 0.95 : 0.3}
              />
            ))}
          </g>

          {/* Battery-style section fills: P1/P2 rise from the bottom long edge
              with the section kW and % riding above the fill line; S1/S2
              descend from the top long edge with detached labels (S2 below
              the pool, S1 above the roof right of the hero). */}
          {QUAD_OVERLAYS.map((quad) => {
            const fromTop = quad.id === "S1" || quad.id === "S2";
            const fill = quadFillGeometry(quadPoints[quad.id], sectionRatios[quad.id], fromTop);
            if (!fill) return null;
            const anchor = SECTION_LABEL_ANCHOR[quad.id];
            const labelX = anchor ? anchor[0] : fill.midX;
            const labelY = anchor ? anchor[1] : fill.midY - 30;
            const labelAngle = quad.id === "S2" ? quadBottomEdgeAngle(quadPoints.P2) : fill.angle;
            const label = `${(sectionPowerW[quad.id] / 1000).toFixed(2)} kW ${Math.round(sectionRatios[quad.id] * 100)}%`;
            return (
              <g key={`fill-${quad.id}`} opacity="0.85">
                <polygon points={fill.points} fill="rgba(52,211,153,0.35)" />
                <text
                  x={labelX}
                  y={labelY}
                  textAnchor="middle"
                  transform={`rotate(${labelAngle.toFixed(1)} ${labelX.toFixed(1)} ${labelY.toFixed(1)})`}
                  fill="#ffffff"
                  fillOpacity="0.9"
                  fontSize="16"
                  fontWeight="600"
                  stroke="rgba(5,46,34,0.65)"
                  strokeWidth="1"
                  paintOrder="stroke"
                >
                  {label}
                </text>
              </g>
            );
          })}

          {/* Photo-calibration chips (admin overlay-editor only): pin each
              quad to the site photos covering it, from the committed manifest.
              Centroids derive from live tuner points so tuner moves carry them. */}
          {showEditorTools
            ? QUAD_OVERLAYS.map((quad) => {
                const corners = quadPoints[quad.id];
                const midX = corners.reduce((sum, [x]) => sum + x, 0) / corners.length;
                const midY = corners.reduce((sum, [, y]) => sum + y, 0) / corners.length;
                const covering = photosForSection(SITE_PHOTO_MANIFEST, quad.id).map(
                  (photo) => photo.id,
                );
                const chip = `${quad.id} · ${covering.length > 0 ? covering.join(" ") : "no photo"}`;
                return (
                  <g key={`photo-${quad.id}`} opacity="0.92">
                    <rect
                      x={midX - 62}
                      y={midY - 13}
                      width={124}
                      height={24}
                      rx={7}
                      fill="rgba(2, 6, 23, 0.82)"
                      stroke="rgba(125, 211, 252, 0.55)"
                      strokeWidth="1.5"
                    />
                    <text
                      x={midX}
                      y={midY + 4.5}
                      textAnchor="middle"
                      fill="#e0f2fe"
                      fontSize="13"
                      fontWeight="600"
                    >
                      {chip}
                    </text>
                  </g>
                );
              })
            : null}

          {/* ISOMETRIC CONDUIT PATHS: one source run per quad (S1/P1 -> upper
              node, S2/P2 -> lower node), shared trunk to the junction dot,
              then into the accumulator (lightning combiner). Geometry comes
              from pipe state so the pipe tuner can move every joint. */}
          <g filter="url(#hoymiles-flow-glow)">
            {(["S1", "P1", "S2", "P2"] as QuadId[]).map((id) => (
              <path
                key={PATH_IDS[`run${id}` as "runS1" | "runP1" | "runS2" | "runP2"]}
                id={PATH_IDS[`run${id}` as "runS1" | "runP1" | "runS2" | "runP2"]}
                d={buildPipeD(runLine(id))}
                className="hoymiles-energy-line"
                stroke="#34d399"
                opacity={solarActive ? 1 : 0.2}
              />
            ))}

            {/* Shared trunk: upper node down to the lower node, then to the junction dot */}
            <path id={PATH_IDS.trunkUpper} d={buildPipeD(trunkUpperLine)} className="hoymiles-energy-line hoymiles-energy-collector" stroke="#34d399" opacity={solarActive ? 1 : 0.2} />

            {/* Single trunk: junction dot to the accumulator (lightning combiner) on the left wall */}
            <path id={PATH_IDS.trunkLower} d={buildPipeD(trunkLowerLine)} className="hoymiles-energy-line hoymiles-energy-collector" stroke="#34d399" opacity={solarActive ? 1 : 0.2} />

            {/* Grid leaves the combiner through the exchange point beside the left-wall window. */}
            <path id={PATH_IDS.gridExport} d={buildPipeD(gridLine)} className="hoymiles-energy-line" stroke="#10b981" opacity={gridState === "exporting" ? 1 : 0.16} />
            <path id={PATH_IDS.gridImport} d={buildPipeD(gridLine)} className="hoymiles-energy-line" stroke="#f59e0b" opacity={gridState === "importing" ? 1 : 0.16} />

            {/* Home Loads Path (Sweeps across garage/driveway seam into living room) */}
            <path id={PATH_IDS.loads} d={buildPipeD(loadsLine)} className="hoymiles-energy-line" stroke="#34d399" opacity={loadsActive ? 1 : 0.18} />
          </g>

          {solarActive ? <FlowParticles pathId={PATH_IDS.runS1} color="#86efac" duration={solarDuration} /> : null}
          {solarActive ? <FlowParticles pathId={PATH_IDS.runP1} color="#86efac" duration={solarDuration} /> : null}
          {solarActive ? <FlowParticles pathId={PATH_IDS.runS2} color="#86efac" duration={solarDuration} /> : null}
          {solarActive ? <FlowParticles pathId={PATH_IDS.runP2} color="#86efac" duration={solarDuration} /> : null}
          {solarActive ? <FlowParticles pathId={PATH_IDS.trunkUpper} color="#6ee7b7" duration={solarDuration} /> : null}
          {solarActive ? <FlowParticles pathId={PATH_IDS.trunkLower} color="#6ee7b7" duration={solarDuration} /> : null}
          {gridState === "exporting" ? <FlowParticles pathId={PATH_IDS.gridExport} color="#34d399" duration={gridDuration} /> : null}
          {gridState === "importing" ? <FlowParticles pathId={PATH_IDS.gridImport} color="#fbbf24" duration={gridDuration} reverse /> : null}
          {loadsActive ? <FlowParticles pathId={PATH_IDS.loads} color="#6ee7b7" duration={loadDuration} /> : null}

          {/* COMBINER JUNCTION BOX ON LEFT WALL — markers follow pipe nodes */}
          <g filter="url(#hoymiles-flow-glow)">
            <circle cx={pipes.nodes.upperMid[0]} cy={pipes.nodes.upperMid[1]} r="5" fill="#d1fae5" stroke="#34d399" strokeWidth="2.5" />
            <circle cx={pipes.nodes.lowerMid[0]} cy={pipes.nodes.lowerMid[1]} r="5" fill="#d1fae5" stroke="#34d399" strokeWidth="2.5" />
            <circle cx={pipes.nodes.junction[0]} cy={pipes.nodes.junction[1]} r="7" fill="#d1fae5" stroke="#34d399" strokeWidth="3" />
            <g transform={`translate(${pipes.nodes.combiner[0] - 220} ${pipes.nodes.combiner[1] - 580})`}>
              <circle cx="220" cy="580" r="18" fill="#082f24" stroke="#6ee7b7" strokeWidth="4" />
              <path d="M219 566 L209 584 H219 L215 595 L231 577 H222 L227 566 Z" fill="#d1fae5" />
              <text x="220" y="607" textAnchor="middle" className="fill-emerald-50 text-[10px] font-semibold">COMBINER</text>
            </g>
            <rect x="64" y="544" width="32" height="32" rx="8" fill="#172554" stroke="#7dd3fc" strokeWidth="3" />
            <path d="M71 555 H88 M85 551 L89 555 L85 559 M90 569 H73 M76 565 L72 569 L76 573" stroke="#e0f2fe" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
            <text x="80" y="591" textAnchor="middle" className="fill-sky-100 text-[10px] font-semibold">EXCHANGE</text>
          </g>
        </svg>
          </>
        )}

        <div style={infoStyle("title")} className="absolute max-w-[43%] rounded-xl border border-white/10 bg-slate-950/80 px-2.5 py-1.5 shadow-lg backdrop-blur-md">
          <p className="truncate text-xs font-semibold text-white">{plantName}</p>
          <p className="mt-0.5 text-[9px] font-medium text-slate-300">Live · {formatTimestamp(timestamp)}</p>
          <p className="mt-0.5 text-[9px] text-slate-400">Capacity {capacityKw.toFixed(2)} kW</p>
        </div>

        <div style={infoStyle("status")} className="absolute flex items-center gap-1.5 rounded-xl border border-white/10 bg-slate-950/80 px-2.5 py-2 text-[10px] shadow-lg backdrop-blur-md">
          <Wifi className="h-3.5 w-3.5 text-emerald-300" aria-hidden="true" />
          <span className="hidden text-slate-200 sm:inline">{connectionLabel}</span>
          <span className="h-3.5 w-px bg-white/10" />
          <CloudSun className="h-3.5 w-3.5 text-sky-200" aria-hidden="true" />
          <span className="font-semibold text-white">{temperatureLabel}</span>
          <span className="h-3.5 w-px bg-white/10" />
          <button
            type="button"
            onClick={toggleTheme}
            className="rounded-full border border-white/10 bg-white/[0.04] p-1 text-slate-200"
            aria-label={`Switch to ${nightMode ? "day" : "night"} theme`}
            aria-pressed={nightMode}
            title={nightMode ? "Switch to daytime theme" : "Switch to nighttime theme"}
          >
            {nightMode ? <Sun className="h-3.5 w-3.5 text-amber-300" aria-hidden="true" /> : <Moon className="h-3.5 w-3.5 text-indigo-200" aria-hidden="true" />}
          </button>
          {webglBlocked && !is3DMode ? (
            <span
              className="flex items-center gap-1 rounded-full border border-white/10 bg-white/[0.04] px-2 py-0.5 font-semibold text-slate-500"
              title="3D view unavailable: WebGL is not supported on this device"
            >
              <Box className="h-3.5 w-3.5" aria-hidden="true" />
              3D N/A
            </span>
          ) : (
            <button
              type="button"
              onClick={() => {
                if (!is3DMode && !isWebGLAvailable()) {
                  setWebglBlocked(true);
                  return;
                }
                setIs3DMode((mode) => !mode);
              }}
              className="flex items-center gap-1 rounded-full border border-white/10 bg-white/[0.04] px-2 py-0.5 font-semibold text-slate-200"
              aria-label={is3DMode ? "Switch to 2D view" : "Switch to 3D view"}
              aria-pressed={is3DMode}
            >
              <Box className="h-3.5 w-3.5 text-emerald-300" aria-hidden="true" />
              {is3DMode ? "3D" : "2D"}
            </button>
          )}
        </div>

        <div style={infoStyle("hero")} className="absolute -translate-x-1/2 -mt-3 rounded-2xl border border-white/10 bg-slate-950/82 px-3 py-1.5 text-center shadow-xl backdrop-blur-md sm:mt-0 sm:px-4 sm:py-2">
          <p data-testid="hero-solar-power" className="whitespace-nowrap text-xl font-bold tracking-tight text-white sm:text-3xl">{formatPowerKw(trueSolarW)}</p>
          <p className="mt-0.5 whitespace-nowrap text-[10px] font-medium text-slate-300">Power Ratio {Math.max(0, powerRatio).toFixed(1)}%</p>
        </div>

        {/* In 3D mode the badges live inside the render as ground-fixed
            signs; the HTML overlays stay 2D-only. */}
        {!is3DMode ? (
        <div data-testid="grid-flow-badge" style={infoStyle("grid")} className="absolute w-28 -translate-x-1/2 rounded-xl border border-white/10 bg-slate-950/80 p-1.5 shadow-lg backdrop-blur-md">
          <p className="text-[8px] font-medium uppercase tracking-[0.12em] text-slate-400">Grid</p>
          <p className="mt-0.5 text-[13px] font-bold leading-tight text-white">{formatPowerKw(Math.abs(trueGridW))}</p>
          <p className={`mt-0.5 flex items-center gap-1 text-[8px] font-semibold ${gridTone}`}>
            <span className={`h-1.5 w-1.5 rounded-full ${gridDotTone}`} />
            {gridLabel}
          </p>
        </div>
        ) : null}

        {!is3DMode ? (
        <div data-testid="loads-flow-badge" style={infoStyle("loads")} className="absolute w-28 rounded-xl border border-white/10 bg-slate-950/80 p-2 shadow-lg backdrop-blur-md">
          <p className="text-[9px] font-medium uppercase tracking-[0.14em] text-slate-400">Loads</p>
          <p className="mt-0.5 text-sm font-bold text-white">{formatPowerKw(trueHomeW)}</p>
          <p className="mt-1 text-[9px] font-semibold text-emerald-300">Home demand</p>
        </div>
        ) : null}
      </div>

      {showEditorTools ? (
      <div className="mx-auto w-full max-w-xl lg:mx-0 lg:max-h-[calc(100vh-1.5rem)] lg:overflow-y-auto lg:pr-1">
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() => setTunerOpen((open) => !open)}
            className="flex items-center gap-1.5 rounded-full border border-white/10 bg-slate-950/80 px-3 py-1.5 text-[11px] font-medium text-slate-300 shadow-lg backdrop-blur-md"
          >
            <SlidersHorizontal className="h-3.5 w-3.5 text-emerald-300" aria-hidden="true" />
            {tunerOpen ? "Hide overlay tuner" : "Tune overlays"}
          </button>
          <button
            type="button"
            onClick={() => setPipeTunerOpen((open) => !open)}
            className="flex items-center gap-1.5 rounded-full border border-white/10 bg-slate-950/80 px-3 py-1.5 text-[11px] font-medium text-slate-300 shadow-lg backdrop-blur-md"
          >
            <SlidersHorizontal className="h-3.5 w-3.5 text-sky-300" aria-hidden="true" />
            {pipeTunerOpen ? "Hide pipe tuner" : "Tune pipes"}
          </button>
          <button
            type="button"
            onClick={() => setBoxTunerOpen((open) => !open)}
            className="flex items-center gap-1.5 rounded-full border border-white/10 bg-slate-950/80 px-3 py-1.5 text-[11px] font-medium text-slate-300 shadow-lg backdrop-blur-md"
          >
            <SlidersHorizontal className="h-3.5 w-3.5 text-amber-300" aria-hidden="true" />
            {boxTunerOpen ? "Hide box tuner" : "Tune boxes"}
          </button>
        </div>
        {tunerOpen ? (
          <div className="mt-2 space-y-3 rounded-2xl border border-white/10 bg-slate-950/80 p-3 shadow-lg backdrop-blur-md">
            <p className="text-[11px] leading-relaxed text-slate-400">
              Nudge quad corners live (viewBox 0 0 1000 750, y grows down, C1–C4 run
              around the perimeter). Values persist in this browser; copy them back
              into QUAD_OVERLAYS to commit.
            </p>
            {QUAD_OVERLAYS.map((quad) => (
              <div key={quad.id} className="rounded-xl border border-white/10 bg-slate-900/50 p-2">
                <div className="mb-2 flex items-center justify-between gap-2">
                  <p className="text-xs font-semibold text-slate-200">
                    {quad.id} <span className="font-normal text-slate-500">{quad.label}</span>
                  </p>
                  <button
                    type="button"
                    onClick={() => copyQuadText(quadPointsToString(quadPoints[quad.id]), quad.id)}
                    className="rounded-full border border-white/10 bg-white/[0.04] px-2 py-0.5 text-[10px] text-slate-300"
                  >
                    {copiedQuad === quad.id ? "Copied" : "Copy"}
                  </button>
                </div>
                <div className="grid grid-cols-2 gap-2">
                  {quadPoints[quad.id].map(([x, y], index) => (
                    <div key={index} className="flex min-w-0 flex-wrap items-center gap-1">
                      <span className="shrink-0 text-[10px] text-slate-500">C{index + 1}</span>
                      <input
                        type="number"
                        value={Math.round(x)}
                        onChange={(event) => setQuadPoint(quad.id, index, 0, event.target.value === "" ? NaN : Number(event.target.value))}
                        className="w-14 shrink-0 rounded-md border border-white/10 bg-slate-950 px-1.5 py-1 text-xs text-white"
                        aria-label={`${quad.id} corner ${index + 1} x`}
                      />
                      <input
                        type="number"
                        value={Math.round(y)}
                        onChange={(event) => setQuadPoint(quad.id, index, 1, event.target.value === "" ? NaN : Number(event.target.value))}
                        className="w-14 shrink-0 rounded-md border border-white/10 bg-slate-950 px-1.5 py-1 text-xs text-white"
                        aria-label={`${quad.id} corner ${index + 1} y`}
                      />
                    </div>
                  ))}
                </div>
              </div>
            ))}
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() =>
                  copyQuadText(
                    QUAD_OVERLAYS.map((quad) => `${quad.id}: ${quadPointsToString(quadPoints[quad.id])}`).join("\n"),
                    "all",
                  )
                }
                className="rounded-full border border-white/10 bg-white/[0.04] px-3 py-1 text-[11px] text-slate-200"
              >
                {copiedQuad === "all" ? "Copied all" : "Copy all"}
              </button>
              <button
                type="button"
                onClick={resetQuadPoints}
                className="rounded-full border border-white/10 bg-white/[0.04] px-3 py-1 text-[11px] text-slate-400"
              >
                Reset
              </button>
            </div>
          </div>
        ) : null}
        {pipeTunerOpen ? (
          <div className="mt-2 space-y-3 rounded-2xl border border-white/10 bg-slate-950/80 p-3 shadow-lg backdrop-blur-md">
            <p className="text-[11px] leading-relaxed text-slate-400">
              One source point per quad, every pipe joint editable (viewBox 0 0 1000 750,
              y grows down). Shared nodes move every connected pipe at once. Values
              persist in this browser; copy them back into the PIPE_* defaults to commit.
            </p>
            <div className="rounded-xl border border-white/10 bg-slate-900/50 p-2">
              <p className="mb-2 text-xs font-semibold text-slate-200">Sources <span className="font-normal text-slate-500">one per quad, each runs to the combiner</span></p>
              <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                {(["S1", "P1", "S2", "P2"] as QuadId[]).map((id) => (
                  <XyInput
                    key={id}
                    label={`${id} src → ${RUN_END_NODES[id] === "upperMid" ? "upper node" : "lower node"}`}
                    point={pipes.sources[id]}
                    onChange={(axis, value) => setPipeSource(id, axis, value)}
                  />
                ))}
              </div>
            </div>
            {(["runS1", "runP1", "runS2", "runP2"] as PipeViaKey[]).map((key) => (
              <ViaPointList
                key={key}
                title={key}
                hint="run midpoints"
                points={pipes.via[key]}
                anchor={pipes.nodes[RUN_END_NODES[key.slice(3) as QuadId]]}
                onChange={(next) => setPipeVia(key, next)}
              />
            ))}
            <ViaPointList
              title="trunkUpper"
              hint="upper node → lower node → junction"
              points={pipes.via.trunkUpper}
              anchor={pipes.nodes.junction}
              onChange={(next) => setPipeVia("trunkUpper", next)}
            />
            <ViaPointList
              title="trunkLower"
              hint="junction → combiner"
              points={pipes.via.trunkLower}
              anchor={pipes.nodes.combiner}
              onChange={(next) => setPipeVia("trunkLower", next)}
            />
            <div className="rounded-xl border border-white/10 bg-slate-900/50 p-2">
              <p className="mb-2 text-xs font-semibold text-slate-200">Nodes <span className="font-normal text-slate-500">shared joints + markers</span></p>
              <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                {(Object.keys(PIPE_NODE_DEFAULTS) as PipeNodeId[]).map((id) => (
                  <XyInput key={id} label={id} point={pipes.nodes[id]} onChange={(axis, value) => setPipeNode(id, axis, value)} />
                ))}
              </div>
            </div>
            <div className="rounded-xl border border-white/10 bg-slate-900/50 p-2">
              <p className="mb-2 text-xs font-semibold text-slate-200">Grid & loads <span className="font-normal text-slate-500">start at combiner</span></p>
              <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                <XyInput label="grid end" point={pipes.ends.grid} onChange={(axis, value) => setPipeEnd("grid", axis, value)} />
                <XyInput label="loads end" point={pipes.ends.loads} onChange={(axis, value) => setPipeEnd("loads", axis, value)} />
              </div>
            </div>
            <ViaPointList
              title="grid"
              hint="combiner → end"
              points={pipes.via.grid}
              anchor={pipes.ends.grid}
              onChange={(next) => setPipeVia("grid", next)}
            />
            <ViaPointList
              title="loads"
              hint="combiner → end"
              points={pipes.via.loads}
              anchor={pipes.ends.loads}
              onChange={(next) => setPipeVia("loads", next)}
            />
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => copyQuadText(JSON.stringify(pipes, null, 2), "pipes-all")}
                className="rounded-full border border-white/10 bg-white/[0.04] px-3 py-1 text-[11px] text-slate-200"
              >
                {copiedQuad === "pipes-all" ? "Copied all" : "Copy all"}
              </button>
              <button
                type="button"
                onClick={resetPipes}
                className="rounded-full border border-white/10 bg-white/[0.04] px-3 py-1 text-[11px] text-slate-400"
              >
                Reset
              </button>
            </div>
          </div>
        ) : null}
        {boxTunerOpen ? (
          <div className="mt-2 space-y-3 rounded-2xl border border-white/10 bg-slate-950/80 p-3 shadow-lg backdrop-blur-md">
            <p className="text-[11px] leading-relaxed text-slate-400">
              Move the info boxes over the house (X/Y are % from the anchored edge and
              top) and dial their size. Values persist in this browser; copy them back
              into INFO_BOX_DEFAULTS to commit.
            </p>
            {(Object.keys(INFO_BOX_DEFAULTS) as InfoBoxId[]).map((id) => (
              <div key={id} className="rounded-xl border border-white/10 bg-slate-900/50 p-2">
                <p className="mb-2 text-xs font-semibold text-slate-200">
                  {INFO_BOX_LABELS[id]}{" "}
                  <span className="font-normal text-slate-500">
                    {INFO_BOX_ANCHOR[id] === "left" ? "from left" : "from right"} · {id}
                  </span>
                </p>
                <div className="flex flex-wrap items-center gap-2">
                  <XyInput
                    label={`${id} pos`}
                    point={[infoBoxes[id].x, infoBoxes[id].y]}
                    onChange={(axis, value) => setInfoBox(id, axis === 0 ? "x" : "y", value)}
                  />
                  <div className="flex items-center gap-1">
                    <span className="text-[10px] text-slate-500">Scale</span>
                    <input
                      type="number"
                      value={Math.round(infoBoxes[id].scale)}
                      onChange={(event) => {
                        const value = event.target.value === "" ? NaN : Number(event.target.value);
                        setInfoBox(id, "scale", value);
                      }}
                      className="w-16 rounded-md border border-white/10 bg-slate-950 px-1.5 py-1 text-xs text-white"
                      aria-label={`${id} scale percent`}
                    />
                    <span className="text-[10px] text-slate-500">%</span>
                  </div>
                </div>
              </div>
            ))}
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => copyQuadText(JSON.stringify(infoBoxes, null, 2), "boxes-all")}
                className="rounded-full border border-white/10 bg-white/[0.04] px-3 py-1 text-[11px] text-slate-200"
              >
                {copiedQuad === "boxes-all" ? "Copied all" : "Copy all"}
              </button>
              <button
                type="button"
                onClick={resetInfoBoxes}
                className="rounded-full border border-white/10 bg-white/[0.04] px-3 py-1 text-[11px] text-slate-400"
              >
                Reset
              </button>
            </div>
          </div>
        ) : null}
      </div>
        ) : null}
      </div>

      <div className="mx-auto max-w-xl space-y-3">
        <div data-testid="today-production-card" className="rounded-3xl border border-white/10 bg-slate-950/80 p-4 shadow-lg backdrop-blur-xl">
          <div className="flex items-start justify-between gap-4">
            <div className="min-w-0 flex-1">
              <p className="text-[11px] uppercase tracking-[0.18em] text-slate-400">Today</p>
              <div className="mt-3 space-y-2">
                <EnergyValue label="Solar yield" value={formatEnergy(todaySolarYieldKwh ?? 0, "kWh")} tone="green" />
                <EnergyValue label="Consumption" value={formatEnergy(todayConsumptionKwh ?? 0, "kWh")} />
                <EnergyValue label={todayGridLabel} value={formatEnergy(Math.abs(todayNetGridKwh ?? 0), "kWh")} tone={todayNetGridKwh && todayNetGridKwh < 0 ? "amber" : "green"} />
              </div>
            </div>
            <div className="space-y-2">
              <SemiGauge value={selfConsumption} label="Self-consumption" />
              <SemiGauge value={Math.min(100, Math.max(0, powerRatio))} label="PV capacity" />
            </div>
          </div>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <EnergySummaryCard icon={CalendarDays} label="This Month" solarKwh={energyTotals.this_month_solar_kwh} consumptionKwh={energyTotals.this_month_home_consumption_kwh} />
          <EnergySummaryCard icon={History} label="Lifetime Energy" solarKwh={energyTotals.lifetime_solar_kwh} consumptionKwh={energyTotals.lifetime_home_consumption_kwh} detail={energyTotals.tracked_day_count > 0 ? `${energyTotals.tracked_day_count} tracked days` : "No data yet"} />
        </div>
      </div>
    </section>
  );
}

function EnergyValue({
  label,
  value,
  tone = "default",
}: {
  label: string;
  value: string;
  tone?: "default" | "green" | "amber";
}) {
  const valueColor =
    tone === "green" ? "text-emerald-300" : tone === "amber" ? "text-amber-300" : "text-white";

  return (
    <div>
      <p className="text-[9px] uppercase tracking-[0.12em] text-slate-500">{label}</p>
      <p className={`mt-1 text-sm font-bold tracking-tight ${valueColor}`}>{value}</p>
    </div>
  );
}

function EnergySummaryCard({
  icon: Icon,
  label,
  solarKwh,
  consumptionKwh,
  detail,
}: {
  icon: LucideIcon;
  label: string;
  solarKwh: number;
  consumptionKwh: number;
  detail?: string;
}) {
  const netEnergyKwh = solarKwh - consumptionKwh;
  const netLabel =
    netEnergyKwh > 0.001
      ? "Net export"
      : netEnergyKwh < -0.001
        ? "Net consumption"
        : "Net balance";

  return (
    <div className="rounded-3xl border border-white/10 bg-slate-950/80 p-4 shadow-lg backdrop-blur-xl">
      <div className="flex items-start justify-between gap-2">
        <p className="text-[11px] uppercase tracking-[0.18em] text-slate-400">{label}</p>
        <Icon className="h-5 w-5 text-emerald-300" aria-hidden="true" />
      </div>
      <div className="mt-3 space-y-2">
        <EnergyValue label="Solar yield" value={formatEnergy(solarKwh, "MWh")} tone="green" />
        <EnergyValue label="Consumption" value={formatEnergy(consumptionKwh, "MWh")} />
        <EnergyValue label={netLabel} value={formatEnergy(Math.abs(netEnergyKwh), "MWh")} tone={netEnergyKwh < 0 ? "amber" : "green"} />
      </div>
      {detail ? <p className="mt-2 text-xs text-slate-400">{detail}</p> : null}
    </div>
  );
}
