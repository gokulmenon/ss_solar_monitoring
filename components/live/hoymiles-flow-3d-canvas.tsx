"use client";

import { Edges, OrbitControls, useGLTF } from "@react-three/drei";
import { Canvas, useFrame } from "@react-three/fiber";
import { Suspense, useEffect, useMemo, useRef, useState } from "react";
import * as THREE from "three";

import type { FlowTelemetry } from "@/lib/flow-telemetry";
import type { SectionId } from "@/lib/roof-layout";
import { getSolarRayCount, getSolarRayPeriod, SOLAR_RAY_COLOR } from "@/lib/solar-rays";

export type PowerFlow3DProps = {
  telemetry: FlowTelemetry;
  sectionPowerW: Record<SectionId, number>;
  sectionRatios: Record<SectionId, number>;
  nightMode: boolean;
};

// GLB model flag (mirrors home_monitoring): the imported v25 house is the
// default 3D scene (owner verdict: model beats the schematic); `?model=0`
// falls back to the procedural scene for the session, persisted via a
// dedicated localStorage key. No UI chrome yet.
const MODEL_STORAGE_KEY = "power-flow-3d-model";
const MODEL_URL = "/models/house-v40.glb";

function useModelFlag(): boolean {
  const [modelOn, setModelOn] = useState(true);
  useEffect(() => {
    try {
      const params = new URLSearchParams(window.location.search);
      if (params.get("model") === "0") {
        window.localStorage.setItem(MODEL_STORAGE_KEY, "0");
        setModelOn(false);
        return;
      }
      if (params.get("model") === "1") {
        window.localStorage.setItem(MODEL_STORAGE_KEY, "1");
        setModelOn(true);
        return;
      }
      setModelOn(window.localStorage.getItem(MODEL_STORAGE_KEY) !== "0");
    } catch {
      // Storage unavailable — stay on the model default.
    }
  }, []);
  return modelOn;
}

/**
 * Imported v25 house. Blender's glTF exporter already converts Z-up to the
 * Y-up glTF convention, i.e. blend (x,y,z) arrives as canvas (x,z,−y) at 1:1
 * meters — no rotation. See home_monitoring/blender-starter/
 * overlay-waypoints.json. Architecture only — pipes/orbs/signs stay
 * procedural.
 */
const PANEL_SECTIONS = ["P1", "S1", "P2", "S2"] as const;

const FRONT_WINDOW_PANE_LAYOUTS = [
  "V5_WinFront_0_Glass",
  "V5_WinFront_3_Glass",
] as const;

/**
 * The v40 GLB has one horizontal mullion on these two large front windows,
 * and the right window has only three vertical lites. Keep the source GLB
 * frozen and correct this small presentation detail at load time: both
 * windows get four evenly-spaced vertical panes and no horizontal divider.
 */
function repairFrontWindowPanes(scene: THREE.Object3D) {
  for (const glassName of FRONT_WINDOW_PANE_LAYOUTS) {
    const glass = scene.getObjectByName(glassName);
    if (!(glass instanceof THREE.Mesh)) continue;

    scene.traverse((object) => {
      if (!(object instanceof THREE.Mesh)) return;
      const name = object.name.toLowerCase();
      const prefix = `pane_${glassName.toLowerCase()}_`;
      if (name.startsWith(prefix)) object.visible = false;
    });

    const bounds = new THREE.Box3().setFromObject(glass);
    const size = bounds.getSize(new THREE.Vector3());
    const center = bounds.getCenter(new THREE.Vector3());
    const barDepth = Math.max(0.01, Math.min(size.z + 0.01, 0.04));
    const barMaterial = new THREE.MeshStandardMaterial({
      color: "#1f2937",
      roughness: 0.8,
      metalness: 0.05,
    });
    barMaterial.depthWrite = false;
    barMaterial.polygonOffset = true;
    barMaterial.polygonOffsetFactor = -1;
    barMaterial.polygonOffsetUnits = -1;

    for (let index = 1; index <= 3; index += 1) {
      const x = bounds.min.x + (size.x * index) / 4;
      const localPosition = scene.worldToLocal(new THREE.Vector3(x, center.y, center.z));
      const bar = new THREE.Mesh(
        new THREE.BoxGeometry(0.025, size.y + 0.015, barDepth),
        barMaterial.clone(),
      );
      bar.name = `Pane_Runtime_${glassName}_V${index}`;
      bar.position.copy(localPosition);
      bar.renderOrder = 3;
      scene.add(bar);
    }
  }
}

/**
 * Derive overlay frames from the GLB Panel_* meshes: world center lifted
 * just off the surface along the face normal, orientation from the mesh
 * quaternion composed with a plane→fat-axes alignment, size from the local
 * bounds. Runs once per load; downward normals are flipped so the lift
 * side faces away from the roof.
 */
