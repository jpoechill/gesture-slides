"use client"

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { FilesetResolver, PoseLandmarker } from "@mediapipe/tasks-vision";

const APP_VERSION = "0.5.4";

const VERSION_HISTORY: { version: string; date: string; changes: string[] }[] = [
  {
    version: "0.5.4",
    date: "2026-03-24",
    changes: [
      "3D box: Ctrl/Cmd+drag, middle-drag, or right-drag on the box to orbit (yaw + pitch); Alt+drag still rotates the overlay on the slide",
    ],
  },
  {
    version: "0.5.3",
    date: "2026-03-24",
    changes: [
      "3D box: orthographic projection after rotation so at 0° yaw / 0° pitch the front face is a flat rectangle with no visible depth; tilt reveals depth",
    ],
  },
  {
    version: "0.5.2",
    date: "2026-03-24",
    changes: [
      "3D box: lateral (yaw) and vertical (pitch) rotation of the box in 3D; full six-face fill + wireframe; slide rotation kept separate",
      "3D box: front-face resize handles follow projected front quad; settings persisted (box3dYawDeg, box3dPitchDeg)",
    ],
  },
  {
    version: "0.5.1",
    date: "2026-03-24",
    changes: [
      "Left panel: Grid, Center frame, Ribcage, Head, Rectangle, and 3D box; Head overlay (true circle, same gestures as Ribcage)",
      "Ribcage: bounding box, crosshair, and corner handles only when selected (yellow)",
      "Head: diameter, rotation, offset; persisted in settings; wheel/Alt/Shift/corners like Ribcage",
      "Rectangle: rotatable rectangle overlay; width, height, rotation, offset; same gestures as Ribcage (corners, edges, Alt rotate, Shift scale, wheel width)",
      "3D box: isometric width × height × depth (front, top, right faces); same gestures as Rectangle; stacked above other shape overlays",
    ],
  },
  {
    version: "0.5.0",
    date: "2026-03-24",
    changes: [
      "Ribcage: portrait defaults; width and height persisted; Ribcage follows image pan, zoom, rotate, and flip",
      "Ribcage bounding box (thin black) with white corner squares; drag corners to resize; mid-edge cap handles removed",
      "Ribcage selection (yellow); short click on image outside Ribcage deselects; drag there (past threshold) rotates; Alt+drag on Ribcage rotates",
      "Rotate and resize cursors (compact rotate icon on image when applicable)",
      "Ribcage reset button; slideshow paused after folder pick until Play; image click no longer enters fullscreen",
      "Landing copy for press-to-advance; localStorage migration when only legacy Ribcage width was stored",
    ],
  },
  {
    version: "0.4.0",
    date: "2026-03-19",
    changes: [
      "Layout/metadata, logo + splash/dashboard, title → home, total-elapsed reset near transport",
      "Center frame (square, crosshair, “a”, size/hide); 3m loop preset; image opacity removed",
      "Classic: 30s×20, 1m×10, 3m×10, 5m×10, 10m×5, 15m×1 — pick active tier; slot-based progress",
    ],
  },
  {
    version: "0.3.0",
    date: "2025-03-10",
    changes: [
      "Total elapsed: cumulative across all sessions (never reset), persisted and restored on load",
      "Last folder: show date and time when folder was last opened on landing page",
      "Play/pause button next to total elapsed in bottom bar (works when overlays are hidden)",
      "Landing page: elements fade in with staggered timing; title slides down on load",
    ],
  },
  {
    version: "0.2.0",
    date: "2025-03-10",
    changes: [
      "Persist interval and image-adjust settings in localStorage (restored on load)",
    ],
  },
  {
    version: "0.1.0",
    date: "2025-03-10",
    changes: [
      "Folder pick, shuffle, auto-advance with configurable interval",
      "Keyboard: arrows, space (fullscreen); preset intervals 15s–1h",
      "Left overlay: image metadata (name, path, size, resolution, last modified)",
      "Right overlay: scale, brightness, contrast, rotate, flip, grayscale, saturation, blur, opacity",
      "Pinch zoom (acceleratable), pan, scale/position memory across slides",
      "Full-width progress timer; advance sound on slide change",
      "Delete moves image to _Deleted; fullscreen keeps header visible",
      "Landscape images fill height; portrait/landscape fit without cropping",
    ],
  },
];

type FileHandleEntry = {
  name: string;
  handle: FileSystemFileHandle;
};

type TimerMode = "classic" | "loop";

function parseTimerMode(v: unknown): TimerMode {
  return v === "classic" ? "classic" : "loop";
}

/** Classic: each tier has a slot budget; the selected preset is the active interval; one completion = −1 on that tier. */
const CLASSIC_PRESETS = [
  { sec: 30, slots: 20, shortLabel: "30s" },
  { sec: 60, slots: 10, shortLabel: "1m" },
  { sec: 180, slots: 10, shortLabel: "3m" },
  { sec: 300, slots: 10, shortLabel: "5m" },
  { sec: 600, slots: 5, shortLabel: "10m" },
  { sec: 900, slots: 1, shortLabel: "15m" },
] as const;

type ClassicTierSec = (typeof CLASSIC_PRESETS)[number]["sec"];
type ClassicSlots = Record<ClassicTierSec, number>;

const CLASSIC_TIER_SEC = CLASSIC_PRESETS.map((p) => p.sec) as readonly ClassicTierSec[];
const CLASSIC_TIER_SET = new Set<number>(CLASSIC_TIER_SEC);

function isClassicTierSec(n: number): n is ClassicTierSec {
  return CLASSIC_TIER_SET.has(n);
}

const CLASSIC_SLOTS_INITIAL: ClassicSlots = Object.fromEntries(
  CLASSIC_PRESETS.map((p) => [p.sec, p.slots])
) as ClassicSlots;

const CLASSIC_STEP_TOTAL = CLASSIC_PRESETS.reduce((sum, p) => sum + p.slots, 0);
const CLASSIC_FIRST_TIER = CLASSIC_PRESETS[0]!.sec;
const CLASSIC_EXHAUSTED_PLACEHOLDER_SEC = CLASSIC_PRESETS[CLASSIC_PRESETS.length - 1]!.sec;

function classicSlotsRemainingTotal(s: ClassicSlots): number {
  let n = 0;
  for (const t of CLASSIC_TIER_SEC) n += s[t];
  return n;
}

function classicSlotsExhausted(s: ClassicSlots): boolean {
  return classicSlotsRemainingTotal(s) === 0;
}

function classicCompletedCount(s: ClassicSlots): number {
  return CLASSIC_STEP_TOTAL - classicSlotsRemainingTotal(s);
}

function classicIntervalButtonLabels(slots: ClassicSlots): { sec: number; label: string }[] {
  return CLASSIC_PRESETS.map((p) => ({
    sec: p.sec,
    label: `${p.shortLabel} x ${slots[p.sec]}`,
  }));
}

const CLASSIC_MODE_TOOLTIP = `Classic: ${CLASSIC_PRESETS.map((p) => `${p.slots}×${p.shortLabel}`).join(", ")} — click a preset for the timer; each finished interval uses one slot on that tier. Session ends when every tier is 0. Loop: one interval for all slides.`;

const LOOP_INTERVAL_PRESETS: [number, string][] = [
  [15, "15s"],
  [30, "30s"],
  [60, "1m"],
  [120, "2m"],
  [180, "3m"],
  [300, "5m"],
  [600, "10m"],
  [900, "15m"],
  [1200, "20m"],
  [1800, "30m"],
  [3600, "1h"],
];

const IMAGE_EXTS = new Set([".jpg", ".jpeg", ".png", ".gif", ".webp", ".bmp", ".avif"]);

const IGNORED_DIRS = new Set(["_Deleted", "z_Deleted"]);

const SETTINGS_STORAGE_KEY = "gesture-slideshow-settings";

const SIDEBAR_SECTION_IDS = [
  "imageInfo",
  "grid",
  "centerFrame",
  "oval",
  "circle",
  "pose",
  "rectangle",
  "box3d",
  "adjustImage",
] as const;
type SidebarSectionId = (typeof SIDEBAR_SECTION_IDS)[number];
type SidebarColumn = "left" | "right";

const SIDEBAR_DND_SECTION = "application/x-gesture-slideshow-sidebar-section";
const SIDEBAR_DND_COLUMN = "application/x-gesture-slideshow-sidebar-column";

const DEFAULT_SIDEBAR_LEFT: SidebarSectionId[] = [
  "imageInfo",
  "grid",
  "centerFrame",
  "oval",
  "circle",
  "pose",
  "rectangle",
  "box3d",
];
const DEFAULT_SIDEBAR_RIGHT: SidebarSectionId[] = ["adjustImage"];

const SIDEBAR_SECTION_LABEL: Record<SidebarSectionId, string> = {
  imageInfo: "Image info",
  grid: "Grid",
  centerFrame: "Center frame",
  oval: "Ribcage",
  circle: "Head",
  pose: "Pose (MediaPipe)",
  rectangle: "Rectangle",
  box3d: "3D box",
  adjustImage: "Adjust image",
};

function isSidebarSectionId(s: string): s is SidebarSectionId {
  return (SIDEBAR_SECTION_IDS as readonly string[]).includes(s);
}

function normalizeSidebarColumns(
  leftRaw: unknown,
  rightRaw: unknown
): { left: SidebarSectionId[]; right: SidebarSectionId[] } {
  const allowed = new Set<string>(SIDEBAR_SECTION_IDS);
  const parseList = (raw: unknown): SidebarSectionId[] => {
    if (!Array.isArray(raw)) return [];
    const seen = new Set<string>();
    const out: SidebarSectionId[] = [];
    for (const item of raw) {
      if (typeof item === "string" && allowed.has(item) && !seen.has(item)) {
        seen.add(item);
        out.push(item as SidebarSectionId);
      }
    }
    return out;
  };
  const left = parseList(leftRaw);
  const right = parseList(rightRaw);
  const assigned = new Set<SidebarSectionId>();
  const outLeft: SidebarSectionId[] = [];
  const outRight: SidebarSectionId[] = [];
  for (const id of left) {
    if (!assigned.has(id)) {
      assigned.add(id);
      outLeft.push(id);
    }
  }
  for (const id of right) {
    if (!assigned.has(id)) {
      assigned.add(id);
      outRight.push(id);
    }
  }
  for (const id of SIDEBAR_SECTION_IDS) {
    if (!assigned.has(id)) {
      assigned.add(id);
      if (id === "adjustImage") outRight.push(id);
      else outLeft.push(id);
    }
  }
  const leftRank = new Map(DEFAULT_SIDEBAR_LEFT.map((id, i) => [id, i]));
  outLeft.sort((a, b) => (leftRank.get(a) ?? 99) - (leftRank.get(b) ?? 99));
  return { left: outLeft, right: outRight };
}

function applySidebarDrop(
  left: SidebarSectionId[],
  right: SidebarSectionId[],
  dragId: SidebarSectionId,
  dropId: SidebarSectionId | null,
  fromCol: SidebarColumn,
  toCol: SidebarColumn
): { left: SidebarSectionId[]; right: SidebarSectionId[] } {
  if (dropId === null) {
    if (fromCol === toCol) return { left, right };
    let newLeft = [...left];
    let newRight = [...right];
    if (fromCol === "left") newLeft = newLeft.filter((id) => id !== dragId);
    else newRight = newRight.filter((id) => id !== dragId);
    if (toCol === "left") newLeft = [dragId, ...newLeft];
    else newRight = [dragId, ...newRight];
    return { left: newLeft, right: newRight };
  }
  if (dragId === dropId && fromCol === toCol) return { left, right };
  if (fromCol === toCol) {
    const list = fromCol === "left" ? [...left] : [...right];
    const fi = list.indexOf(dragId);
    const ti = list.indexOf(dropId);
    if (fi === -1 || ti === -1) return { left, right };
    list.splice(fi, 1);
    list.splice(list.indexOf(dropId), 0, dragId);
    return fromCol === "left" ? { left: list, right } : { left, right: list };
  }
  let newLeft = [...left];
  let newRight = [...right];
  if (fromCol === "left") {
    const i = newLeft.indexOf(dragId);
    if (i === -1) return { left, right };
    newLeft.splice(i, 1);
  } else {
    const i = newRight.indexOf(dragId);
    if (i === -1) return { left, right };
    newRight.splice(i, 1);
  }
  if (toCol === "left") {
    const ti = newLeft.indexOf(dropId);
    if (ti === -1) return { left, right };
    newLeft.splice(ti, 0, dragId);
  } else {
    const ti = newRight.indexOf(dropId);
    if (ti === -1) return { left, right };
    newRight.splice(ti, 0, dragId);
  }
  return { left: newLeft, right: newRight };
}

const DEFAULT_SETTINGS = {
  intervalSec: 60,
  elapsedSec: 0,
  imageScale: 1,
  imageBrightness: 1,
  imageContrast: 1,
  imageRotate: 0,
  imageFlipH: false,
  imageFlipV: false,
  imageGrayscale: 0,
  imageSaturation: 1,
  imageBlur: 0,
  showCenterFrame: true,
  showGrid: true,
  gridCellSize: 48,
  centerFrameSize: 136,
  centerFrameLabelSize: 50,
  showOval: true,
  ovalWidth: 139,
  ovalHeightPx: 240,
  ovalRotateDeg: 0,
  ovalOffsetX: 0,
  ovalOffsetY: 0,
  showCircle: true,
  showPose: false,
  poseFigureMode: true,
  poseMinConfidence: 0.45,
  poseOffsetX: -6,
  poseOffsetY: -6,
  circleDiameterPx: 200,
  circleRotateDeg: 0,
  circleOffsetX: 0,
  circleOffsetY: 0,
  showRectangle: true,
  rectangleWidth: 200,
  rectangleHeightPx: 140,
  rectangleRotateDeg: 0,
  rectangleOffsetX: 0,
  rectangleOffsetY: 0,
  showBox3d: true,
  box3dWidth: 160,
  box3dHeightPx: 120,
  box3dDepthPx: 72,
  box3dRotateDeg: 0,
  box3dYawDeg: 0,
  box3dPitchDeg: 0,
  box3dOffsetX: 0,
  box3dOffsetY: 0,
  leftPanelSectionOrder: [...DEFAULT_SIDEBAR_LEFT] as SidebarSectionId[],
  rightPanelSectionOrder: [...DEFAULT_SIDEBAR_RIGHT] as SidebarSectionId[],
  timerMode: "loop" as TimerMode,
};

function loadStoredSettings(): typeof DEFAULT_SETTINGS {
  if (typeof window === "undefined") return DEFAULT_SETTINGS;
  try {
    const raw = localStorage.getItem(SETTINGS_STORAGE_KEY);
    if (!raw) return DEFAULT_SETTINGS;
    const parsed = JSON.parse(raw) as Partial<typeof DEFAULT_SETTINGS>;
    const merged = { ...DEFAULT_SETTINGS, ...parsed };
    const cols = normalizeSidebarColumns(parsed.leftPanelSectionOrder, parsed.rightPanelSectionOrder);
    merged.leftPanelSectionOrder = cols.left;
    merged.rightPanelSectionOrder = cols.right;
    if (parsed.ovalHeightPx === undefined && parsed.ovalWidth != null) {
      const ow = Number(parsed.ovalWidth);
      if (Number.isFinite(ow)) {
        merged.ovalHeightPx = Math.max(48, Math.round(ow * 0.58));
      }
    }
    return merged;
  } catch {
    return DEFAULT_SETTINGS;
  }
}

function saveStoredSettings(settings: typeof DEFAULT_SETTINGS) {
  if (typeof window === "undefined") return;
  try {
    localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(settings));
  } catch {
    // ignore quota or other errors
  }
}

const LAST_FOLDER_NAME_KEY = "gesture-slideshow-last-folder-name";
const LAST_FOLDER_OPENED_AT_KEY = "gesture-slideshow-last-folder-opened-at";
const IDB_NAME = "gesture-slideshow";
const IDB_STORE = "handles";
const IDB_LAST_FOLDER_KEY = "last-folder";

function getLastFolderName(): string {
  if (typeof window === "undefined") return "";
  try {
    return localStorage.getItem(LAST_FOLDER_NAME_KEY) ?? "";
  } catch {
    return "";
  }
}

function setLastFolderName(name: string) {
  if (typeof window === "undefined") return;
  try {
    if (name) localStorage.setItem(LAST_FOLDER_NAME_KEY, name);
    else localStorage.removeItem(LAST_FOLDER_NAME_KEY);
  } catch { }
}

function getLastFolderOpenedAt(): number | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = localStorage.getItem(LAST_FOLDER_OPENED_AT_KEY);
    if (raw == null) return null;
    const n = parseInt(raw, 10);
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

function setLastFolderOpenedAt(ms: number) {
  if (typeof window === "undefined") return;
  try {
    localStorage.setItem(LAST_FOLDER_OPENED_AT_KEY, String(ms));
  } catch { }
}

function openIDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(IDB_NAME, 1);
    req.onerror = () => reject(req.error);
    req.onsuccess = () => resolve(req.result);
    req.onupgradeneeded = (e) => {
      const db = (e.target as IDBOpenDBRequest).result;
      if (!db.objectStoreNames.contains(IDB_STORE)) db.createObjectStore(IDB_STORE);
    };
  });
}

async function saveLastFolderHandle(handle: FileSystemDirectoryHandle): Promise<void> {
  const db = await openIDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(IDB_STORE, "readwrite");
    tx.objectStore(IDB_STORE).put(handle, IDB_LAST_FOLDER_KEY);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function getLastFolderHandle(): Promise<FileSystemDirectoryHandle | null> {
  const db = await openIDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(IDB_STORE, "readonly");
    const req = tx.objectStore(IDB_STORE).get(IDB_LAST_FOLDER_KEY);
    req.onsuccess = () => resolve(req.result ?? null);
    req.onerror = () => reject(req.error);
  });
}

function isImageFileName(name: string) {
  const lower = name.toLowerCase();
  for (const ext of IMAGE_EXTS) if (lower.endsWith(ext)) return true;
  return false;
}

function shuffle<T>(array: T[]) {
  const a = [...array];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatElapsed(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
}

function touchDistance(
  t1: { clientX: number; clientY: number },
  t2: { clientX: number; clientY: number }
): number {
  return Math.hypot(t2.clientX - t1.clientX, t2.clientY - t1.clientY);
}

function playAdvanceSound() {
  try {
    if (typeof window === "undefined" || !window.AudioContext) return;
    const ctx = new window.AudioContext();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.frequency.value = 520;
    osc.type = "sine";
    gain.gain.setValueAtTime(0.12, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + 0.12);
    osc.start(ctx.currentTime);
    osc.stop(ctx.currentTime + 0.12);
  } catch {
    // ignore if AudioContext not allowed or unavailable
  }
}

function MetaRow({ label, value }: { label: string; value: string }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
      <span style={{ opacity: 0.6, fontSize: 11, textTransform: "uppercase", letterSpacing: "0.04em" }}>
        {label}
      </span>
      <span style={{ opacity: 0.95, wordBreak: "break-all" }}>{value}</span>
    </div>
  );
}

function SliderRow({
  label,
  value,
  min,
  max,
  step = 0.01,
  format = (v: number) => String(v),
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  format?: (v: number) => string;
  onChange: (v: number) => void;
}) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <span style={{ opacity: 0.85, fontSize: 12 }}>{label}</span>
        <span style={{ opacity: 0.7, fontSize: 11 }}>{format(value)}</span>
      </div>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(parseFloat(e.target.value))}
        style={{
          width: "100%",
          accentColor: "rgba(255,255,255,0.8)",
        }}
      />
    </div>
  );
}

function normalizeDeg(deg: number): number {
  let d = deg % 360;
  if (d > 180) d -= 360;
  if (d < -180) d += 360;
  return d;
}

