"use client";

import { Edges, OrbitControls } from "@react-three/drei";
import { Canvas, useFrame } from "@react-three/fiber";
import { useEffect, useMemo, useRef, useState } from "react";
import * as THREE from "three";

import type { FlowTelemetry } from "@/lib/flow-telemetry";
import type { SectionId } from "@/lib/roof-layout";

export type PowerFlow3DProps = {
  telemetry: FlowTelemetry;
  sectionPowerW: Record<SectionId, number>;
  sectionRatios: Record<SectionId, number>;
};

const PANEL_COLOR = "#0a2540";
const PANEL_EDGE = "#6ee7b7";

function PanelGroup({
  position,
  rotation,
  size,
  ratio,
}: {
  position: [number, number, number];
  rotation: [number, number, number];
  size: [number, number];
  ratio: number;
}) {
  return (
    <mesh position={position} rotation={rotation}>
      <planeGeometry args={size} />
      <meshStandardMaterial
        color={PANEL_COLOR}
        metalness={0.55}
        roughness={0.35}
        emissive="#10b981"
        emissiveIntensity={0.12 + 0.5 * ratio}
        side={THREE.DoubleSide}
      />
      <Edges linewidth={1} scale={1} threshold={15} color={PANEL_EDGE} />
    </mesh>
  );
}

type FlowRoute = {
  points: [number, number, number][];
  period: number;
  count: number;
  color: string;
  reverse: boolean;
};

// Pipe runs hug exterior surfaces like the real conduits — never through the
// building volumes, or pipes/orbs hide inside walls. Owner correction
// (2026-09-05): the gear lives on the EAST outer face of the two-story block
// (opposite end from the garage), occluded from the initial POV and revealed
// on orbit. Topology mirrors the 2D cartoon: one run per array (P1/S1/P2/S2)
// to the combiner, combiner → grid exchange, combiner → loads — only the
// combiner/grid placement differs (true east-face position, not the
// front-view schematic). Each run renders as a grey pipe with animated
// spheres flowing along it.
// P1: panel top edge → stub up to the nearby ridge T-junction.
const RUN_P1_POINTS: [number, number, number][] = [
  [4.6, 7.95, 1.05],
  [4.6, 8.18, 0.85],
];

// S1: panel top edge → stub up to the nearby ridge T-junction.
const RUN_S1_POINTS: [number, number, number][] = [
  [4.6, 7.95, 0.28],
  [4.6, 8.18, 0.85],
];

// Upper-combined: T_UP on the ridge straight east, then down the east face
// into the combiner top — parallel to the lower-combined drop.
const RUN_UPPER_POINTS: [number, number, number][] = [
  [4.6, 8.18, 0.85],
  [6.2, 8.2, 0.8],
  [7.45, 7.85, 0.35],
  [7.5, 5.2, -0.2],
  [7.48, 3.4, -0.7],
  [7.25, 2.66, -1.25],
];

// P2: panel top edge → stub to the T-junction between the panels.
const RUN_P2_POINTS: [number, number, number][] = [
  [-5.0, 4.78, 1.0],
  [-5.0, 4.97, 0.68],
  [-5.0, 4.9, 0.35],
];

// S2: panel top edge → stub to the T-junction between the panels.
const RUN_S2_POINTS: [number, number, number][] = [
  [-5.0, 4.63, 0.1],
  [-5.0, 4.9, 0.35],
];

// Lower-combined: T_LOW east along the garage ridge, riser past the west
// roof edge, then straight east along the RIDGE corridor between the P1/S1
// arrays (never over the panels), parallel to the upper-combined run, down
// the east face into the combiner — 2 parallel drops into the box.
const RUN_LOWER_POINTS: [number, number, number][] = [
  [-5.0, 4.9, 0.35],
  [-3.5, 5.05, 0.55],
  [-2.0, 5.15, 0.7],
  [-0.5, 5.25, 0.7],
  [-0.35, 6.4, 0.4],
  [-0.35, 7.7, 0.1],
  [1.0, 7.95, 0.35],
  [3.0, 8.02, 0.5],
  [5.0, 8.05, 0.5],
  [6.6, 8.0, 0.45],
  [7.45, 7.7, 0.1],
  [7.62, 5.4, -0.7],
  [7.62, 3.4, -1.2],
  [7.25, 2.42, -1.55],
];