function ModelHouse({
  onFrames,
  nightMode,
}: {
  onFrames: (frames: Record<string, PanelFrame>) => void;
  nightMode: boolean;
}) {
  const gltf = useGLTF(MODEL_URL);
  const done = useRef(false);
  useEffect(() => {
    if (done.current) return;
    done.current = true;
    const frames: Record<string, PanelFrame> = {};
    gltf.scene.updateMatrixWorld(true);
    repairFrontWindowPanes(gltf.scene);
    gltf.scene.updateMatrixWorld(true);
    for (const section of PANEL_SECTIONS) {
      const node = gltf.scene.getObjectByName(`Panel_${section}`);
      if (!node || !(node instanceof THREE.Mesh)) continue;
      const geo = node.geometry as THREE.BufferGeometry;
      // Face normal = largest-triangle normal (box slabs cancel in a
      // Newell sum), flipped skyward; long axis via 2D PCA on the face
      // plane so triangulation diagonals can't skew it.
      const posAttr = geo.attributes.position as THREE.BufferAttribute;
      const idx = geo.index;
      const triCount = idx ? idx.count / 3 : posAttr.count / 3;
      const at = (i: number) =>
        new THREE.Vector3().fromBufferAttribute(posAttr, idx ? idx.getX(i) : i);
      const wv = (v: THREE.Vector3) => v.applyMatrix4(node.matrixWorld);
      let bestArea = -1;
      const n = new THREE.Vector3(0, 1, 0);
      for (let t = 0; t < triCount; t++) {
        const p0 = wv(at(t * 3));
        const p1 = wv(at(t * 3 + 1));
        const p2 = wv(at(t * 3 + 2));
        const e1 = p1.clone().sub(p0);
        const e2 = p2.clone().sub(p0);
        const fn = e1.clone().cross(e2);
        const area = fn.length() / 2;
        if (area > bestArea) {
          bestArea = area;
          n.copy(fn.normalize());
        }
      }
      if (n.y < 0) n.negate();
      const t0 = Math.abs(n.y) > 0.99
        ? new THREE.Vector3(1, 0, 0)
        : new THREE.Vector3().crossVectors(n, new THREE.Vector3(0, 1, 0)).normalize();
      const b0 = new THREE.Vector3().crossVectors(n, t0).normalize();
      const pts: THREE.Vector3[] = [];
      for (let i = 0; i < posAttr.count; i++) pts.push(wv(at(i)));
      const mean = pts.reduce((acc, p) => acc.add(p), new THREE.Vector3()).multiplyScalar(1 / pts.length);
      let cxx = 0;
      let cxy = 0;
      let cyy = 0;
      let nMin = Infinity;
      let nMax = -Infinity;
      for (const p of pts) {
        const d = p.clone().sub(mean);
        const x = d.dot(t0);
        const y = d.dot(b0);
        const z = d.dot(n);
        cxx += x * x;
        cxy += x * y;
        cyy += y * y;
        nMin = Math.min(nMin, z);
        nMax = Math.max(nMax, z);
      }
      const ang = 0.5 * Math.atan2(2 * cxy, cxx - cyy);
      const u = t0.clone().multiplyScalar(Math.cos(ang)).addScaledVector(b0, Math.sin(ang));
      const v = t0.clone().multiplyScalar(-Math.sin(ang)).addScaledVector(b0, Math.cos(ang));
      let uMin = Infinity;
      let uMax = -Infinity;
      let vMin = Infinity;
      let vMax = -Infinity;
      for (const p of pts) {
        const d = p.clone().sub(mean);
        uMin = Math.min(uMin, d.dot(u));
        uMax = Math.max(uMax, d.dot(u));
        vMin = Math.min(vMin, d.dot(v));
        vMax = Math.max(vMax, d.dot(v));
      }
      const q = new THREE.Quaternion().setFromRotationMatrix(
        new THREE.Matrix4().makeBasis(u, v, n),
      );
      const su = uMax - uMin;
      const sv = vMax - vMin;
      const center2D = mean
        .addScaledVector(u, (uMin + uMax) / 2)
        .addScaledVector(v, (vMin + vMax) / 2)
        .addScaledVector(n, (nMin + nMax) / 2 + (nMax - nMin) / 2 + 0.03);
      frames[section] = {
        position: [center2D.x, center2D.y, center2D.z],
        quaternion: [q.x, q.y, q.z, q.w],
        size: [su * 0.96, sv * 0.96],
      };
    }
    onFrames(frames);
  }, [gltf, onFrames]);

  useEffect(() => {
    gltf.scene.traverse((object) => {
      if (!(object instanceof THREE.Mesh)) return;
      const name = object.name.toLowerCase();
      const isModelPanel = name.startsWith("panel_");
      const isRearGarageDoor = name === "rear_garage_door";

      if (isRearGarageDoor) {
        // This is an opaque door, not a light pane. Keep it black in both
        // themes so the nighttime lights cannot wash it into a window-like
        // surface.
        const sourceMaterials = Array.isArray(object.material) ? object.material : [object.material];
        const doorMaterials = sourceMaterials.map((material) => {
          if (!(material instanceof THREE.MeshStandardMaterial) && !(material instanceof THREE.MeshPhysicalMaterial)) return material;
          const adjusted = new THREE.MeshBasicMaterial({
            color: "#05070b",
            side: material.side,
            transparent: material.transparent,
            opacity: material.opacity,
            depthWrite: material.depthWrite,
          });
          adjusted.toneMapped = false;
          return adjusted;
        });
        object.material = Array.isArray(object.material) ? doorMaterials : doorMaterials[0];
        return;
      }

      if (isModelPanel) {
        // The GLB photovoltaic material is intentionally very glossy for
        // daylight, which turns its bevels into bright outlines under the
        // cool nighttime key light. Use the source color with an unlit
        // material so day/night changes do not light the panel edges.
        const sourceMaterials = Array.isArray(object.material) ? object.material : [object.material];
        const panelMaterials = sourceMaterials.map((material) => {
          if (!(material instanceof THREE.MeshStandardMaterial) && !(material instanceof THREE.MeshPhysicalMaterial)) return material;
          const adjusted = new THREE.MeshBasicMaterial({
            color: material.color,
            side: material.side,
            transparent: material.transparent,
            opacity: material.opacity,
            depthWrite: material.depthWrite,
          });
          adjusted.userData.hoymilesPanelMaterial = true;
          adjusted.toneMapped = false;
          return adjusted;
        });
        object.material = Array.isArray(object.material) ? panelMaterials : panelMaterials[0];
      }

      const isPaneDivider = name.startsWith("pane_");
      if (isPaneDivider) {
        // Pane_* objects are the slim muntins added by the Blender pass. They
        // must stay dark/light dividers, never inherit the amber glass glow.
        const sourceMaterials = Array.isArray(object.material) ? object.material : [object.material];
        const dividerMaterials = sourceMaterials.map((material) => {
          if (!(material instanceof THREE.MeshStandardMaterial) && !(material instanceof THREE.MeshPhysicalMaterial)) return material;
          const adjusted = material.userData.hoymilesPaneDivider === true ? material : material.clone();
          adjusted.userData.hoymilesPaneDivider = true;
          adjusted.emissive.set("#000000");
          adjusted.emissiveIntensity = 0;
          adjusted.depthWrite = false;
          adjusted.polygonOffset = true;
          adjusted.polygonOffsetFactor = -1;
          adjusted.polygonOffsetUnits = -1;
          return adjusted;
        });
        object.renderOrder = 3;
        object.material = Array.isArray(object.material) ? dividerMaterials : dividerMaterials[0];
        return;
      }

      const isFrontDoorFrame = ["door_front", "door_sidelight_l", "door_sidelight_r"].includes(name);

      if (isFrontDoorFrame) {
        // Keep the opaque door pieces visible as muted gray-brown surfaces at
        // night. Clone before changing color because the source dark-trim
        // material is shared by other house meshes.
        const sourceMaterials = Array.isArray(object.material) ? object.material : [object.material];
        const doorMaterials = sourceMaterials.map((material) => {
          if (!(material instanceof THREE.MeshStandardMaterial) && !(material instanceof THREE.MeshPhysicalMaterial)) return material;
          const adjusted = material.userData.hoymilesDoorMaterialOwner === name ? material : material.clone();
          adjusted.userData.hoymilesDoorMaterialOwner = name;
          adjusted.color.set(nightMode ? "#4b5563" : "#68727d");
          adjusted.emissive.set("#000000");
          adjusted.emissiveIntensity = 0;
          return adjusted;
        });
        object.material = Array.isArray(object.material) ? doorMaterials : doorMaterials[0];
      }

      // The front door's center pane is the one door surface that should
      // participate in the window-light treatment; the opaque pieces above
      // stay separate so the pane still reads as transparent glass.
      const isFrontDoorGlass = name.includes("door_front_glass");
      const isWindowLike = name.includes("win") || name.includes("window") || name.includes("pane") || name.includes("glass");
      if (!isFrontDoorGlass && !isWindowLike) return;
      const materials = Array.isArray(object.material) ? object.material : [object.material];
      materials.forEach((material) => {
        if (!(material instanceof THREE.MeshStandardMaterial) && !(material instanceof THREE.MeshPhysicalMaterial)) return;
        const baseIntensity =
          typeof material.userData.hoymilesDayEmissiveIntensity === "number"
            ? material.userData.hoymilesDayEmissiveIntensity
            : material.emissiveIntensity;
        material.userData.hoymilesDayEmissiveIntensity = baseIntensity;
        material.emissive.set(nightMode ? "#ffd97a" : "#9fb4c7");
        material.emissiveIntensity = nightMode
          ? Math.max(baseIntensity * 2.4, isFrontDoorGlass ? 0.85 : 0.95)
          : Math.min(baseIntensity * 0.35, isFrontDoorGlass ? 0.08 : 0.16);
      });
    });
  }, [gltf.scene, nightMode]);
  return <primitive object={gltf.scene} />;
}