/** Hit-test point (viewport) against ellipse centered at (cx,cy) with rotation rotDeg (deg). */
function pointInRotatedEllipse(
  clientX: number,
  clientY: number,
  cx: number,
  cy: number,
  rotDeg: number,
  rx: number,
  ry: number
): boolean {
  const dx = clientX - cx;
  const dy = clientY - cy;
  const rad = (rotDeg * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  const xLocal = dx * cos + dy * sin;
  const yLocal = -dx * sin + dy * cos;
  return (xLocal * xLocal) / (rx * rx) + (yLocal * yLocal) / (ry * ry) <= 1;
}

/** Hit-test point (viewport) against axis-aligned rectangle centered at (cx,cy) with rotation rotDeg (deg). */
function pointInRotatedRect(
  clientX: number,
  clientY: number,
  cx: number,
  cy: number,
  rotDeg: number,
  halfW: number,
  halfH: number
): boolean {
  const dx = clientX - cx;
  const dy = clientY - cy;
  const rad = (rotDeg * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  const xLocal = dx * cos + dy * sin;
  const yLocal = -dx * sin + dy * cos;
  return Math.abs(xLocal) <= halfW && Math.abs(yLocal) <= halfH;
}

function clientPointToSvgUser(
  svg: SVGSVGElement,
  clientX: number,
  clientY: number
): { x: number; y: number } | null {
  const pt = svg.createSVGPoint();
  pt.x = clientX;
  pt.y = clientY;
  const ctm = svg.getScreenCTM();
  if (!ctm) return null;
  const p = pt.matrixTransform(ctm.inverse());
  return { x: p.x, y: p.y };
}

/** Curved-arrow cursor for Ribcage rotation (compact; hot spot center). */
const OVAL_ROTATE_CURSOR = `url("data:image/svg+xml;charset=utf-8,${encodeURIComponent(
  `<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 20 20">
    <path d="M10 4.5 A6.2 6.2 0 1 1 6.5 13.5" fill="none" stroke="white" stroke-width="3" stroke-linecap="round"/>
    <path d="M10 4.5 A6.2 6.2 0 1 1 6.5 13.5" fill="none" stroke="black" stroke-width="1.1" stroke-linecap="round"/>
    <path d="M10 2.2 L13.2 7.8 H6.8 Z" fill="white" stroke="black" stroke-width="0.65" stroke-linejoin="round"/>
  </svg>`
)}") 10 10, crosshair`;

function resolveOvalSvgPointerCursor(
  svg: SVGSVGElement,
  clientX: number,
  clientY: number,
  altKey: boolean,
  shiftKey: boolean,
  ovalWidth: number,
  ovalHeightPx: number,
  ovalRotateDeg: number,
  handlesVisible: boolean
): string {
  const lp = clientPointToSvgUser(svg, clientX, clientY);
  if (!lp) return "grab";

  const lcx = ovalWidth / 2;
  const lcy = ovalHeightPx / 2;
  const lerx = Math.max(4, ovalWidth / 2 - 4);
  const lery = Math.max(4, ovalHeightPx / 2 - 4);
  const boxL = lcx - lerx;
  const boxT = lcy - lery;
  const boxWi = 2 * lerx;
  const boxHi = 2 * lery;
  if (handlesVisible) {
    const cornerSz = Math.min(14, Math.max(5, Math.min(ovalWidth, ovalHeightPx) * 0.06));
    const cornerHalf = cornerSz / 2;
    const cornerPts = [
      [boxL, boxT],
      [boxL + boxWi, boxT],
      [boxL + boxWi, boxT + boxHi],
      [boxL, boxT + boxHi],
    ] as const;
    const cornerCursors = ["nwse-resize", "nesw-resize", "nwse-resize", "nesw-resize"] as const;
    for (let i = 0; i < 4; i++) {
      const [bx, by] = cornerPts[i];
      if (
        lp.x >= bx - cornerHalf &&
        lp.x <= bx + cornerHalf &&
        lp.y >= by - cornerHalf &&
        lp.y <= by + cornerHalf
      ) {
        return cornerCursors[i];
      }
    }

    const edgeDepth = Math.max(6, Math.min(18, Math.min(ovalWidth, ovalHeightPx) * 0.09));
    const edgeInset = cornerHalf + 2;
    const inTop =
      lp.x >= boxL + edgeInset &&
      lp.x <= boxL + boxWi - edgeInset &&
      lp.y >= boxT - edgeDepth &&
      lp.y <= boxT + edgeDepth;
    const inBottom =
      lp.x >= boxL + edgeInset &&
      lp.x <= boxL + boxWi - edgeInset &&
      lp.y >= boxT + boxHi - edgeDepth &&
      lp.y <= boxT + boxHi + edgeDepth;
    const inLeft =
      lp.x >= boxL - edgeDepth &&
      lp.x <= boxL + edgeDepth &&
      lp.y >= boxT + edgeInset &&
      lp.y <= boxT + boxHi - edgeInset;
    const inRight =
      lp.x >= boxL + boxWi - edgeDepth &&
      lp.x <= boxL + boxWi + edgeDepth &&
      lp.y >= boxT + edgeInset &&
      lp.y <= boxT + boxHi - edgeInset;

    if (inTop || inBottom) return "ns-resize";
    if (inLeft || inRight) return "ew-resize";
  }

  const srect = svg.getBoundingClientRect();
  const scx = srect.left + srect.width / 2;
  const scy = srect.top + srect.height / 2;
  const scaleX = srect.width / ovalWidth;
  const scaleY = srect.height / ovalHeightPx;
  const rxPix = Math.max(4, ovalWidth / 2 - 4) * scaleX;
  const ryPix = Math.max(4, ovalHeightPx / 2 - 4) * scaleY;
  const inEllipse = pointInRotatedEllipse(
    clientX,
    clientY,
    scx,
    scy,
    ovalRotateDeg,
    rxPix,
    ryPix
  );

  if (!inEllipse) return "grab";
  if (shiftKey) return "ns-resize";
  if (altKey) return OVAL_ROTATE_CURSOR;
  return "grab";
}

function resolveCircleSvgPointerCursor(
  svg: SVGSVGElement,
  clientX: number,
  clientY: number,
  altKey: boolean,
  shiftKey: boolean,
  diameterPx: number,
  rotateDeg: number,
  handlesVisible: boolean
): string {
  return resolveOvalSvgPointerCursor(
    svg,
    clientX,
    clientY,
    altKey,
    shiftKey,
    diameterPx,
    diameterPx,
    rotateDeg,
    handlesVisible
  );
}

function resolveRotatedRectSvgPointerCursor(
  svg: SVGSVGElement,
  clientX: number,
  clientY: number,
  altKey: boolean,
  shiftKey: boolean,
  rectWidth: number,
  rectHeightPx: number,
  rectRotateDeg: number,
  handlesVisible: boolean
): string {
  const lp = clientPointToSvgUser(svg, clientX, clientY);
  if (!lp) return "grab";

  const lcx = rectWidth / 2;
  const lcy = rectHeightPx / 2;
  const lerx = Math.max(4, rectWidth / 2 - 4);
  const lery = Math.max(4, rectHeightPx / 2 - 4);
  const boxL = lcx - lerx;
  const boxT = lcy - lery;
  const boxWi = 2 * lerx;
  const boxHi = 2 * lery;
  if (handlesVisible) {
    const cornerSz = Math.min(14, Math.max(5, Math.min(rectWidth, rectHeightPx) * 0.06));
    const cornerHalf = cornerSz / 2;
    const cornerPts = [
      [boxL, boxT],
      [boxL + boxWi, boxT],
      [boxL + boxWi, boxT + boxHi],
      [boxL, boxT + boxHi],
    ] as const;
    const cornerCursors = ["nwse-resize", "nesw-resize", "nwse-resize", "nesw-resize"] as const;
    for (let i = 0; i < 4; i++) {
      const [bx, by] = cornerPts[i];
      if (
        lp.x >= bx - cornerHalf &&
        lp.x <= bx + cornerHalf &&
        lp.y >= by - cornerHalf &&
        lp.y <= by + cornerHalf
      ) {
        return cornerCursors[i];
      }
    }

    const edgeDepth = Math.max(6, Math.min(18, Math.min(rectWidth, rectHeightPx) * 0.09));
    const edgeInset = cornerHalf + 2;
    const inTop =
      lp.x >= boxL + edgeInset &&
      lp.x <= boxL + boxWi - edgeInset &&
      lp.y >= boxT - edgeDepth &&
      lp.y <= boxT + edgeDepth;
    const inBottom =
      lp.x >= boxL + edgeInset &&
      lp.x <= boxL + boxWi - edgeInset &&
      lp.y >= boxT + boxHi - edgeDepth &&
      lp.y <= boxT + boxHi + edgeDepth;
    const inLeft =
      lp.x >= boxL - edgeDepth &&
      lp.x <= boxL + edgeDepth &&
      lp.y >= boxT + edgeInset &&
      lp.y <= boxT + boxHi - edgeInset;
    const inRight =
      lp.x >= boxL + boxWi - edgeDepth &&
      lp.x <= boxL + boxWi + edgeDepth &&
      lp.y >= boxT + edgeInset &&
      lp.y <= boxT + boxHi - edgeInset;

    if (inTop || inBottom) return "ns-resize";
    if (inLeft || inRight) return "ew-resize";
  }

  const srect = svg.getBoundingClientRect();
  const scx = srect.left + srect.width / 2;
  const scy = srect.top + srect.height / 2;
  const scaleX = srect.width / rectWidth;
  const scaleY = srect.height / rectHeightPx;
  const hxPix = lerx * scaleX;
  const hyPix = lery * scaleY;
  const inRect = pointInRotatedRect(clientX, clientY, scx, scy, rectRotateDeg, hxPix, hyPix);

  if (!inRect) return "grab";
  if (shiftKey) return "ns-resize";
  if (altKey) return OVAL_ROTATE_CURSOR;
  return "grab";
}

const BOX3D_PAD = 14;
/** Degrees per pixel for Ctrl/Cmd or middle/right-drag orbit on the 3D box. */
const BOX3D_ORBIT_DEG_PER_PX = 0.45;

type Box3dLayout = {
  vbW: number;
  vbH: number;
  w: number;
  h: number;
  d: number;
  verts2d: [number, number][];
  frontFacePoly: [number, number][];
  facesSorted: { poly: [number, number][]; key: string }[];
  wireframeEdges: readonly (readonly [number, number])[];
};

/** Rotate box vertex (screen y down). Caller orthographically projects with (x, y) only so at yaw=0, pitch=0 the front face is a flat rectangle and depth is not visible until tilted. */
function rotateBox3dVertex(
  x: number,
  y: number,
  z: number,
  w: number,
  h: number,
  d: number,
  yawDeg: number,
  pitchDeg: number
): [number, number, number] {
  const yaw = (yawDeg * Math.PI) / 180;
  const pitch = (pitchDeg * Math.PI) / 180;
  const X = x - w / 2;
  const YUp = -(y - h / 2);
  const Z = z - d / 2;
  const x1 = X * Math.cos(yaw) + Z * Math.sin(yaw);
  const z1 = -X * Math.sin(yaw) + Z * Math.cos(yaw);
  const y1 = YUp;
  const y2 = y1 * Math.cos(pitch) - z1 * Math.sin(pitch);
  const z2 = y1 * Math.sin(pitch) + z1 * Math.cos(pitch);
  const x2 = x1;
  return [x2 + w / 2, h / 2 - y2, z2 + d / 2];
}

function computeBox3dLayout(
  w: number,
  h: number,
  d: number,
  yawDeg: number,
  pitchDeg: number,
  pad: number = BOX3D_PAD
): Box3dLayout {
  const raw: [number, number][] = [];
  const verts3d: [number, number, number][] = [
    [0, 0, 0],
    [w, 0, 0],
    [w, h, 0],
    [0, h, 0],
    [0, 0, d],
    [w, 0, d],
    [w, h, d],
    [0, h, d],
  ];
  for (const [x, y, z] of verts3d) {
    const [xr, yr] = rotateBox3dVertex(x, y, z, w, h, d, yawDeg, pitchDeg);
    raw.push([xr, yr]);
  }
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const [px, py] of raw) {
    minX = Math.min(minX, px);
    minY = Math.min(minY, py);
    maxX = Math.max(maxX, px);
    maxY = Math.max(maxY, py);
  }
  // Keep the cube's geometric center fixed in the SVG viewBox so yaw/pitch rotations
  // don't make the cube appear to "orbit around" a moving 2D pivot.
  let cx = 0;
  let cy = 0;
  for (const [px, py] of raw) {
    cx += px;
    cy += py;
  }
  cx /= raw.length;
  cy /= raw.length;

  let padX = pad;
  let padY = pad;
  let vbW = maxX - minX + 2 * padX;
  let vbH = maxY - minY + 2 * padY;
  let ox = vbW / 2 - cx;
  let oy = vbH / 2 - cy;

  // Ensure all points remain inside the viewBox after centering the centroid.
  for (let iter = 0; iter < 3; iter++) {
    const minAfterX = minX + ox;
    const maxAfterX = maxX + ox;
    const minAfterY = minY + oy;
    const maxAfterY = maxY + oy;
    const extraX = Math.max(0, -minAfterX, maxAfterX - vbW) + 1;
    const extraY = Math.max(0, -minAfterY, maxAfterY - vbH) + 1;
    if (extraX <= 1 && extraY <= 1) break;
    padX += Math.max(0, extraX - 1);
    padY += Math.max(0, extraY - 1);
    vbW = maxX - minX + 2 * padX;
    vbH = maxY - minY + 2 * padY;
    ox = vbW / 2 - cx;
    oy = vbH / 2 - cy;
  }

  const verts2d: [number, number][] = raw.map(([px, py]) => [px + ox, py + oy]);

  const faceIdx: { key: string; vi: readonly number[] }[] = [
    { key: "back", vi: [5, 4, 7, 6] },
    { key: "left", vi: [0, 3, 7, 4] },
    { key: "bottom", vi: [3, 2, 6, 7] },
    { key: "top", vi: [0, 1, 5, 4] },
    { key: "right", vi: [1, 2, 6, 5] },
    { key: "front", vi: [0, 1, 2, 3] },
  ];

  const faceDepth = (vi: readonly number[]) => {
    let s = 0;
    for (const i of vi) {
      const [x, y, z] = verts3d[i]!;
      const [, , zr] = rotateBox3dVertex(x, y, z, w, h, d, yawDeg, pitchDeg);
      s += zr;
    }
    return s / vi.length;
  };

  const facesSorted = [...faceIdx]
    .sort((a, b) => faceDepth(b.vi) - faceDepth(a.vi))
    .map(({ key, vi }) => ({
      key,
      poly: vi.map((i) => verts2d[i]!) as [number, number][],
    }));

  const frontFacePoly = [0, 1, 2, 3].map((i) => verts2d[i]!) as [number, number][];

  const wireframeEdges: (readonly [number, number])[] = [
    [0, 1],
    [1, 2],
    [2, 3],
    [3, 0],
    [4, 5],
    [5, 6],
    [6, 7],
    [7, 4],
    [0, 4],
    [1, 5],
    [2, 6],
    [3, 7],
  ];

  return {
    vbW,
    vbH,
    w,
    h,
    d,
    verts2d,
    frontFacePoly,
    facesSorted,
    wireframeEdges,
  };
}

/** Unit tangent along a projected wireframe edge, canonicalized so horizontal edges point right and vertical edges point up (screen y down). */
function box3dWireframeEdgeTangentCanonical(va: readonly [number, number], vb: readonly [number, number]): [number, number] {
  let tx = vb[0] - va[0];
  let ty = vb[1] - va[1];
  const len = Math.hypot(tx, ty);
  if (len < 1e-9) return [1, 0];
  tx /= len;
  ty /= len;
  if (Math.abs(tx) >= Math.abs(ty) && tx < 0) {
    tx = -tx;
    ty = -ty;
  }
  if (Math.abs(ty) > Math.abs(tx) && ty > 0) {
    tx = -tx;
    ty = -ty;
  }
  return [tx, ty];
}

/**
 * Map pointer delta (screen px) to yaw/pitch change for dragging along a wireframe edge.
 * Horizontal-ish edges: drag along the edge → yaw, perpendicular → pitch; vertical-ish: perpendicular → yaw, along → pitch.
 */
function box3dEdgePointerDeltaToYawPitch(tx: number, ty: number, dx: number, dy: number, k: number): { dyaw: number; dpitch: number } {
  const θ = Math.atan2(ty, tx);
  const u = dx * Math.cos(θ) + dy * Math.sin(θ);
  const v = -dx * Math.sin(θ) + dy * Math.cos(θ);
  if (Math.abs(tx) >= Math.abs(ty)) {
    return { dyaw: k * u, dpitch: -k * v };
  }
  return { dyaw: k * v, dpitch: k * u };
}

function pointNearBox3dWireframeEdge(
  px: number,
  py: number,
  L: Box3dLayout,
  edgeInset: number
): boolean {
  const edgeDepth = Math.max(6, Math.min(18, Math.min(L.w, L.h) * 0.09));
  for (const [a, b] of L.wireframeEdges) {
    const va = L.verts2d[a]!;
    const vb = L.verts2d[b]!;
    if (pointNearSegment(px, py, va[0], va[1], vb[0], vb[1], edgeDepth, edgeInset)) return true;
  }
  return false;
}

function isBox3dDepthEdge(edge: readonly [number, number]): boolean {
  const [a, b] = edge;
  return Math.abs(a - b) === 4;
}

const BOX3D_FACE_FILL: Record<string, string> = {
  front: "rgba(255,255,255,0.06)",
  back: "rgba(255,255,255,0.04)",
  top: "rgba(255,255,255,0.11)",
  bottom: "rgba(255,255,255,0.05)",
  left: "rgba(255,255,255,0.06)",
  right: "rgba(255,255,255,0.07)",
};

function quadCentroid(poly: readonly [number, number][]): [number, number] {
  let sx = 0;
  let sy = 0;
  for (const [x, y] of poly) {
    sx += x;
    sy += y;
  }
  const n = poly.length;
  return [sx / n, sy / n];
}

function shrinkQuad(poly: [number, number][], t: number): [number, number][] {
  const [cx, cy] = quadCentroid(poly);
  return poly.map(([x, y]) => [cx + (x - cx) * t, cy + (y - cy) * t]);
}

function pointNearSegment(
  px: number,
  py: number,
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  maxDist: number,
  endMargin: number
): boolean {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const len = Math.hypot(dx, dy);
  if (len < 1e-9) return Math.hypot(px - x1, py - y1) <= maxDist;
  let t = ((px - x1) * dx + (py - y1) * dy) / (len * len);
  t = Math.max(0, Math.min(1, t));
  if (t * len < endMargin || (1 - t) * len < endMargin) return false;
  const qx = x1 + t * dx;
  const qy = y1 + t * dy;
  return Math.hypot(px - qx, py - qy) <= maxDist;
}

function pointInPolygon(x: number, y: number, poly: readonly [number, number][]): boolean {
  let inside = false;
  const n = poly.length;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const xi = poly[i][0];
    const yi = poly[i][1];
    const xj = poly[j][0];
    const yj = poly[j][1];
    const denom = yj - yi;
    const inter =
      yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (Math.abs(denom) < 1e-9 ? 1e-9 : denom) + xi;
    if (inter) inside = !inside;
  }
  return inside;
}

function pointInBox3dUnion(x: number, y: number, L: Box3dLayout): boolean {
  for (const f of L.facesSorted) {
    if (pointInPolygon(x, y, f.poly)) return true;
  }
  return false;
}

function resolveBox3dSvgPointerCursor(
  svg: SVGSVGElement,
  clientX: number,
  clientY: number,
  altKey: boolean,
  shiftKey: boolean,
  ctrlKey: boolean,
  metaKey: boolean,
  w: number,
  h: number,
  d: number,
  yawDeg: number,
  pitchDeg: number,
  handlesVisible: boolean
): string {
  const lp = clientPointToSvgUser(svg, clientX, clientY);
  if (!lp) return "grab";
  const L = computeBox3dLayout(w, h, d, yawDeg, pitchDeg);
  const front = L.frontFacePoly;
  if (handlesVisible) {
    const cornerSz = Math.min(14, Math.max(5, Math.min(w, h) * 0.06));
    const cornerHalf = cornerSz / 2;
    const cornerCursors = ["nwse-resize", "nesw-resize", "nwse-resize", "nesw-resize"] as const;
    for (let i = 0; i < 4; i++) {
      const [bx, by] = front[i]!;
      if (
        lp.x >= bx - cornerHalf &&
        lp.x <= bx + cornerHalf &&
        lp.y >= by - cornerHalf &&
        lp.y <= by + cornerHalf
      ) {
        return cornerCursors[i];
      }
    }

    const edgeInset = cornerHalf + 2;
    if (!shiftKey && !altKey && pointNearBox3dWireframeEdge(lp.x, lp.y, L, edgeInset)) return "grab";

    const chHalf = Math.max(10, Math.min(w, h) * 0.11);
    // Crosshair hover/pan target is centered on the cube's 3D center.
    const ccx = L.vbW / 2;
    const ccy = L.vbH / 2;
    if (Math.hypot(lp.x - ccx, lp.y - ccy) <= chHalf + 10) return "move";
  }

  if (!pointInBox3dUnion(lp.x, lp.y, L)) return "grab";
  if (shiftKey && !altKey) return "ns-resize";
  if (shiftKey && altKey) return "move";
  if (altKey) return OVAL_ROTATE_CURSOR;
  if (!shiftKey && !altKey && pointNearBox3dWireframeEdge(lp.x, lp.y, L, 0)) return "grab";
  if (ctrlKey || metaKey) return "grab";
  return "grab";
}