// Combiner → meter jumper (single combined pipe to the net-meter box).
const RUN_JUMPER_POINTS: [number, number, number][] = [
  [7.25, 1.95, -1.1],
  [7.25, 1.86, -0.4],
  [7.2, 1.86, -0.2],
];

// Grid: street tie-in → front yard → up the east-face riser into the mast
// conduit (parallel to the solar drops). Import flows street → mast; export
// reverses. Orbs terminate at the mast junction and feed up it.
const RUN_GRID_POINTS: [number, number, number][] = [
  [6.0, 0.3, 17.5],
  [6.8, 0.3, 10.0],
  [7.3, 0.5, 4.0],
  [7.5, 1.0, 1.5],
  [7.4, 1.8, 0.4],
  [7.3, 2.5, -0.15],
];

// Loads: combiner → around the southeast corner → across the front yard → home
// marker. The corner waypoint keeps the curve off the house mass.
const RUN_LOADS_POINTS: [number, number, number][] = [
  [7.25, 2.0, -1.0],
  [7.5, 1.3, 1.5],
  [7.85, 1.0, 3.2],
  [7.0, 0.85, 4.3],
  [4.0, 0.8, 4.2],
  [0.5, 0.4, 4.6],
];

function particleCount(watts: number): number {
  return Math.max(1, Math.min(6, Math.round(Math.abs(watts) / 600)));
}