useGLTF.preload(MODEL_URL);

const PANEL_COLOR = "#0a2540";
const PANEL_EDGE = "#6ee7b7";

/**
 * Panel array with battery-level production overlay, ported from the 2D
 * cartoon: a transparent green level strip rises edge-anchored from one
 * long edge (bottom by default, top for S1/S2 like the 2D fills) with
 * height = `ratio` of section capacity, inside a green border — the base
 * stays black and shows through the unfilled area. The static outline and
 * panel grid remain visible in both themes; the translucent production fill
 * is gated by `active` (the 2D `solarActive` signal). Fill sits 12 mm proud
 * to avoid z-fighting. In model mode the same component is fed runtime
 * frames from the GLB Panel_* nodes (see ModelHouse).
 */
const PANEL_FILL = "#34d399";
// 0.35 matches the 2D cartoon over a bright photo; the 3D base is near-black
// so the level needs more punch to read at a glance.
const PANEL_FILL_OPACITY = 0.55;

// Per-section panel separation grids (cols x rows). APPROXIMATION from panel
// counts until the 45-panel cardboard-geometry checkpoint lands exact cells:
// S1 4 (strip), P1 ~13, P2 12, S2 16.
const PANEL_GRID: Record<SectionId, [number, number]> = {
  S1: [4, 1],
  P1: [7, 2],
  P2: [6, 2],
  S2: [8, 2],
};
const PANEL_SEAM = "#6b7280";

/**
 * kW + % text riding just off the fill's leading edge (2D: label above the
 * fill line), drawn on the panel surface above the fill plane so it stays
 * visible. Canvas texture like GroundSign — no font downloads.
 */
function PanelLabel({ text, y }: { text: string; y: number }) {
  const texture = useMemo(() => {
    const tex = new THREE.CanvasTexture(document.createElement("canvas"));
    tex.image.width = 640;
    tex.image.height = 160;
    tex.colorSpace = THREE.SRGBColorSpace;
    return tex;
  }, []);
  useEffect(() => {
    const canvas = texture.image as HTMLCanvasElement;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.clearRect(0, 0, 640, 160);
    ctx.textAlign = "center";
    ctx.font = "700 76px system-ui, sans-serif";
    ctx.lineWidth = 10;
    ctx.strokeStyle = "rgba(5,46,34,0.65)";
    ctx.strokeText(text, 320, 108);
    ctx.fillStyle = "rgba(255,255,255,0.92)";
    ctx.fillText(text, 320, 108);
    texture.needsUpdate = true;
  }, [texture, text]);
  useEffect(() => () => {
    texture.dispose();
  }, [texture]);
  return (
    <mesh position={[0, y, 0.018]} rotation={[0, 0, Math.PI]}>
      <planeGeometry args={[2.3, 0.575]} />
      <meshBasicMaterial map={texture} transparent toneMapped={false} side={THREE.DoubleSide} />
    </mesh>
  );
}

