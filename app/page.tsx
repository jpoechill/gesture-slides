"use client"

import React, { useEffect, useMemo, useRef, useState } from "react";

const APP_VERSION = "0.3.0";

const VERSION_HISTORY: { version: string; date: string; changes: string[] }[] = [
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
  imageOpacity: 1,
};

function loadStoredSettings(): typeof DEFAULT_SETTINGS {
  if (typeof window === "undefined") return DEFAULT_SETTINGS;
  try {
    const raw = localStorage.getItem(SETTINGS_STORAGE_KEY);
    if (!raw) return DEFAULT_SETTINGS;
    const parsed = JSON.parse(raw) as Partial<typeof DEFAULT_SETTINGS>;
    return { ...DEFAULT_SETTINGS, ...parsed };
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
  } catch {}
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
  } catch {}
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

export default function Page() {
  const [dirHandle, setDirHandle] = useState<FileSystemDirectoryHandle | null>(null);
  const [files, setFiles] = useState<FileHandleEntry[]>([]);
  const [order, setOrder] = useState<number[]>([]);
  const [idxInOrder, setIdxInOrder] = useState(0);

  const storedSettings = useMemo(() => loadStoredSettings(), []);

  const [isRunning, setIsRunning] = useState(false);
  const [intervalSec, setIntervalSec] = useState(storedSettings.intervalSec);
  const [timeRemaining, setTimeRemaining] = useState(0);
  const [elapsedSec, setElapsedSec] = useState(storedSettings.elapsedSec);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [currentUrl, setCurrentUrl] = useState<string | null>(null);
  const currentUrlRef = useRef<string | null>(null);
  const timerRef = useRef<number | null>(null);
  const countdownRef = useRef<number | null>(null);
  const imageContainerRef = useRef<HTMLDivElement | null>(null);
  const fullscreenContainerRef = useRef<HTMLDivElement | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);

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
  const [imageOpacity, setImageOpacity] = useState(storedSettings.imageOpacity);
  const [panX, setPanX] = useState(0);
  const [panY, setPanY] = useState(0);
  const [isPanning, setIsPanning] = useState(false);
  const panStartRef = useRef<{ startX: number; startY: number; startPanX: number; startPanY: number } | null>(null);
  const hasPannedRef = useRef(false);
  const pinchRef = useRef<{
    distance: number;
    scale: number;
    lastDistance?: number;
    lastTime?: number;
  } | null>(null);
  const zoomContainerRef = useRef<HTMLDivElement | null>(null);
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
    setImageOpacity(s.imageOpacity);
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
      imageOpacity,
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
    imageOpacity,
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
      setIsRunning(false);
      return;
    }
    setFiles(collected);
    setOrder(shuffle(collected.map((_, i) => i)));
    setIdxInOrder(0);
    setIsRunning(true);
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
        hasPannedRef.current = true;
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
      setTimeRemaining(intervalSec);
      timerRef.current = window.setInterval(() => {
        setIdxInOrder((v) => (v + 1) % order.length);
      }, Math.max(1, intervalSec) * 1000);
    } else {
      setTimeRemaining(0);
    }

    return () => {
      if (timerRef.current) window.clearInterval(timerRef.current);
    };
  }, [isRunning, intervalSec, order.length, idxInOrder]);

  // Countdown timer
  useEffect(() => {
    if (countdownRef.current) {
      window.clearInterval(countdownRef.current);
      countdownRef.current = null;
    }

    if (isRunning && order.length) {
      // Reset timer when image changes or when starting
      setTimeRemaining(intervalSec);
      countdownRef.current = window.setInterval(() => {
        setTimeRemaining((prev) => {
          if (prev <= 1) {
            return intervalSec;
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
  }, [isRunning, intervalSec, order.length, idxInOrder]);

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
          <h1 style={{
            margin: "0 0 12px",
            fontSize: 32,
            fontWeight: 500,
            opacity: 0.95,
            animation: "landingSlideDown 0.55s ease-out 0s both",
          }}>
            Gesture Slideshow <span style={{ fontSize: 18, opacity: 0.7, fontWeight: 400 }}>β {APP_VERSION}</span>
          </h1>
          <p style={{
            margin: "0 0 32px",
            fontSize: 16,
            opacity: 0.7,
            lineHeight: 1.5,
            animation: "landingFadeIn 0.5s ease-out 0.08s both",
          }}>
            Pick a folder → images shuffle → auto-advance
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
            <h1 style={{ margin: 0, fontSize: 18, fontWeight: 500, opacity: 0.9 }}>
              Gesture Slideshow <span style={{ fontSize: 14, opacity: 0.6, fontWeight: 400 }}>β {APP_VERSION}</span>
            </h1>
            <span style={{ fontSize: 13, opacity: 0.6 }}>
              Pick a folder → images shuffle → auto-advance
            </span>
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

            <button onClick={() => setIsRunning(true)} disabled={!canRun} style={btn(!canRun)}>
              Start
            </button>
            <button onClick={() => setIsRunning(false)} disabled={!canRun} style={btn(!canRun)}>
              Pause
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

            <label style={{ display: "flex", alignItems: "center", gap: 6, marginLeft: 4 }}>
              <span style={{ opacity: 0.7, fontSize: 13 }}>Interval:</span>
              <input
                type="number"
                min={1}
                value={intervalSec}
                onChange={(e) => setIntervalSec(parseInt(e.target.value || "60", 10))}
                style={{
                  width: 60,
                  padding: "6px 8px",
                  borderRadius: 6,
                  border: "1px solid rgba(255,255,255,0.15)",
                  background: "rgba(255,255,255,0.05)",
                  color: "white",
                  fontSize: 13,
                }}
              />
              <span style={{ opacity: 0.7, fontSize: 13 }}>s</span>
            </label>

            {isRunning && timeRemaining > 0 && (
              <div
                style={{
                  padding: "4px 10px",
                  borderRadius: 6,
                  background: "rgba(255,255,255,0.08)",
                  fontSize: 13,
                  opacity: 0.9,
                }}
              >
                {timeRemaining}s
              </div>
            )}

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
                <SliderRow
                  label="Opacity"
                  value={imageOpacity}
                  min={0.2}
                  max={1}
                  step={0.05}
                  format={(v) => `${Math.round(v * 100)}%`}
                  onChange={setImageOpacity}
                />
                <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                  <span style={{ opacity: 0.85, fontSize: 12 }}>Flip</span>
                  <div style={{ display: "flex", gap: 8 }}>
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
                    setImageOpacity(1);
                    setPanX(0);
                    setPanY(0);
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
                  transform: `translate(${panX}px, ${panY}px) scale(${imageScale}) rotate(${imageRotate}deg) scaleX(${imageFlipH ? -1 : 1}) scaleY(${imageFlipV ? -1 : 1})`,
                  cursor: isPanning ? "grabbing" : imageScale > 1 ? "grab" : "pointer",
                  userSelect: "none",
                  touchAction: "none",
                }}
                onMouseDown={(e) => {
                  if (e.button !== 0) return;
                  hasPannedRef.current = false;
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
                  onClick={() => {
                    if (hasPannedRef.current) {
                      hasPannedRef.current = false;
                      return;
                    }
                    toggleFullscreen();
                  }}
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
                    opacity: imageOpacity,
                  }}
                />
              </div>
            </div>
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
                  <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                    {[
                      [15, "15s"],
                      [30, "30s"],
                      [60, "1m"],
                      [120, "2m"],
                      [300, "5m"],
                      [600, "10m"],
                      [900, "15m"],
                      [1200, "20m"],
                      [1800, "30m"],
                      [3600, "1h"],
                    ].map(([sec, label]) => (
                      <button
                        key={sec}
                        type="button"
                        onClick={() => setIntervalSec(sec as number)}
                        style={{
                          ...btn(false),
                          padding: "4px 10px",
                          fontSize: 12,
                          opacity: intervalSec === sec ? 1 : 0.8,
                          borderColor: intervalSec === sec ? "rgba(255,255,255,0.4)" : "rgba(255,255,255,0.12)",
                        }}
                      >
                        {label}
                      </button>
                    ))}
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
                      onClick={() => setIsRunning((r) => !r)}
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
                      width: isRunning && order.length ? `${(timeRemaining / intervalSec) * 100}%` : "100%",
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
                    ? `${timeRemaining}s left · ${intervalSec}s interval`
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
