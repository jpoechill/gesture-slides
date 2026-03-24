"use client"

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";

const APP_VERSION = "0.5.0";

const VERSION_HISTORY: { version: string; date: string; changes: string[] }[] = [
  {
    version: "0.5.0",
    date: "2026-03-24",
    changes: [
      "Oval: portrait defaults; width and height persisted; oval follows image pan, zoom, rotate, and flip",
      "Oval bounding box (thin black) with white corner squares; drag corners to resize; mid-edge cap handles removed",
      "Oval selection (yellow); short click on image outside oval deselects; drag there (past threshold) rotates; Alt+drag on oval rotates",
      "Rotate and resize cursors (compact rotate icon on image when applicable)",
      "Oval reset button; slideshow paused after folder pick until Play; image click no longer enters fullscreen",
      "Landing copy for press-to-advance; localStorage migration when only legacy oval width was stored",
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
  timerMode: "loop" as TimerMode,
};

function loadStoredSettings(): typeof DEFAULT_SETTINGS {
  if (typeof window === "undefined") return DEFAULT_SETTINGS;
  try {
    const raw = localStorage.getItem(SETTINGS_STORAGE_KEY);
    if (!raw) return DEFAULT_SETTINGS;
    const parsed = JSON.parse(raw) as Partial<typeof DEFAULT_SETTINGS>;
    const merged = { ...DEFAULT_SETTINGS, ...parsed };
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

/** Curved-arrow cursor for oval rotation (compact; hot spot center). */
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
  ovalRotateDeg: number
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
  const ovalHitAreaRef = useRef<HTMLDivElement | null>(null);
  const ovalSvgRef = useRef<SVGSVGElement | null>(null);
  const lastPointerOnOvalSvgRef = useRef<{ x: number; y: number } | null>(null);
  const pointerInsideOvalSvgRef = useRef(false);

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
  /** Selected after clicking the oval; yellow outline. Cleared by clicking outside the oval. */
  const [ovalSelected, setOvalSelected] = useState(false);
  const ovalSelectedRef = useRef(ovalSelected);
  ovalSelectedRef.current = ovalSelected;
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
        ovalRotateDeg
      );
    },
    [ovalWidth, ovalHeightPx, ovalRotateDeg]
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
        ovalRotateDeg
      );
    },
    [ovalWidth, ovalHeightPx, ovalRotateDeg]
  );

  const handleOvalSvgPointerLeave = useCallback(() => {
    pointerInsideOvalSvgRef.current = false;
    lastPointerOnOvalSvgRef.current = null;
    const svg = ovalSvgRef.current;
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
        ovalRotateDeg
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
    if (!currentUrl || !showOval) {
      setOvalSelected(false);
    }
  }, [currentUrl, showOval]);

  useEffect(() => {
    if (!currentUrl || !showOval) return;
    const ROTATE_DRAG_PX = 6;
    const onDocPointerDown = (ev: PointerEvent) => {
      const hit = ovalHitAreaRef.current;
      if (hit && ev.target instanceof Node && hit.contains(ev.target)) return;

      if (!ovalSelectedRef.current) return;

      const stage = slideshowStageRef.current;
      const t = ev.target;
      if (!(t instanceof Node) || !stage?.contains(t)) {
        ovalSelectedRef.current = false;
        setOvalSelected(false);
        return;
      }

      if (t instanceof Element) {
        if (t.closest("button, input, select, textarea, label, a, option")) {
          ovalSelectedRef.current = false;
          setOvalSelected(false);
          return;
        }
      }

      if (ev.button !== 0) return;

      ev.preventDefault();
      ev.stopPropagation();

      const svg = ovalSvgRef.current;
      if (!svg) {
        ovalSelectedRef.current = false;
        setOvalSelected(false);
        return;
      }

      const srect = svg.getBoundingClientRect();
      const scx = srect.left + srect.width / 2;
      const scy = srect.top + srect.height / 2;
      const θ0 = Math.atan2(ev.clientY - scy, ev.clientX - scx);
      const angleOffset = θ0 - (ovalRotateDegRef.current * Math.PI) / 180;
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
        setOvalRotateDeg(normalizeDeg(((θ - angleOffset) * 180) / Math.PI));
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
          ovalSelectedRef.current = false;
          setOvalSelected(false);
        }
      };
      document.addEventListener("pointermove", onMove);
      document.addEventListener("pointerup", onUp);
      document.addEventListener("pointercancel", onUp);
    };
    document.addEventListener("pointerdown", onDocPointerDown, true);
    return () => document.removeEventListener("pointerdown", onDocPointerDown, true);
  }, [currentUrl, showOval]);

  useEffect(() => {
    if (!showOval || !currentUrl) setDeckCursorMode("grab");
  }, [showOval, currentUrl]);

  useEffect(() => {
    if (!ovalSelected) setDeckCursorMode("grab");
  }, [ovalSelected]);

  useEffect(() => {
    const el = zoomContainerRef.current;
    if (!el) return;
    const onMove = (e: PointerEvent) => {
      if (!currentUrl || !showOval || !ovalSelectedRef.current) {
        setDeckCursorMode((m) => (m === "grab" ? m : "grab"));
        return;
      }
      const hit = ovalHitAreaRef.current;
      if (!hit) return;
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
  }, [currentUrl, showOval, ovalSelected]);

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
      const dir = ev.deltaY > 0 ? -1 : 1;
      const step = ev.shiftKey ? 16 : 8;
      setOvalWidth((w) => Math.min(560, Math.max(80, Math.round((w + dir * step) / 4) * 4)));
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [currentUrl, showOval, ovalWidth, ovalHeightPx, ovalRotateDeg]);

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
                <div style={{ fontWeight: 600, marginBottom: 12, opacity: 0.95 }}>
                  Image info
                </div>
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
                <div
                  style={{
                    marginTop: 16,
                    paddingTop: 16,
                    borderTop: "1px solid rgba(255,255,255,0.1)",
                    display: "flex",
                    flexDirection: "column",
                    gap: 12,
                  }}
                >
                  <div style={{ fontWeight: 600, opacity: 0.95, fontSize: 12 }}>Center frame & flip</div>
                  <div
                    style={{
                      display: "flex",
                      flexWrap: "wrap",
                      gap: "12px 20px",
                      alignItems: "center",
                    }}
                  >
                    <label
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: 8,
                        cursor: "pointer",
                        fontSize: 12,
                        opacity: 0.9,
                      }}
                    >
                      <input
                        type="checkbox"
                        checked={!showCenterFrame}
                        onChange={(e) => setShowCenterFrame(!e.target.checked)}
                      />
                      <span>Hide center frame</span>
                    </label>
                    <label
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: 8,
                        cursor: "pointer",
                        fontSize: 12,
                        opacity: 0.9,
                      }}
                    >
                      <input
                        type="checkbox"
                        checked={!showGrid}
                        onChange={(e) => setShowGrid(!e.target.checked)}
                      />
                      <span>Hide grid</span>
                    </label>
                    <label
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: 8,
                        cursor: "pointer",
                        fontSize: 12,
                        opacity: 0.9,
                      }}
                    >
                      <input
                        type="checkbox"
                        checked={!showOval}
                        onChange={(e) => setShowOval(!e.target.checked)}
                      />
                      <span>Hide oval</span>
                    </label>
                  </div>
                  <SliderRow
                    label="Grid cell size"
                    value={gridCellSize}
                    min={16}
                    max={200}
                    step={4}
                    format={(v) => `${Math.round(v)}px`}
                    onChange={setGridCellSize}
                  />
                  <SliderRow
                    label="Frame size"
                    value={centerFrameSize}
                    min={48}
                    max={480}
                    step={4}
                    format={(v) => `${Math.round(v)}px`}
                    onChange={setCenterFrameSize}
                  />
                  <SliderRow
                    label="Lettra Size"
                    value={centerFrameLabelSize}
                    min={8}
                    max={300}
                    step={1}
                    format={(v) => `${Math.round(v)}px`}
                    onChange={setCenterFrameLabelSize}
                  />
                  <SliderRow
                    label="Oval width"
                    value={ovalWidth}
                    min={80}
                    max={560}
                    step={4}
                    format={(v) => `${Math.round(v)}×${ovalHeightPx} px`}
                    onChange={setOvalWidth}
                  />
                  <SliderRow
                    label="Oval height"
                    value={ovalHeightPx}
                    min={48}
                    max={560}
                    step={4}
                    format={(v) => `${Math.round(v)}px`}
                    onChange={setOvalHeightPx}
                  />
                  <SliderRow
                    label="Oval rotation"
                    value={ovalRotateDeg}
                    min={-180}
                    max={180}
                    step={1}
                    format={(v) => `${Math.round(v)}°`}
                    onChange={setOvalRotateDeg}
                  />
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
                    style={{
                      alignSelf: "flex-start",
                      padding: "6px 10px",
                      fontSize: 12,
                      borderRadius: 6,
                      border: "1px solid rgba(255,255,255,0.2)",
                      background: "rgba(255,255,255,0.08)",
                      color: "white",
                      cursor: "pointer",
                    }}
                  >
                    Reset oval
                  </button>
                  <p style={{ margin: 0, fontSize: 11, opacity: 0.65, lineHeight: 1.4 }}>
                    Drag inside the oval to move it (turns yellow when selected). With the oval selected,
                    drag on the image outside the oval to rotate (cursor shows a curved arrow); a short click
                    there without dragging deselects. Alt+drag on the oval also rotates. Shift+drag or scroll
                    on the oval resizes width from the center. Drag the white corner squares to resize.
                  </p>
                  <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                    <span style={{ opacity: 0.85, fontSize: 12 }}>Flip</span>
                    <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
                      <label style={{ display: "flex", alignItems: "center", gap: 6, cursor: "pointer" }}>
                        <input
                          type="checkbox"
                          checked={imageFlipH}
                          onChange={(e) => setImageFlipH(e.target.checked)}
                        />
                        <span style={{ fontSize: 12 }}>Horizontal</span>
                      </label>
                      <label style={{ display: "flex", alignItems: "center", gap: 6, cursor: "pointer" }}>
                        <input
                          type="checkbox"
                          checked={imageFlipV}
                          onChange={(e) => setImageFlipV(e.target.checked)}
                        />
                        <span style={{ fontSize: 12 }}>Vertical</span>
                      </label>
                    </div>
                  </div>
                </div>
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
                <div style={{ fontWeight: 600, marginBottom: 4, opacity: 0.95 }}>
                  Adjust image
                </div>
                <SliderRow
                  label="Scale"
                  value={imageScale}
                  min={0.25}
                  max={3}
                  step={0.05}
                  format={(v) => `${Math.round(v * 100)}%`}
                  onChange={setImageScale}
                />
                <SliderRow
                  label="Brightness"
                  value={imageBrightness}
                  min={0}
                  max={2}
                  step={0.05}
                  format={(v) => `${Math.round(v * 100)}%`}
                  onChange={setImageBrightness}
                />
                <SliderRow
                  label="Contrast"
                  value={imageContrast}
                  min={0}
                  max={3}
                  step={0.05}
                  format={(v) => `${Math.round(v * 100)}%`}
                  onChange={setImageContrast}
                />
                <SliderRow
                  label="Rotate"
                  value={imageRotate}
                  min={0}
                  max={360}
                  step={1}
                  format={(v) => `${v}°`}
                  onChange={setImageRotate}
                />
                <SliderRow
                  label="Grayscale"
                  value={imageGrayscale}
                  min={0}
                  max={1}
                  step={0.01}
                  format={(v) => `${Math.round(v * 100)}%`}
                  onChange={setImageGrayscale}
                />
                <SliderRow
                  label="Saturation"
                  value={imageSaturation}
                  min={0}
                  max={2}
                  step={0.05}
                  format={(v) => `${Math.round(v * 100)}%`}
                  onChange={setImageSaturation}
                />
                <SliderRow
                  label="Blur"
                  value={imageBlur}
                  min={0}
                  max={10}
                  step={0.5}
                  format={(v) => (v === 0 ? "0" : `${v}px`)}
                  onChange={setImageBlur}
                />
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
                  }}
                  style={{
                    marginTop: 8,
                    padding: "8px 12px",
                    fontSize: 12,
                    borderRadius: 6,
                    border: "1px solid rgba(255,255,255,0.2)",
                    background: "rgba(255,255,255,0.08)",
                    color: "white",
                    cursor: "pointer",
                  }}
                >
                  Reset all
                </button>
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
                  if (showOval && ovalSelectedRef.current) return;
                  setIsPanning(true);
                  panStartRef.current = {
                    startX: e.clientX,
                    startY: e.clientY,
                    startPanX: panX,
                    startPanY: panY,
                  };
                }}
              >
                <img
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
                      aria-label="Oval: drag inside to move; when selected, drag on the image outside the oval to rotate or click without dragging to deselect; Alt+drag on oval to rotate; Shift+drag or wheel to resize width; drag corner squares to resize"
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