function PanelGroup({
  position,
  rotation,
  quaternion,
  size,
  ratio,
  active,
  fromTop = false,
  gridCols = 1,
  gridRows = 1,
  label = "",
}: {
  position: [number, number, number];
  rotation?: [number, number, number];
  quaternion?: [number, number, number, number];
  size: [number, number];
  ratio: number;
  active: boolean;
  fromTop?: boolean;
  gridCols?: number;
  gridRows?: number;
  label?: string;
}) {
  const r = Math.max(0, Math.min(1, ratio || 0));
  const quat = useMemo(
    () =>
      quaternion
        ? new THREE.Quaternion(...quaternion)
        : new THREE.Quaternion().setFromEuler(
            new THREE.Euler(...(rotation ?? [0, 0, 0])),
          ),
    [quaternion, rotation],
  );
  const innerW = size[0] * 0.92;
  const innerH = size[1] * 0.92;
  const barH = innerH * r;
  const barY = fromTop ? innerH / 2 - barH / 2 : -innerH / 2 + barH / 2;
  // Label rides just off the fill's leading edge, clamped inside the array.
  const labelY = fromTop
    ? Math.max(-innerH / 2 + 0.2, innerH / 2 - barH - 0.24)
    : Math.min(innerH / 2 - 0.2, -innerH / 2 + barH + 0.24);
  return (
    <group position={position} quaternion={quat}>
      <mesh>
        <planeGeometry args={size} />
        <meshStandardMaterial
          color={PANEL_COLOR}
          metalness={0.55}
          roughness={0.35}
          emissive="#000000"
          emissiveIntensity={0}
          side={THREE.DoubleSide}
        />
        <Edges linewidth={1} scale={1} threshold={15} color={PANEL_EDGE} />
      </mesh>
      {active && r > 0.02 && (
        <mesh position={[0, barY, 0.012]}>
          <planeGeometry args={[innerW, barH]} />
          <meshBasicMaterial
            color={PANEL_FILL}
            transparent
            opacity={PANEL_FILL_OPACITY}
            toneMapped={false}
            side={THREE.DoubleSide}
          />
        </mesh>
      )}
      {active && r > 0.02 && label !== "" && (
        <PanelLabel text={label} y={labelY} />
      )}
      {/* Panel separation seams: thin aluminum strips on the base, UNDER the
          level fill (z 0.006 < 0.012). Keep the static grid visible in
          both themes; only the level fill is telemetry-gated. */}
      {Array.from({ length: Math.max(0, gridCols - 1) }).map((_, i) => (
        <mesh
          key={`seam-v-${i}`}
          position={[-size[0] / 2 + ((i + 1) * size[0]) / gridCols, 0, 0.006]}
        >
          <planeGeometry args={[0.025, size[1] * 0.98]} />
          <meshBasicMaterial color={PANEL_SEAM} toneMapped={false} side={THREE.DoubleSide} />
        </mesh>
      ))}
      {Array.from({ length: Math.max(0, gridRows - 1) }).map((_, j) => (
        <mesh
          key={`seam-h-${j}`}
          position={[0, -size[1] / 2 + ((j + 1) * size[1]) / gridRows, 0.006]}
        >
          <planeGeometry args={[size[0] * 0.98, 0.025]} />
          <meshBasicMaterial color={PANEL_SEAM} toneMapped={false} side={THREE.DoubleSide} />
        </mesh>
      ))}
    </group>
  );
}

export type PanelFrame = {
  position: [number, number, number];
  quaternion: [number, number, number, number];
  size: [number, number];
};

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
// v22 photo-fit refresh (see home_monitoring blender-starter/WIRING_LAYOUT.md):
// waypoints snapped to the 161-haase-v22.blend pipe meshes. Canvas frame =
// Blender (x, z, -y). JUMPER/GRID/LOADS move to the v18 meter-top topology
// (the street tie-in run is gone — grid is meter-top → roof dead-end).
// P1: panel top edge → stub up to the nearby ridge T-junction.
const RUN_P1_POINTS: [number, number, number][] = [
  [4.56, 7.98, 1.08],
  [4.56, 8.21, 0.88],
];

// S1: panel top edge → stub up to the nearby ridge T-junction.
const RUN_S1_POINTS: [number, number, number][] = [
  [4.31, 7.7, 0.11],
  [4.55, 8.18, 0.85],
];

// Upper-combined: T_UP on the ridge straight east, then down the east face
// into the combiner top — parallel to the lower-combined drop. Drops ride
// 7 cm proud of the combiner east face (x 7.42 vs face 7.35) and turn INTO
// the top; the old line ran inside the box x-range and read as piercing it.
const RUN_UPPER_POINTS: [number, number, number][] = [
  [4.6, 8.12, 0.85],
  [6.14, 7.94, 0.8],
  [7.4, 7.7, 0.69],
  [7.42, 5.66, -1.08],
  [7.42, 2.78, -1.08],
  [7.3, 2.72, -1.08],
];

// P2: panel top edge → stub to the T-junction between the panels.
const RUN_P2_POINTS: [number, number, number][] = [
  [-5.04, 4.81, 1.02],
  [-5.0, 4.95, 0.66],
  [-5.0, 4.9, 0.56],
];

// S2: panel top edge → stub to the T-junction between the panels.
const RUN_S2_POINTS: [number, number, number][] = [
  [-5.04, 4.6, 0.13],
  [-5.0, 4.9, 0.44],
];