/** prefers-reduced-motion → parked particles (no useFrame advance). */
function usePrefersReducedMotion(): boolean {
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

function FlowParticles({ points, period, count, color, reverse }: FlowRoute) {
  const curve = useMemo(
    () => new THREE.CatmullRomCurve3(points.map((point) => new THREE.Vector3(...point))),
    [points],
  );
  const group = useRef<THREE.Group>(null);
  const reduceMotion = usePrefersReducedMotion();
  useFrame(({ clock }) => {
    const node = group.current;
    if (!node) return;
    const elapsed = clock.getElapsedTime();
    for (let i = 0; i < node.children.length; i += 1) {
      const t = ((reduceMotion ? 0.5 : elapsed / period) + i / node.children.length) % 1;
      node.children[i].position.copy(curve.getPoint(reverse ? 1 - t : t));
    }
  });
  if (count <= 0) return null;
  return (
    <group ref={group}>
      {Array.from({ length: count }).map((_, index) => (
        <mesh key={index} position={curve.getPoint((index + 1) / (count + 1))}>
          <sphereGeometry args={[0.22, 12, 12]} />
          <meshBasicMaterial color={color} toneMapped={false} />
        </mesh>
      ))}
    </group>
  );
}

/**
 * Asymmetric gable roof: short steep south slope, long shallow north slope.
 * Profile (eave/ridge/eave in shape-x = world-z) extruded across the width.
 */
function GableRoof({
  width,
  depth,
  ridgeOffset,
  height,
  color,
  position,
}: {
  width: number;
  depth: number;
  ridgeOffset: number;
  height: number;
  color: string;
  position: [number, number, number];
}) {
  const geometry = useMemo(() => {
    const eave = depth / 2 + 0.3;
    const shape = new THREE.Shape();
    shape.moveTo(eave, 0);
    shape.lineTo(ridgeOffset, height);
    shape.lineTo(-eave, 0);
    shape.closePath();
    const extrude = width + 0.4;
    const geo = new THREE.ExtrudeGeometry(shape, { depth: extrude, bevelEnabled: false });
    geo.translate(0, 0, -extrude / 2);
    return geo;
  }, [width, depth, ridgeOffset, height]);
  useEffect(() => () => geometry.dispose(), [geometry]);
  return (
    <mesh geometry={geometry} rotation={[0, -Math.PI / 2, 0]} position={position}>
      <meshStandardMaterial color={color} roughness={0.9} />
    </mesh>
  );
}

/**
 * Ground-fixed info sign (replaces the HTML overlay badges in 3D mode):
 * two posts + a canvas-texture panel. Offline-safe (no runtime font fetch).
 */
function GroundSign({
  position,
  rotationY = 0,
  title,
  value,
  status,
  statusColor,
}: {
  position: [number, number, number];
  rotationY?: number;
  title: string;
  value: string;
  status: string;
  statusColor: string;
}) {
  const texture = useMemo(() => {
    const tex = new THREE.CanvasTexture(document.createElement("canvas"));
    tex.image.width = 512;
    tex.image.height = 300;
    tex.colorSpace = THREE.SRGBColorSpace;
    return tex;
  }, []);
  useEffect(() => {
    const canvas = texture.image as HTMLCanvasElement;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.fillStyle = "rgba(2,6,23,0.92)";
    ctx.fillRect(0, 0, 512, 300);
    ctx.strokeStyle = "rgba(255,255,255,0.16)";
    ctx.lineWidth = 6;
    ctx.strokeRect(5, 5, 502, 290);
    ctx.textAlign = "center";
    ctx.fillStyle = "#94a3b8";
    ctx.font = "600 34px system-ui, sans-serif";
    ctx.fillText(title, 256, 64);
    ctx.fillStyle = "#ffffff";
    ctx.font = "700 84px system-ui, sans-serif";
    ctx.fillText(value, 256, 170);
    ctx.fillStyle = statusColor;
    ctx.font = "600 38px system-ui, sans-serif";
    ctx.fillText(status, 256, 242);
    texture.needsUpdate = true;
  }, [texture, title, value, status, statusColor]);
  useEffect(() => () => {
    texture.dispose();
  }, [texture]);
  return (
    <group position={position} rotation={[0, rotationY, 0]}>
      <mesh position={[-0.9, 0.3, 0]}>
        <boxGeometry args={[0.12, 0.6, 0.12]} />
        <meshStandardMaterial color="#64748b" roughness={0.6} metalness={0.4} />
      </mesh>
      <mesh position={[0.9, 0.3, 0]}>
        <boxGeometry args={[0.12, 0.6, 0.12]} />
        <meshStandardMaterial color="#64748b" roughness={0.6} metalness={0.4} />
      </mesh>
      {/* Back-to-back faces so the text reads correctly from both sides. */}
      <mesh position={[0, 1.35, 0.012]}>
        <planeGeometry args={[2.6, 1.52]} />
        <meshBasicMaterial map={texture} toneMapped={false} />
      </mesh>
      <mesh position={[0, 1.35, -0.012]} rotation={[0, Math.PI, 0]}>
        <planeGeometry args={[2.6, 1.52]} />
        <meshBasicMaterial map={texture} toneMapped={false} />
      </mesh>
    </group>
  );
}

/**
 * Front-face window: white frame + dark glass + muntin cross, seated proud
 * of the wall face like the 2D photo's punched openings.
 */
function Window({
  position,
  size = [1.2, 1.4],
}: {
  position: [number, number, number];
  size?: [number, number];
}) {
  const [w, h] = size;
  return (
    <group position={position}>
      <mesh>
        <boxGeometry args={[w + 0.16, h + 0.16, 0.1]} />
        <meshStandardMaterial color="#e8e6e0" roughness={0.8} />
      </mesh>
      <mesh position={[0, 0, 0.03]}>
        <boxGeometry args={[w, h, 0.06]} />
        <meshStandardMaterial color="#16202e" roughness={0.2} metalness={0.6} />
      </mesh>
      <mesh position={[0, 0, 0.07]}>
        <boxGeometry args={[0.05, h, 0.02]} />
        <meshStandardMaterial color="#e8e6e0" roughness={0.8} />
      </mesh>
      <mesh position={[0, 0, 0.07]}>
        <boxGeometry args={[w, 0.05, 0.02]} />
        <meshStandardMaterial color="#e8e6e0" roughness={0.8} />
      </mesh>
    </group>
  );
}

/** Visible grey conduit pipe along a run. Spheres flow on top of it. */
function PipeRun({ points }: { points: [number, number, number][] }) {
  const geometry = useMemo(
    () =>
      new THREE.TubeGeometry(
        new THREE.CatmullRomCurve3(points.map((point) => new THREE.Vector3(...point))),
        64,
        0.06,
        8,
        false,
      ),
    [points],
  );
  return (
    <mesh geometry={geometry}>
      <meshStandardMaterial color="#9ca3af" roughness={0.45} metalness={0.55} />
    </mesh>
  );
}

function Tree({ position, scale = 1 }: { position: [number, number, number]; scale?: number }) {
  return (
    <group position={position} scale={scale}>
      <mesh position={[0, 0.6, 0]}>
        <cylinderGeometry args={[0.12, 0.16, 1.2, 7]} />
        <meshStandardMaterial color="#5b3d26" roughness={1} />
      </mesh>
      <mesh position={[0, 1.8, 0]}>
        <coneGeometry args={[1.0, 1.8, 8]} />
        <meshStandardMaterial color="#2c5a34" roughness={1} />
      </mesh>
      <mesh position={[0, 2.9, 0]}>
        <coneGeometry args={[0.7, 1.3, 8]} />
        <meshStandardMaterial color="#35703f" roughness={1} />
      </mesh>
    </group>
  );
}

// Property-line trees: rear row beyond the back fence, both side boundaries
// inside the side fences, front corners. Kept clear of fence planes.
const TREE_SPOTS: { position: [number, number, number]; scale?: number }[] = [
  ...[-12, -8, -4, 0, 4, 8, 12].map((x) => ({ position: [x, 0, -14.5] as [number, number, number] })),
  ...[-8, -4, 0, 4, 8].map((z) => ({ position: [14.5, 0, z] as [number, number, number] })),
  ...[-8, -4, 0, 4, 8].map((z) => ({ position: [-12.5, 0, z] as [number, number, number] })),
  { position: [-13, 0, 12], scale: 1.2 },
  { position: [13, 0, 12], scale: 1.2 },
];

/**
 * Procedural 3D power-flow scene (static in U2; particle animation lands in
 * U3). Massing is a simplified single rectangular base per owner direction
 * (garage wing + two-story share front/rear planes and meet at x = 0; the
 * real house's set-back lives in the photos, not the model), pool/patio rear,
 * driveway front-left joining the street,
 * electrical gear on the east outer face of the two-story (owner correction
 * 2026-09-05: opposite end from the garage, occluded from the initial POV).
 * Front slopes carry P1/P2, rear slopes S1/S2 per the satellite placement.
 * Trees + fences (white vinyl sides, brown wood rear) mark the property
 * lines; no street-name labels (privacy).
 */
export function PowerFlow3DCanvas({ telemetry, sectionPowerW, sectionRatios }: PowerFlow3DProps) {
  const solarPeriod = Math.max(0.4, Number.parseFloat(telemetry.solarDuration) || 2);
  const loadPeriod = Math.max(0.4, Number.parseFloat(telemetry.loadDuration) || 2);
  const gridPeriod = Math.max(0.4, Number.parseFloat(telemetry.gridDuration) || 2);
  const exporting = telemetry.gridState === "exporting";
  const importing = telemetry.gridState === "importing";
  const gridMarker =
    telemetry.gridState === "exporting"
      ? "#34d399"
      : telemetry.gridState === "importing"
        ? "#f59e0b"
        : "#64748b";
  const gridSignLabel =
    telemetry.gridState === "exporting"
      ? "Exporting"
      : telemetry.gridState === "importing"
        ? "Importing"
        : "Balanced";
  const gridSignColor =
    telemetry.gridState === "exporting"
      ? "#6ee7b7"
      : telemetry.gridState === "importing"
        ? "#fbbf24"
        : "#94a3b8";

  return (
    <div className="absolute inset-0">
      <Canvas dpr={[1, 1.75]} frameloop="always" camera={{ position: [-13, 9, 15], fov: 38 }}>
        <color attach="background" args={["#020617"]} />
        <ambientLight intensity={0.55} />
        <hemisphereLight args={["#93c5fd", "#1c1917", 0.35]} />
        <directionalLight position={[8, 12, 6]} intensity={1.2} />

        {/* Ground, driveway, pool + patio */}
        <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0, 0]}>
          <planeGeometry args={[70, 70]} />
          <meshStandardMaterial color="#2f5d33" roughness={1} />
        </mesh>
        <mesh rotation={[-Math.PI / 2, 0, 0]} position={[-7, 0.02, 8]}>
          <planeGeometry args={[6, 14]} />
          <meshStandardMaterial color="#1f2937" roughness={1} />
        </mesh>
        <mesh position={[-6, 0.15, -7]}>
          <boxGeometry args={[10, 0.3, 7]} />
          <meshStandardMaterial color="#94a3b8" roughness={0.95} />
        </mesh>
        <mesh position={[-6, 0.45, -7]}>
          <boxGeometry args={[7, 0.5, 4]} />
          <meshStandardMaterial color="#38bdf8" roughness={0.25} metalness={0.1} />
        </mesh>

        {/* Single rectangular base: garage wing (single story, stretched west
            to the driveway edge) and two-story block share front/rear
            planes (z -3..3) and meet at x = 0. */}
        <mesh position={[-5, 1.5, 0]}>
          <boxGeometry args={[10, 3, 6]} />
          <meshStandardMaterial color="#8d8880" roughness={0.9} />
        </mesh>
        <GableRoof
          width={10}
          depth={6}
          ridgeOffset={0.75}
          height={1.8}
          color="#2b2f36"
          position={[-5, 3.0, 0]}
        />

        {/* Black garage door + grooves, aligned with the driveway. */}
        <mesh position={[-7, 1.35, 3.04]}>
          <boxGeometry args={[3.6, 2.3, 0.1]} />
          <meshStandardMaterial color="#0b0d12" roughness={0.7} />
        </mesh>
        {[0.8, 1.35, 1.9].map((y) => (
          <mesh key={`groove-${y}`} position={[-7, y, 3.1]}>
            <boxGeometry args={[3.6, 0.04, 0.02]} />
            <meshStandardMaterial color="#232936" roughness={0.7} />
          </mesh>
        ))}

        {/* Entry extension on the two-story front with porch slab + main door. */}
        <mesh position={[1.1, 1.3, 3.6]}>
          <boxGeometry args={[2.0, 2.6, 1.2]} />
          <meshStandardMaterial color="#8d8880" roughness={0.9} />
        </mesh>
        <mesh position={[1.1, 2.7, 3.6]}>
          <boxGeometry args={[2.3, 0.18, 1.5]} />
          <meshStandardMaterial color="#2b2f36" roughness={0.9} />
        </mesh>
        <mesh position={[1.1, 1.05, 4.22]}>
          <boxGeometry args={[1.0, 2.1, 0.08]} />
          <meshStandardMaterial color="#4a2c1a" roughness={0.7} />
        </mesh>

        {/* Two-story front windows + one between the doors. */}
        <Window position={[-2.0, 1.9, 3.02]} size={[1.2, 1.1]} />
        <Window position={[1.8, 4.4, 3.02]} />
        <Window position={[5.2, 4.4, 3.02]} />
        <Window position={[4.1, 1.4, 3.02]} size={[2.4, 1.6]} />

        {/* Two-story block: stone base + charcoal upper + gable roof */}
        <mesh position={[3.5, 1.3, 0]}>
          <boxGeometry args={[7, 2.6, 6]} />
          <meshStandardMaterial color="#8d8880" roughness={0.9} />
        </mesh>
        <mesh position={[3.5, 4.3, 0]}>
          <boxGeometry args={[7, 3.4, 6]} />
          <meshStandardMaterial color="#23272e" roughness={0.85} />
        </mesh>
        <GableRoof
          width={7}
          depth={6}
          ridgeOffset={0.8}
          height={2.0}
          color="#2b2f36"
          position={[3.5, 6.0, 0]}
        />

        {/* Panel groups seated on the slopes (south steep, north shallow):
            P1/P2 front slopes, S1/S2 rear slopes. */}
        <PanelGroup position={[-5, 3.95, 2.02]} rotation={[-0.937, 0, 0]} size={[4.6, 2.4]} ratio={sectionRatios.P2} />
        <PanelGroup position={[3.5, 7.05, 2.09]} rotation={[-0.896, 0, 0]} size={[5, 2.6]} ratio={sectionRatios.P1} />
        <PanelGroup position={[-5, 3.95, -1.29]} rotation={[-1.999, 0, 0]} size={[4.6, 3.2]} ratio={sectionRatios.S2} />
        <PanelGroup position={[3.5, 7.03, -1.31]} rotation={[-2.025, 0, 0]} size={[5, 3.6]} ratio={sectionRatios.S1} />

        {/* Electrical gear on the east outer face of the two-story (x = 7
            plane, opposite end from the garage). Occluded from the initial
            POV; orbit around to inspect. */}
        <mesh position={[7.2, 2.2, -1.5]}>
          <boxGeometry args={[0.3, 0.9, 0.7]} />
          <meshStandardMaterial color="#065f46" roughness={0.6} metalness={0.3} />
        </mesh>
        <mesh position={[7.2, 1.5, -0.2]}>
          <boxGeometry args={[0.3, 0.7, 0.55]} />
          <meshStandardMaterial color="#1e3a8a" roughness={0.6} metalness={0.3} />
        </mesh>
        <mesh position={[7.25, 3.9, -1.5]}>
          <cylinderGeometry args={[0.06, 0.06, 3, 8]} />
          <meshStandardMaterial color="#9ca3af" roughness={0.5} metalness={0.5} />
        </mesh>
        {/* Service mast: meter top → roof. The grid riser ties into its side. */}
        <mesh position={[7.25, 3.6, -0.2]}>
          <cylinderGeometry args={[0.06, 0.06, 3.6, 8]} />
          <meshStandardMaterial color="#9ca3af" roughness={0.5} metalness={0.5} />
        </mesh>

        {/* T-junction fittings: upper pair at the ridge, lower pair on the
            garage ridge between the S2/P2 panels. */}
        <mesh position={[4.6, 8.18, 0.85]}>
          <boxGeometry args={[0.24, 0.24, 0.24]} />
          <meshStandardMaterial color="#6b7280" roughness={0.5} metalness={0.5} />
        </mesh>
        <mesh position={[-5.0, 4.9, 0.35]}>
          <boxGeometry args={[0.24, 0.24, 0.24]} />
          <meshStandardMaterial color="#6b7280" roughness={0.5} metalness={0.5} />
        </mesh>

        {/* Grid tie-in marker at the street + home loads marker */}
        <mesh position={[6.0, 0.4, 17.2]}>
          <sphereGeometry args={[0.35, 20, 20]} />
          <meshStandardMaterial color={gridMarker} emissive={gridMarker} emissiveIntensity={0.7} />
        </mesh>
        <mesh position={[0.5, 0.35, 4.6]}>
          <sphereGeometry args={[0.3, 20, 20]} />
          <meshStandardMaterial
            color="#fbbf24"
            emissive="#fbbf24"
            emissiveIntensity={telemetry.loadsActive ? 0.9 : 0.15}
          />
        </mesh>

        {/* Grey conduit pipes: array pairs meet at T-junctions, combined runs
            drop parallel into the combiner; combiner → meter jumper;
            grid tie-in → mast; combiner → loads. */}
        <PipeRun points={RUN_P1_POINTS} />
        <PipeRun points={RUN_S1_POINTS} />
        <PipeRun points={RUN_UPPER_POINTS} />
        <PipeRun points={RUN_P2_POINTS} />
        <PipeRun points={RUN_S2_POINTS} />
        <PipeRun points={RUN_LOWER_POINTS} />
        <PipeRun points={RUN_JUMPER_POINTS} />
        <PipeRun points={RUN_GRID_POINTS} />
        <PipeRun points={RUN_LOADS_POINTS} />

        {/* Power-flow particles: green spheres ride the array runs + combined
            drops + loads pipe while active; yellow grid spheres run street →
            mast on import and reverse on export, hiding at idle. Speeds reuse
            the 2D durations. */}
        <FlowParticles
          points={RUN_P1_POINTS}
          period={solarPeriod}
          count={telemetry.solarActive ? particleCount(sectionPowerW.P1) : 0}
          color="#34d399"
          reverse={false}
        />
        <FlowParticles
          points={RUN_S1_POINTS}
          period={solarPeriod}
          count={telemetry.solarActive ? particleCount(sectionPowerW.S1) : 0}
          color="#34d399"
          reverse={false}
        />
        <FlowParticles
          points={RUN_UPPER_POINTS}
          period={solarPeriod}
          count={telemetry.solarActive ? particleCount(sectionPowerW.P1 + sectionPowerW.S1) : 0}
          color="#34d399"
          reverse={false}
        />
        <FlowParticles
          points={RUN_P2_POINTS}
          period={solarPeriod}
          count={telemetry.solarActive ? particleCount(sectionPowerW.P2) : 0}
          color="#34d399"
          reverse={false}
        />
        <FlowParticles
          points={RUN_S2_POINTS}
          period={solarPeriod}
          count={telemetry.solarActive ? particleCount(sectionPowerW.S2) : 0}
          color="#34d399"
          reverse={false}
        />
        <FlowParticles
          points={RUN_LOWER_POINTS}
          period={solarPeriod}
          count={telemetry.solarActive ? particleCount(sectionPowerW.P2 + sectionPowerW.S2) : 0}
          color="#34d399"
          reverse={false}
        />
        <FlowParticles
          points={RUN_GRID_POINTS}
          period={gridPeriod}
          count={exporting || importing ? particleCount(telemetry.trueGridW) : 0}
          color="#fbbf24"
          reverse={exporting}
        />
        <FlowParticles
          points={RUN_LOADS_POINTS}
          period={loadPeriod}
          count={telemetry.loadsActive ? particleCount(telemetry.trueHomeW) : 0}
          color="#6ee7b7"
          reverse={false}
        />

        {/* Street along the front; the driveway ties into it. */}
        <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.015, 18]}>
          <planeGeometry args={[70, 7]} />
          <meshStandardMaterial color="#23262b" roughness={1} />
        </mesh>
        {Array.from({ length: 9 }).map((_, index) => (
          <mesh key={`dash-${index}`} position={[-16 + index * 4, 0.03, 18]}>
            <boxGeometry args={[1.6, 0.02, 0.18]} />
            <meshStandardMaterial color="#d7dae0" roughness={0.9} />
          </mesh>
        ))}

        {/* East vinyl boundary fence with posts. */}
        <mesh position={[13, 0.6, 0]}>
          <boxGeometry args={[0.15, 1.2, 24]} />
          <meshStandardMaterial color="#e8e6e0" roughness={0.8} />
        </mesh>
        {[-11, -5.5, 0, 5.5, 11].map((z) => (
          <mesh key={`vinyl-post-${z}`} position={[13, 0.65, z]}>
            <boxGeometry args={[0.3, 1.3, 0.3]} />
            <meshStandardMaterial color="#dedbd4" roughness={0.8} />
          </mesh>
        ))}

        {/* West vinyl boundary fence with posts. */}
        <mesh position={[-14, 0.6, 0]}>
          <boxGeometry args={[0.15, 1.2, 24]} />
          <meshStandardMaterial color="#e8e6e0" roughness={0.8} />
        </mesh>
        {[-11, -5.5, 0, 5.5, 11].map((z) => (
          <mesh key={`vinyl-west-post-${z}`} position={[-14, 0.65, z]}>
            <boxGeometry args={[0.3, 1.3, 0.3]} />
            <meshStandardMaterial color="#dedbd4" roughness={0.8} />
          </mesh>
        ))}

        {/* Rear brown wood fence with posts, running behind the pool. */}
        <mesh position={[0, 0.55, -12.5]}>
          <boxGeometry args={[28, 1.1, 0.12]} />
          <meshStandardMaterial color="#6b4a2f" roughness={0.9} />
        </mesh>
        {[-13.5, -9, -4.5, 0, 4.5, 9, 13.5].map((x) => (
          <mesh key={`wood-post-${x}`} position={[x, 0.6, -12.5]}>
            <boxGeometry args={[0.22, 1.2, 0.22]} />
            <meshStandardMaterial color="#4e3421" roughness={0.9} />
          </mesh>
        ))}

        {/* Property-line trees. */}
        {TREE_SPOTS.map((spot, index) => (
          <Tree key={`tree-${index}`} position={spot.position} scale={spot.scale} />
        ))}

        {/* Ground-fixed info signs (the HTML badges hide in 3D mode). */}
        <GroundSign
          position={[0.5, 0, 6.8]}
          rotationY={-0.3}
          title="LOADS"
          value={`${(telemetry.trueHomeW / 1000).toFixed(2)} kW`}
          status="Home demand"
          statusColor="#6ee7b7"
        />
        <GroundSign
          position={[10.5, 0, 5.0]}
          rotationY={-0.5}
          title="GRID"
          value={`${(Math.abs(telemetry.trueGridW) / 1000).toFixed(2)} kW`}
          status={gridSignLabel}
          statusColor={gridSignColor}
        />

        <OrbitControls
          makeDefault
          target={[0, 2.5, 0]}
          minDistance={6}
          maxDistance={32}
          maxPolarAngle={Math.PI / 2}
          enableDamping
        />
      </Canvas>
    </div>
  );
}