export default function Page() {
  const [dirHandle, setDirHandle] = useState<FileSystemDirectoryHandle | null>(null);
  const [files, setFiles] = useState<FileHandleEntry[]>([]);
  const [order, setOrder] = useState<number[]>([]);
  const [idxInOrder, setIdxInOrder] = useState(0);
  /** Always matches idxInOrder so interval callbacks can compute advance synchronously (React may defer setState updaters). */
  const idxInOrderRef = useRef(0);
  idxInOrderRef.current = idxInOrder;

  const storedSettings = useMemo(() => loadStoredSettings(), []);

  const [isRunning, setIsRunning] = useState(false);
  const [intervalSec, setIntervalSec] = useState(storedSettings.intervalSec);
  const [timerMode, setTimerMode] = useState<TimerMode>(parseTimerMode(storedSettings.timerMode));
  /** Remaining classic slot counts per tier; each completed interval decrements the tier that was active. */
  const [classicSlots, setClassicSlots] = useState<ClassicSlots>(() => ({ ...CLASSIC_SLOTS_INITIAL }));
  const prevTimerModeRef = useRef<TimerMode>(parseTimerMode(storedSettings.timerMode));
  const [timeRemaining, setTimeRemaining] = useState(0);
  const [elapsedSec, setElapsedSec] = useState(storedSettings.elapsedSec);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [currentUrl, setCurrentUrl] = useState<string | null>(null);
  const currentUrlRef = useRef<string | null>(null);
  const timerRef = useRef<number | null>(null);
  /** Tier (seconds) for the auto-advance interval currently scheduled — used when a classic slot completes. */
  const classicAdvanceTierRef = useRef<ClassicTierSec>(CLASSIC_FIRST_TIER);
  const countdownRef = useRef<number | null>(null);
  const imageContainerRef = useRef<HTMLDivElement | null>(null);
  const fullscreenContainerRef = useRef<HTMLDivElement | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const currentImgRef = useRef<HTMLImageElement | null>(null);
  const poseCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const poseLandmarkerRef = useRef<PoseLandmarker | null>(null);
  const [poseReady, setPoseReady] = useState(false);
  const [poseNonce, setPoseNonce] = useState(0);
  const ovalHitAreaRef = useRef<HTMLDivElement | null>(null);
  const ovalSvgRef = useRef<SVGSVGElement | null>(null);
  const lastPointerOnOvalSvgRef = useRef<{ x: number; y: number } | null>(null);
  const pointerInsideOvalSvgRef = useRef(false);
  const circleHitAreaRef = useRef<HTMLDivElement | null>(null);
  const circleSvgRef = useRef<SVGSVGElement | null>(null);
  const lastPointerOnCircleSvgRef = useRef<{ x: number; y: number } | null>(null);
  const pointerInsideCircleSvgRef = useRef(false);
  const rectangleHitAreaRef = useRef<HTMLDivElement | null>(null);
  const rectangleSvgRef = useRef<SVGSVGElement | null>(null);
  const lastPointerOnRectangleSvgRef = useRef<{ x: number; y: number } | null>(null);
  const pointerInsideRectangleSvgRef = useRef(false);
  const box3dHitAreaRef = useRef<HTMLDivElement | null>(null);
  const box3dSvgRef = useRef<SVGSVGElement | null>(null);
  const lastPointerOnBox3dSvgRef = useRef<{ x: number; y: number } | null>(null);
  const pointerInsideBox3dSvgRef = useRef(false);

  const [supported, setSupported] = useState(false);
  const [lastFolderName, setLastFolderNameState] = useState("");
  const [lastFolderOpenedAt, setLastFolderOpenedAtState] = useState<number | null>(null);

  type ImageMeta = {
    fileSize?: number;
    lastModified?: number;
    width?: number;
    height?: number;
  };
  const [imageMeta, setImageMeta] = useState<ImageMeta>({});

  const [imageScale, setImageScale] = useState(storedSettings.imageScale);
  const [imageBrightness, setImageBrightness] = useState(storedSettings.imageBrightness);
  const [imageContrast, setImageContrast] = useState(storedSettings.imageContrast);
  const [imageRotate, setImageRotate] = useState(storedSettings.imageRotate);
  const [imageFlipH, setImageFlipH] = useState(storedSettings.imageFlipH);
  const [imageFlipV, setImageFlipV] = useState(storedSettings.imageFlipV);
  const [imageGrayscale, setImageGrayscale] = useState(storedSettings.imageGrayscale);
  const [imageSaturation, setImageSaturation] = useState(storedSettings.imageSaturation);
  const [imageBlur, setImageBlur] = useState(storedSettings.imageBlur);
  const [showCenterFrame, setShowCenterFrame] = useState(
    storedSettings.showCenterFrame !== false
  );
  const [showGrid, setShowGrid] = useState(storedSettings.showGrid !== false);
  const [gridCellSize, setGridCellSize] = useState(
    Math.min(200, Math.max(16, Number(storedSettings.gridCellSize) || 48))
  );
  const [centerFrameSize, setCenterFrameSize] = useState(
    Math.min(
      480,
      Math.max(48, Number(storedSettings.centerFrameSize) || 136)
    )
  );
  const [centerFrameLabelSize, setCenterFrameLabelSize] = useState(
    Math.min(
      300,
      Math.max(8, Number(storedSettings.centerFrameLabelSize) || 50)
    )
  );
  const [showOval, setShowOval] = useState(storedSettings.showOval !== false);
  const [ovalWidth, setOvalWidth] = useState(
    Math.min(560, Math.max(80, Number(storedSettings.ovalWidth) || 139))
  );
  const [ovalHeightPx, setOvalHeightPx] = useState(() => {
    const w = Number(storedSettings.ovalWidth) || 139;
    const fromStored = Number(storedSettings.ovalHeightPx);
    const fallback = Math.max(80, Math.round(w / 0.58));
    return Math.min(
      560,
      Math.max(48, Number.isFinite(fromStored) ? fromStored : fallback)
    );
  });
  const [ovalRotateDeg, setOvalRotateDeg] = useState(
    Math.min(180, Math.max(-180, Number(storedSettings.ovalRotateDeg) || 0))
  );
  const [ovalOffsetX, setOvalOffsetX] = useState(
    Number.isFinite(Number(storedSettings.ovalOffsetX)) ? Number(storedSettings.ovalOffsetX) : 0
  );
  const [ovalOffsetY, setOvalOffsetY] = useState(
    Number.isFinite(Number(storedSettings.ovalOffsetY)) ? Number(storedSettings.ovalOffsetY) : 0
  );
  /** Selected after clicking the Ribcage overlay; yellow outline. Cleared by clicking outside it. */
  const [ovalSelected, setOvalSelected] = useState(false);
  const ovalSelectedRef = useRef(ovalSelected);
  ovalSelectedRef.current = ovalSelected;
  const [showCircle, setShowCircle] = useState(storedSettings.showCircle !== false);
  const [showPose, setShowPose] = useState(storedSettings.showPose === true);
  const [poseFigureMode, setPoseFigureMode] = useState(storedSettings.poseFigureMode !== false);
  const [poseMinConfidence, setPoseMinConfidence] = useState(
    Math.min(0.95, Math.max(0.05, Number(storedSettings.poseMinConfidence) || DEFAULT_SETTINGS.poseMinConfidence))
  );
  const [poseOffsetX, setPoseOffsetX] = useState(
    Number.isFinite(Number(storedSettings.poseOffsetX)) ? Number(storedSettings.poseOffsetX) : DEFAULT_SETTINGS.poseOffsetX
  );
  const [poseOffsetY, setPoseOffsetY] = useState(
    Number.isFinite(Number(storedSettings.poseOffsetY)) ? Number(storedSettings.poseOffsetY) : DEFAULT_SETTINGS.poseOffsetY
  );
  const [circleDiameterPx, setCircleDiameterPx] = useState(
    Math.min(560, Math.max(48, Number(storedSettings.circleDiameterPx) || 200))
  );
  const [circleRotateDeg, setCircleRotateDeg] = useState(
    Math.min(180, Math.max(-180, Number(storedSettings.circleRotateDeg) || 0))
  );
  const [circleOffsetX, setCircleOffsetX] = useState(
    Number.isFinite(Number(storedSettings.circleOffsetX)) ? Number(storedSettings.circleOffsetX) : 0
  );
  const [circleOffsetY, setCircleOffsetY] = useState(
    Number.isFinite(Number(storedSettings.circleOffsetY)) ? Number(storedSettings.circleOffsetY) : 0
  );
  const [circleSelected, setCircleSelected] = useState(false);
  const circleSelectedRef = useRef(circleSelected);
  circleSelectedRef.current = circleSelected;
  const circleRotateDegRef = useRef(circleRotateDeg);
  circleRotateDegRef.current = circleRotateDeg;
  const [showRectangle, setShowRectangle] = useState(storedSettings.showRectangle !== false);
  const [rectangleWidth, setRectangleWidth] = useState(
    Math.min(560, Math.max(80, Number(storedSettings.rectangleWidth) || DEFAULT_SETTINGS.rectangleWidth))
  );
  const [rectangleHeightPx, setRectangleHeightPx] = useState(
    Math.min(560, Math.max(48, Number(storedSettings.rectangleHeightPx) || DEFAULT_SETTINGS.rectangleHeightPx))
  );
  const [rectangleRotateDeg, setRectangleRotateDeg] = useState(
    Math.min(180, Math.max(-180, Number(storedSettings.rectangleRotateDeg) || 0))
  );
  const [rectangleOffsetX, setRectangleOffsetX] = useState(
    Number.isFinite(Number(storedSettings.rectangleOffsetX)) ? Number(storedSettings.rectangleOffsetX) : 0
  );
  const [rectangleOffsetY, setRectangleOffsetY] = useState(
    Number.isFinite(Number(storedSettings.rectangleOffsetY)) ? Number(storedSettings.rectangleOffsetY) : 0
  );
  const [rectangleSelected, setRectangleSelected] = useState(false);
  const rectangleSelectedRef = useRef(rectangleSelected);
  rectangleSelectedRef.current = rectangleSelected;
  const rectangleRotateDegRef = useRef(rectangleRotateDeg);
  rectangleRotateDegRef.current = rectangleRotateDeg;
  const [showBox3d, setShowBox3d] = useState(storedSettings.showBox3d !== false);
  const [box3dWidth, setBox3dWidth] = useState(
    Math.min(560, Math.max(80, Number(storedSettings.box3dWidth) || DEFAULT_SETTINGS.box3dWidth))
  );
  const [box3dHeightPx, setBox3dHeightPx] = useState(
    Math.min(560, Math.max(48, Number(storedSettings.box3dHeightPx) || DEFAULT_SETTINGS.box3dHeightPx))
  );
  const [box3dDepthPx, setBox3dDepthPx] = useState(
    Math.min(560, Math.max(24, Number(storedSettings.box3dDepthPx) || DEFAULT_SETTINGS.box3dDepthPx))
  );
  const [box3dRotateDeg, setBox3dRotateDeg] = useState(
    Math.min(180, Math.max(-180, Number(storedSettings.box3dRotateDeg) || 0))
  );
  const [box3dYawDeg, setBox3dYawDeg] = useState(
    Math.min(180, Math.max(-180, Number(storedSettings.box3dYawDeg) || 0))
  );
  const [box3dPitchDeg, setBox3dPitchDeg] = useState(
    Math.min(180, Math.max(-180, Number(storedSettings.box3dPitchDeg) || 0))
  );
  const [box3dOffsetX, setBox3dOffsetX] = useState(
    Number.isFinite(Number(storedSettings.box3dOffsetX)) ? Number(storedSettings.box3dOffsetX) : 0
  );
  const [box3dOffsetY, setBox3dOffsetY] = useState(
    Number.isFinite(Number(storedSettings.box3dOffsetY)) ? Number(storedSettings.box3dOffsetY) : 0
  );
  const [box3dSelected, setBox3dSelected] = useState(false);
  const [box3dActiveEdgeIndex, setBox3dActiveEdgeIndex] = useState<number | null>(null);
  const [box3dActiveEdgeColor, setBox3dActiveEdgeColor] = useState<"green" | "orange" | null>(null);
  const box3dSelectedRef = useRef(box3dSelected);
  box3dSelectedRef.current = box3dSelected;
  const box3dRotateDegRef = useRef(box3dRotateDeg);
  box3dRotateDegRef.current = box3dRotateDeg;
  const ovalRotateDegRef = useRef(ovalRotateDeg);
  ovalRotateDegRef.current = ovalRotateDeg;
  const ovalCrosshairHalf = useMemo(
    () => Math.max(10, Math.min(ovalWidth, ovalHeightPx) * 0.11),
    [ovalWidth, ovalHeightPx]
  );
  const ovalStrokeColor = ovalSelected ? "#facc15" : "#ffffff";
  const ovalCx = ovalWidth / 2;
  const ovalCy = ovalHeightPx / 2;
  const ovalErx = Math.max(4, ovalWidth / 2 - 4);
  const ovalEry = Math.max(4, ovalHeightPx / 2 - 4);
  const ovalBoxLeft = ovalCx - ovalErx;
  const ovalBoxTop = ovalCy - ovalEry;
  const ovalBoxW = 2 * ovalErx;
  const ovalBoxH = 2 * ovalEry;
  const ovalBoundingCornerSize = useMemo(
    () => Math.min(14, Math.max(5, Math.min(ovalWidth, ovalHeightPx) * 0.06)),
    [ovalWidth, ovalHeightPx]
  );
  const ovalBoundingCornerHalf = ovalBoundingCornerSize / 2;
  const circleStrokeColor = circleSelected ? "#facc15" : "#ffffff";
  const circleRGeom = Math.max(4, circleDiameterPx / 2 - 4);
  const circleSvgStrokeWidth = 5;
  const circleCrosshairOutsidePx = 30;
  const circleCrosshairHalf = useMemo(() => {
    const outerStrokeRadius = circleRGeom + circleSvgStrokeWidth / 2;
    return outerStrokeRadius + circleCrosshairOutsidePx;
  }, [circleRGeom]);
  const circleSvgHalf = circleCrosshairHalf;
  const circleSvgSize = circleSvgHalf * 2;
  const circleCx = circleSvgHalf;
  const circleCy = circleSvgHalf;
  const circleBoxLeft = circleCx - circleRGeom;
  const circleBoxTop = circleCy - circleRGeom;
  const circleBoxW = 2 * circleRGeom;
  const circleBoxH = 2 * circleRGeom;
  const circleBoundingCornerSize = useMemo(
    () => Math.min(14, Math.max(5, circleDiameterPx * 0.06)),
    [circleDiameterPx]
  );
  const circleBoundingCornerHalf = circleBoundingCornerSize / 2;
  const rectangleStrokeColor = rectangleSelected ? "#facc15" : "#ffffff";
  const rectangleCx = rectangleWidth / 2;
  const rectangleCy = rectangleHeightPx / 2;
  const rectangleLerx = Math.max(4, rectangleWidth / 2 - 4);
  const rectangleLery = Math.max(4, rectangleHeightPx / 2 - 4);
  const rectangleBoxLeft = rectangleCx - rectangleLerx;
  const rectangleBoxTop = rectangleCy - rectangleLery;
  const rectangleBoxW = 2 * rectangleLerx;
  const rectangleBoxH = 2 * rectangleLery;
  const rectangleBoundingCornerSize = useMemo(
    () => Math.min(14, Math.max(5, Math.min(rectangleWidth, rectangleHeightPx) * 0.06)),
    [rectangleWidth, rectangleHeightPx]
  );
  const rectangleBoundingCornerHalf = rectangleBoundingCornerSize / 2;
  const rectangleCrosshairHalf = useMemo(
    () => Math.max(10, Math.min(rectangleWidth, rectangleHeightPx) * 0.11),
    [rectangleWidth, rectangleHeightPx]
  );
  const box3dLayout = useMemo(
    () => computeBox3dLayout(box3dWidth, box3dHeightPx, box3dDepthPx, box3dYawDeg, box3dPitchDeg),
    [box3dWidth, box3dHeightPx, box3dDepthPx, box3dYawDeg, box3dPitchDeg]
  );
  const box3dStrokeColor = box3dSelected ? "#facc15" : "#ffffff";
  // Crosshair should be centered on the cube's geometric center in 3D space.
  // After projection + centering, that corresponds to the SVG viewBox center.
  const box3dFrontCx = useMemo(() => box3dLayout.vbW / 2, [box3dLayout.vbW]);
  const box3dFrontCy = useMemo(() => box3dLayout.vbH / 2, [box3dLayout.vbH]);
  const box3dFrontInnerPoly = useMemo(
    () =>
      shrinkQuad(box3dLayout.frontFacePoly, Math.max(0.82, 1 - 8 / Math.min(box3dWidth, box3dHeightPx))),
    [box3dLayout.frontFacePoly, box3dWidth, box3dHeightPx]
  );
  const box3dBoundingCornerSize = useMemo(
    () => Math.min(14, Math.max(5, Math.min(box3dWidth, box3dHeightPx) * 0.06)),
    [box3dWidth, box3dHeightPx]
  );
  const box3dBoundingCornerHalf = box3dBoundingCornerSize / 2;
  const box3dCrosshairHalf = useMemo(
    () => Math.max(10, Math.min(box3dWidth, box3dHeightPx) * 0.11),
    [box3dWidth, box3dHeightPx]
  );

  useEffect(() => {
    if (!box3dSelected) {
      setBox3dActiveEdgeIndex(null);
      setBox3dActiveEdgeColor(null);
    }
  }, [box3dSelected]);
  const lettraDisplayPx = useMemo(
    () =>
      Math.max(
        6,
        Math.min(centerFrameLabelSize, Math.max(8, centerFrameSize - 20))
      ),
    [centerFrameLabelSize, centerFrameSize]
  );

  const handleOvalPointerDown = useCallback(
    (e: React.PointerEvent<SVGSVGElement>) => {
      const svg = e.currentTarget;
      const srect = svg.getBoundingClientRect();
      const scx = srect.left + srect.width / 2;
      const scy = srect.top + srect.height / 2;
      const scaleX = srect.width / ovalWidth;
      const scaleY = srect.height / ovalHeightPx;
      const rxGeom = Math.max(4, ovalWidth / 2 - 4);
      const ryGeom = Math.max(4, ovalHeightPx / 2 - 4);
      const rxPix = rxGeom * scaleX;
      const ryPix = ryGeom * scaleY;

      const lp = clientPointToSvgUser(svg, e.clientX, e.clientY);
      if (!lp) return;

      const lcx = ovalWidth / 2;
      const lcy = ovalHeightPx / 2;
      const lerx = Math.max(4, ovalWidth / 2 - 4);
      const lery = Math.max(4, ovalHeightPx / 2 - 4);
      const boxL = lcx - lerx;
      const boxT = lcy - lery;
      const boxWi = 2 * lerx;
      const boxHi = 2 * lery;
      const cornerSz = Math.min(14, Math.max(5, Math.min(ovalWidth, ovalHeightPx) * 0.06));
      const cornerHalf = cornerSz / 2;

      const cornerPts = [
        [boxL, boxT],
        [boxL + boxWi, boxT],
        [boxL + boxWi, boxT + boxHi],
        [boxL, boxT + boxHi],
      ] as const;

      let cornerIndex: number | null = null;
      for (let i = 0; i < 4; i++) {
        const [bx, by] = cornerPts[i];
        if (
          lp.x >= bx - cornerHalf &&
          lp.x <= bx + cornerHalf &&
          lp.y >= by - cornerHalf &&
          lp.y <= by + cornerHalf
        ) {
          cornerIndex = i;
          break;
        }
      }

      const edgeDepth = Math.max(6, Math.min(18, Math.min(ovalWidth, ovalHeightPx) * 0.09));
      const edgeInset = cornerHalf + 2;
      let edgeKind: "top" | "bottom" | "left" | "right" | null = null;
      if (
        lp.x >= boxL + edgeInset &&
        lp.x <= boxL + boxWi - edgeInset &&
        lp.y >= boxT - edgeDepth &&
        lp.y <= boxT + edgeDepth
      ) {
        edgeKind = "top";
      } else if (
        lp.x >= boxL + edgeInset &&
        lp.x <= boxL + boxWi - edgeInset &&
        lp.y >= boxT + boxHi - edgeDepth &&
        lp.y <= boxT + boxHi + edgeDepth
      ) {
        edgeKind = "bottom";
      } else if (
        lp.x >= boxL - edgeDepth &&
        lp.x <= boxL + edgeDepth &&
        lp.y >= boxT + edgeInset &&
        lp.y <= boxT + boxHi - edgeInset
      ) {
        edgeKind = "left";
      } else if (
        lp.x >= boxL + boxWi - edgeDepth &&
        lp.x <= boxL + boxWi + edgeDepth &&
        lp.y >= boxT + edgeInset &&
        lp.y <= boxT + boxHi - edgeInset
      ) {
        edgeKind = "right";
      }
      // Edge/corner handles are available only while selected.
      if (!ovalSelectedRef.current) edgeKind = null;
      if (!ovalSelectedRef.current) cornerIndex = null;

      const inEllipse = pointInRotatedEllipse(
        e.clientX,
        e.clientY,
        scx,
        scy,
        ovalRotateDeg,
        rxPix,
        ryPix
      );

      if (cornerIndex === null && !inEllipse) return;

      e.preventDefault();
      e.stopPropagation();
      const pointerId = e.pointerId;
      svg.setPointerCapture(pointerId);
      setOvalSelected(true);
      setCircleSelected(false);
      setRectangleSelected(false);
      setBox3dSelected(false);

      const bindGesture = (onMove: (ev: PointerEvent) => void, cursor: string) => {
        svg.style.cursor = cursor;
        const wrappedUp = () => {
          svg.style.cursor = "grab";
          try {
            if (svg.hasPointerCapture(pointerId)) svg.releasePointerCapture(pointerId);
          } catch {
            /* ignore */
          }
          window.removeEventListener("pointermove", onMove);
          window.removeEventListener("pointerup", wrappedUp);
          window.removeEventListener("pointercancel", wrappedUp);
        };
        window.addEventListener("pointermove", onMove);
        window.addEventListener("pointerup", wrappedUp);
        window.addEventListener("pointercancel", wrappedUp);
      };

      if (e.shiftKey && inEllipse) {
        const r0 = Math.max(10, Math.hypot(e.clientX - scx, e.clientY - scy));
        const startW = ovalWidth;
        bindGesture((ev: PointerEvent) => {
          const r = Math.max(10, Math.hypot(ev.clientX - scx, ev.clientY - scy));
          const w = Math.min(560, Math.max(80, Math.round(((startW * r) / r0) / 4) * 4));
          setOvalWidth(w);
        }, "ns-resize");
        return;
      }

      if (cornerIndex !== null) {
        const startW = ovalWidth;
        const startH = ovalHeightPx;
        const startClientX = e.clientX;
        const startClientY = e.clientY;
        const mults = [
          [-2, -2],
          [2, -2],
          [2, 2],
          [-2, 2],
        ] as const;
        const [mx, my] = mults[cornerIndex];
        const cursors = ["nwse-resize", "nesw-resize", "nwse-resize", "nesw-resize"] as const;
        bindGesture((ev: PointerEvent) => {
          const dx = ev.clientX - startClientX;
          const dy = ev.clientY - startClientY;
          const w = Math.min(560, Math.max(80, Math.round((startW + mx * dx) / 4) * 4));
          const h = Math.min(560, Math.max(48, Math.round(startH + my * dy)));
          setOvalWidth(w);
          setOvalHeightPx(h);
        }, cursors[cornerIndex]);
        return;
      }

      if (edgeKind !== null) {
        const startW = ovalWidth;
        const startH = ovalHeightPx;
        const startClientX = e.clientX;
        const startClientY = e.clientY;
        if (edgeKind === "top" || edgeKind === "bottom") {
          const my = edgeKind === "top" ? -2 : 2;
          bindGesture((ev: PointerEvent) => {
            const dy = ev.clientY - startClientY;
            const h = Math.min(560, Math.max(48, Math.round(startH + my * dy)));
            setOvalHeightPx(h);
          }, "ns-resize");
          return;
        }
        const mx = edgeKind === "left" ? -2 : 2;
        bindGesture((ev: PointerEvent) => {
          const dx = ev.clientX - startClientX;
          const w = Math.min(560, Math.max(80, Math.round((startW + mx * dx) / 4) * 4));
          setOvalWidth(w);
        }, "ew-resize");
        return;
      }

      if (e.altKey && inEllipse) {
        const θ0 = Math.atan2(e.clientY - scy, e.clientX - scx);
        const angleOffset = θ0 - (ovalRotateDeg * Math.PI) / 180;
        bindGesture((ev: PointerEvent) => {
          const θ = Math.atan2(ev.clientY - scy, ev.clientX - scx);
          setOvalRotateDeg(normalizeDeg(((θ - angleOffset) * 180) / Math.PI));
        }, "grabbing");
        return;
      }

      const startX = e.clientX;
      const startY = e.clientY;
      const startOx = ovalOffsetX;
      const startOy = ovalOffsetY;
      bindGesture((ev: PointerEvent) => {
        setOvalOffsetX(startOx + ev.clientX - startX);
        setOvalOffsetY(startOy + ev.clientY - startY);
      }, "move");
    },
    [ovalWidth, ovalHeightPx, ovalRotateDeg, ovalOffsetX, ovalOffsetY]
  );

  const handleCirclePointerDown = useCallback(
    (e: React.PointerEvent<SVGSVGElement>) => {
      const svg = e.currentTarget;
      const d = circleDiameterPx;
      const svgSize = circleSvgSize;
      const srect = svg.getBoundingClientRect();
      const scx = srect.left + srect.width / 2;
      const scy = srect.top + srect.height / 2;
      const rGeom = Math.max(4, d / 2 - 4);
      const scaleX = srect.width / svgSize;
      const scaleY = srect.height / svgSize;
      const rxPix = rGeom * scaleX;
      const ryPix = rGeom * scaleY;

      const lp = clientPointToSvgUser(svg, e.clientX, e.clientY);
      if (!lp) return;

      const lcx = svgSize / 2;
      const lcy = svgSize / 2;
      const lr = Math.max(4, d / 2 - 4);
      const boxL = lcx - lr;
      const boxT = lcy - lr;
      const boxWi = 2 * lr;
      const boxHi = 2 * lr;
      const cornerSz = Math.min(14, Math.max(5, d * 0.06));
      const cornerHalf = cornerSz / 2;

      const cornerPts = [
        [boxL, boxT],
        [boxL + boxWi, boxT],
        [boxL + boxWi, boxT + boxHi],
        [boxL, boxT + boxHi],
      ] as const;

      let cornerIndex: number | null = null;
      for (let i = 0; i < 4; i++) {
        const [bx, by] = cornerPts[i];
        if (
          lp.x >= bx - cornerHalf &&
          lp.x <= bx + cornerHalf &&
          lp.y >= by - cornerHalf &&
          lp.y <= by + cornerHalf
        ) {
          cornerIndex = i;
          break;
        }
      }

      const inCircle = pointInRotatedEllipse(
        e.clientX,
        e.clientY,
        scx,
        scy,
        circleRotateDeg,
        rxPix,
        ryPix
      );

      // Allow panning when starting a drag on the extended crosshair lines
      // (even if the pointer is outside the circle outline).
      const crosshairBand = 3; // SVG user units (viewBox units); gives a small usability buffer
      const inCrosshair =
        (Math.abs(lp.x - lcx) <= crosshairBand && Math.abs(lp.y - lcy) <= circleCrosshairHalf + crosshairBand) ||
        (Math.abs(lp.y - lcy) <= crosshairBand && Math.abs(lp.x - lcx) <= circleCrosshairHalf + crosshairBand);

      if (cornerIndex === null && !inCircle && !inCrosshair) return;

      e.preventDefault();
      e.stopPropagation();
      const pointerId = e.pointerId;
      svg.setPointerCapture(pointerId);
      setCircleSelected(true);
      setOvalSelected(false);
      setRectangleSelected(false);
      setBox3dSelected(false);

      const bindGesture = (onMove: (ev: PointerEvent) => void, cursor: string) => {
        svg.style.cursor = cursor;
        const wrappedUp = () => {
          svg.style.cursor = "grab";
          try {
            if (svg.hasPointerCapture(pointerId)) svg.releasePointerCapture(pointerId);
          } catch {
            /* ignore */
          }
          window.removeEventListener("pointermove", onMove);
          window.removeEventListener("pointerup", wrappedUp);
          window.removeEventListener("pointercancel", wrappedUp);
        };
        window.addEventListener("pointermove", onMove);
        window.addEventListener("pointerup", wrappedUp);
        window.addEventListener("pointercancel", wrappedUp);
      };

      if (e.shiftKey && inCircle) {
        const r0 = Math.max(10, Math.hypot(e.clientX - scx, e.clientY - scy));
        const startD = circleDiameterPx;
        bindGesture((ev: PointerEvent) => {
          const r = Math.max(10, Math.hypot(ev.clientX - scx, ev.clientY - scy));
          const nd = Math.min(560, Math.max(48, Math.round(((startD * r) / r0) / 4) * 4));
          setCircleDiameterPx(nd);
        }, "ns-resize");
        return;
      }

      // Dragging outward from the rim should resize the diameter.
      // This intentionally does not require Shift, so "pull out" feels natural.
      if (
        cornerIndex === null &&
        !e.shiftKey &&
        !e.altKey &&
        e.button === 0 &&
        inCircle
      ) {
        const r0 = Math.max(0.01, Math.hypot(e.clientX - scx, e.clientY - scy));
        const rEdge = (rxPix + ryPix) / 2;
        const edgeBand = Math.max(6, rEdge * 0.08);
        if (Math.abs(r0 - rEdge) <= edgeBand) {
          const startD = circleDiameterPx;
          bindGesture((ev: PointerEvent) => {
            const r = Math.max(10, Math.hypot(ev.clientX - scx, ev.clientY - scy));
            const nd = Math.min(560, Math.max(48, Math.round(((startD * r) / r0) / 4) * 4));
            setCircleDiameterPx(nd);
          }, "ns-resize");
          return;
        }
      }

      if (cornerIndex !== null) {
        const startD = circleDiameterPx;
        const startClientX = e.clientX;
        const startClientY = e.clientY;
        const r0 = Math.max(0.01, Math.hypot(startClientX - scx, startClientY - scy));
        const cursors = ["nwse-resize", "nesw-resize", "nwse-resize", "nesw-resize"] as const;
        bindGesture((ev: PointerEvent) => {
          // Pull outward increases radius -> increases diameter; pull inward decreases.
          const r = Math.max(0.01, Math.hypot(ev.clientX - scx, ev.clientY - scy));
          const nd = Math.min(560, Math.max(48, Math.round(((startD * r) / r0) / 4) * 4));
          setCircleDiameterPx(nd);
        }, cursors[cornerIndex]);
        return;
      }

      if (e.altKey && inCircle) {
        const θ0 = Math.atan2(e.clientY - scy, e.clientX - scx);
        const angleOffset = θ0 - (circleRotateDeg * Math.PI) / 180;
        bindGesture((ev: PointerEvent) => {
          const θ = Math.atan2(ev.clientY - scy, ev.clientX - scx);
          setCircleRotateDeg(normalizeDeg(((θ - angleOffset) * 180) / Math.PI));
        }, "grabbing");
        return;
      }

      const startX = e.clientX;
      const startY = e.clientY;
      const startOx = circleOffsetX;
      const startOy = circleOffsetY;
      bindGesture((ev: PointerEvent) => {
        setCircleOffsetX(startOx + ev.clientX - startX);
        setCircleOffsetY(startOy + ev.clientY - startY);
      }, "move");
    },
    [circleDiameterPx, circleSvgSize, circleCrosshairHalf, circleRotateDeg, circleOffsetX, circleOffsetY]
  );

  const handleRectanglePointerDown = useCallback(
    (e: React.PointerEvent<SVGSVGElement>) => {
      const svg = e.currentTarget;
      const rw = rectangleWidth;
      const rh = rectangleHeightPx;
      const srect = svg.getBoundingClientRect();
      const scx = srect.left + srect.width / 2;
      const scy = srect.top + srect.height / 2;
      const scaleX = srect.width / rw;
      const scaleY = srect.height / rh;
      const lerxGeom = Math.max(4, rw / 2 - 4);
      const leryGeom = Math.max(4, rh / 2 - 4);
      const hxPix = lerxGeom * scaleX;
      const hyPix = leryGeom * scaleY;

      const lp = clientPointToSvgUser(svg, e.clientX, e.clientY);
      if (!lp) return;

      const lcx = rw / 2;
      const lcy = rh / 2;
      const lerx = Math.max(4, rw / 2 - 4);
      const lery = Math.max(4, rh / 2 - 4);
      const boxL = lcx - lerx;
      const boxT = lcy - lery;
      const boxWi = 2 * lerx;
      const boxHi = 2 * lery;
      const cornerSz = Math.min(14, Math.max(5, Math.min(rw, rh) * 0.06));
      const cornerHalf = cornerSz / 2;

      const cornerPts = [
        [boxL, boxT],
        [boxL + boxWi, boxT],
        [boxL + boxWi, boxT + boxHi],
        [boxL, boxT + boxHi],
      ] as const;

      let cornerIndex: number | null = null;
      for (let i = 0; i < 4; i++) {
        const [bx, by] = cornerPts[i];
        if (
          lp.x >= bx - cornerHalf &&
          lp.x <= bx + cornerHalf &&
          lp.y >= by - cornerHalf &&
          lp.y <= by + cornerHalf
        ) {
          cornerIndex = i;
          break;
        }
      }

      const edgeDepth = Math.max(6, Math.min(18, Math.min(rw, rh) * 0.09));
      const edgeInset = cornerHalf + 2;
      let edgeKind: "top" | "bottom" | "left" | "right" | null = null;
      if (
        lp.x >= boxL + edgeInset &&
        lp.x <= boxL + boxWi - edgeInset &&
        lp.y >= boxT - edgeDepth &&
        lp.y <= boxT + edgeDepth
      ) {
        edgeKind = "top";
      } else if (
        lp.x >= boxL + edgeInset &&
        lp.x <= boxL + boxWi - edgeInset &&
        lp.y >= boxT + boxHi - edgeDepth &&
        lp.y <= boxT + boxHi + edgeDepth
      ) {
        edgeKind = "bottom";
      } else if (
        lp.x >= boxL - edgeDepth &&
        lp.x <= boxL + edgeDepth &&
        lp.y >= boxT + edgeInset &&
        lp.y <= boxT + boxHi - edgeInset
      ) {
        edgeKind = "left";
      } else if (
        lp.x >= boxL + boxWi - edgeDepth &&
        lp.x <= boxL + boxWi + edgeDepth &&
        lp.y >= boxT + edgeInset &&
        lp.y <= boxT + boxHi - edgeInset
      ) {
        edgeKind = "right";
      }
      if (!rectangleSelectedRef.current) edgeKind = null;
      if (!rectangleSelectedRef.current) cornerIndex = null;

      const inRect = pointInRotatedRect(
        e.clientX,
        e.clientY,
        scx,
        scy,
        rectangleRotateDeg,
        hxPix,
        hyPix
      );

      if (cornerIndex === null && !inRect) return;

      e.preventDefault();
      e.stopPropagation();
      const pointerId = e.pointerId;
      svg.setPointerCapture(pointerId);
      setRectangleSelected(true);
      setOvalSelected(false);
      setCircleSelected(false);
      setBox3dSelected(false);

      const bindGesture = (onMove: (ev: PointerEvent) => void, cursor: string) => {
        svg.style.cursor = cursor;
        const wrappedUp = () => {
          svg.style.cursor = "grab";
          try {
            if (svg.hasPointerCapture(pointerId)) svg.releasePointerCapture(pointerId);
          } catch {
            /* ignore */
          }
          window.removeEventListener("pointermove", onMove);
          window.removeEventListener("pointerup", wrappedUp);
          window.removeEventListener("pointercancel", wrappedUp);
        };
        window.addEventListener("pointermove", onMove);
        window.addEventListener("pointerup", wrappedUp);
        window.addEventListener("pointercancel", wrappedUp);
      };

      if (e.shiftKey && inRect) {
        const r0 = Math.max(10, Math.hypot(e.clientX - scx, e.clientY - scy));
        const startW = rw;
        const startH = rh;
        bindGesture((ev: PointerEvent) => {
          const r = Math.max(10, Math.hypot(ev.clientX - scx, ev.clientY - scy));
          const factor = r / r0;
          const w = Math.min(560, Math.max(80, Math.round((startW * factor) / 4) * 4));
          const h = Math.min(560, Math.max(48, Math.round(startH * factor)));
          setRectangleWidth(w);
          setRectangleHeightPx(h);
        }, "ns-resize");
        return;
      }

      if (cornerIndex !== null) {
        const startW = rw;
        const startH = rh;
        const startClientX = e.clientX;
        const startClientY = e.clientY;
        const mults = [
          [-2, -2],
          [2, -2],
          [2, 2],
          [-2, 2],
        ] as const;
        const [mx, my] = mults[cornerIndex];
        const cursors = ["nwse-resize", "nesw-resize", "nwse-resize", "nesw-resize"] as const;
        bindGesture((ev: PointerEvent) => {
          const dx = ev.clientX - startClientX;
          const dy = ev.clientY - startClientY;
          const w = Math.min(560, Math.max(80, Math.round((startW + mx * dx) / 4) * 4));
          const h = Math.min(560, Math.max(48, Math.round(startH + my * dy)));
          setRectangleWidth(w);
          setRectangleHeightPx(h);
        }, cursors[cornerIndex]);
        return;
      }

      if (edgeKind !== null) {
        const startW = rw;
        const startH = rh;
        const startClientX = e.clientX;
        const startClientY = e.clientY;
        if (edgeKind === "top" || edgeKind === "bottom") {
          const my = edgeKind === "top" ? -2 : 2;
          bindGesture((ev: PointerEvent) => {
            const dy = ev.clientY - startClientY;
            const h = Math.min(560, Math.max(48, Math.round(startH + my * dy)));
            setRectangleHeightPx(h);
          }, "ns-resize");
          return;
        }
        const mx = edgeKind === "left" ? -2 : 2;
        bindGesture((ev: PointerEvent) => {
          const dx = ev.clientX - startClientX;
          const w = Math.min(560, Math.max(80, Math.round((startW + mx * dx) / 4) * 4));
          setRectangleWidth(w);
        }, "ew-resize");
        return;
      }

      if (e.altKey && inRect) {
        const θ0 = Math.atan2(e.clientY - scy, e.clientX - scx);
        const angleOffset = θ0 - (rectangleRotateDeg * Math.PI) / 180;
        bindGesture((ev: PointerEvent) => {
          const θ = Math.atan2(ev.clientY - scy, ev.clientX - scx);
          setRectangleRotateDeg(normalizeDeg(((θ - angleOffset) * 180) / Math.PI));
        }, "grabbing");
        return;
      }

      const startX = e.clientX;
      const startY = e.clientY;
      const startOx = rectangleOffsetX;
      const startOy = rectangleOffsetY;
      bindGesture((ev: PointerEvent) => {
        setRectangleOffsetX(startOx + ev.clientX - startX);
        setRectangleOffsetY(startOy + ev.clientY - startY);
      }, "move");
    },
    [rectangleWidth, rectangleHeightPx, rectangleRotateDeg, rectangleOffsetX, rectangleOffsetY]
  );

  const handleBox3dPointerDown = useCallback(
    (e: React.PointerEvent<SVGSVGElement>) => {
      const svg = e.currentTarget;
      const rw = box3dWidth;
      const rh = box3dHeightPx;
      const rd = box3dDepthPx;
      const layout = computeBox3dLayout(rw, rh, rd, box3dYawDeg, box3dPitchDeg);
      const srect = svg.getBoundingClientRect();
      const scx = srect.left + srect.width / 2;
      const scy = srect.top + srect.height / 2;

      const lp = clientPointToSvgUser(svg, e.clientX, e.clientY);
      if (!lp) return;

      const inBox3d = pointInBox3dUnion(lp.x, lp.y, layout);

      const front = layout.frontFacePoly;
      const cornerSz = Math.min(14, Math.max(5, Math.min(rw, rh) * 0.06));
      const cornerHalf = cornerSz / 2;

      let cornerIndex: number | null = null;
      let edgeTangent: [number, number] | null = null;
      let edgeIndex: number | null = null;
      if (e.button === 0) {
        for (let i = 0; i < 4; i++) {
          const [bx, by] = front[i]!;
          if (
            lp.x >= bx - cornerHalf &&
            lp.x <= bx + cornerHalf &&
            lp.y >= by - cornerHalf &&
            lp.y <= by + cornerHalf
          ) {
            cornerIndex = i;
            break;
          }
        }

        if (!box3dSelectedRef.current) cornerIndex = null;

        if (cornerIndex === null) {
          const edgeDepth = Math.max(6, Math.min(18, Math.min(rw, rh) * 0.09));
          const edgeInset = cornerHalf + 2;
          for (let ei = 0; ei < layout.wireframeEdges.length; ei++) {
            const [a, b] = layout.wireframeEdges[ei]!;
            const va = layout.verts2d[a]!;
            const vb = layout.verts2d[b]!;
            if (pointNearSegment(lp.x, lp.y, va[0], va[1], vb[0], vb[1], edgeDepth, edgeInset)) {
              edgeIndex = ei;
              edgeTangent = box3dWireframeEdgeTangentCanonical(va, vb);
              break;
            }
          }
        }
      }

      if (cornerIndex === null && edgeIndex === null && !inBox3d) return;
      if (e.button !== 0 && e.button !== 1 && e.button !== 2) return;

      e.preventDefault();
      e.stopPropagation();
      const pointerId = e.pointerId;
      svg.setPointerCapture(pointerId);
      setBox3dSelected(true);
      if (edgeIndex !== null) {
        setBox3dActiveEdgeIndex(edgeIndex);
        setBox3dActiveEdgeColor(
          edgeTangent !== null && Math.abs(edgeTangent[0]) >= Math.abs(edgeTangent[1]) ? "orange" : "green"
        );
      } else if (e.button === 0) {
        setBox3dActiveEdgeIndex(null);
        setBox3dActiveEdgeColor(null);
      }
      setOvalSelected(false);
      setCircleSelected(false);
      setRectangleSelected(false);

      const bindGesture = (onMove: (ev: PointerEvent) => void, cursor: string) => {
        svg.style.cursor = cursor;
        const wrappedUp = () => {
          svg.style.cursor = "grab";
          try {
            if (svg.hasPointerCapture(pointerId)) svg.releasePointerCapture(pointerId);
          } catch {
            /* ignore */
          }
          window.removeEventListener("pointermove", onMove);
          window.removeEventListener("pointerup", wrappedUp);
          window.removeEventListener("pointercancel", wrappedUp);
        };
        window.addEventListener("pointermove", onMove);
        window.addEventListener("pointerup", wrappedUp);
        window.addEventListener("pointercancel", wrappedUp);
      };

      if (e.shiftKey && !e.altKey && e.button === 0 && inBox3d) {
        const r0 = Math.max(10, Math.hypot(e.clientX - scx, e.clientY - scy));
        const startW = rw;
        const startH = rh;
        const startD = rd;
        bindGesture((ev: PointerEvent) => {
          const r = Math.max(10, Math.hypot(ev.clientX - scx, ev.clientY - scy));
          const factor = r / r0;
          const w = Math.min(560, Math.max(80, Math.round((startW * factor) / 4) * 4));
          const h = Math.min(560, Math.max(48, Math.round(startH * factor)));
          const d = Math.min(560, Math.max(24, Math.round(startD * factor)));
          setBox3dWidth(w);
          setBox3dHeightPx(h);
          setBox3dDepthPx(d);
        }, "ns-resize");
        return;
      }

      if (cornerIndex !== null) {
        const startW = rw;
        const startH = rh;
        const startClientX = e.clientX;
        const startClientY = e.clientY;
        const mults = [
          [-2, -2],
          [2, -2],
          [2, 2],
          [-2, 2],
        ] as const;
        const [mx, my] = mults[cornerIndex];
        const cursors = ["nwse-resize", "nesw-resize", "nwse-resize", "nesw-resize"] as const;
        bindGesture((ev: PointerEvent) => {
          const dx = ev.clientX - startClientX;
          const dy = ev.clientY - startClientY;
          const w = Math.min(560, Math.max(80, Math.round((startW + mx * dx) / 4) * 4));
          const h = Math.min(560, Math.max(48, Math.round(startH + my * dy)));
          setBox3dWidth(w);
          setBox3dHeightPx(h);
        }, cursors[cornerIndex]);
        return;
      }

      if (e.shiftKey && e.altKey && e.button === 0 && inBox3d) {
        const startX = e.clientX;
        const startY = e.clientY;
        const startOx = box3dOffsetX;
        const startOy = box3dOffsetY;
        bindGesture((ev: PointerEvent) => {
          setBox3dOffsetX(startOx + ev.clientX - startX);
          setBox3dOffsetY(startOy + ev.clientY - startY);
        }, "move");
        return;
      }

      if (e.altKey && !e.shiftKey && e.button === 0 && inBox3d) {
        const θ0 = Math.atan2(e.clientY - scy, e.clientX - scx);
        const angleOffset = θ0 - (box3dRotateDeg * Math.PI) / 180;
        bindGesture((ev: PointerEvent) => {
          const θ = Math.atan2(ev.clientY - scy, ev.clientX - scx);
          setBox3dRotateDeg(normalizeDeg(((θ - angleOffset) * 180) / Math.PI));
        }, "grabbing");
        return;
      }

      if (
        box3dSelectedRef.current &&
        e.button === 0 &&
        !e.shiftKey &&
        !e.altKey &&
        inBox3d
      ) {
        const ccx = layout.vbW / 2;
        const ccy = layout.vbH / 2;
        const chHalf = Math.max(10, Math.min(rw, rh) * 0.11);
        if (Math.hypot(lp.x - ccx, lp.y - ccy) <= chHalf + 10) {
          const startX = e.clientX;
          const startY = e.clientY;
          const startOx = box3dOffsetX;
          const startOy = box3dOffsetY;
          bindGesture((ev: PointerEvent) => {
            setBox3dOffsetX(startOx + ev.clientX - startX);
            setBox3dOffsetY(startOy + ev.clientY - startY);
          }, "move");
          return;
        }
      }

      if (
        edgeTangent !== null &&
        e.button === 0 &&
        !e.shiftKey &&
        !e.altKey &&
        inBox3d
      ) {
        const startYaw = box3dYawDeg;
        const startPitch = box3dPitchDeg;
        const startClientX = e.clientX;
        const startClientY = e.clientY;
        const k = BOX3D_ORBIT_DEG_PER_PX;
        const isHorizontalEdge = Math.abs(edgeTangent[0]) >= Math.abs(edgeTangent[1]);
        if (isHorizontalEdge) {
          // Dragging along the vertical direction on a "horizontal" edge adjusts pitch only.
          bindGesture((ev: PointerEvent) => {
            const dy = ev.clientY - startClientY;
            setBox3dPitchDeg(Math.min(180, Math.max(-180, startPitch - dy * k)));
          }, "grabbing");
          return;
        }

        // Dragging left/right on a "side" edge adjusts yaw only (pitch locked).
        bindGesture((ev: PointerEvent) => {
          const dx = ev.clientX - startClientX;
          setBox3dYawDeg(Math.min(180, Math.max(-180, startYaw + dx * k)));
        }, "grabbing");
        return;
      }

      const wantOrbit =
        inBox3d && (e.button === 0 || e.button === 1 || e.button === 2);
      if (wantOrbit) {
        const startYaw = box3dYawDeg;
        const startPitch = box3dPitchDeg;
        const startClientX = e.clientX;
        const startClientY = e.clientY;
        const k = BOX3D_ORBIT_DEG_PER_PX;
        bindGesture((ev: PointerEvent) => {
          const dx = ev.clientX - startClientX;
          const dy = ev.clientY - startClientY;
          setBox3dYawDeg(Math.min(180, Math.max(-180, startYaw + dx * k)));
          setBox3dPitchDeg(Math.min(180, Math.max(-180, startPitch - dy * k)));
        }, "grabbing");
        return;
      }

      try {
        if (svg.hasPointerCapture(pointerId)) svg.releasePointerCapture(pointerId);
      } catch {
        /* ignore */
      }
    },
    [box3dWidth, box3dHeightPx, box3dDepthPx, box3dYawDeg, box3dPitchDeg, box3dRotateDeg, box3dOffsetX, box3dOffsetY, box3dActiveEdgeIndex]
  );

  const handleOvalSvgPointerMove = useCallback(
    (e: React.PointerEvent<SVGSVGElement>) => {
      lastPointerOnOvalSvgRef.current = { x: e.clientX, y: e.clientY };
      e.currentTarget.style.cursor = resolveOvalSvgPointerCursor(
        e.currentTarget,
        e.clientX,
        e.clientY,
        e.altKey,
        e.shiftKey,
        ovalWidth,
        ovalHeightPx,
        ovalRotateDeg,
        ovalSelected
      );
    },
    [ovalWidth, ovalHeightPx, ovalRotateDeg, ovalSelected]
  );

  const handleOvalSvgPointerEnter = useCallback(
    (e: React.PointerEvent<SVGSVGElement>) => {
      pointerInsideOvalSvgRef.current = true;
      lastPointerOnOvalSvgRef.current = { x: e.clientX, y: e.clientY };
      e.currentTarget.style.cursor = resolveOvalSvgPointerCursor(
        e.currentTarget,
        e.clientX,
        e.clientY,
        e.altKey,
        e.shiftKey,
        ovalWidth,
        ovalHeightPx,
        ovalRotateDeg,
        ovalSelected
      );
    },
    [ovalWidth, ovalHeightPx, ovalRotateDeg, ovalSelected]
  );

  const handleOvalSvgPointerLeave = useCallback(() => {
    pointerInsideOvalSvgRef.current = false;
    lastPointerOnOvalSvgRef.current = null;
    const svg = ovalSvgRef.current;
    if (svg) svg.style.cursor = "grab";
  }, []);

  const handleCircleSvgPointerMove = useCallback(
    (e: React.PointerEvent<SVGSVGElement>) => {
      lastPointerOnCircleSvgRef.current = { x: e.clientX, y: e.clientY };
      e.currentTarget.style.cursor = resolveCircleSvgPointerCursor(
        e.currentTarget,
        e.clientX,
        e.clientY,
        e.altKey,
        e.shiftKey,
        circleDiameterPx,
        circleRotateDeg,
        circleSelected
      );
    },
    [circleDiameterPx, circleRotateDeg, circleSelected]
  );

  const handleCircleSvgPointerEnter = useCallback(
    (e: React.PointerEvent<SVGSVGElement>) => {
      pointerInsideCircleSvgRef.current = true;
      lastPointerOnCircleSvgRef.current = { x: e.clientX, y: e.clientY };
      e.currentTarget.style.cursor = resolveCircleSvgPointerCursor(
        e.currentTarget,
        e.clientX,
        e.clientY,
        e.altKey,
        e.shiftKey,
        circleDiameterPx,
        circleRotateDeg,
        circleSelected
      );
    },
    [circleDiameterPx, circleRotateDeg, circleSelected]
  );

  const handleCircleSvgPointerLeave = useCallback(() => {
    pointerInsideCircleSvgRef.current = false;
    lastPointerOnCircleSvgRef.current = null;
    const svg = circleSvgRef.current;
    if (svg) svg.style.cursor = "grab";
  }, []);

  const handleRectangleSvgPointerMove = useCallback(
    (e: React.PointerEvent<SVGSVGElement>) => {
      lastPointerOnRectangleSvgRef.current = { x: e.clientX, y: e.clientY };
      e.currentTarget.style.cursor = resolveRotatedRectSvgPointerCursor(
        e.currentTarget,
        e.clientX,
        e.clientY,
        e.altKey,
        e.shiftKey,
        rectangleWidth,
        rectangleHeightPx,
        rectangleRotateDeg,
        rectangleSelected
      );
    },
    [rectangleWidth, rectangleHeightPx, rectangleRotateDeg, rectangleSelected]
  );

  const handleRectangleSvgPointerEnter = useCallback(
    (e: React.PointerEvent<SVGSVGElement>) => {
      pointerInsideRectangleSvgRef.current = true;
      lastPointerOnRectangleSvgRef.current = { x: e.clientX, y: e.clientY };
      e.currentTarget.style.cursor = resolveRotatedRectSvgPointerCursor(
        e.currentTarget,
        e.clientX,
        e.clientY,
        e.altKey,
        e.shiftKey,
        rectangleWidth,
        rectangleHeightPx,
        rectangleRotateDeg,
        rectangleSelected
      );
    },
    [rectangleWidth, rectangleHeightPx, rectangleRotateDeg, rectangleSelected]
  );

  const handleRectangleSvgPointerLeave = useCallback(() => {
    pointerInsideRectangleSvgRef.current = false;
    lastPointerOnRectangleSvgRef.current = null;
    const svg = rectangleSvgRef.current;
    if (svg) svg.style.cursor = "grab";
  }, []);

  const handleBox3dSvgPointerMove = useCallback(
    (e: React.PointerEvent<SVGSVGElement>) => {
      lastPointerOnBox3dSvgRef.current = { x: e.clientX, y: e.clientY };
      e.currentTarget.style.cursor = resolveBox3dSvgPointerCursor(
        e.currentTarget,
        e.clientX,
        e.clientY,
        e.altKey,
        e.shiftKey,
        e.ctrlKey,
        e.metaKey,
        box3dWidth,
        box3dHeightPx,
        box3dDepthPx,
        box3dYawDeg,
        box3dPitchDeg,
        box3dSelected
      );
    },
    [box3dWidth, box3dHeightPx, box3dDepthPx, box3dYawDeg, box3dPitchDeg, box3dSelected]
  );

  const handleBox3dSvgPointerEnter = useCallback(
    (e: React.PointerEvent<SVGSVGElement>) => {
      pointerInsideBox3dSvgRef.current = true;
      lastPointerOnBox3dSvgRef.current = { x: e.clientX, y: e.clientY };
      e.currentTarget.style.cursor = resolveBox3dSvgPointerCursor(
        e.currentTarget,
        e.clientX,
        e.clientY,
        e.altKey,
        e.shiftKey,
        e.ctrlKey,
        e.metaKey,
        box3dWidth,
        box3dHeightPx,
        box3dDepthPx,
        box3dYawDeg,
        box3dPitchDeg,
        box3dSelected
      );
    },
    [box3dWidth, box3dHeightPx, box3dDepthPx, box3dYawDeg, box3dPitchDeg, box3dSelected]
  );

  const handleBox3dSvgPointerLeave = useCallback(() => {
    pointerInsideBox3dSvgRef.current = false;
    lastPointerOnBox3dSvgRef.current = null;
    const svg = box3dSvgRef.current;
    if (svg) svg.style.cursor = "grab";
  }, []);

  useEffect(() => {
    if (!currentUrl || !showOval) return;
    const syncAltCursor = (e: KeyboardEvent) => {
      if (e.key !== "Alt") return;
      if (!pointerInsideOvalSvgRef.current) return;
      const svg = ovalSvgRef.current;
      const pt = lastPointerOnOvalSvgRef.current;
      if (!svg || !pt) return;
      const altHeld = e.type === "keydown";
      svg.style.cursor = resolveOvalSvgPointerCursor(
        svg,
        pt.x,
        pt.y,
        altHeld,
        e.shiftKey,
        ovalWidth,
        ovalHeightPx,
        ovalRotateDeg,
        ovalSelectedRef.current
      );
    };
    window.addEventListener("keydown", syncAltCursor);
    window.addEventListener("keyup", syncAltCursor);
    return () => {
      window.removeEventListener("keydown", syncAltCursor);
      window.removeEventListener("keyup", syncAltCursor);
    };
  }, [currentUrl, showOval, ovalWidth, ovalHeightPx, ovalRotateDeg]);

  useEffect(() => {
    if (!currentUrl || !showCircle) return;
    const syncAltCursor = (e: KeyboardEvent) => {
      if (e.key !== "Alt") return;
      if (!pointerInsideCircleSvgRef.current) return;
      const svg = circleSvgRef.current;
      const pt = lastPointerOnCircleSvgRef.current;
      if (!svg || !pt) return;
      const altHeld = e.type === "keydown";
      svg.style.cursor = resolveCircleSvgPointerCursor(
        svg,
        pt.x,
        pt.y,
        altHeld,
        e.shiftKey,
        circleDiameterPx,
        circleRotateDeg,
        circleSelectedRef.current
      );
    };
    window.addEventListener("keydown", syncAltCursor);
    window.addEventListener("keyup", syncAltCursor);
    return () => {
      window.removeEventListener("keydown", syncAltCursor);
      window.removeEventListener("keyup", syncAltCursor);
    };
  }, [currentUrl, showCircle, circleDiameterPx, circleRotateDeg]);

  useEffect(() => {
    if (!currentUrl || !showRectangle) return;
    const syncAltCursor = (e: KeyboardEvent) => {
      if (e.key !== "Alt") return;
      if (!pointerInsideRectangleSvgRef.current) return;
      const svg = rectangleSvgRef.current;
      const pt = lastPointerOnRectangleSvgRef.current;
      if (!svg || !pt) return;
      const altHeld = e.type === "keydown";
      svg.style.cursor = resolveRotatedRectSvgPointerCursor(
        svg,
        pt.x,
        pt.y,
        altHeld,
        e.shiftKey,
        rectangleWidth,
        rectangleHeightPx,
        rectangleRotateDeg,
        rectangleSelectedRef.current
      );
    };
    window.addEventListener("keydown", syncAltCursor);
    window.addEventListener("keyup", syncAltCursor);
    return () => {
      window.removeEventListener("keydown", syncAltCursor);
      window.removeEventListener("keyup", syncAltCursor);
    };
  }, [currentUrl, showRectangle, rectangleWidth, rectangleHeightPx, rectangleRotateDeg]);

  useEffect(() => {
    if (!currentUrl || !showBox3d) return;
    const syncModifierCursor = (e: KeyboardEvent) => {
      if (!["Alt", "Control", "Meta"].includes(e.key)) return;
      if (!pointerInsideBox3dSvgRef.current) return;
      const svg = box3dSvgRef.current;
      const pt = lastPointerOnBox3dSvgRef.current;
      if (!svg || !pt) return;
      svg.style.cursor = resolveBox3dSvgPointerCursor(
        svg,
        pt.x,
        pt.y,
        e.altKey,
        e.shiftKey,
        e.ctrlKey,
        e.metaKey,
        box3dWidth,
        box3dHeightPx,
        box3dDepthPx,
        box3dYawDeg,
        box3dPitchDeg,
        box3dSelectedRef.current
      );
    };
    window.addEventListener("keydown", syncModifierCursor);
    window.addEventListener("keyup", syncModifierCursor);
    return () => {
      window.removeEventListener("keydown", syncModifierCursor);
      window.removeEventListener("keyup", syncModifierCursor);
    };
  }, [currentUrl, showBox3d, box3dWidth, box3dHeightPx, box3dDepthPx, box3dYawDeg, box3dPitchDeg]);

  useEffect(() => {
    if (!currentUrl || !showOval) {
      setOvalSelected(false);
    }
  }, [currentUrl, showOval]);

  useEffect(() => {
    if (!currentUrl || !showCircle) {
      setCircleSelected(false);
    }
  }, [currentUrl, showCircle]);

  useEffect(() => {
    if (!currentUrl || !showRectangle) {
      setRectangleSelected(false);
    }
  }, [currentUrl, showRectangle]);

  useEffect(() => {
    if (!currentUrl || !showBox3d) {
      setBox3dSelected(false);
    }
  }, [currentUrl, showBox3d]);

  useEffect(() => {
    if (!currentUrl || (!showOval && !showCircle && !showRectangle && !showBox3d)) return;
    const ROTATE_DRAG_PX = 6;
    const onDocPointerDown = (ev: PointerEvent) => {
      const ovalHit = ovalHitAreaRef.current;
      const circleHit = circleHitAreaRef.current;
      const rectangleHit = rectangleHitAreaRef.current;
      const box3dHit = box3dHitAreaRef.current;
      if (ovalHit && ev.target instanceof Node && ovalHit.contains(ev.target)) return;
      if (circleHit && ev.target instanceof Node && circleHit.contains(ev.target)) {
        // circleHitAreaRef can be larger than the drawn circle (we extend crosshairs),
        // so only keep the selection if the pointer is inside the circle outline.
        const svg = circleSvgRef.current;
        if (svg) {
          const srect = svg.getBoundingClientRect();
          const scx = srect.left + srect.width / 2;
          const scy = srect.top + srect.height / 2;
          const rGeom = Math.max(4, circleDiameterPx / 2 - 4);
          const scaleX = srect.width / circleSvgSize;
          const scaleY = srect.height / circleSvgSize;
          const rxPix = rGeom * scaleX;
          const ryPix = rGeom * scaleY;
          const inEllipse = pointInRotatedEllipse(
            ev.clientX,
            ev.clientY,
            scx,
            scy,
            circleRotateDegRef.current,
            rxPix,
            ryPix
          );
          if (inEllipse) return;
        }
      }
      if (rectangleHit && ev.target instanceof Node && rectangleHit.contains(ev.target)) return;
      if (box3dHit && ev.target instanceof Node && box3dHit.contains(ev.target)) return;

      if (
        !ovalSelectedRef.current &&
        !circleSelectedRef.current &&
        !rectangleSelectedRef.current &&
        !box3dSelectedRef.current
      )
        return;

      const useOval = ovalSelectedRef.current;
      const useCircle = circleSelectedRef.current;
      const useRectangle = rectangleSelectedRef.current;
      const useBox3d = box3dSelectedRef.current;

      const stage = slideshowStageRef.current;
      const t = ev.target;
      if (!(t instanceof Node) || !stage?.contains(t)) {
        ovalSelectedRef.current = false;
        setOvalSelected(false);
        circleSelectedRef.current = false;
        setCircleSelected(false);
        rectangleSelectedRef.current = false;
        setRectangleSelected(false);
        box3dSelectedRef.current = false;
        setBox3dSelected(false);
        return;
      }

      if (t instanceof Element) {
        if (t.closest("button, input, select, textarea, label, a, option")) {
          ovalSelectedRef.current = false;
          setOvalSelected(false);
          circleSelectedRef.current = false;
          setCircleSelected(false);
          rectangleSelectedRef.current = false;
          setRectangleSelected(false);
          box3dSelectedRef.current = false;
          setBox3dSelected(false);
          return;
        }
      }

      if (ev.button !== 0) return;

      ev.preventDefault();
      ev.stopPropagation();

      const svg = useOval
        ? ovalSvgRef.current
        : useCircle
          ? circleSvgRef.current
          : useRectangle
            ? rectangleSvgRef.current
            : useBox3d
              ? box3dSvgRef.current
              : null;
      if (!svg) {
        ovalSelectedRef.current = false;
        setOvalSelected(false);
        circleSelectedRef.current = false;
        setCircleSelected(false);
        rectangleSelectedRef.current = false;
        setRectangleSelected(false);
        box3dSelectedRef.current = false;
        setBox3dSelected(false);
        return;
      }

      if (useBox3d) {
        const srect = svg.getBoundingClientRect();
        const scx = srect.left + srect.width / 2;
        const scy = srect.top + srect.height / 2;
        const θ0 = Math.atan2(ev.clientY - scy, ev.clientX - scx);
        const angleOffset = θ0 - (box3dRotateDegRef.current * Math.PI) / 180;
        const pointerId = ev.pointerId;
        const captureEl = t instanceof Element ? t : stage;
        const startX = ev.clientX;
        const startY = ev.clientY;
        let rotationActive = false;
        try {
          captureEl.setPointerCapture(pointerId);
        } catch {
          /* ignore */
        }
        const onMove = (moveEv: PointerEvent) => {
          const dist = Math.hypot(moveEv.clientX - startX, moveEv.clientY - startY);
          if (!rotationActive) {
            if (dist < ROTATE_DRAG_PX) return;
            rotationActive = true;
          }
          const θ = Math.atan2(moveEv.clientY - scy, moveEv.clientX - scx);
          const deg = normalizeDeg(((θ - angleOffset) * 180) / Math.PI);
          setBox3dRotateDeg(deg);
        };
        const onUp = () => {
          try {
            if (captureEl.hasPointerCapture(pointerId)) captureEl.releasePointerCapture(pointerId);
          } catch {
            /* ignore */
          }
          document.removeEventListener("pointermove", onMove);
          document.removeEventListener("pointerup", onUp);
          document.removeEventListener("pointercancel", onUp);
          if (!rotationActive) {
            box3dSelectedRef.current = false;
            setBox3dSelected(false);
          }
        };
        document.addEventListener("pointermove", onMove);
        document.addEventListener("pointerup", onUp);
        document.addEventListener("pointercancel", onUp);
        return;
      }

      const srect = svg.getBoundingClientRect();
      const scx = srect.left + srect.width / 2;
      const scy = srect.top + srect.height / 2;
      const θ0 = Math.atan2(ev.clientY - scy, ev.clientX - scx);
      const rotDeg = useOval
        ? ovalRotateDegRef.current
        : useCircle
          ? circleRotateDegRef.current
          : rectangleRotateDegRef.current;
      const angleOffset = θ0 - (rotDeg * Math.PI) / 180;
      const pointerId = ev.pointerId;
      const captureEl = t instanceof Element ? t : stage;
      const startX = ev.clientX;
      const startY = ev.clientY;
      let rotationActive = false;

      try {
        captureEl.setPointerCapture(pointerId);
      } catch {
        /* ignore */
      }

      const onMove = (moveEv: PointerEvent) => {
        const dist = Math.hypot(moveEv.clientX - startX, moveEv.clientY - startY);
        if (!rotationActive) {
          if (dist < ROTATE_DRAG_PX) return;
          rotationActive = true;
        }
        const θ = Math.atan2(moveEv.clientY - scy, moveEv.clientX - scx);
        const deg = normalizeDeg(((θ - angleOffset) * 180) / Math.PI);
        if (useOval) setOvalRotateDeg(deg);
        else if (useCircle) setCircleRotateDeg(deg);
        else setRectangleRotateDeg(deg);
      };
      const onUp = () => {
        try {
          if (captureEl.hasPointerCapture(pointerId)) captureEl.releasePointerCapture(pointerId);
        } catch {
          /* ignore */
        }
        document.removeEventListener("pointermove", onMove);
        document.removeEventListener("pointerup", onUp);
        document.removeEventListener("pointercancel", onUp);
        if (!rotationActive) {
          if (useOval) {
            ovalSelectedRef.current = false;
            setOvalSelected(false);
          } else if (useCircle) {
            circleSelectedRef.current = false;
            setCircleSelected(false);
          } else if (useRectangle) {
            rectangleSelectedRef.current = false;
            setRectangleSelected(false);
          }
        }
      };
      document.addEventListener("pointermove", onMove);
      document.addEventListener("pointerup", onUp);
      document.addEventListener("pointercancel", onUp);
    };
    document.addEventListener("pointerdown", onDocPointerDown, true);
    return () => document.removeEventListener("pointerdown", onDocPointerDown, true);
  }, [currentUrl, showOval, showCircle, showRectangle, showBox3d, circleDiameterPx, circleSvgSize]);

  useEffect(() => {
    if (!currentUrl || (!showOval && !showCircle && !showRectangle && !showBox3d)) setDeckCursorMode("grab");
  }, [showOval, showCircle, showRectangle, showBox3d, currentUrl]);

  useEffect(() => {
    if (!ovalSelected && !circleSelected && !rectangleSelected && !box3dSelected) setDeckCursorMode("grab");
  }, [ovalSelected, circleSelected, rectangleSelected, box3dSelected]);

  useEffect(() => {
    if (!showPose) return;
    let cancelled = false;
    (async () => {
      try {
        if (poseLandmarkerRef.current) {
          if (!cancelled) setPoseReady(true);
          return;
        }
        const vision = await FilesetResolver.forVisionTasks(
          "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@latest/wasm"
        );
        const landmarker = await PoseLandmarker.createFromOptions(vision, {
          baseOptions: {
            // Prefer GPU when available for higher throughput (and often better stability).
            delegate: "GPU",
            modelAssetPath:
              "https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_full/float16/latest/pose_landmarker_full.task",
          },
          runningMode: "IMAGE",
          numPoses: 1,
          minPoseDetectionConfidence: 0.6,
          minPosePresenceConfidence: 0.6,
          minTrackingConfidence: 0.6,
        });
        poseLandmarkerRef.current = landmarker;
        if (!cancelled) setPoseReady(true);
      } catch {
        if (!cancelled) setPoseReady(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [showPose]);

  useEffect(() => {
    if (!showPose) return;
    if (!poseReady) return;
    const img = currentImgRef.current;
    const canvas = poseCanvasRef.current;
    const landmarker = poseLandmarkerRef.current;
    if (!img || !canvas || !landmarker) return;
    if (!img.complete || !img.naturalWidth || !img.naturalHeight) return;

    const draw = () => {
      const cssW = img.clientWidth;
      const cssH = img.clientHeight;
      if (!cssW || !cssH) return;
      const dpr = window.devicePixelRatio || 1;
      const w = Math.max(1, Math.round(cssW * dpr));
      const h = Math.max(1, Math.round(cssH * dpr));
      if (canvas.width !== w) canvas.width = w;
      if (canvas.height !== h) canvas.height = h;
      canvas.style.width = `${cssW}px`;
      canvas.style.height = `${cssH}px`;

      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      ctx.clearRect(0, 0, w, h);

      const res = landmarker.detect(img);
      const landmarks = res.landmarks?.[0];
      if (!landmarks || landmarks.length === 0) return;

      ctx.save();
      ctx.scale(dpr, dpr);
      const toXY = (i: number): [number, number] | null => {
        const lm = landmarks[i];
        if (!lm) return null;
        const conf = Math.min(1, Math.max(0, (lm.visibility ?? 1) as number));
        if (conf < poseMinConfidence) return null;
        return [lm.x * cssW + poseOffsetX, lm.y * cssH + poseOffsetY];
      };

      const mid = (a: number, b: number): [number, number] | null => {
        const pa = toXY(a);
        const pb = toXY(b);
        if (!pa || !pb) return null;
        return [(pa[0] + pb[0]) / 2, (pa[1] + pb[1]) / 2];
      };

      const line = (a: number, b: number) => {
        const pa = toXY(a);
        const pb = toXY(b);
        if (!pa || !pb) return;
        ctx.beginPath();
        ctx.moveTo(pa[0], pa[1]);
        ctx.lineTo(pb[0], pb[1]);
        ctx.stroke();
      };

      const dot = (i: number, rad: number) => {
        const p = toXY(i);
        if (!p) return;
        ctx.beginPath();
        ctx.arc(p[0], p[1], rad, 0, Math.PI * 2);
        ctx.fill();
      };

      if (poseFigureMode) {
        // Figure drawing calibration: cleaner construction lines.
        ctx.strokeStyle = "rgba(255, 170, 0, 0.85)";
        ctx.fillStyle = "rgba(255, 170, 0, 0.95)";
        ctx.lineWidth = 2.5;

        // torso + pelvis
        line(11, 12); // shoulders
        line(23, 24); // hips
        line(11, 23); // left torso
        line(12, 24); // right torso
        line(11, 13); line(13, 15); // left arm
        line(12, 14); line(14, 16); // right arm
        line(23, 25); line(25, 27); // left leg
        line(24, 26); line(26, 28); // right leg

        const neck = mid(11, 12);
        const pelvis = mid(23, 24);
        if (neck && pelvis) {
          ctx.beginPath();
          ctx.moveTo(neck[0], neck[1]);
          ctx.lineTo(pelvis[0], pelvis[1]);
          ctx.stroke();
        }

        // head (approx): use nose + ears if available; otherwise a small marker at nose.
        const nose = toXY(0);
        const earL = toXY(7);
        const earR = toXY(8);
        if (nose && earL && earR) {
          const cx = (earL[0] + earR[0]) / 2;
          const cy = (earL[1] + earR[1]) / 2;
          const rad = Math.max(10, Math.hypot(earL[0] - earR[0], earL[1] - earR[1]) * 0.75);
          ctx.beginPath();
          ctx.arc(cx, cy, rad, 0, Math.PI * 2);
          ctx.stroke();
        } else if (nose) {
          ctx.beginPath();
          ctx.arc(nose[0], nose[1], 6, 0, Math.PI * 2);
          ctx.fill();
        }

        // key dots for drawing
        for (const i of [0, 11, 12, 23, 24, 15, 16, 27, 28]) dot(i, 3.5);
      } else {
        ctx.fillStyle = "rgba(34, 197, 94, 0.95)";
        ctx.strokeStyle = "rgba(34, 197, 94, 0.55)";
        ctx.lineWidth = 2;
        for (let i = 0; i < landmarks.length; i++) dot(i, 3.2);
        const segs: [number, number][] = [
          [11, 12],
          [23, 24],
          [11, 23],
          [12, 24],
        ];
        for (const [a, b] of segs) line(a, b);
      }
      ctx.restore();
    };

    // Defer to next frame so layout settles (esp after image change).
    const raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, [showPose, poseReady, currentUrl, poseNonce, poseFigureMode, poseMinConfidence, poseOffsetX, poseOffsetY]);

  useEffect(() => {
    const el = zoomContainerRef.current;
    if (!el) return;
    const onMove = (e: PointerEvent) => {
      if (!currentUrl) {
        setDeckCursorMode((m) => (m === "grab" ? m : "grab"));
        return;
      }
      const hit =
        showOval && ovalSelectedRef.current
          ? ovalHitAreaRef.current
          : showCircle && circleSelectedRef.current
            ? circleHitAreaRef.current
            : showRectangle && rectangleSelectedRef.current
              ? rectangleHitAreaRef.current
              : showBox3d && box3dSelectedRef.current
                ? box3dHitAreaRef.current
                : null;
      if (!hit) {
        setDeckCursorMode((m) => (m === "grab" ? m : "grab"));
        return;
      }
      const r = hit.getBoundingClientRect();
      const outside =
        e.clientX < r.left ||
        e.clientX > r.right ||
        e.clientY < r.top ||
        e.clientY > r.bottom;
      const next = outside ? "rotate" : "grab";
      setDeckCursorMode((m) => (m === next ? m : next));
    };
    const onLeave = () => setDeckCursorMode("grab");
    el.addEventListener("pointermove", onMove);
    el.addEventListener("pointerleave", onLeave);
    return () => {
      el.removeEventListener("pointermove", onMove);
      el.removeEventListener("pointerleave", onLeave);
    };
  }, [currentUrl, showOval, showCircle, showRectangle, showBox3d, ovalSelected, circleSelected, rectangleSelected, box3dSelected]);

  useEffect(() => {
    const el = ovalSvgRef.current;
    if (!el || !currentUrl || !showOval) return;
    const onWheel = (ev: WheelEvent) => {
      const srect = el.getBoundingClientRect();
      const scx = srect.left + srect.width / 2;
      const scy = srect.top + srect.height / 2;
      const scaleX = srect.width / ovalWidth;
      const scaleY = srect.height / ovalHeightPx;
      const rxPix = Math.max(4, ovalWidth / 2 - 4) * scaleX;
      const ryPix = Math.max(4, ovalHeightPx / 2 - 4) * scaleY;
      if (!pointInRotatedEllipse(ev.clientX, ev.clientY, scx, scy, ovalRotateDeg, rxPix, ryPix)) return;
      ev.preventDefault();
      ev.stopPropagation();
      setOvalSelected(true);
      setCircleSelected(false);
      setRectangleSelected(false);
      setBox3dSelected(false);
      const dir = ev.deltaY > 0 ? -1 : 1;
      const step = ev.shiftKey ? 16 : 8;
      setOvalWidth((w) => Math.min(560, Math.max(80, Math.round((w + dir * step) / 4) * 4)));
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [currentUrl, showOval, ovalWidth, ovalHeightPx, ovalRotateDeg]);

  useEffect(() => {
    const el = circleSvgRef.current;
    if (!el || !currentUrl || !showCircle) return;
    const d = circleDiameterPx;
    const onWheel = (ev: WheelEvent) => {
      const srect = el.getBoundingClientRect();
      const scx = srect.left + srect.width / 2;
      const scy = srect.top + srect.height / 2;
      const rGeom = Math.max(4, d / 2 - 4);
      const scaleX = srect.width / d;
      const scaleY = srect.height / d;
      const rxPix = rGeom * scaleX;
      const ryPix = rGeom * scaleY;
      if (!pointInRotatedEllipse(ev.clientX, ev.clientY, scx, scy, circleRotateDeg, rxPix, ryPix)) return;
      ev.preventDefault();
      ev.stopPropagation();
      setCircleSelected(true);
      setOvalSelected(false);
      setRectangleSelected(false);
      setBox3dSelected(false);
      const dir = ev.deltaY > 0 ? -1 : 1;
      const step = ev.shiftKey ? 16 : 8;
      setCircleDiameterPx((w) => Math.min(560, Math.max(48, Math.round((w + dir * step) / 4) * 4)));
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [currentUrl, showCircle, circleDiameterPx, circleRotateDeg]);

  useEffect(() => {
    const el = rectangleSvgRef.current;
    if (!el || !currentUrl || !showRectangle) return;
    const rw = rectangleWidth;
    const rh = rectangleHeightPx;
    const onWheel = (ev: WheelEvent) => {
      const srect = el.getBoundingClientRect();
      const scx = srect.left + srect.width / 2;
      const scy = srect.top + srect.height / 2;
      const scaleX = srect.width / rw;
      const scaleY = srect.height / rh;
      const lerx = Math.max(4, rw / 2 - 4);
      const lery = Math.max(4, rh / 2 - 4);
      const hxPix = lerx * scaleX;
      const hyPix = lery * scaleY;
      if (!pointInRotatedRect(ev.clientX, ev.clientY, scx, scy, rectangleRotateDeg, hxPix, hyPix)) return;
      ev.preventDefault();
      ev.stopPropagation();
      setRectangleSelected(true);
      setOvalSelected(false);
      setCircleSelected(false);
      setBox3dSelected(false);
      const dir = ev.deltaY > 0 ? -1 : 1;
      const step = ev.shiftKey ? 16 : 8;
      setRectangleWidth((w) => Math.min(560, Math.max(80, Math.round((w + dir * step) / 4) * 4)));
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [currentUrl, showRectangle, rectangleWidth, rectangleHeightPx, rectangleRotateDeg]);

  useEffect(() => {
    const el = box3dSvgRef.current;
    if (!el || !currentUrl || !showBox3d) return;
    const rw = box3dWidth;
    const rh = box3dHeightPx;
    const rd = box3dDepthPx;
    const onWheel = (ev: WheelEvent) => {
      const lp = clientPointToSvgUser(el, ev.clientX, ev.clientY);
      if (!lp) return;
      const layout = computeBox3dLayout(rw, rh, rd, box3dYawDeg, box3dPitchDeg);
      if (!pointInBox3dUnion(lp.x, lp.y, layout)) return;
      ev.preventDefault();
      ev.stopPropagation();
      setBox3dSelected(true);
      setOvalSelected(false);
      setCircleSelected(false);
      setRectangleSelected(false);
      const dir = ev.deltaY > 0 ? -1 : 1;
      const step = ev.shiftKey ? 16 : 8;
      setBox3dWidth((w) => Math.min(560, Math.max(80, Math.round((w + dir * step) / 4) * 4)));
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [currentUrl, showBox3d, box3dWidth, box3dHeightPx, box3dDepthPx, box3dYawDeg, box3dPitchDeg]);

  const effectiveIntervalSec = useMemo(() => {
    if (timerMode !== "classic") return intervalSec;
    if (classicSlotsExhausted(classicSlots)) return CLASSIC_EXHAUSTED_PLACEHOLDER_SEC;
    if (isClassicTierSec(intervalSec) && classicSlots[intervalSec] > 0) return intervalSec;
    return CLASSIC_TIER_SEC.find((t) => classicSlots[t] > 0) ?? CLASSIC_FIRST_TIER;
  }, [timerMode, intervalSec, classicSlots]);
  const [panX, setPanX] = useState(0);
  const [panY, setPanY] = useState(0);
  /** Same transform as the image so the oval’s top/bottom follow the picture (rotate, flip, pan, zoom). */
  const imageComposeTransform = useMemo(
    () =>
      `translate(${panX}px, ${panY}px) scale(${imageScale}) rotate(${imageRotate}deg) scaleX(${imageFlipH ? -1 : 1}) scaleY(${imageFlipV ? -1 : 1})`,
    [panX, panY, imageScale, imageRotate, imageFlipH, imageFlipV]
  );
  const [isPanning, setIsPanning] = useState(false);
  /** When oval is selected, show rotate cursor over the image outside the oval widget. */
  const [deckCursorMode, setDeckCursorMode] = useState<"grab" | "rotate">("grab");
  const panStartRef = useRef<{ startX: number; startY: number; startPanX: number; startPanY: number } | null>(null);
  const pinchRef = useRef<{
    distance: number;
    scale: number;
    lastDistance?: number;
    lastTime?: number;
  } | null>(null);
  const zoomContainerRef = useRef<HTMLDivElement | null>(null);
  /** Image stage (excludes side panels); hit target for oval deselect / rotate-from-image. */
  const slideshowStageRef = useRef<HTMLDivElement | null>(null);
  const imageScaleRef = useRef(imageScale);
  imageScaleRef.current = imageScale;
  const prevIdxInOrderRef = useRef<number | null>(null);
  const elapsedIntervalRef = useRef<number | null>(null);
  const [showOverlays, setShowOverlays] = useState(true);
  const [imageInfoExpanded, setImageInfoExpanded] = useState(true);
  const [gridExpanded, setGridExpanded] = useState(true);
  const [centerFrameExpanded, setCenterFrameExpanded] = useState(true);
  const [ovalExpanded, setOvalExpanded] = useState(true);
  const [circleExpanded, setCircleExpanded] = useState(true);
  const [rectangleExpanded, setRectangleExpanded] = useState(true);
  const [box3dExpanded, setBox3dExpanded] = useState(true);
  const [adjustImageExpanded, setAdjustImageExpanded] = useState(true);
  const initialSidebarColumns = normalizeSidebarColumns(
    storedSettings.leftPanelSectionOrder,
    storedSettings.rightPanelSectionOrder
  );
  const [leftPanelSectionOrder, setLeftPanelSectionOrder] = useState<SidebarSectionId[]>(
    () => initialSidebarColumns.left
  );
  const [rightPanelSectionOrder, setRightPanelSectionOrder] = useState<SidebarSectionId[]>(
    () => initialSidebarColumns.right
  );
  const overlayIdleTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    setSupported(typeof window !== "undefined" && "showDirectoryPicker" in window);
  }, []);

  // Hide overlays (except bottom timers) after 45s idle; show again on mouse move
  useEffect(() => {
    if (!currentUrl) return;
    const container = fullscreenContainerRef.current;
    if (!container) return;
    const IDLE_MS = 45000;
    function scheduleHide() {
      if (overlayIdleTimeoutRef.current) clearTimeout(overlayIdleTimeoutRef.current);
      overlayIdleTimeoutRef.current = setTimeout(() => setShowOverlays(false), IDLE_MS);
    }
    function handleMove() {
      setShowOverlays(true);
      scheduleHide();
    }
    scheduleHide();
    container.addEventListener("mousemove", handleMove);
    container.addEventListener("mouseenter", handleMove);
    return () => {
      container.removeEventListener("mousemove", handleMove);
      container.removeEventListener("mouseenter", handleMove);
      if (overlayIdleTimeoutRef.current) clearTimeout(overlayIdleTimeoutRef.current);
    };
  }, [currentUrl]);

  useEffect(() => {
    setLastFolderNameState(getLastFolderName());
    setLastFolderOpenedAtState(getLastFolderOpenedAt());
  }, []);

  useEffect(() => {
    if (prevTimerModeRef.current === "loop" && timerMode === "classic") {
      setClassicSlots({ ...CLASSIC_SLOTS_INITIAL });
      setIntervalSec(CLASSIC_FIRST_TIER);
    }
    if (prevTimerModeRef.current === "classic" && timerMode === "loop") {
      setClassicSlots({ ...CLASSIC_SLOTS_INITIAL });
    }
    prevTimerModeRef.current = timerMode;
  }, [timerMode]);

  // Classic: if the selected tier just hit 0, move selection to the next tier with slots.
  useEffect(() => {
    if (timerMode !== "classic" || classicSlotsExhausted(classicSlots)) return;
    if (isClassicTierSec(intervalSec) && classicSlots[intervalSec] > 0) return;
    const next = CLASSIC_TIER_SEC.find((t) => classicSlots[t] > 0);
    if (next !== undefined) setIntervalSec(next);
  }, [timerMode, intervalSec, classicSlots]);

  // Restore persisted settings from localStorage after mount (hydration fix: server uses defaults)
  useEffect(() => {
    const s = loadStoredSettings();
    setIntervalSec(s.intervalSec);
    setElapsedSec(s.elapsedSec);
    setImageScale(s.imageScale);
    setImageBrightness(s.imageBrightness);
    setImageContrast(s.imageContrast);
    setImageRotate(s.imageRotate);
    setImageFlipH(s.imageFlipH);
    setImageFlipV(s.imageFlipV);
    setImageGrayscale(s.imageGrayscale);
    setImageSaturation(s.imageSaturation);
    setImageBlur(s.imageBlur);
    setShowCenterFrame(s.showCenterFrame !== false);
    setShowGrid(s.showGrid !== false);
    setGridCellSize(Math.min(200, Math.max(16, Number(s.gridCellSize) || 48)));
    setCenterFrameSize(
      Math.min(480, Math.max(48, Number(s.centerFrameSize) || 136))
    );
    setCenterFrameLabelSize(
      Math.min(300, Math.max(8, Number(s.centerFrameLabelSize) || 50))
    );
    setShowOval(s.showOval !== false);
    const ow = Math.min(560, Math.max(80, Number(s.ovalWidth) || 139));
    setOvalWidth(ow);
    const fromStoredH = Number(s.ovalHeightPx);
    const hFallback = Math.max(80, Math.round(ow / 0.58));
    setOvalHeightPx(
      Math.min(560, Math.max(48, Number.isFinite(fromStoredH) ? fromStoredH : hFallback))
    );
    setOvalRotateDeg(Math.min(180, Math.max(-180, Number(s.ovalRotateDeg) || 0)));
    setOvalOffsetX(Number.isFinite(Number(s.ovalOffsetX)) ? Number(s.ovalOffsetX) : 0);
    setOvalOffsetY(Number.isFinite(Number(s.ovalOffsetY)) ? Number(s.ovalOffsetY) : 0);
    setShowCircle(s.showCircle !== false);
    setShowPose(s.showPose === true);
    setPoseFigureMode(s.poseFigureMode !== false);
    setPoseMinConfidence(
      Math.min(0.95, Math.max(0.05, Number(s.poseMinConfidence) || DEFAULT_SETTINGS.poseMinConfidence))
    );
    setPoseOffsetX(
      Number.isFinite(Number(s.poseOffsetX)) ? Number(s.poseOffsetX) : DEFAULT_SETTINGS.poseOffsetX
    );
    setPoseOffsetY(
      Number.isFinite(Number(s.poseOffsetY)) ? Number(s.poseOffsetY) : DEFAULT_SETTINGS.poseOffsetY
    );
    setCircleDiameterPx(
      Math.min(560, Math.max(48, Number(s.circleDiameterPx) || DEFAULT_SETTINGS.circleDiameterPx))
    );
    setCircleRotateDeg(Math.min(180, Math.max(-180, Number(s.circleRotateDeg) || 0)));
    setCircleOffsetX(Number.isFinite(Number(s.circleOffsetX)) ? Number(s.circleOffsetX) : 0);
    setCircleOffsetY(Number.isFinite(Number(s.circleOffsetY)) ? Number(s.circleOffsetY) : 0);
    setShowRectangle(s.showRectangle !== false);
    setRectangleWidth(
      Math.min(560, Math.max(80, Number(s.rectangleWidth) || DEFAULT_SETTINGS.rectangleWidth))
    );
    setRectangleHeightPx(
      Math.min(560, Math.max(48, Number(s.rectangleHeightPx) || DEFAULT_SETTINGS.rectangleHeightPx))
    );
    setRectangleRotateDeg(Math.min(180, Math.max(-180, Number(s.rectangleRotateDeg) || 0)));
    setRectangleOffsetX(Number.isFinite(Number(s.rectangleOffsetX)) ? Number(s.rectangleOffsetX) : 0);
    setRectangleOffsetY(Number.isFinite(Number(s.rectangleOffsetY)) ? Number(s.rectangleOffsetY) : 0);
    setShowBox3d(s.showBox3d !== false);
    setBox3dWidth(Math.min(560, Math.max(80, Number(s.box3dWidth) || DEFAULT_SETTINGS.box3dWidth)));
    setBox3dHeightPx(Math.min(560, Math.max(48, Number(s.box3dHeightPx) || DEFAULT_SETTINGS.box3dHeightPx)));
    setBox3dDepthPx(Math.min(560, Math.max(24, Number(s.box3dDepthPx) || DEFAULT_SETTINGS.box3dDepthPx)));
    setBox3dRotateDeg(Math.min(180, Math.max(-180, Number(s.box3dRotateDeg) || 0)));
    setBox3dYawDeg(Math.min(180, Math.max(-180, Number(s.box3dYawDeg) || 0)));
    setBox3dPitchDeg(Math.min(180, Math.max(-180, Number(s.box3dPitchDeg) || 0)));
    setBox3dOffsetX(Number.isFinite(Number(s.box3dOffsetX)) ? Number(s.box3dOffsetX) : 0);
    setBox3dOffsetY(Number.isFinite(Number(s.box3dOffsetY)) ? Number(s.box3dOffsetY) : 0);
    const cols = normalizeSidebarColumns(s.leftPanelSectionOrder, s.rightPanelSectionOrder);
    setLeftPanelSectionOrder(cols.left);
    setRightPanelSectionOrder(cols.right);
    setTimerMode(parseTimerMode(s.timerMode));
  }, []);

  // Persist interval, elapsed, and image settings to localStorage
  useEffect(() => {
    saveStoredSettings({
      intervalSec,
      elapsedSec,
      imageScale,
      imageBrightness,
      imageContrast,
      imageRotate,
      imageFlipH,
      imageFlipV,
      imageGrayscale,
      imageSaturation,
      imageBlur,
      showCenterFrame,
      showGrid,
      gridCellSize,
      centerFrameSize,
      centerFrameLabelSize,
      showOval,
      ovalWidth,
      ovalHeightPx,
      ovalRotateDeg,
      ovalOffsetX,
      ovalOffsetY,
      showCircle,
      showPose,
      poseFigureMode,
      poseMinConfidence,
      poseOffsetX,
      poseOffsetY,
      circleDiameterPx,
      circleRotateDeg,
      circleOffsetX,
      circleOffsetY,
      showRectangle,
      rectangleWidth,
      rectangleHeightPx,
      rectangleRotateDeg,
      rectangleOffsetX,
      rectangleOffsetY,
      showBox3d,
      box3dWidth,
      box3dHeightPx,
      box3dDepthPx,
      box3dRotateDeg,
      box3dYawDeg,
      box3dPitchDeg,
      box3dOffsetX,
      box3dOffsetY,
      leftPanelSectionOrder,
      rightPanelSectionOrder,
      timerMode,
    });
  }, [
    intervalSec,
    elapsedSec,
    imageScale,
    imageBrightness,
    imageContrast,
    imageRotate,
    imageFlipH,
    imageFlipV,
    imageGrayscale,
    imageSaturation,
    imageBlur,
    showCenterFrame,
    showGrid,
    gridCellSize,
    centerFrameSize,
    centerFrameLabelSize,
    showOval,
    ovalWidth,
    ovalHeightPx,
    ovalRotateDeg,
    ovalOffsetX,
    ovalOffsetY,
    showCircle,
    showPose,
    poseFigureMode,
    poseMinConfidence,
    poseOffsetX,
    poseOffsetY,
    circleDiameterPx,
    circleRotateDeg,
      circleOffsetX,
      circleOffsetY,
      showRectangle,
      rectangleWidth,
      rectangleHeightPx,
      rectangleRotateDeg,
      rectangleOffsetX,
      rectangleOffsetY,
      showBox3d,
      box3dWidth,
      box3dHeightPx,
      box3dDepthPx,
      box3dRotateDeg,
      box3dYawDeg,
      box3dPitchDeg,
      box3dOffsetX,
      box3dOffsetY,
      leftPanelSectionOrder,
      rightPanelSectionOrder,
      timerMode,
    ]);

  // Play sound when slide changes (next image)
  useEffect(() => {
    if (prevIdxInOrderRef.current !== null && prevIdxInOrderRef.current !== idxInOrder) {
      playAdvanceSound();
    }
    prevIdxInOrderRef.current = idxInOrder;
  }, [idxInOrder]);

  const currentFile = useMemo(() => {
    if (!files.length || !order.length) return null;
    const fileIndex = order[idxInOrder % order.length];
    return files[fileIndex] || null;
  }, [files, order, idxInOrder]);

  async function collectImagesRecursive(
    dir: FileSystemDirectoryHandle,
    pathPrefix: string
  ): Promise<FileHandleEntry[]> {
    const collected: FileHandleEntry[] = [];
    // @ts-expect-error: values() exists on FileSystemDirectoryHandle but types may be incomplete
    for await (const entry of dir.values()) {
      if (entry.kind === "file" && isImageFileName(entry.name)) {
        collected.push({ name: pathPrefix ? `${pathPrefix}/${entry.name}` : entry.name, handle: entry });
      } else if (entry.kind === "directory" && !IGNORED_DIRS.has(entry.name)) {
        const subPath = pathPrefix ? `${pathPrefix}/${entry.name}` : entry.name;
        const subFiles = await collectImagesRecursive(entry, subPath);
        collected.push(...subFiles);
      }
    }
    return collected;
  }

  async function applyFolder(handle: FileSystemDirectoryHandle) {
    setDirHandle(handle);
    const collected = await collectImagesRecursive(handle, "");
    if (!collected.length) {
      alert("No images found in that folder. Try a folder with .jpg/.png/.webp etc.");
      setFiles([]);
      setOrder([]);
      setIdxInOrder(0);
      setClassicSlots({ ...CLASSIC_SLOTS_INITIAL });
      setIsRunning(false);
      return;
    }
    setFiles(collected);
    setOrder(shuffle(collected.map((_, i) => i)));
    setIdxInOrder(0);
    setClassicSlots({ ...CLASSIC_SLOTS_INITIAL });
    setIsRunning(false);
  }

  async function pickFolder() {
    try {
      // @ts-expect-error: showDirectoryPicker types exist in newer TS libs; safe in Chromium
      const handle: FileSystemDirectoryHandle = await window.showDirectoryPicker({ mode: "readwrite" });
      try {
        await saveLastFolderHandle(handle);
        const now = Date.now();
        setLastFolderName(handle.name);
        setLastFolderNameState(handle.name);
        setLastFolderOpenedAt(now);
        setLastFolderOpenedAtState(now);
      } catch {
        // IndexedDB or localStorage may be unavailable
      }
      await applyFolder(handle);
    } catch (e) {
      console.warn(e);
    }
  }

  async function openLastFolder() {
    try {
      const handle = await getLastFolderHandle();
      if (!handle) {
        alert("No previous folder saved. Pick a folder first.");
        return;
      }
      const h = handle as FileSystemDirectoryHandle & {
        queryPermission?(opts: { mode: string }): Promise<string>;
        requestPermission?(opts: { mode: string }): Promise<boolean>;
      };
      const permission = await h.queryPermission?.({ mode: "readwrite" }).catch(() => "prompt");
      if (permission === "denied") {
        alert("Permission to the last folder was denied. Use Pick Folder to choose it again.");
        return;
      }
      if (permission === "prompt") {
        const granted = await h.requestPermission?.({ mode: "readwrite" }).catch(() => false);
        if (!granted) {
          alert("Permission to the last folder is needed. Use Pick Folder to choose it again.");
          return;
        }
      }
      const now = Date.now();
      setLastFolderOpenedAt(now);
      setLastFolderOpenedAtState(now);
      setLastFolderNameState(handle.name);
      await applyFolder(handle);
    } catch (e) {
      console.warn(e);
      alert("Could not open last folder. It may have been moved. Use Pick Folder instead.");
    }
  }

  function reshuffle() {
    if (!files.length) return;
    setOrder(shuffle(files.map((_, i) => i)));
    setIdxInOrder(0);
    setClassicSlots({ ...CLASSIC_SLOTS_INITIAL });
  }

  function next() {
    if (!order.length) return;
    setIdxInOrder((v) => (v + 1) % order.length);
  }

  function prev() {
    if (!order.length) return;
    setIdxInOrder((v) => (v - 1 + order.length) % order.length);
  }

  async function enterFullscreen() {
    const el = fullscreenContainerRef.current;
    if (!el) return;
    try {
      if (el.requestFullscreen) {
        await el.requestFullscreen();
      }
    } catch (e) {
      console.warn("Failed to enter fullscreen:", e);
    }
  }

  async function exitFullscreen() {
    try {
      if (document.exitFullscreen) {
        await document.exitFullscreen();
      }
    } catch (e) {
      console.warn("Failed to exit fullscreen:", e);
    }
  }

  function toggleFullscreen() {
    if (isFullscreen) {
      exitFullscreen();
    } else {
      enterFullscreen();
    }
  }

  function goToLanding() {
    if (currentUrlRef.current) {
      URL.revokeObjectURL(currentUrlRef.current);
      currentUrlRef.current = null;
    }
    setCurrentUrl(null);
    setIsRunning(false);
    setShowOverlays(true);
  }

  async function deleteCurrentImage() {
    if (!currentFile || !dirHandle) return;
    try {
      const parts = currentFile.name.split("/").filter(Boolean);
      const fileName = parts[parts.length - 1];
      const parentPath = parts.slice(0, -1);

      let parentDir: FileSystemDirectoryHandle = dirHandle;
      for (const dirName of parentPath) {
        parentDir = await parentDir.getDirectoryHandle(dirName);
      }

      const deletedDir = await dirHandle.getDirectoryHandle("_Deleted", { create: true });

      const file = await currentFile.handle.getFile();
      const blob = await file.arrayBuffer();
      const newFileHandle = await deletedDir.getFileHandle(fileName, { create: true });
      const writable = await newFileHandle.createWritable();
      await writable.write(blob);
      await writable.close();

      await parentDir.removeEntry(fileName);

      const deletedIdx = files.indexOf(currentFile);
      const newFiles = files.filter((_, i) => i !== deletedIdx);
      const newOrder = order
        .filter((i) => i !== deletedIdx)
        .map((i) => (i > deletedIdx ? i - 1 : i));

      setFiles(newFiles);
      setOrder(newOrder);
      setIdxInOrder((v) => Math.min(v, Math.max(0, newOrder.length - 1)));
      if (newFiles.length === 0) {
        if (currentUrlRef.current) {
          URL.revokeObjectURL(currentUrlRef.current);
          currentUrlRef.current = null;
        }
        setCurrentUrl(null);
        setIsRunning(false);
      }
    } catch (e) {
      console.warn("Failed to delete:", e);
      alert("Failed to move file to _Deleted. Make sure you granted read/write permission.");
    }
  }

  // Load/display current image
  useEffect(() => {
    let cancelled = false;

    async function load() {
      if (!currentFile) return;

      if (currentUrlRef.current) {
        URL.revokeObjectURL(currentUrlRef.current);
        currentUrlRef.current = null;
      }

      const file = await currentFile.handle.getFile();
      const url = URL.createObjectURL(file);

      if (cancelled) {
        URL.revokeObjectURL(url);
        return;
      }

      currentUrlRef.current = url;
      setCurrentUrl(url);
      setImageMeta((prev) => ({
        ...prev,
        fileSize: file.size,
        lastModified: file.lastModified,
        width: undefined,
        height: undefined,
      }));
    }

    load();
    return () => {
      cancelled = true;
    };
  }, [currentFile]);

  const MAX_SCALE = 3;
  const MIN_SCALE = 0.25;

  // Ctrl+wheel zoom (trackpad pinch on desktop) – on full view so it works over overlays too
  useEffect(() => {
    if (!currentUrl) return;
    const el = fullscreenContainerRef.current;
    if (!el) return;
    function handleWheel(e: WheelEvent) {
      if (!e.ctrlKey) return;
      e.preventDefault();
      const delta = e.deltaY > 0 ? -0.05 : 0.05;
      setImageScale((s) => Math.min(MAX_SCALE, Math.max(MIN_SCALE, s + delta)));
    }
    el.addEventListener("wheel", handleWheel, { passive: false });
    return () => el.removeEventListener("wheel", handleWheel);
  }, [currentUrl]);

  // Two-finger pinch zoom on full view so pinching off the image (e.g. on overlays) still zooms
  useEffect(() => {
    if (!currentUrl) return;
    const el = fullscreenContainerRef.current;
    if (!el) return;
    function handleTouchStart(e: TouchEvent) {
      if (e.touches.length === 2) {
        pinchRef.current = {
          distance: touchDistance(e.touches[0], e.touches[1]),
          scale: imageScaleRef.current,
        };
      }
    }
    function handleTouchMove(e: TouchEvent) {
      if (e.touches.length === 2 && pinchRef.current) {
        e.preventDefault();
        const dist = touchDistance(e.touches[0], e.touches[1]);
        const now = performance.now();
        const pr = pinchRef.current;

        const ratio = dist / pr.distance;
        const baseSensitivity = 14;
        let scaleDelta = Math.pow(ratio, baseSensitivity);

        if (pr.lastTime != null && pr.lastDistance != null) {
          const dt = Math.max(now - pr.lastTime, 1);
          const velocity = (dist - pr.lastDistance) / dt;
          const velocityBoost = 1 + Math.min(Math.max(velocity * 0.12, 0), 1.5);
          scaleDelta *= velocityBoost;
        }

        pr.lastDistance = dist;
        pr.lastTime = now;

        const newScale = Math.min(
          MAX_SCALE,
          Math.max(MIN_SCALE, pr.scale * scaleDelta)
        );
        setImageScale(newScale);
      }
    }
    function handleTouchEnd(e: TouchEvent) {
      if (e.touches.length < 2) pinchRef.current = null;
    }
    el.addEventListener("touchstart", handleTouchStart, { passive: true });
    el.addEventListener("touchmove", handleTouchMove, { passive: false });
    el.addEventListener("touchend", handleTouchEnd, { passive: true });
    el.addEventListener("touchcancel", handleTouchEnd, { passive: true });
    return () => {
      el.removeEventListener("touchstart", handleTouchStart);
      el.removeEventListener("touchmove", handleTouchMove);
      el.removeEventListener("touchend", handleTouchEnd);
      el.removeEventListener("touchcancel", handleTouchEnd);
    };
  }, [currentUrl]);

  // Pan: global mouse move/up when dragging
  useEffect(() => {
    if (!isPanning) return;
    function handleMouseMove(e: MouseEvent) {
      if (panStartRef.current) {
        setPanX(panStartRef.current.startPanX + (e.clientX - panStartRef.current.startX));
        setPanY(panStartRef.current.startPanY + (e.clientY - panStartRef.current.startY));
      }
    }
    function handleMouseUp() {
      setIsPanning(false);
      panStartRef.current = null;
    }
    window.addEventListener("mousemove", handleMouseMove);
    window.addEventListener("mouseup", handleMouseUp);
    return () => {
      window.removeEventListener("mousemove", handleMouseMove);
      window.removeEventListener("mouseup", handleMouseUp);
    };
  }, [isPanning]);

  // Timer logic
  useEffect(() => {
    if (timerRef.current) {
      window.clearInterval(timerRef.current);
      timerRef.current = null;
    }

    if (isRunning && order.length) {
      if (timerMode === "classic") {
        classicAdvanceTierRef.current = effectiveIntervalSec as ClassicTierSec;
      }
      setTimeRemaining(effectiveIntervalSec);
      timerRef.current = window.setInterval(() => {
        const v = idxInOrderRef.current;
        if (!order.length) return;
        let advanced = false;
        let next = v;
        if (timerMode === "loop") {
          advanced = true;
          next = (v + 1) % order.length;
        } else if (order.length <= 1) {
          advanced = true;
          next = v;
        } else if (v >= order.length - 1) {
          next = v;
        } else {
          advanced = true;
          next = v + 1;
        }
        setIdxInOrder(next);
        if (timerMode === "classic" && advanced) {
          const tier = classicAdvanceTierRef.current;
          if (isClassicTierSec(tier)) {
            setClassicSlots((prev) => {
              if (prev[tier] <= 0) return prev;
              const nextSlots: ClassicSlots = { ...prev, [tier]: prev[tier] - 1 };
              if (classicSlotsExhausted(nextSlots)) setIsRunning(false);
              return nextSlots;
            });
          }
        }
      }, Math.max(1, effectiveIntervalSec) * 1000);
    } else {
      setTimeRemaining(0);
    }

    return () => {
      if (timerRef.current) window.clearInterval(timerRef.current);
    };
  }, [isRunning, effectiveIntervalSec, order.length, idxInOrder, timerMode, classicSlots]);

  // Countdown timer
  useEffect(() => {
    if (countdownRef.current) {
      window.clearInterval(countdownRef.current);
      countdownRef.current = null;
    }

    if (isRunning && order.length) {
      // Reset timer when image changes or when starting
      setTimeRemaining(effectiveIntervalSec);
      countdownRef.current = window.setInterval(() => {
        setTimeRemaining((prev) => {
          if (prev <= 1) {
            return effectiveIntervalSec;
          }
          return prev - 1;
        });
      }, 1000);
    } else {
      setTimeRemaining(0);
    }

    return () => {
      if (countdownRef.current) window.clearInterval(countdownRef.current);
    };
  }, [isRunning, effectiveIntervalSec, order.length, idxInOrder, timerMode, classicSlots]);

  // Elapsed time (total seconds since slideshow started)
  useEffect(() => {
    if (elapsedIntervalRef.current) {
      window.clearInterval(elapsedIntervalRef.current);
      elapsedIntervalRef.current = null;
    }
    if (isRunning && order.length) {
      elapsedIntervalRef.current = window.setInterval(() => {
        setElapsedSec((e) => e + 1);
      }, 1000);
    }
    return () => {
      if (elapsedIntervalRef.current) window.clearInterval(elapsedIntervalRef.current);
    };
  }, [isRunning, order.length]);

  // Fullscreen state tracking
  useEffect(() => {
    function handleFullscreenChange() {
      setIsFullscreen(!!document.fullscreenElement);
    }

    document.addEventListener("fullscreenchange", handleFullscreenChange);
    return () => {
      document.removeEventListener("fullscreenchange", handleFullscreenChange);
    };
  }, []);

  // Keyboard controls
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === " ") {
        e.preventDefault();
        if (files.length && order.length) {
          if (document.fullscreenElement) {
            exitFullscreen();
          } else {
            enterFullscreen();
          }
        }
        return;
      }
      if (!files.length || !order.length) return;

      if (e.key === "ArrowLeft") {
        e.preventDefault();
        setIdxInOrder((v) => (v - 1 + order.length) % order.length);
      } else if (e.key === "ArrowRight") {
        e.preventDefault();
        setIdxInOrder((v) => (v + 1) % order.length);
      }
    }

    document.addEventListener("keydown", handleKeyDown, true);
    return () => {
      document.removeEventListener("keydown", handleKeyDown, true);
    };
  }, [files.length, order.length]);

  // Cleanup object URL on unmount
  useEffect(() => {
    return () => {
      if (currentUrlRef.current) URL.revokeObjectURL(currentUrlRef.current);
    };
  }, []);

  function commitSidebarDrop(
    dragId: string,
    fromCol: string,
    dropId: SidebarSectionId | null,
    toCol: SidebarColumn
  ) {
    if (!isSidebarSectionId(dragId)) return;
    if (fromCol !== "left" && fromCol !== "right") return;
    const from = fromCol as SidebarColumn;
    const next = applySidebarDrop(
      leftPanelSectionOrder,
      rightPanelSectionOrder,
      dragId,
      dropId,
      from,
      toCol
    );
    setLeftPanelSectionOrder(next.left);
    setRightPanelSectionOrder(next.right);
  }

  function renderSectionContent(sectionId: SidebarSectionId): React.ReactNode {
    switch (sectionId) {
      case "imageInfo":
        if (!currentFile) return null;
        return (
          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            <MetaRow label="File name" value={currentFile.name.split("/").pop() ?? currentFile.name} />
            <MetaRow label="Path" value={currentFile.name} />
            <MetaRow label="File size" value={imageMeta.fileSize != null ? formatBytes(imageMeta.fileSize) : "—"} />
            <MetaRow
              label="Resolution"
              value={
                imageMeta.width != null && imageMeta.height != null
                  ? `${imageMeta.width} × ${imageMeta.height}`
                  : "—"
              }
            />
            <MetaRow
              label="Last modified"
              value={
                imageMeta.lastModified != null
                  ? new Date(imageMeta.lastModified).toLocaleString(undefined, {
                      dateStyle: "short",
                      timeStyle: "short",
                    })
                  : "—"
              }
            />
          </div>
        );
      case "grid":
        return (
          <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            <label style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer", fontSize: 12, opacity: 0.9 }}>
              <input type="checkbox" checked={!showGrid} onChange={(e) => setShowGrid(!e.target.checked)} />
              <span>Hide grid</span>
            </label>
            <SliderRow
              label="Grid cell size"
              value={gridCellSize}
              min={16}
              max={200}
              step={4}
              format={(v) => `${Math.round(v)}px`}
              onChange={setGridCellSize}
            />
          </div>
        );
      case "centerFrame":
        return (
          <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            <label style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer", fontSize: 12, opacity: 0.9 }}>
              <input type="checkbox" checked={!showCenterFrame} onChange={(e) => setShowCenterFrame(!e.target.checked)} />
              <span>Hide center frame</span>
            </label>
            <SliderRow label="Frame size" value={centerFrameSize} min={48} max={480} step={4} format={(v) => `${Math.round(v)}px`} onChange={setCenterFrameSize} />
            <SliderRow label="Lettra Size" value={centerFrameLabelSize} min={8} max={300} step={1} format={(v) => `${Math.round(v)}px`} onChange={setCenterFrameLabelSize} />
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              <span style={{ opacity: 0.85, fontSize: 12 }}>Flip</span>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
                <label style={{ display: "flex", alignItems: "center", gap: 6, cursor: "pointer" }}>
                  <input type="checkbox" checked={imageFlipH} onChange={(e) => setImageFlipH(e.target.checked)} />
                  <span style={{ fontSize: 12 }}>Horizontal</span>
                </label>
                <label style={{ display: "flex", alignItems: "center", gap: 6, cursor: "pointer" }}>
                  <input type="checkbox" checked={imageFlipV} onChange={(e) => setImageFlipV(e.target.checked)} />
                  <span style={{ fontSize: 12 }}>Vertical</span>
                </label>
              </div>
            </div>
          </div>
        );
      case "oval":
        return (
          <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            <label style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer", fontSize: 12, opacity: 0.9 }}>
              <input type="checkbox" checked={!showOval} onChange={(e) => setShowOval(!e.target.checked)} />
              <span>Hide Ribcage</span>
            </label>
            <SliderRow label="Ribcage width" value={ovalWidth} min={80} max={560} step={4} format={(v) => `${Math.round(v)}×${ovalHeightPx} px`} onChange={setOvalWidth} />
            <SliderRow label="Ribcage height" value={ovalHeightPx} min={48} max={560} step={4} format={(v) => `${Math.round(v)}px`} onChange={setOvalHeightPx} />
            <SliderRow label="Ribcage rotation" value={ovalRotateDeg} min={-180} max={180} step={1} format={(v) => `${Math.round(v)}°`} onChange={setOvalRotateDeg} />
            <button
              type="button"
              onClick={() => {
                setOvalWidth(DEFAULT_SETTINGS.ovalWidth);
                setOvalHeightPx(DEFAULT_SETTINGS.ovalHeightPx);
                setOvalRotateDeg(DEFAULT_SETTINGS.ovalRotateDeg);
                setOvalOffsetX(DEFAULT_SETTINGS.ovalOffsetX);
                setOvalOffsetY(DEFAULT_SETTINGS.ovalOffsetY);
                setOvalSelected(false);
              }}
              style={{ alignSelf: "flex-start", padding: "6px 10px", fontSize: 12, borderRadius: 6, border: "1px solid rgba(255,255,255,0.2)", background: "rgba(255,255,255,0.08)", color: "white", cursor: "pointer" }}
            >
              Reset Ribcage
            </button>
          </div>
        );
      case "circle":
        return (
          <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            <label style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer", fontSize: 12, opacity: 0.9 }}>
              <input type="checkbox" checked={!showCircle} onChange={(e) => setShowCircle(!e.target.checked)} />
              <span>Hide head</span>
            </label>
            <SliderRow label="Diameter" value={circleDiameterPx} min={48} max={560} step={4} format={(v) => `${Math.round(v)}px`} onChange={setCircleDiameterPx} />
            <SliderRow label="Rotation" value={circleRotateDeg} min={-180} max={180} step={1} format={(v) => `${Math.round(v)}°`} onChange={setCircleRotateDeg} />
          </div>
        );
      case "pose":
        return (
          <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            <label style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer", fontSize: 12, opacity: 0.9 }}>
              <input type="checkbox" checked={!showPose} onChange={(e) => setShowPose(!e.target.checked)} />
              <span>Hide pose</span>
            </label>
            <label style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer", fontSize: 12, opacity: 0.9 }}>
              <input type="checkbox" checked={poseFigureMode} onChange={(e) => setPoseFigureMode(e.target.checked)} />
              <span>Figure drawing mode</span>
            </label>
            <SliderRow
              label="Min confidence"
              value={poseMinConfidence}
              min={0.05}
              max={0.95}
              step={0.05}
              format={(v) => v.toFixed(2)}
              onChange={setPoseMinConfidence}
            />
            <SliderRow
              label="Offset X"
              value={poseOffsetX}
              min={-60}
              max={60}
              step={1}
              format={(v) => `${Math.round(v)}px`}
              onChange={setPoseOffsetX}
            />
            <SliderRow
              label="Offset Y"
              value={poseOffsetY}
              min={-60}
              max={60}
              step={1}
              format={(v) => `${Math.round(v)}px`}
              onChange={setPoseOffsetY}
            />
            <p style={{ margin: 0, fontSize: 11, lineHeight: 1.45, opacity: 0.78 }}>
              MediaPipe Pose Landmarker overlay on the current image.
            </p>
          </div>
        );
      case "rectangle":
        return (
          <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            <label style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer", fontSize: 12, opacity: 0.9 }}>
              <input type="checkbox" checked={!showRectangle} onChange={(e) => setShowRectangle(!e.target.checked)} />
              <span>Hide rectangle</span>
            </label>
            <SliderRow label="Width" value={rectangleWidth} min={80} max={560} step={4} format={(v) => `${Math.round(v)}×${rectangleHeightPx} px`} onChange={setRectangleWidth} />
            <SliderRow label="Height" value={rectangleHeightPx} min={48} max={560} step={4} format={(v) => `${Math.round(v)}px`} onChange={setRectangleHeightPx} />
            <SliderRow label="Rotation" value={rectangleRotateDeg} min={-180} max={180} step={1} format={(v) => `${Math.round(v)}°`} onChange={setRectangleRotateDeg} />
            <button
              type="button"
              onClick={() => {
                setRectangleWidth(DEFAULT_SETTINGS.rectangleWidth);
                setRectangleHeightPx(DEFAULT_SETTINGS.rectangleHeightPx);
                setRectangleRotateDeg(DEFAULT_SETTINGS.rectangleRotateDeg);
                setRectangleOffsetX(DEFAULT_SETTINGS.rectangleOffsetX);
                setRectangleOffsetY(DEFAULT_SETTINGS.rectangleOffsetY);
                setRectangleSelected(false);
              }}
              style={{ alignSelf: "flex-start", padding: "6px 10px", fontSize: 12, borderRadius: 6, border: "1px solid rgba(255,255,255,0.2)", background: "rgba(255,255,255,0.08)", color: "white", cursor: "pointer" }}
            >
              Reset rectangle
            </button>
          </div>
        );
      case "box3d":
        return (
          <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            <label style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer", fontSize: 12, opacity: 0.9 }}>
              <input type="checkbox" checked={!showBox3d} onChange={(e) => setShowBox3d(!e.target.checked)} />
              <span>Hide 3D box</span>
            </label>
            <SliderRow label="Width" value={box3dWidth} min={80} max={560} step={4} format={(v) => `${Math.round(v)}×${box3dHeightPx}×${box3dDepthPx} px`} onChange={setBox3dWidth} />
            <SliderRow label="Height" value={box3dHeightPx} min={48} max={560} step={4} format={(v) => `${Math.round(v)}px`} onChange={setBox3dHeightPx} />
            <SliderRow label="Depth" value={box3dDepthPx} min={24} max={560} step={4} format={(v) => `${Math.round(v)}px`} onChange={setBox3dDepthPx} />
            <SliderRow label="Slide rotation" value={box3dRotateDeg} min={-180} max={180} step={1} format={(v) => `${Math.round(v)}°`} onChange={setBox3dRotateDeg} />
            <SliderRow label="Lateral (yaw)" value={box3dYawDeg} min={-180} max={180} step={1} format={(v) => `${Math.round(v)}°`} onChange={setBox3dYawDeg} />
            <SliderRow label="Vertical (pitch)" value={box3dPitchDeg} min={-180} max={180} step={1} format={(v) => `${Math.round(v)}°`} onChange={setBox3dPitchDeg} />
            <p style={{ margin: 0, fontSize: 11, lineHeight: 1.45, opacity: 0.78 }}>
              On the slide: drag faces to orbit, or drag any wireframe edge so movement along that edge adjusts yaw and movement perpendicular adjusts
              pitch (and the other way around on vertical edges); when selected, drag the crosshair to pan; Alt + drag rotates the box on the slide; Shift +
              Alt + drag moves it; middle- or right-drag also orbit; Shift + drag scales (not while holding Alt). When selected, drag corners to resize
              the front face; when selected, drag outside the box on the image to rotate it on the slide.
            </p>
            <button
              type="button"
              onClick={() => {
                setBox3dWidth(DEFAULT_SETTINGS.box3dWidth);
                setBox3dHeightPx(DEFAULT_SETTINGS.box3dHeightPx);
                setBox3dDepthPx(DEFAULT_SETTINGS.box3dDepthPx);
                setBox3dRotateDeg(DEFAULT_SETTINGS.box3dRotateDeg);
                setBox3dYawDeg(DEFAULT_SETTINGS.box3dYawDeg);
                setBox3dPitchDeg(DEFAULT_SETTINGS.box3dPitchDeg);
                setBox3dOffsetX(DEFAULT_SETTINGS.box3dOffsetX);
                setBox3dOffsetY(DEFAULT_SETTINGS.box3dOffsetY);
                setBox3dSelected(false);
              }}
              style={{ alignSelf: "flex-start", padding: "6px 10px", fontSize: 12, borderRadius: 6, border: "1px solid rgba(255,255,255,0.2)", background: "rgba(255,255,255,0.08)", color: "white", cursor: "pointer" }}
            >
              Reset 3D box
            </button>
          </div>
        );
      case "adjustImage":
        return (
          <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
            <SliderRow label="Scale" value={imageScale} min={0.25} max={3} step={0.05} format={(v) => `${Math.round(v * 100)}%`} onChange={setImageScale} />
            <SliderRow label="Brightness" value={imageBrightness} min={0} max={2} step={0.05} format={(v) => `${Math.round(v * 100)}%`} onChange={setImageBrightness} />
            <SliderRow label="Contrast" value={imageContrast} min={0} max={3} step={0.05} format={(v) => `${Math.round(v * 100)}%`} onChange={setImageContrast} />
            <SliderRow label="Rotate" value={imageRotate} min={0} max={360} step={1} format={(v) => `${v}°`} onChange={setImageRotate} />
            <SliderRow label="Grayscale" value={imageGrayscale} min={0} max={1} step={0.01} format={(v) => `${Math.round(v * 100)}%`} onChange={setImageGrayscale} />
            <SliderRow label="Saturation" value={imageSaturation} min={0} max={2} step={0.05} format={(v) => `${Math.round(v * 100)}%`} onChange={setImageSaturation} />
            <SliderRow label="Blur" value={imageBlur} min={0} max={10} step={0.5} format={(v) => (v === 0 ? "0" : `${v}px`)} onChange={setImageBlur} />
            <button
              type="button"
              onClick={() => {
                setImageScale(1);
                setImageBrightness(1);
                setImageContrast(1);
                setImageRotate(0);
                setImageFlipH(false);
                setImageFlipV(false);
                setImageGrayscale(0);
                setImageSaturation(1);
                setImageBlur(0);
                setPanX(0);
                setPanY(0);
                setShowCenterFrame(DEFAULT_SETTINGS.showCenterFrame);
                setShowGrid(DEFAULT_SETTINGS.showGrid);
                setGridCellSize(DEFAULT_SETTINGS.gridCellSize);
                setCenterFrameSize(DEFAULT_SETTINGS.centerFrameSize);
                setCenterFrameLabelSize(DEFAULT_SETTINGS.centerFrameLabelSize);
                setShowOval(DEFAULT_SETTINGS.showOval);
                setOvalWidth(DEFAULT_SETTINGS.ovalWidth);
                setOvalHeightPx(DEFAULT_SETTINGS.ovalHeightPx);
                setOvalRotateDeg(DEFAULT_SETTINGS.ovalRotateDeg);
                setOvalOffsetX(DEFAULT_SETTINGS.ovalOffsetX);
                setOvalOffsetY(DEFAULT_SETTINGS.ovalOffsetY);
                setShowCircle(DEFAULT_SETTINGS.showCircle);
                setShowPose(DEFAULT_SETTINGS.showPose);
                setPoseFigureMode(DEFAULT_SETTINGS.poseFigureMode);
                setPoseMinConfidence(DEFAULT_SETTINGS.poseMinConfidence);
                setPoseOffsetX(DEFAULT_SETTINGS.poseOffsetX);
                setPoseOffsetY(DEFAULT_SETTINGS.poseOffsetY);
                setCircleDiameterPx(DEFAULT_SETTINGS.circleDiameterPx);
                setCircleRotateDeg(DEFAULT_SETTINGS.circleRotateDeg);
                setCircleOffsetX(DEFAULT_SETTINGS.circleOffsetX);
                setCircleOffsetY(DEFAULT_SETTINGS.circleOffsetY);
                setCircleSelected(false);
                setShowRectangle(DEFAULT_SETTINGS.showRectangle);
                setRectangleWidth(DEFAULT_SETTINGS.rectangleWidth);
                setRectangleHeightPx(DEFAULT_SETTINGS.rectangleHeightPx);
                setRectangleRotateDeg(DEFAULT_SETTINGS.rectangleRotateDeg);
                setRectangleOffsetX(DEFAULT_SETTINGS.rectangleOffsetX);
                setRectangleOffsetY(DEFAULT_SETTINGS.rectangleOffsetY);
                setRectangleSelected(false);
                setShowBox3d(DEFAULT_SETTINGS.showBox3d);
                setBox3dWidth(DEFAULT_SETTINGS.box3dWidth);
                setBox3dHeightPx(DEFAULT_SETTINGS.box3dHeightPx);
                setBox3dDepthPx(DEFAULT_SETTINGS.box3dDepthPx);
                setBox3dRotateDeg(DEFAULT_SETTINGS.box3dRotateDeg);
                setBox3dYawDeg(DEFAULT_SETTINGS.box3dYawDeg);
                setBox3dPitchDeg(DEFAULT_SETTINGS.box3dPitchDeg);
                setBox3dOffsetX(DEFAULT_SETTINGS.box3dOffsetX);
                setBox3dOffsetY(DEFAULT_SETTINGS.box3dOffsetY);
                setBox3dSelected(false);
              }}
              style={{ marginTop: 8, padding: "8px 12px", fontSize: 12, borderRadius: 6, border: "1px solid rgba(255,255,255,0.2)", background: "rgba(255,255,255,0.08)", color: "white", cursor: "pointer" }}
            >
              Reset all
            </button>
          </div>
        );
      default:
        return null;
    }
  }

  function isExpanded(sectionId: SidebarSectionId): boolean {
    switch (sectionId) {
      case "imageInfo": return imageInfoExpanded;
      case "grid": return gridExpanded;
      case "centerFrame": return centerFrameExpanded;
      case "oval": return ovalExpanded;
      case "circle": return circleExpanded;
      case "pose": return true;
      case "rectangle": return rectangleExpanded;
      case "box3d": return box3dExpanded;
      case "adjustImage": return adjustImageExpanded;
      default: return true;
    }
  }

  function setExpanded(sectionId: SidebarSectionId, next: boolean) {
    switch (sectionId) {
      case "imageInfo": setImageInfoExpanded(next); break;
      case "grid": setGridExpanded(next); break;
      case "centerFrame": setCenterFrameExpanded(next); break;
      case "oval": setOvalExpanded(next); break;
      case "circle": setCircleExpanded(next); break;
      case "pose": break;
      case "rectangle": setRectangleExpanded(next); break;
      case "box3d": setBox3dExpanded(next); break;
      case "adjustImage": setAdjustImageExpanded(next); break;
    }
  }

  function renderSidebarColumn(column: SidebarColumn, order: SidebarSectionId[]): React.ReactNode {
    return (
      <div
        style={{ display: "flex", flexDirection: "column" }}
        onDragOver={(e) => {
          e.preventDefault();
          e.dataTransfer.dropEffect = "move";
        }}
        onDrop={(e) => {
          if (order.length > 0) return;
          e.preventDefault();
          const id = e.dataTransfer.getData(SIDEBAR_DND_SECTION);
          const fromCol = e.dataTransfer.getData(SIDEBAR_DND_COLUMN);
          commitSidebarDrop(id, fromCol, null, column);
        }}
      >
        {order.length === 0 ? (
          <div style={{ minHeight: 48, border: "1px dashed rgba(255,255,255,0.25)", borderRadius: 8, display: "flex", alignItems: "center", justifyContent: "center", opacity: 0.6, fontSize: 12 }}>
            Drop section here
          </div>
        ) : null}
        {order.map((sectionId, index) => {
          const expanded = isExpanded(sectionId);
          const body = renderSectionContent(sectionId);
          return (
            <div
              key={sectionId}
              style={index === 0 ? undefined : { marginTop: 16, paddingTop: 16, borderTop: "1px solid rgba(255,255,255,0.1)" }}
              onDragOver={(e) => {
                e.preventDefault();
                e.dataTransfer.dropEffect = "move";
              }}
              onDrop={(e) => {
                e.preventDefault();
                const id = e.dataTransfer.getData(SIDEBAR_DND_SECTION);
                const fromCol = e.dataTransfer.getData(SIDEBAR_DND_COLUMN);
                commitSidebarDrop(id, fromCol, sectionId, column);
              }}
            >
              <div style={{ display: "flex", alignItems: "flex-start", gap: 6 }}>
                <div
                  draggable
                  onDragStart={(e) => {
                    e.dataTransfer.setData(SIDEBAR_DND_SECTION, sectionId);
                    e.dataTransfer.setData(SIDEBAR_DND_COLUMN, column);
                    e.dataTransfer.effectAllowed = "move";
                  }}
                  aria-label={`Drag to reorder ${SIDEBAR_SECTION_LABEL[sectionId]}`}
                  title="Drag to reorder"
                  style={{ cursor: "grab", opacity: 0.45, fontSize: 15, lineHeight: 1.2, padding: "6px 6px 0 0", userSelect: "none", flexShrink: 0 }}
                >
                  ≡
                </div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <button
                    type="button"
                    onClick={() => setExpanded(sectionId, !expanded)}
                    style={{ display: "flex", alignItems: "center", justifyContent: "space-between", width: "100%", padding: "6px 0", marginBottom: expanded ? 8 : 0, border: "none", background: "transparent", color: "white", font: "inherit", fontWeight: 600, opacity: 0.95, cursor: "pointer", textAlign: "left" }}
                  >
                    <span>{SIDEBAR_SECTION_LABEL[sectionId]}</span>
                    <span aria-hidden style={{ opacity: 0.7, fontSize: 11, marginLeft: 8 }}>{expanded ? "▼" : "▶"}</span>
                  </button>
                  {expanded ? body : null}
                </div>
              </div>
            </div>
          );
        })}
      </div>
    );
  }

  const canRun = files.length > 0;

  return (
    <div
      ref={containerRef}
      style={{
        minHeight: "100vh",
        height: currentUrl ? "100vh" : "auto",
        width: "100%",
        background: "#0b1220",
        color: "white",
        position: "relative",
        overflow: currentUrl ? "hidden" : "visible",
      }}
    >
      {!currentUrl ? (
        // Landing page
        <div style={{
          maxWidth: 600,
          margin: "0 auto",
          height: "100vh",
          display: "flex",
          flexDirection: "column",
          justifyContent: "center",
          alignItems: "center",
          padding: 40,
          textAlign: "center",
        }}>
          <style>{`
            @keyframes landingFadeIn {
              from { opacity: 0; }
              to { opacity: 1; }
            }
            @keyframes landingSlideDown {
              from { opacity: 0; transform: translateY(-20px); }
              to { opacity: 1; transform: translateY(0); }
            }
          `}</style>
          <h1
            onClick={goToLanding}
            style={{
              margin: "0 0 12px",
              fontSize: 32,
              fontWeight: 500,
              opacity: 0.95,
              animation: "landingSlideDown 0.55s ease-out 0s both",
              cursor: "pointer",
              display: "flex",
              alignItems: "center",
              gap: 12,
            }}
          >
            <img src="/logo.png" alt="" style={{ height: 32, width: "auto", display: "block", filter: "brightness(0) invert(1)" }} />
            Gesture Slideshow <span style={{ fontSize: 18, opacity: 0.7, fontWeight: 400 }}>β {APP_VERSION}</span>
          </h1>
          <p style={{
            margin: "0 0 32px",
            fontSize: 16,
            opacity: 0.7,
            lineHeight: 1.5,
            animation: "landingFadeIn 0.5s ease-out 0.08s both",
          }}>
            Pick a folder → images shuffle → press play to auto-advance
          </p>

          {!supported && (
            <div
              style={{
                padding: "10px 14px",
                borderRadius: 8,
                background: "rgba(255,255,255,0.05)",
                marginBottom: 24,
                fontSize: 14,
                opacity: 0.8,
                animation: "landingFadeIn 0.5s ease-out 0.12s both",
              }}
            >
              Your browser doesn't support folder picking. Use Chrome/Edge on desktop.
            </div>
          )}

          <div style={{
            display: "flex",
            gap: 12,
            flexWrap: "wrap",
            justifyContent: "center",
            alignItems: "center",
            animation: "landingFadeIn 0.5s ease-out 0.16s both",
          }}>
            <button
              onClick={openLastFolder}
              disabled={!supported || !lastFolderName}
              style={{
                ...btn(!supported || !lastFolderName),
                padding: "14px 28px",
                fontSize: 16,
                fontWeight: 600,
              }}
            >
              Open Last
            </button>
            <button
              onClick={pickFolder}
              disabled={!supported}
              style={{
                ...btn(!supported),
                padding: "14px 28px",
                fontSize: 16,
                fontWeight: 600,
              }}
            >
              Pick Folder
            </button>
          </div>
          {lastFolderName ? (
            <p style={{
              marginTop: 10,
              fontSize: 13,
              opacity: 0.65,
              maxWidth: 400,
              wordBreak: "break-all",
              animation: "landingFadeIn 0.5s ease-out 0.2s both",
            }}>
              Last: {lastFolderName}
              {lastFolderOpenedAt != null ? (
                <span style={{ opacity: 0.85 }}>
                  {" — "}
                  {new Date(lastFolderOpenedAt).toLocaleString(undefined, {
                    dateStyle: "medium",
                    timeStyle: "short",
                  })}
                </span>
              ) : null}
            </p>
          ) : null}

          <div
            style={{
              marginTop: 40,
              maxHeight: 220,
              overflow: "auto",
              textAlign: "left",
              width: "100%",
              maxWidth: 480,
              padding: "12px 16px",
              borderRadius: 8,
              background: "rgba(255,255,255,0.04)",
              border: "1px solid rgba(255,255,255,0.08)",
              animation: "landingFadeIn 0.5s ease-out 0.28s both",
            }}
          >
            <div style={{ fontSize: 11, opacity: 0.6, marginBottom: 8, textTransform: "uppercase", letterSpacing: "0.06em" }}>
              Version history
            </div>
            {VERSION_HISTORY.map(({ version, date, changes }) => (
              <div key={version} style={{ marginBottom: 12 }}>
                <div style={{ fontSize: 13, fontWeight: 600, opacity: 0.9 }}>
                  β {version} <span style={{ fontWeight: 400, opacity: 0.6 }}>· {date}</span>
                </div>
                <ul style={{ margin: "4px 0 0", paddingLeft: 18, fontSize: 12, opacity: 0.75, lineHeight: 1.45 }}>
                  {changes.map((c, i) => (
                    <li key={i}>{c}</li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        </div>
      ) : (
        // Image view with controls (this wrapper goes fullscreen so header stays visible)
        <div
          ref={fullscreenContainerRef}
          style={{
            maxWidth: currentUrl ? "100%" : 1200,
            width: currentUrl ? "100%" : "auto",
            margin: currentUrl ? 0 : "0 auto",
            height: currentUrl ? "100vh" : "auto",
            minHeight: currentUrl ? "100vh" : "auto",
            display: "flex",
            flexDirection: "column",
            padding: currentUrl ? 0 : 20,
            position: "relative",
            background: "#0b1220",
          }}
        >
          <div
            style={{
              padding: currentUrl ? "20px 20px 0" : "0 0 20px",
              display: "flex",
              alignItems: "baseline",
              gap: 12,
              opacity: showOverlays ? 1 : 0,
              pointerEvents: showOverlays ? "auto" : "none",
              transition: "opacity 0.3s ease",
              position: currentUrl ? "absolute" : "relative",
              top: 0,
              left: 0,
              right: 0,
              zIndex: 10,
            }}
          >
            <h1
              onClick={goToLanding}
              style={{
                margin: 0,
                fontSize: 18,
                fontWeight: 500,
                opacity: 0.9,
                cursor: "pointer",
                display: "flex",
                alignItems: "center",
                gap: 8,
              }}
            >
              <img src="/logo.png" alt="" style={{ height: 18, width: "auto", display: "block", filter: "brightness(0) invert(1)" }} />
              Gesture Slideshow <span style={{ fontSize: 14, opacity: 0.6, fontWeight: 400 }}>β {APP_VERSION}</span>
            </h1>
          </div>

          <div
            style={{
              display: "flex",
              gap: 8,
              flexWrap: "wrap",
              alignItems: "center",
              justifyContent: currentUrl ? "flex-end" : "flex-start",
              marginBottom: currentUrl ? 0 : 20,
              padding: currentUrl ? "20px 20px 0 0" : 0,
              opacity: showOverlays ? 1 : 0,
              pointerEvents: showOverlays ? "auto" : "none",
              transition: "opacity 0.3s ease",
              position: currentUrl ? "absolute" : "relative",
              top: currentUrl ? 0 : "auto",
              right: currentUrl ? 0 : "auto",
              left: currentUrl ? "auto" : "auto",
              bottom: currentUrl ? "auto" : "auto",
              zIndex: 10,
            }}
          >
            <button onClick={pickFolder} disabled={!supported} style={btn(!supported)}>
              {dirHandle ? "Change Folder" : "Pick Folder"}
            </button>

            <button onClick={prev} disabled={!canRun} style={btn(!canRun)}>
              ←
            </button>
            <button onClick={next} disabled={!canRun} style={btn(!canRun)}>
              →
            </button>

            <button onClick={reshuffle} disabled={!canRun} style={btn(!canRun)}>
              ↻
            </button>

            <button onClick={toggleFullscreen} disabled={!canRun} style={btn(!canRun)}>
              ⛶
            </button>

            <button onClick={deleteCurrentImage} disabled={!canRun} style={btn(!canRun)}>
              Delete
            </button>


            <div style={{ marginLeft: "auto", opacity: 0.7, fontSize: 13 }}>
              {files.length ? (
                <>
                  {idxInOrder + 1}/{order.length}
                </>
              ) : null}
            </div>
          </div>

          <div
            ref={imageContainerRef}
            style={{
              borderRadius: isFullscreen ? 0 : 12,
              overflow: "hidden",
              border: isFullscreen ? "none" : "none",
              background: isFullscreen ? "#0b1220" : "#0b1220",
              minHeight: isFullscreen ? "100vh" : "100vh",
              width: isFullscreen ? "100vw" : "100vw",
              height: isFullscreen ? "100vh" : "100vh",
              flex: 1,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              position: "relative",
            }}
          >
            {currentFile && (
              <div
                style={{
                  position: "absolute",
                  left: 0,
                  top: 52,
                  bottom: 0,
                  width: 280,
                  padding: "20px 16px",
                  background: "transparent",
                  zIndex: 5,
                  overflow: "auto",
                  fontSize: 13,
                  lineHeight: 1.5,
                  opacity: showOverlays ? 1 : 0,
                  pointerEvents: showOverlays ? "auto" : "none",
                  transition: "opacity 0.3s ease",
                }}
              >
                {renderSidebarColumn("left", leftPanelSectionOrder)}
              </div>
            )}
            {currentFile && (
              <div
                style={{
                  position: "absolute",
                  right: 0,
                  top: 52,
                  bottom: 0,
                  width: 280,
                  padding: "20px 16px",
                  background: "transparent",
                  zIndex: 5,
                  overflow: "auto",
                  fontSize: 13,
                  lineHeight: 1.5,
                  display: "flex",
                  flexDirection: "column",
                  gap: 16,
                  opacity: showOverlays ? 1 : 0,
                  pointerEvents: showOverlays ? "auto" : "none",
                  transition: "opacity 0.3s ease",
                }}
              >
                {renderSidebarColumn("right", rightPanelSectionOrder)}
              </div>
            )}
            <div
              ref={slideshowStageRef}
              style={{
                flex: 1,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                minWidth: 0,
                minHeight: 0,
                overflow: "hidden",
                touchAction: "none",
              }}
            >
              <div
                ref={zoomContainerRef}
                style={{
                  height: "100%",
                  width: "100%",
                  maxHeight: "100%",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  transform: imageComposeTransform,
                  transformOrigin: "center center",
                  cursor: isPanning
                    ? "grabbing"
                    : deckCursorMode === "rotate"
                      ? OVAL_ROTATE_CURSOR
                      : "grab",
                  userSelect: "none",
                  touchAction: "none",
                }}
                onMouseDown={(e) => {
                  if (e.button !== 0) return;
                  if (
                    (showOval && ovalSelectedRef.current) ||
                    (showCircle && circleSelectedRef.current) ||
                    (showRectangle && rectangleSelectedRef.current) ||
                    (showBox3d && box3dSelectedRef.current)
                  )
                    return;
                  setIsPanning(true);
                  panStartRef.current = {
                    startX: e.clientX,
                    startY: e.clientY,
                    startPanX: panX,
                    startPanY: panY,
                  };
                }}
              >
                <div style={{ position: "relative", display: "inline-block" }}>
                  <img
                    ref={currentImgRef}
                    src={currentUrl}
                    alt={currentFile?.name || "gesture"}
                    draggable={false}
                    onLoad={(e) => {
                      const img = e.currentTarget;
                      setImageMeta((prev) => ({
                        ...prev,
                        width: img.naturalWidth,
                        height: img.naturalHeight,
                      }));
                      setPoseNonce((n) => n + 1);
                    }}
                    style={{
                      height: "100vh",
                      width: "auto",
                      maxWidth: "none",
                      objectFit: "contain",
                      objectPosition: "center",
                      display: "block",
                      background: "black",
                      filter: `brightness(${imageBrightness}) contrast(${imageContrast}) grayscale(${imageGrayscale}) saturate(${imageSaturation}) blur(${imageBlur}px)`,
                    }}
                  />
                  {showPose ? (
                    <canvas
                      ref={poseCanvasRef}
                      aria-hidden
                      style={{
                        position: "absolute",
                        left: 0,
                        top: 0,
                        width: "100%",
                        height: "100%",
                        pointerEvents: "none",
                        zIndex: 1,
                      }}
                    />
                  ) : null}
                </div>
              </div>
            </div>
            {currentUrl && showGrid && (
              <div
                aria-hidden
                style={{
                  position: "absolute",
                  inset: 0,
                  pointerEvents: "none",
                  zIndex: 2,
                  backgroundImage: `
                    linear-gradient(to right, rgba(255,255,255,0.48) 2px, transparent 2px),
                    linear-gradient(to bottom, rgba(255,255,255,0.48) 2px, transparent 2px)
                  `,
                  backgroundSize: `${gridCellSize}px ${gridCellSize}px`,
                  backgroundPosition: "center center",
                }}
              />
            )}
            {currentUrl && showCenterFrame && (
              <div
                aria-hidden
                style={{
                  position: "absolute",
                  inset: 0,
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  pointerEvents: "none",
                  zIndex: 3,
                }}
              >
                <svg
                  width={centerFrameSize}
                  height={centerFrameSize}
                  viewBox={`0 0 ${centerFrameSize} ${centerFrameSize}`}
                  style={{ flexShrink: 0 }}
                >
                  <rect
                    x={3}
                    y={3}
                    width={Math.max(4, centerFrameSize - 6)}
                    height={Math.max(4, centerFrameSize - 6)}
                    fill="none"
                    stroke="#ffffff"
                    strokeWidth={6}
                  />
                  <text
                    x={11}
                    y={9}
                    fill="#ffffff"
                    fontSize={lettraDisplayPx}
                    fontFamily="system-ui, -apple-system, sans-serif"
                    fontWeight={600}
                    dominantBaseline="hanging"
                  >
                    a
                  </text>
                  {/* 25×25 px crosshair at center */}
                  <line
                    x1={centerFrameSize / 2 - 12.5}
                    y1={centerFrameSize / 2}
                    x2={centerFrameSize / 2 + 12.5}
                    y2={centerFrameSize / 2}
                    stroke="#ffffff"
                    strokeWidth={2}
                    strokeLinecap="square"
                  />
                  <line
                    x1={centerFrameSize / 2}
                    y1={centerFrameSize / 2 - 12.5}
                    x2={centerFrameSize / 2}
                    y2={centerFrameSize / 2 + 12.5}
                    stroke="#ffffff"
                    strokeWidth={2}
                    strokeLinecap="square"
                  />
                </svg>
              </div>
            )}
            {currentUrl && showOval && (
              <div
                style={{
                  position: "absolute",
                  inset: 0,
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  pointerEvents: "none",
                  zIndex: 4,
                  transform: imageComposeTransform,
                  transformOrigin: "center center",
                }}
              >
                <div
                  ref={ovalHitAreaRef}
                  style={{
                    transform: `translate(${ovalOffsetX}px, ${ovalOffsetY}px)`,
                    flexShrink: 0,
                    pointerEvents: "auto",
                    touchAction: "none",
                  }}
                >
                  <div
                    style={{
                      transform: `rotate(${ovalRotateDeg}deg)`,
                      transformOrigin: "center center",
                    }}
                  >
                    <svg
                      ref={ovalSvgRef}
                      width={ovalWidth}
                      height={ovalHeightPx}
                      viewBox={`0 0 ${ovalWidth} ${ovalHeightPx}`}
                      style={{ display: "block", cursor: "grab" }}
                      role="img"
                      aria-label="Ribcage: drag inside to move; when selected, drag on the image outside the Ribcage to rotate or click without dragging to deselect; Alt+drag on Ribcage to rotate; Shift+drag or wheel to resize width; drag corner squares to resize"
                      aria-selected={ovalSelected}
                      onPointerDown={handleOvalPointerDown}
                      onPointerMove={handleOvalSvgPointerMove}
                      onPointerEnter={handleOvalSvgPointerEnter}
                      onPointerLeave={handleOvalSvgPointerLeave}
                    >
                      <ellipse
                        cx={ovalCx}
                        cy={ovalCy}
                        rx={ovalErx}
                        ry={ovalEry}
                        fill="rgba(0,0,0,0.001)"
                        stroke={ovalStrokeColor}
                        strokeWidth={5}
                        style={{ cursor: "inherit" }}
                      />
                      {ovalSelected ? (
                        <>
                          <rect
                            x={ovalBoxLeft}
                            y={ovalBoxTop}
                            width={ovalBoxW}
                            height={ovalBoxH}
                            fill="none"
                            stroke="#000000"
                            strokeWidth={1.25}
                            vectorEffect="non-scaling-stroke"
                            pointerEvents="none"
                          />
                          <line
                            x1={ovalCx - ovalCrosshairHalf}
                            y1={ovalCy}
                            x2={ovalCx + ovalCrosshairHalf}
                            y2={ovalCy}
                            stroke={ovalStrokeColor}
                            strokeWidth={2}
                            strokeLinecap="square"
                            pointerEvents="none"
                          />
                          <line
                            x1={ovalCx}
                            y1={ovalCy - ovalCrosshairHalf}
                            x2={ovalCx}
                            y2={ovalCy + ovalCrosshairHalf}
                            stroke={ovalStrokeColor}
                            strokeWidth={2}
                            strokeLinecap="square"
                            pointerEvents="none"
                          />
                          {(
                            [
                              [ovalBoxLeft, ovalBoxTop],
                              [ovalBoxLeft + ovalBoxW, ovalBoxTop],
                              [ovalBoxLeft + ovalBoxW, ovalBoxTop + ovalBoxH],
                              [ovalBoxLeft, ovalBoxTop + ovalBoxH],
                            ] as const
                          ).map(([bx, by], i) => (
                            <rect
                              key={i}
                              x={bx - ovalBoundingCornerHalf}
                              y={by - ovalBoundingCornerHalf}
                              width={ovalBoundingCornerSize}
                              height={ovalBoundingCornerSize}
                              fill="#ffffff"
                              stroke="#000000"
                              strokeWidth={0.5}
                              vectorEffect="non-scaling-stroke"
                              style={{ cursor: "inherit" }}
                            />
                          ))}
                        </>
                      ) : null}
                    </svg>
                  </div>
                </div>
              </div>
            )}
            {currentUrl && showCircle && (
              <div
                style={{
                  position: "absolute",
                  inset: 0,
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  pointerEvents: "none",
                  zIndex: 5,
                  transform: imageComposeTransform,
                  transformOrigin: "center center",
                }}
              >
                <div
                  ref={circleHitAreaRef}
                  style={{
                    transform: `translate(${circleOffsetX}px, ${circleOffsetY}px)`,
                    flexShrink: 0,
                    pointerEvents: "auto",
                    touchAction: "none",
                  }}
                >
                  <div
                    style={{
                      transform: `rotate(${circleRotateDeg}deg)`,
                      transformOrigin: "center center",
                    }}
                  >
                    <svg
                      ref={circleSvgRef}
                        width={circleSvgSize}
                        height={circleSvgSize}
                        viewBox={`0 0 ${circleSvgSize} ${circleSvgSize}`}
                      style={{ display: "block", cursor: "grab" }}
                      role="img"
                      aria-label="Head: drag inside to move; when selected, drag on the image outside to rotate or click without dragging to deselect; Alt+drag on the head rotates; Shift+drag or wheel resizes from center; drag corner squares to resize"
                      aria-selected={circleSelected}
                      onPointerDown={handleCirclePointerDown}
                      onPointerMove={handleCircleSvgPointerMove}
                      onPointerEnter={handleCircleSvgPointerEnter}
                      onPointerLeave={handleCircleSvgPointerLeave}
                    >
                      <circle
                        cx={circleCx}
                        cy={circleCy}
                        r={circleRGeom}
                        fill="rgba(0,0,0,0.001)"
                        stroke={circleStrokeColor}
                        strokeWidth={5}
                        style={{ cursor: "inherit" }}
                      />
                      <line
                        x1={circleCx - circleCrosshairHalf}
                        y1={circleCy}
                        x2={circleCx + circleCrosshairHalf}
                        y2={circleCy}
                        stroke={circleStrokeColor}
                        strokeWidth={2}
                        strokeLinecap="square"
                        pointerEvents="none"
                      />
                      <line
                        x1={circleCx}
                        y1={circleCy - circleCrosshairHalf}
                        x2={circleCx}
                        y2={circleCy + circleCrosshairHalf}
                        stroke={circleStrokeColor}
                        strokeWidth={2}
                        strokeLinecap="square"
                        pointerEvents="none"
                      />
                      {circleSelected ? (
                        <>
                          <rect
                            x={circleBoxLeft}
                            y={circleBoxTop}
                            width={circleBoxW}
                            height={circleBoxH}
                            fill="none"
                            stroke="#000000"
                            strokeWidth={1.25}
                            vectorEffect="non-scaling-stroke"
                            pointerEvents="none"
                          />
                          {(
                            [
                              [circleBoxLeft, circleBoxTop],
                              [circleBoxLeft + circleBoxW, circleBoxTop],
                              [circleBoxLeft + circleBoxW, circleBoxTop + circleBoxH],
                              [circleBoxLeft, circleBoxTop + circleBoxH],
                            ] as const
                          ).map(([bx, by], i) => (
                            <rect
                              key={i}
                              x={bx - circleBoundingCornerHalf}
                              y={by - circleBoundingCornerHalf}
                              width={circleBoundingCornerSize}
                              height={circleBoundingCornerSize}
                              fill="#ffffff"
                              stroke="#000000"
                              strokeWidth={0.5}
                              vectorEffect="non-scaling-stroke"
                              style={{ cursor: "inherit" }}
                            />
                          ))}
                        </>
                      ) : null}
                    </svg>
                  </div>
                </div>
              </div>
            )}
            {currentUrl && showRectangle && (
              <div
                style={{
                  position: "absolute",
                  inset: 0,
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  pointerEvents: "none",
                  zIndex: 6,
                  transform: imageComposeTransform,
                  transformOrigin: "center center",
                }}
              >
                <div
                  ref={rectangleHitAreaRef}
                  style={{
                    transform: `translate(${rectangleOffsetX}px, ${rectangleOffsetY}px)`,
                    flexShrink: 0,
                    pointerEvents: "auto",
                    touchAction: "none",
                  }}
                >
                  <div
                    style={{
                      transform: `rotate(${rectangleRotateDeg}deg)`,
                      transformOrigin: "center center",
                    }}
                  >
                    <svg
                      ref={rectangleSvgRef}
                      width={rectangleWidth}
                      height={rectangleHeightPx}
                      viewBox={`0 0 ${rectangleWidth} ${rectangleHeightPx}`}
                      style={{ display: "block", cursor: "grab" }}
                      role="img"
                      aria-label="Rectangle: drag inside to move; when selected, drag on the image outside the rectangle to rotate or click without dragging to deselect; Alt+drag on the rectangle to rotate; Shift+drag or wheel to resize width; drag corner squares or edges to resize"
                      aria-selected={rectangleSelected}
                      onPointerDown={handleRectanglePointerDown}
                      onPointerMove={handleRectangleSvgPointerMove}
                      onPointerEnter={handleRectangleSvgPointerEnter}
                      onPointerLeave={handleRectangleSvgPointerLeave}
                    >
                      <rect
                        x={rectangleBoxLeft}
                        y={rectangleBoxTop}
                        width={rectangleBoxW}
                        height={rectangleBoxH}
                        fill="rgba(0,0,0,0.001)"
                        stroke={rectangleStrokeColor}
                        strokeWidth={5}
                        style={{ cursor: "inherit" }}
                      />
                      {rectangleSelected ? (
                        <>
                          <rect
                            x={rectangleBoxLeft}
                            y={rectangleBoxTop}
                            width={rectangleBoxW}
                            height={rectangleBoxH}
                            fill="none"
                            stroke="#000000"
                            strokeWidth={1.25}
                            vectorEffect="non-scaling-stroke"
                            pointerEvents="none"
                          />
                          <line
                            x1={rectangleCx - rectangleCrosshairHalf}
                            y1={rectangleCy}
                            x2={rectangleCx + rectangleCrosshairHalf}
                            y2={rectangleCy}
                            stroke={rectangleStrokeColor}
                            strokeWidth={2}
                            strokeLinecap="square"
                            pointerEvents="none"
                          />
                          <line
                            x1={rectangleCx}
                            y1={rectangleCy - rectangleCrosshairHalf}
                            x2={rectangleCx}
                            y2={rectangleCy + rectangleCrosshairHalf}
                            stroke={rectangleStrokeColor}
                            strokeWidth={2}
                            strokeLinecap="square"
                            pointerEvents="none"
                          />
                          {(
                            [
                              [rectangleBoxLeft, rectangleBoxTop],
                              [rectangleBoxLeft + rectangleBoxW, rectangleBoxTop],
                              [rectangleBoxLeft + rectangleBoxW, rectangleBoxTop + rectangleBoxH],
                              [rectangleBoxLeft, rectangleBoxTop + rectangleBoxH],
                            ] as const
                          ).map(([bx, by], i) => (
                            <rect
                              key={i}
                              x={bx - rectangleBoundingCornerHalf}
                              y={by - rectangleBoundingCornerHalf}
                              width={rectangleBoundingCornerSize}
                              height={rectangleBoundingCornerSize}
                              fill="#ffffff"
                              stroke="#000000"
                              strokeWidth={0.5}
                              vectorEffect="non-scaling-stroke"
                              style={{ cursor: "inherit" }}
                            />
                          ))}
                        </>
                      ) : null}
                    </svg>
                  </div>
                </div>
              </div>
            )}
            {currentUrl && showBox3d && (
              <div
                style={{
                  position: "absolute",
                  inset: 0,
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  pointerEvents: "none",
                  zIndex: 7,
                  transform: imageComposeTransform,
                  transformOrigin: "center center",
                }}
              >
                <div
                  ref={box3dHitAreaRef}
                  style={{
                    transform: `translate(${box3dOffsetX}px, ${box3dOffsetY}px)`,
                    flexShrink: 0,
                    pointerEvents: "auto",
                    touchAction: "none",
                  }}
                >
                  <div
                    style={{
                      transform: `rotate(${box3dRotateDeg}deg)`,
                      transformOrigin: "center center",
                    }}
                  >
                  <svg
                    ref={box3dSvgRef}
                    width={box3dLayout.vbW}
                    height={box3dLayout.vbH}
                    viewBox={`0 0 ${box3dLayout.vbW} ${box3dLayout.vbH}`}
                    style={{ display: "block", cursor: "grab" }}
                    role="img"
                    aria-label="3D box: drag faces to orbit, or drag any wireframe edge for yaw and pitch along that edge; when selected, drag the crosshair to pan; Alt + drag rotates the box on the slide; Shift + Alt + drag to move; middle- or right-drag also orbit; Shift + drag scales; when selected, drag corners to resize the front face; when selected, drag outside the box on the image to rotate on the slide; wheel changes width"
                    aria-selected={box3dSelected}
                    onPointerDown={handleBox3dPointerDown}
                    onPointerMove={handleBox3dSvgPointerMove}
                    onPointerEnter={handleBox3dSvgPointerEnter}
                    onPointerLeave={handleBox3dSvgPointerLeave}
                    onContextMenu={(ev) => ev.preventDefault()}
                  >
                      {box3dLayout.facesSorted.map((f) => (
                        <polygon
                          key={f.key}
                          points={f.poly.map(([x, y]) => `${x},${y}`).join(" ")}
                          fill={BOX3D_FACE_FILL[f.key] ?? "rgba(255,255,255,0.06)"}
                          stroke="none"
                          style={{ cursor: "inherit" }}
                        />
                      ))}
                      {box3dLayout.wireframeEdges.map(([a, b], i) => {
                        const va = box3dLayout.verts2d[a]!;
                        const vb = box3dLayout.verts2d[b]!;
                        return (
                          <line
                            key={`e-${i}`}
                            x1={va[0]}
                            y1={va[1]}
                            x2={vb[0]}
                            y2={vb[1]}
                            stroke={
                              box3dActiveEdgeIndex === i
                                ? box3dActiveEdgeColor === "orange"
                                  ? "#f59e0b"
                                  : "#22c55e"
                                : box3dStrokeColor
                            }
                            strokeWidth={box3dSelected ? 2.2 : 1.4}
                            strokeLinecap="square"
                            pointerEvents="none"
                          />
                        );
                      })}
                      {box3dSelected ? (
                        <>
                          <polygon
                            points={box3dFrontInnerPoly.map(([x, y]) => `${x},${y}`).join(" ")}
                            fill="none"
                            stroke="#000000"
                            strokeWidth={1.25}
                            vectorEffect="non-scaling-stroke"
                            pointerEvents="none"
                          />
                          <line
                            x1={box3dFrontCx - box3dCrosshairHalf}
                            y1={box3dFrontCy}
                            x2={box3dFrontCx + box3dCrosshairHalf}
                            y2={box3dFrontCy}
                            stroke={box3dStrokeColor}
                            strokeWidth={2}
                            strokeLinecap="square"
                            pointerEvents="none"
                          />
                          <line
                            x1={box3dFrontCx}
                            y1={box3dFrontCy - box3dCrosshairHalf}
                            x2={box3dFrontCx}
                            y2={box3dFrontCy + box3dCrosshairHalf}
                            stroke={box3dStrokeColor}
                            strokeWidth={2}
                            strokeLinecap="square"
                            pointerEvents="none"
                          />
                          {box3dLayout.frontFacePoly.map(([bx, by], i) => (
                            <rect
                              key={i}
                              x={bx - box3dBoundingCornerHalf}
                              y={by - box3dBoundingCornerHalf}
                              width={box3dBoundingCornerSize}
                              height={box3dBoundingCornerSize}
                              fill="#ffffff"
                              stroke="#000000"
                              strokeWidth={0.5}
                              vectorEffect="non-scaling-stroke"
                              style={{ cursor: "inherit" }}
                            />
                          ))}
                        </>
                      ) : null}
                    </svg>
                  </div>
                </div>
              </div>
            )}
            {currentUrl && (
              <div
                style={{
                  position: "absolute",
                  bottom: 20,
                  left: 0,
                  right: 0,
                  width: "100%",
                  padding: "0 20px",
                  boxSizing: "border-box",
                  zIndex: 10,
                }}
              >
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "space-between",
                    gap: 12,
                    flexWrap: "wrap",
                    marginBottom: 10,
                  }}
                >
                  <div style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center" }}>
                    <select
                      value={timerMode}
                      onChange={(e) => setTimerMode(parseTimerMode(e.target.value))}
                      aria-label="Timer mode"
                      title={CLASSIC_MODE_TOOLTIP}
                      style={{
                        ...btn(false),
                        padding: "4px 10px",
                        fontSize: 12,
                        appearance: "auto",
                        WebkitAppearance: "menulist",
                        minHeight: 28,
                      }}
                    >
                      <option value="classic">Classic</option>
                      <option value="loop">Loop</option>
                    </select>
                    {(timerMode === "classic"
                      ? classicIntervalButtonLabels(classicSlots)
                      : LOOP_INTERVAL_PRESETS.map(([sec, label]) => ({ sec, label }))
                    ).map(({ sec, label }) => {
                      const selected = intervalSec === sec;
                      const classicDepleted =
                        timerMode === "classic" &&
                        isClassicTierSec(sec) &&
                        classicSlots[sec] <= 0;
                      return (
                        <button
                          key={sec}
                          type="button"
                          disabled={classicDepleted}
                          onClick={() => {
                            if (timerMode === "classic") {
                              if (!isClassicTierSec(sec) || classicSlots[sec] <= 0) return;
                            }
                            setIntervalSec(sec);
                          }}
                          style={{
                            ...btn(classicDepleted),
                            padding: "4px 10px",
                            fontSize: 12,
                            opacity: classicDepleted ? 0.35 : selected ? 1 : 0.8,
                            borderColor: selected ? "rgba(255,255,255,0.4)" : "rgba(255,255,255,0.12)",
                          }}
                        >
                          {label}
                        </button>
                      );
                    })}
                    {timerMode === "classic" && (
                      <button
                        type="button"
                        aria-label="Reset classic mode slot counts"
                        onClick={() => {
                          setClassicSlots({ ...CLASSIC_SLOTS_INITIAL });
                          setIntervalSec(CLASSIC_FIRST_TIER);
                        }}
                        style={{
                          ...btn(false),
                          padding: "4px 10px",
                          fontSize: 12,
                          opacity: 0.9,
                          borderColor: "rgba(255,255,255,0.2)",
                        }}
                        title="Restore all classic tiers to their starting slot counts"
                      >
                        Reset
                      </button>
                    )}
                  </div>
                  <div
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 8,
                      whiteSpace: "nowrap",
                    }}
                  >
                    <button
                      type="button"
                      onClick={() => {
                        if (!isRunning && timerMode === "classic" && classicSlotsExhausted(classicSlots)) {
                          setClassicSlots({ ...CLASSIC_SLOTS_INITIAL });
                          setIntervalSec(CLASSIC_FIRST_TIER);
                        }
                        setIsRunning((r) => !r);
                      }}
                      disabled={!canRun}
                      style={{
                        ...btn(!canRun),
                        padding: "4px 8px",
                        fontSize: 12,
                        minWidth: 28,
                      }}
                      title={isRunning ? "Pause" : "Start"}
                    >
                      {isRunning ? "⏸" : "▶"}
                    </button>
                    <button
                      type="button"
                      onClick={() => setElapsedSec(0)}
                      disabled={!canRun}
                      style={{
                        ...btn(!canRun),
                        padding: "4px 8px",
                        fontSize: 12,
                        minWidth: 28,
                        opacity: 0.85,
                      }}
                      title="Reset total elapsed"
                    >
                      ↺
                    </button>
                    <span style={{ fontSize: 13, opacity: 0.85 }}>
                      Total elapsed {formatElapsed(elapsedSec)}
                    </span>
                  </div>
                </div>
                <div
                  style={{
                    height: 8,
                    borderRadius: 4,
                    background: "rgba(255,255,255,0.15)",
                    overflow: "hidden",
                  }}
                >
                  <div
                    style={{
                      height: "100%",
                      width:
                        isRunning && order.length
                          ? `${(timeRemaining / Math.max(1, effectiveIntervalSec)) * 100}%`
                          : "100%",
                      background: "rgba(255,255,255,0.6)",
                      borderRadius: 4,
                      transition: "width 1s linear",
                    }}
                  />
                </div>
                <div
                  style={{
                    marginTop: 6,
                    fontSize: 13,
                    opacity: 0.85,
                    textAlign: "center",
                  }}
                >
                  {isRunning && order.length
                    ? `${timeRemaining}s left · ${effectiveIntervalSec}s interval${
                        timerMode === "classic" && !classicSlotsExhausted(classicSlots)
                          ? ` · classic ${Math.min(classicCompletedCount(classicSlots) + 1, CLASSIC_STEP_TOTAL)}/${CLASSIC_STEP_TOTAL}`
                          : ""
                      }`
                    : timerMode === "classic" && classicSlotsExhausted(classicSlots)
                      ? "Classic session complete"
                      : "Paused"}
                </div>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function btn(disabled = false): React.CSSProperties {
  return {
    padding: "6px 12px",
    borderRadius: 6,
    border: "1px solid rgba(255,255,255,0.12)",
    background: disabled ? "rgba(255,255,255,0.04)" : "rgba(255,255,255,0.08)",
    color: "white",
    cursor: disabled ? "not-allowed" : "pointer",
    opacity: disabled ? 0.5 : 0.9,
    fontWeight: 500,
    fontSize: 13,
    transition: "opacity 0.2s",
  };
}