// Lower-combined: T_LOW east along the garage ridge, riser past the west
// roof edge, then straight east along the RIDGE corridor between the P1/S1
// arrays (never over the panels), parallel to the upper-combined run, down
// the east face into the combiner — 2 parallel drops into the box.
const RUN_LOWER_POINTS: [number, number, number][] = [
  [-4.96, 4.91, 0.49],
  [-3.4, 4.86, 0.55],
  [-1.93, 4.89, 0.56],
  [-0.33, 4.92, 0.56],
  [-0.3, 6.41, 0.5],
  [-0.3, 7.9, 0.55],
  [1.0, 7.97, 0.61],
  [2.94, 8.03, 0.6],
  [4.92, 8.06, 0.62],
  [6.47, 8.01, 0.57],
  [7.21, 7.97, 0.38],
  [7.42, 5.66, -1.18],
  [7.42, 2.78, -1.18],
  [7.3, 2.72, -1.18],
];

// Combiner → meter jumper (single combined pipe to the net-meter box).
// Solar into meter: combiner → (overlap, no pipe) → shutoff valve →
// meter bottom box. One direction, panels → meter, always.
const RUN_JUMPER_POINTS: [number, number, number][] = [
  [7.25, 1.41, -1.33],
  [7.3, 1.21, -0.58],
  [7.21, 1.23, -0.31],
];

// Meter link: bottom-box top → meter-box bottom (the nipple between the two
// boxes in the site photo). Completes combiner → shutoff → bottom → meter.
// Green orbs ride bottom → meter while powered. x 7.12 keeps the 0.14 orbs
// clear of the meter card plane (7.283).
const RUN_METER_LINK_POINTS: [number, number, number][] = [
  [7.12, 1.69, -0.2],
  [7.12, 2.18, -0.2],
];

// v24 pole topology: the 2-way net meter is the ONLY 3-way point (grid
// import/export, house loads, solar via combiner + shutoff). Grid runs
// meter-top → riser → service-drop wire → street pole; import flows pole
// DOWN into the meter, export reverses. Termini verified against
// home_monitoring/blender-starter/overlay-waypoints.json (v24 contract).
const RUN_GRID_POINTS: [number, number, number][] = [
  [7.15, 2.55, -0.2],
  [7.15, 3.2, -0.2],
  [7.17, 5.22, 0.0],
  [7.32, 5.83, 0.88],
  [9.45, 7.07, 9.45],
  [12.5, 8.52, 16.51],
];

// Loads: home loads tap at the METER (the net meter is the only 3-way
// point: grid import/export, house loads, solar via combiner + shutoff).
// Out the meter south-bottom edge, dip BELOW dial/card height, run south
// along the wall, then east into the wall toward the house interior. One
// direction, meter → house, always.
const RUN_LOADS_POINTS: [number, number, number][] = [
  [7.15, 2.25, -0.1],
  [7.22, 2.02, 0.08],
  [7.3, 1.9, 0.35],
  [7.3, 1.9, 1.2],
  [6.95, 1.9, 1.2],
];

function particleCount(watts: number, cap = 6): number {
  return Math.max(1, Math.min(cap, Math.round(Math.abs(watts) / 600)));
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
          <sphereGeometry args={[0.14, 12, 12]} />
          <meshBasicMaterial color={color} toneMapped={false} />
        </mesh>
      ))}
    </group>
  );
}

const SOLAR_RAY_PATHS: { from: [number, number, number]; to: [number, number, number] }[] = [
  { from: [-8.2, 13, 3.8], to: [-6.8, 4.5, 2.6] },
  { from: [-5.8, 13.5, 4.8], to: [-4.6, 4.7, 2.4] },
  { from: [-2.8, 14, 5.4], to: [-2.3, 5.8, 2.8] },
  { from: [0.3, 14, 4.5], to: [0.6, 7.8, 2.9] },
  { from: [3.5, 14, 5.2], to: [3.8, 7.8, 2.4] },
  { from: [6.8, 13.5, 4.2], to: [6.6, 7.5, 2.2] },
  { from: [-9.8, 11.5, 0.2], to: [-7.2, 4.2, -1.1] },
  { from: [-6.5, 12.8, -0.8], to: [-5.1, 4.0, -1.5] },
  { from: [-3.1, 13.4, -1.2], to: [-2.8, 5.2, -1.6] },
  { from: [0.2, 13.5, -0.3], to: [0.4, 6.8, -1.7] },
  { from: [3.6, 13.0, -0.8], to: [3.8, 7.4, -1.4] },
  { from: [7.3, 12.4, -1.5], to: [7.2, 0.08, -3.4] },
  { from: [-11.0, 10.0, 8.0], to: [-7.5, 0.08, 7.8] },
  { from: [10.0, 11.0, 7.0], to: [8.5, 0.08, 6.5] },
];

function SolarRayParticles({ solarW, active }: { solarW: number; active: boolean }) {
  const count = getSolarRayCount(active ? solarW : 0);
  const period = getSolarRayPeriod(solarW);
  const reducedMotion = usePrefersReducedMotion();
  const rays = useMemo(
    () => SOLAR_RAY_PATHS.slice(0, count).map((ray) => ({
      from: new THREE.Vector3(...ray.from),
      to: new THREE.Vector3(...ray.to),
    })),
    [count],
  );
  const group = useRef<THREE.Group>(null);

  useFrame(({ clock }) => {
    const node = group.current;
    if (!node) return;
    const elapsed = clock.getElapsedTime();
    rays.forEach((ray, index) => {
      const phase = reducedMotion ? 1 : ((elapsed / period + index / Math.max(rays.length, 1)) % 1);
      node.children[index]?.position.lerpVectors(ray.from, ray.to, phase);
    });
  });

  if (count === 0) return null;
  return (
    <group ref={group}>
      {rays.map((ray, index) => (
        <mesh key={index} position={ray.to}>
          <sphereGeometry args={[0.09, 8, 8]} />
          <meshBasicMaterial color={SOLAR_RAY_COLOR} transparent opacity={0.68} toneMapped={false} />
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
  tilt = 0.45,
  title,
  value,
  status,
  statusColor,
}: {
  position: [number, number, number];
  rotationY?: number;
  tilt?: number;
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
      {/* Back-to-back faces so the text reads correctly from both sides,
          tilted up toward the high default POV (posts stay vertical). */}
      <group position={[0, 1.35, 0]} rotation={[-tilt, 0, 0]}>
        <mesh position={[0, 0, 0.012]}>
          <planeGeometry args={[2.6, 1.52]} />
          <meshBasicMaterial map={texture} toneMapped={false} />
        </mesh>
        <mesh position={[0, 0, -0.012]} rotation={[0, Math.PI, 0]}>
          <planeGeometry args={[2.6, 1.52]} />
          <meshBasicMaterial map={texture} toneMapped={false} />
        </mesh>
      </group>
    </group>
  );
}

/**
 * Front-face window: white frame + lit pale-yellow panes + slim muntins +
 * sill ledge, seated proud of the wall face like the 2D photo's punched
 * openings. Muntins sit flush with the glass face (not proud boxes) so they
 * read as pane dividers, not a grid mesh. Wide units get 3 columns.
 */
function Window({
  position,
  size = [1.2, 1.4],
  nightMode,
}: {
  position: [number, number, number];
  size?: [number, number];
  nightMode: boolean;
}) {
  const [w, h] = size;
  const cols = w > 1.8 ? 3 : 2;
  const verticals = Array.from(
    { length: cols - 1 },
    (_, i) => -w / 2 + ((i + 1) * w) / cols,
  );
  return (
    <group position={position}>
      <mesh>
        <boxGeometry args={[w + 0.16, h + 0.16, 0.1]} />
        <meshStandardMaterial color="#e8e6e0" roughness={0.8} />
      </mesh>
      <mesh position={[0, 0, 0.03]}>
        <boxGeometry args={[w, h, 0.06]} />
        <meshStandardMaterial
          color={nightMode ? "#ffedb5" : "#dbe7ef"}
          emissive={nightMode ? "#ffd97a" : "#7c8da1"}
          emissiveIntensity={nightMode ? 1.15 : 0.08}
          roughness={0.4}
          metalness={0}
        />
      </mesh>
      {verticals.map((x) => (
        <mesh key={`mullion-${x.toFixed(2)}`} position={[x, 0, 0.05]}>
          <boxGeometry args={[0.035, h, 0.02]} />
          <meshStandardMaterial color="#f4f2ec" roughness={0.8} />
        </mesh>
      ))}
      <mesh position={[0, 0, 0.05]}>
        <boxGeometry args={[w, 0.035, 0.02]} />
        <meshStandardMaterial color="#f4f2ec" roughness={0.8} />
      </mesh>
      <mesh position={[0, -(h / 2 + 0.12), 0.02]}>
        <boxGeometry args={[w + 0.3, 0.08, 0.18]} />
        <meshStandardMaterial color="#e8e6e0" roughness={0.8} />
      </mesh>
    </group>
  );
}

/** Visible grey conduit pipe along a run. Spheres flow on top of it. */
/**
 * Conduit pipe with state glow: the tube echoes the orb color — green while
 * its run carries power, amber for grid import, near-dark at idle — so the
 * line itself reads live even between passing spheres. Thinner (0.045) than
 * the original schematic tube so the glow reads as a wire, not a pipe.
 */
function PipeRun({
  points,
  glow = "#000000",
  glowIntensity = 0,
}: {
  points: [number, number, number][];
  glow?: string;
  glowIntensity?: number;
}) {
  const geometry = useMemo(
    () =>
      new THREE.TubeGeometry(
        new THREE.CatmullRomCurve3(points.map((point) => new THREE.Vector3(...point))),
        64,
        0.045,
        8,
        false,
      ),
    [points],
  );
  return (
    <mesh geometry={geometry}>
      <meshStandardMaterial
        color="#9ca3af"
        roughness={0.45}
        metalness={0.55}
        emissive={glow}
        emissiveIntensity={glowIntensity}
      />
    </mesh>
  );
}

/** Orb-glow pair: bright state color while flowing, near-dark at idle. */
function flowGlow(active: boolean, color: string): { glow: string; glowIntensity: number } {
  return active
    ? { glow: color, glowIntensity: 0.85 }
    : { glow: "#000000", glowIntensity: 0 };
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
  // Satellite audit: one dominant street tree over the front-west yard
  // (shades the driveway in frame 01) plus the mature east grove.
  { position: [-11.5, 0, 13.0], scale: 2.3 },
  { position: [10.8, 0, -3.5], scale: 1.5 },
  { position: [11.8, 0, 1.5], scale: 1.7 },
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
export function PowerFlow3DCanvas({ telemetry, sectionPowerW, sectionRatios, nightMode }: PowerFlow3DProps) {
  const solarPeriod = Math.max(0.4, Number.parseFloat(telemetry.solarDuration) || 2);
  const loadPeriod = Math.max(0.4, Number.parseFloat(telemetry.loadDuration) || 2);
  const gridPeriod = Math.max(0.4, Number.parseFloat(telemetry.gridDuration) || 2);
  const exporting = telemetry.gridState === "exporting";
  const importing = telemetry.gridState === "importing";
  const solarGlow = flowGlow(telemetry.solarActive, "#34d399");
  const gridGlow = exporting
    ? { glow: "#34d399", glowIntensity: 0.85 }
    : importing
      ? { glow: "#fbbf24", glowIntensity: 0.85 }
      : { glow: "#000000", glowIntensity: 0 };
  const loadsGlow = flowGlow(telemetry.loadsActive, "#6ee7b7");
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
  const modelOn = useModelFlag();
  const [panelFrames, setPanelFrames] = useState<Record<string, PanelFrame> | null>(null);
  // Day/powered gate for panels + solar orbs (mirrors the 2D solarActive).
  const panelsPowered = telemetry.solarActive === true;
  const totalSolarW =
    sectionPowerW.S1 + sectionPowerW.P1 + sectionPowerW.S2 + sectionPowerW.P2;

  return (
    <div className="absolute inset-0">
      {/* Default POV ported from the blend's main camera (ProofCam, v24
          verified): east-above view onto the gear/pipes face. */}
      <Canvas dpr={[1, 1.75]} frameloop="always" camera={{ position: [15, 22, 10], fov: 38 }}>
        <color attach="background" args={[nightMode ? "#02030a" : "#10263b"]} />
        <ambientLight intensity={nightMode ? 0.18 : 0.55} />
        <hemisphereLight
          args={nightMode ? ["#1d315d", "#0b1020", 0.18] : ["#93c5fd", "#1c1917", 0.35]}
        />
        <directionalLight
          position={[8, 12, 6]}
          color={nightMode ? "#9ab2df" : "#fff3dd"}
          intensity={nightMode ? 0.32 : 1.2}
        />

        {modelOn && (
          <Suspense fallback={null}>
            <ModelHouse onFrames={setPanelFrames} nightMode={nightMode} />
          </Suspense>
        )}
        {modelOn &&
          panelFrames &&
          PANEL_SECTIONS.map((section) => {
            const frame = panelFrames[section];
            if (!frame) return null;
            return (
              <PanelGroup
                key={`modelfill-${section}`}
                position={frame.position}
                quaternion={frame.quaternion}
                size={frame.size}
                ratio={sectionRatios[section as SectionId]}
                active={panelsPowered}
                // GLB runtime frames orient local +Y eave-ward, so every
                // section fills from the top edge; the procedural fallback
                // below uses hand-set eulers with the opposite convention.
                fromTop
                gridCols={PANEL_GRID[section as SectionId][0]}
                gridRows={PANEL_GRID[section as SectionId][1]}
                label={`${((sectionPowerW[section as SectionId] ?? 0) / 1000).toFixed(2)} kW ${Math.round((sectionRatios[section as SectionId] ?? 0) * 100)}%`}
              />
            );
          })}

        {/* Procedural statics (hidden when the GLB model is on). */}
        <group visible={!modelOn}>
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
        <Window position={[-2.0, 1.9, 3.02]} size={[1.2, 1.1]} nightMode={nightMode} />
        <Window position={[1.8, 4.4, 3.02]} nightMode={nightMode} />
        <Window position={[5.2, 4.4, 3.02]} nightMode={nightMode} />
        <Window position={[4.1, 1.4, 3.02]} size={[2.4, 1.6]} nightMode={nightMode} />

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
        <PanelGroup position={[-5, 3.95, 2.02]} rotation={[-0.937, 0, 0]} size={[4.6, 2.4]} ratio={sectionRatios.P2} active={panelsPowered} gridCols={PANEL_GRID.P2[0]} gridRows={PANEL_GRID.P2[1]} label={`${(sectionPowerW.P2 / 1000).toFixed(2)} kW ${Math.round(sectionRatios.P2 * 100)}%`} />
        <PanelGroup position={[3.5, 7.05, 2.09]} rotation={[-0.896, 0, 0]} size={[5, 2.6]} ratio={sectionRatios.P1} active={panelsPowered} gridCols={PANEL_GRID.P1[0]} gridRows={PANEL_GRID.P1[1]} label={`${(sectionPowerW.P1 / 1000).toFixed(2)} kW ${Math.round(sectionRatios.P1 * 100)}%`} />
        <PanelGroup position={[-5, 3.95, -1.29]} rotation={[-1.999, 0, 0]} size={[4.6, 3.2]} ratio={sectionRatios.S2} active={panelsPowered} fromTop gridCols={PANEL_GRID.S2[0]} gridRows={PANEL_GRID.S2[1]} label={`${(sectionPowerW.S2 / 1000).toFixed(2)} kW ${Math.round(sectionRatios.S2 * 100)}%`} />
        <PanelGroup position={[3.5, 7.03, -1.31]} rotation={[-2.025, 0, 0]} size={[5, 3.6]} ratio={sectionRatios.S1} active={panelsPowered} fromTop gridCols={PANEL_GRID.S1[0]} gridRows={PANEL_GRID.S1[1]} label={`${(sectionPowerW.S1 / 1000).toFixed(2)} kW ${Math.round(sectionRatios.S1 * 100)}%`} />

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

        {/* Condensers on the ground beside the gear (frame 06 landmarks):
            AC unit south of the mast, mini-split north. Kept clear of the
            drops (x <= 7.62) and the loads run (z >= 1.5 at y ~1). */}
        <mesh position={[7.45, 0.45, 1.1]}>
          <boxGeometry args={[0.7, 0.9, 0.9]} />
          <meshStandardMaterial color="#cbd5e1" roughness={0.7} />
        </mesh>
        <mesh position={[7.45, 0.6, -2.9]}>
          <boxGeometry args={[0.5, 1.2, 0.8]} />
          <meshStandardMaterial color="#e8e6e0" roughness={0.7} />
        </mesh>

        {/* Basketball hoop at the street end of the driveway (frame 01
            landmark). West of the driveway center, clear of the loads run. */}
        <mesh position={[-8.5, 1.9, 12.5]}>
          <cylinderGeometry args={[0.09, 0.09, 3.8, 8]} />
          <meshStandardMaterial color="#4b5563" roughness={0.6} metalness={0.4} />
        </mesh>
        <mesh position={[-8.5, 3.7, 12.15]}>
          <boxGeometry args={[1.2, 0.8, 0.08]} />
          <meshStandardMaterial color="#f1f5f9" roughness={0.6} />
        </mesh>
        <mesh position={[-8.5, 3.35, 11.85]}>
          <cylinderGeometry args={[0.32, 0.32, 0.06, 12]} />
          <meshStandardMaterial color="#ea580c" roughness={0.6} />
        </mesh>

        {/* T-junction fittings: upper pair at the ridge, lower pair on the
            garage ridge between the S2/P2 panels. */}
        <mesh position={[4.6, 8.18, 0.85]}>
          <boxGeometry args={[0.24, 0.24, 0.24]} />
          <meshStandardMaterial color="#6b7280" roughness={0.5} metalness={0.5} />
        </mesh>
        <mesh position={[-5.0, 4.9, 0.57]}>
          <boxGeometry args={[0.24, 0.24, 0.24]} />
          <meshStandardMaterial color="#6b7280" roughness={0.5} metalness={0.5} />
        </mesh>
        </group>

        {/* Grid tie-in marker at the pole base (loads terminate at the meter run) */}
        <mesh position={[12.5, 0.4, 16.4]}>
          <sphereGeometry args={[0.35, 20, 20]} />
          <meshStandardMaterial color={gridMarker} emissive={gridMarker} emissiveIntensity={0.7} />
        </mesh>
        {/* Grey conduit pipes: array pairs meet at T-junctions, combined runs
            drop parallel into the combiner; combiner → meter jumper;
            grid tie-in → mast; combiner → loads. */}
        <PipeRun points={RUN_P1_POINTS} {...solarGlow} />
        <PipeRun points={RUN_S1_POINTS} {...solarGlow} />
        <PipeRun points={RUN_UPPER_POINTS} {...solarGlow} />
        <PipeRun points={RUN_P2_POINTS} {...solarGlow} />
        <PipeRun points={RUN_S2_POINTS} {...solarGlow} />
        <PipeRun points={RUN_LOWER_POINTS} {...solarGlow} />
        <PipeRun points={RUN_JUMPER_POINTS} {...solarGlow} />
        <PipeRun points={RUN_METER_LINK_POINTS} {...solarGlow} />
        <PipeRun points={RUN_GRID_POINTS} {...gridGlow} />
        <PipeRun points={RUN_LOADS_POINTS} {...loadsGlow} />
        <SolarRayParticles solarW={telemetry.trueSolarW} active={telemetry.solarActive} />

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
          color={exporting ? "#34d399" : "#fbbf24"}
          reverse={importing}
        />
        <FlowParticles
          points={RUN_LOADS_POINTS}
          period={loadPeriod}
          count={telemetry.loadsActive ? particleCount(telemetry.trueHomeW, 2) : 0}
          color="#6ee7b7"
          reverse={false}
        />
        {/* Combiner → shutoff → net-meter-bottom jumper: the tube rendered
            but orbs were never attached, so no green dots rode it. Green
            while powered, panels → meter, always. */}
        <FlowParticles
          points={RUN_JUMPER_POINTS}
          period={solarPeriod}
          count={telemetry.solarActive ? particleCount(totalSolarW, 3) : 0}
          color="#34d399"
          reverse={false}
        />
        {/* Bottom-box → meter nipple link: completes the chain into the
            meter. Green bottom → meter while powered. */}
        <FlowParticles
          points={RUN_METER_LINK_POINTS}
          period={solarPeriod}
          count={telemetry.solarActive ? particleCount(totalSolarW, 2) : 0}
          color="#34d399"
          reverse={false}
        />

        <group visible={!modelOn}>
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

        {/* East vinyl boundary fence with posts + a gate gap (z -3..-0.5)
            by the gear (frame 04 gate-fence landmark). */}
        <mesh position={[13, 0.6, -7.5]}>
          <boxGeometry args={[0.15, 1.2, 9]} />
          <meshStandardMaterial color="#e8e6e0" roughness={0.8} />
        </mesh>
        <mesh position={[13, 0.6, 5.75]}>
          <boxGeometry args={[0.15, 1.2, 12.5]} />
          <meshStandardMaterial color="#e8e6e0" roughness={0.8} />
        </mesh>
        {[-11, -7.5, -4, -3, -0.5, 3, 6.5, 10].map((z) => (
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

        {/* Neighbor masses for context (generic, unlabeled): west house
            across the driveway side, east house beyond the vinyl fence.
            Kept outside the lot lines and clear of the flow runs. */}
        <mesh position={[-23, 2.0, -1]}>
          <boxGeometry args={[9, 4, 11]} />
          <meshStandardMaterial color="#7a756c" roughness={0.9} />
        </mesh>
        <GableRoof
          width={9}
          depth={11}
          ridgeOffset={0}
          height={2.2}
          color="#34383f"
          position={[-23, 4.0, -1]}
        />
        <mesh position={[23, 2.0, 1]}>
          <boxGeometry args={[9, 4, 11]} />
          <meshStandardMaterial color="#6e6a63" roughness={0.9} />
        </mesh>
        <GableRoof
          width={9}
          depth={11}
          ridgeOffset={0}
          height={2.2}
          color="#3a2f28"
          position={[23, 4.0, 1]}
        />

        {/* Property-line trees. */}
        {TREE_SPOTS.map((spot, index) => (
          <Tree key={`tree-${index}`} position={spot.position} scale={spot.scale} />
        ))}
        </group>

        {/* Ground-fixed info signs (the HTML badges hide in 3D mode). */}
        <GroundSign
          position={[4.2, 0, 7.2]}
          rotationY={1.35}
          title="LOADS"
          value={`${(telemetry.trueHomeW / 1000).toFixed(2)} kW`}
          status="Home demand"
          statusColor="#6ee7b7"
        />
        <GroundSign
          position={[7.0, 0, 5.5]}
          rotationY={1.35}
          tilt={0.7}
          title="GRID"
          value={`${(Math.abs(telemetry.trueGridW) / 1000).toFixed(2)} kW`}
          status={gridSignLabel}
          statusColor={gridSignColor}
        />

        <OrbitControls
          makeDefault
          target={[2.4, 1.6, -0.1]}
          minDistance={6}
          maxDistance={32}
          maxPolarAngle={Math.PI / 2}
          enableDamping
        />
      </Canvas>
    </div>
  );
}
