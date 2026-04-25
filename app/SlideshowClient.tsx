"use client"

import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { flushSync } from "react-dom";
import type { PoseLandmarker } from "@mediapipe/tasks-vision";
import { APP_VERSION, VERSION_HISTORY } from "./lib/version";
import { isEditableTextKeyboardTarget } from "./lib/keyboard";
import type { TimerMode } from "./lib/classicTimer";
import {
  parseTimerMode,
  CLASSIC_PRESETS,
  type ClassicTierSec,
  type ClassicSlots,
  CLASSIC_TIER_SEC,
  isClassicTierSec,
  CLASSIC_SLOTS_INITIAL,
  CLASSIC_STEP_TOTAL,
  CLASSIC_FIRST_TIER,
  CLASSIC_EXHAUSTED_PLACEHOLDER_SEC,
  classicSlotsRemainingTotal,
  classicSlotsExhausted,
  classicCompletedCount,
  classicIntervalButtonLabels,
  CLASSIC_MODE_TOOLTIP,
  LOOP_INTERVAL_PRESETS,
} from "./lib/classicTimer";
import {
  IGNORED_DIRS,
  isImageFileName,
  shuffle,
  formatBytes,
  formatElapsed,
  touchDistance,
  playAdvanceSound,
} from "./lib/formatUtils";
import {
  getLastFolderName,
  setLastFolderName,
  getLastFolderOpenedAt,
  setLastFolderOpenedAt,
  saveLastFolderHandle,
  getLastFolderHandle,
} from "./lib/folderStorage";
import {
  type SidebarSectionId,
  type SidebarColumn,
  SIDEBAR_DND_SECTION,
  SIDEBAR_DND_COLUMN,
  sidebarOrderForTab,
  SIDEBAR_SECTION_LABEL,
  isSidebarSectionId,
  normalizeSidebarColumns,
  applySidebarDrop,
} from "./lib/sidebar";
import {
  DEFAULT_SETTINGS,
  SETTINGS_SCHEMA_VERSION,
  loadStoredSettings,
  saveStoredSettings,
} from "./lib/settings";
import {
  normalizeDeg,
  pointInRotatedEllipse,
  pointInRotatedRect,
  clientPointToSvgUser,
  buildExtraOvalPanRecord,
  ellipseNormDistance,
} from "./lib/geometry";
import { MetaRow } from "./components/ui/MetaRow";
import { SliderRow } from "./components/ui/SliderRow";
import {
  PER_IMAGE_AGGREGATE_FILENAME,
  PER_IMAGE_BARE_NON_PENCIL_VERSION,
  defaultPerImageSlideData,
  hasPencilMarkings,
  migrateLegacyPencilStrokesToUv,
  pencilStrokeToDisplayPixels,
  perImageMarkupScore,
  resetNonPencilSlidesToBare,
  type ParsedPerImageAggregate,
  type PencilPoint,
  type PencilStroke,
  type PerImageSlideData,
} from "./lib/perImageSlide";
import {
  drawSmoothPencilStroke,
  smoothPencilPoints,
  simplifyPencilPoints,
  simplifyPencilPointsRdp,
  trySnapStrokeToEllipse,
} from "./lib/pencilStroke";

type FileHandleEntry = {
  name: string;
  key: string;
  handle: FileSystemFileHandle;
};

type HudNeighborKey = "p0" | "p1" | "n0" | "n1";

/** Two back, one back, one ahead, two ahead in shuffle order (p0 left … p1 toward center; n0 toward center … n1 right). */
function hudNeighborWindow(
  files: FileHandleEntry[],
  order: number[],
  idxInOrder: number,
  currentKey: string | undefined,
): Record<HudNeighborKey, FileHandleEntry | null> {
  const empty: Record<HudNeighborKey, FileHandleEntry | null> = {
    p0: null,
    p1: null,
    n0: null,
    n1: null,
  };
  if (!files.length || !order.length || order.length < 2) return empty;
  const n = order.length;
  const at = (rel: number) => {
    const i = (idxInOrder + rel + n * 64) % n;
    return files[order[i]] ?? null;
  };
  let p0: FileHandleEntry | null = at(-2);
  let p1: FileHandleEntry | null = at(-1);
  if (p0 && currentKey && p0.key === currentKey) p0 = null;
  if (p1 && p0 && p1.key === p0.key) p0 = null;
  let n0: FileHandleEntry | null = at(1);
  let n1: FileHandleEntry | null = at(2);
  if (n1 && currentKey && n1.key === currentKey) n1 = null;
  if (n0 && n1 && n0.key === n1.key) n1 = null;
  return { p0, p1, n0, n1 };
}

async function computeFileContentHash(handle: FileSystemFileHandle): Promise<string> {
  const file = await handle.getFile();
  const buf = await file.arrayBuffer();
  const digest = await crypto.subtle.digest("SHA-256", buf);
  const bytes = new Uint8Array(digest);
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  return `sha256:${hex}`;
}

function pickRicherSlideData(a: PerImageSlideData, b: PerImageSlideData): PerImageSlideData {
  return perImageMarkupScore(b) > perImageMarkupScore(a) ? b : a;
}

function orderWithoutAdjacentDuplicateHashes(files: FileHandleEntry[], order: number[]): number[] {
  if (order.length < 2) return order;
  const buckets = new Map<string, number[]>();
  for (const idx of order) {
    const key = files[idx]?.key ?? `idx:${idx}`;
    const arr = buckets.get(key);
    if (arr) arr.push(idx);
    else buckets.set(key, [idx]);
  }
  const out: number[] = [];
  let prevKey = "";
  while (out.length < order.length) {
    let pickKey: string | null = null;
    let pickCount = -1;
    for (const [k, arr] of buckets) {
      const n = arr.length;
      if (n <= 0 || k === prevKey) continue;
      if (n > pickCount) {
        pickCount = n;
        pickKey = k;
      }
    }
    if (!pickKey) {
      for (const [k, arr] of buckets) {
        const n = arr.length;
        if (n <= 0) continue;
        if (n > pickCount) {
          pickCount = n;
          pickKey = k;
        }
      }
    }
    if (!pickKey) break;
    const q = buckets.get(pickKey)!;
    const idx = q.shift();
    if (idx === undefined) break;
    out.push(idx);
    prevKey = pickKey;
  }
  if (out.length > 2) {
    const firstKey = files[out[0] ?? -1]?.key ?? "";
    const lastKey = files[out[out.length - 1] ?? -1]?.key ?? "";
    if (firstKey && firstKey === lastKey) {
      for (let i = out.length - 2; i >= 1; i--) {
        const candidateKey = files[out[i] ?? -1]?.key ?? "";
        const beforeCandidateKey = files[out[i - 1] ?? -1]?.key ?? "";
        if (!candidateKey || candidateKey === firstKey || beforeCandidateKey === firstKey) continue;
        const tail = out[out.length - 1]!;
        out[out.length - 1] = out[i]!;
        out[i] = tail;
        break;
      }
    }
  }
  return out.length === order.length ? out : order;
}

async function readPerImageAggregateFromAppStorage(): Promise<ParsedPerImageAggregate> {
  try {
    const res = await fetch("/api/annotations", { cache: "no-store" });
    if (!res.ok) {
      console.warn("gesture-slideshow: reading local aggregate failed", res.status);
      return { images: {}, bareNonPencilMigrationVersion: PER_IMAGE_BARE_NON_PENCIL_VERSION };
    }
    const data = (await res.json()) as ParsedPerImageAggregate;
    return {
      images: data?.images ?? {},
      bareNonPencilMigrationVersion:
        typeof data?.bareNonPencilMigrationVersion === "number"
          ? data.bareNonPencilMigrationVersion
          : PER_IMAGE_BARE_NON_PENCIL_VERSION,
    };
  } catch (err) {
    console.warn("gesture-slideshow: reading local aggregate failed", err);
    return { images: {}, bareNonPencilMigrationVersion: PER_IMAGE_BARE_NON_PENCIL_VERSION };
  }
}

async function writePerImageAggregateToAppStorage(
  images: Record<string, PerImageSlideData>,
  opts?: { bareNonPencilMigrationVersion?: number }
): Promise<void> {
  const bareNonPencilMigrationVersion =
    opts?.bareNonPencilMigrationVersion ?? PER_IMAGE_BARE_NON_PENCIL_VERSION;
  const res = await fetch("/api/annotations", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ images, bareNonPencilMigrationVersion }),
  });
  if (!res.ok) {
    throw new Error(`writing local aggregate failed (${res.status})`);
  }
}

function revokeSlidePrefetchMap(m: Map<string, string>) {
  for (const url of m.values()) {
    URL.revokeObjectURL(url);
  }
  m.clear();
}

/** Match main stage image layout: height = viewport, width from aspect (legacy pencil preview scaling). */
function mainStageDisplaySizeForNatural(nw: number, nh: number): { refW: number; refH: number } {
  if (!nw || !nh || nh <= 0) return { refW: 1, refH: 1 };
  const refH = typeof window !== "undefined" ? window.innerHeight : 800;
  const refW = (nw / nh) * refH;
  return { refW, refH };
}

function drawPencilStrokesInImageCssBox(
  ctx: CanvasRenderingContext2D,
  strokes: PencilStroke[],
  imgCssW: number,
  imgCssH: number
) {
  if (!strokes.length || !imgCssW || !imgCssH) return;
  const maxPreviewStrokePx = Math.max(0.75, Math.min(2.5, Math.min(imgCssW, imgCssH) * 0.015));
  for (const stroke of strokes) {
    const s = pencilStrokeToDisplayPixels(stroke, imgCssW, imgCssH);
    drawSmoothPencilStroke(ctx, {
      ...s,
      size: Math.min(maxPreviewStrokePx, Math.max(0.2, s.size)),
    });
  }
}

/** Pre-UV strokes in main-stage CSS pixels; scale into a mini preview box. */
function drawLegacyPencilStrokesHudPreview(
  ctx: CanvasRenderingContext2D,
  strokes: PencilStroke[],
  previewCssW: number,
  previewCssH: number,
  nw: number,
  nh: number
) {
  if (!strokes.length || !previewCssW || !previewCssH) return;
  const { refW, refH } = mainStageDisplaySizeForNatural(nw, nh);
  if (!refW || !refH) return;
  const scaleX = previewCssW / refW;
  const scaleY = previewCssH / refH;
  const sLine = Math.min(scaleX, scaleY);
  const maxPreviewStrokePx = Math.max(0.75, Math.min(2.5, Math.min(previewCssW, previewCssH) * 0.015));
  for (const stroke of strokes) {
    drawSmoothPencilStroke(ctx, {
      color: stroke.color,
      size: Math.min(maxPreviewStrokePx, Math.max(0.2, stroke.size * sLine)),
      points: stroke.points.map((p) => ({ x: p.x * scaleX, y: p.y * scaleY })),
    });
  }
}

/**
 * Defensive heuristic for old/mis-saved data:
 * UV strokes should mostly be inside [0,1] (with tiny tolerance).
 */
function looksLikeUvStrokeCoordinates(strokes: PencilStroke[]): boolean {
  let total = 0;
  let outside = 0;
  for (const stroke of strokes) {
    for (const p of stroke.points) {
      total += 1;
      if (!Number.isFinite(p.x) || !Number.isFinite(p.y) || p.x < -0.25 || p.x > 1.25 || p.y < -0.25 || p.y > 1.25) {
        outside += 1;
      }
    }
  }
  if (!total) return true;
  return outside / total < 0.2;
}

const EMPTY_PENCIL_PREVIEW: PencilStroke[] = [];

type HudMiniSlidePreviewProps = {
  outerStyle: React.CSSProperties;
  imageUrl: string;
  label: string;
  regionTitle: string;
  minimized: boolean;
  onToggleMinimized: () => void;
  strokes: PencilStroke[];
  pencilRevision: number;
  corner: "left" | "right";
  /** When set, expanded preview is clickable to open that slide as the main image. */
  onPickSlide?: () => void;
  /** False = stroke coords are legacy main-stage CSS pixels (HUD scales from ref layout). */
  pencilStrokesUv: boolean;
};

function HudMiniSlidePreview(props: HudMiniSlidePreviewProps) {
  const {
    outerStyle,
    imageUrl,
    label,
    regionTitle,
    minimized,
    onToggleMinimized,
    strokes,
    pencilRevision,
    corner,
    onPickSlide,
    pencilStrokesUv,
  } = props;
  const imgRef = useRef<HTMLImageElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  const redraw = useCallback(() => {
    if (minimized) return;
    const img = imgRef.current;
    const canvas = canvasRef.current;
    if (!img || !canvas || !img.complete || !imageUrl) return;
    const nw = img.naturalWidth;
    const nh = img.naturalHeight;
    if (!nw || !nh) return;
    const pw = img.clientWidth;
    const ph = img.clientHeight;
    if (!pw || !ph) return;
    const dpr = typeof window !== "undefined" ? window.devicePixelRatio || 1 : 1;
    const cw = Math.max(1, Math.round(pw * dpr));
    const ch = Math.max(1, Math.round(ph * dpr));
    if (canvas.width !== cw) canvas.width = cw;
    if (canvas.height !== ch) canvas.height = ch;
    canvas.style.width = `${pw}px`;
    canvas.style.height = `${ph}px`;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.clearRect(0, 0, cw, ch);
    ctx.save();
    ctx.scale(dpr, dpr);
    const useUv = pencilStrokesUv && looksLikeUvStrokeCoordinates(strokes);
    if (useUv) drawPencilStrokesInImageCssBox(ctx, strokes, pw, ph);
    else drawLegacyPencilStrokesHudPreview(ctx, strokes, pw, ph, nw, nh);
    ctx.restore();
  }, [imageUrl, minimized, pencilStrokesUv, strokes, pencilRevision]);

  useLayoutEffect(() => {
    redraw();
  }, [redraw]);

  useEffect(() => {
    if (minimized) return;
    const img = imgRef.current;
    if (!img || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => redraw());
    ro.observe(img);
    return () => ro.disconnect();
  }, [redraw, minimized]);

  const btnPos: React.CSSProperties =
    corner === "right"
      ? { right: minimized ? 0 : 6, left: undefined }
      : { left: minimized ? 0 : 6, right: undefined };

  return (
    <div style={{ ...outerStyle, position: "relative" }}>
      <button
        type="button"
        aria-label={minimized ? `Expand ${label} preview` : `Minimize ${label} preview`}
        aria-expanded={!minimized}
        onClick={(e) => {
          e.stopPropagation();
          onToggleMinimized();
        }}
        style={{
          position: minimized ? "relative" : "absolute",
          top: minimized ? 0 : 6,
          zIndex: 3,
          border: "1px solid rgba(255,255,255,0.22)",
          background: "rgba(0,0,0,0.55)",
          color: "white",
          borderRadius: 8,
          width: 34,
          height: 30,
          cursor: "pointer",
          padding: 0,
          fontSize: 18,
          lineHeight: 1,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          opacity: 0.95,
          pointerEvents: "auto",
          ...btnPos,
        }}
        title={minimized ? `Show ${label} preview` : `Hide ${label} preview`}
      >
        {minimized ? "+" : "−"}
      </button>
      {!minimized ? (
        <div
          role={onPickSlide ? "button" : "region"}
          tabIndex={onPickSlide ? 0 : undefined}
          aria-label={regionTitle}
          title={onPickSlide ? `${regionTitle} — click to open as main slide` : regionTitle}
          onClick={
            onPickSlide
              ? (e) => {
                  e.stopPropagation();
                  onPickSlide();
                }
              : undefined
          }
          onKeyDown={
            onPickSlide
              ? (e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    e.stopPropagation();
                    onPickSlide();
                  }
                }
              : undefined
          }
          style={{
            pointerEvents: onPickSlide ? "auto" : "none",
            cursor: onPickSlide ? "pointer" : undefined,
            display: "block",
            width: "fit-content",
            maxWidth: 220,
            borderRadius: 10,
            overflow: "hidden",
            border: "1px solid rgba(255,255,255,0.28)",
            boxShadow: "0 4px 14px rgba(0,0,0,0.45)",
            background: "rgba(0,0,0,0.5)",
            zIndex: 1,
          }}
        >
          <div
            style={{
              fontSize: 11,
              fontWeight: 600,
              letterSpacing: "0.04em",
              textTransform: "uppercase",
              opacity: 0.85,
              padding: "8px 10px 4px",
              borderBottom: "1px solid rgba(255,255,255,0.12)",
            }}
          >
            {label}
          </div>
          <div
            style={{
              position: "relative",
              display: "block",
              width: "fit-content",
              maxWidth: 220,
              background: "#000",
              lineHeight: 0,
              fontSize: 0,
            }}
          >
            <img
              ref={imgRef}
              src={imageUrl}
              alt=""
              draggable={false}
              onLoad={redraw}
              style={{
                maxWidth: 220,
                maxHeight: 180,
                width: "auto",
                height: "auto",
                objectFit: "contain",
                display: "block",
                margin: 0,
              }}
            />
            <canvas
              ref={canvasRef}
              aria-hidden
              style={{
                position: "absolute",
                left: 0,
                top: 0,
                width: "100%",
                height: "100%",
                pointerEvents: "none",
                zIndex: 2,
              }}
            />
          </div>
        </div>
      ) : null}
    </div>
  );
}

/** Curved-arrow cursor for oval / head rotation (compact; hot spot center). */
const OVAL_ROTATE_CURSOR = `url("data:image/svg+xml;charset=utf-8,${encodeURIComponent(
  `<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 20 20">
    <path d="M10 4.5 A6.2 6.2 0 1 1 6.5 13.5" fill="none" stroke="white" stroke-width="3" stroke-linecap="round"/>
    <path d="M10 4.5 A6.2 6.2 0 1 1 6.5 13.5" fill="none" stroke="black" stroke-width="1.1" stroke-linecap="round"/>
    <path d="M10 2.2 L13.2 7.8 H6.8 Z" fill="white" stroke="black" stroke-width="0.65" stroke-linejoin="round"/>
  </svg>`
)}") 10 10, crosshair`;

/** Angled pencil with tip at lower-left of icon (hot spot ~ graphite point). */
const PENCIL_TOOL_CURSOR = `url("data:image/svg+xml;charset=utf-8,${encodeURIComponent(
  `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24">
    <path d="M4 19 L5 14.5 L15.2 4.3 L17.8 6.9 L7.6 17.1 Z" fill="white" stroke="black" stroke-width="1.15" stroke-linejoin="round"/>
    <path d="M5 14.5 L3 20 L8.5 18.2 Z" fill="#d8d8d8" stroke="black" stroke-width="1" stroke-linejoin="round"/>
    <path d="M15.5 4 L18.1 6.6" fill="none" stroke="#666" stroke-width="1" stroke-linecap="round"/>
  </svg>`
)}") 3 19, crosshair`;

/** Map slide photo top-left into pencil canvas CSS pixels (canvas fills the zoom stage). */
function imageOriginInPencilCanvasCss(canvas: HTMLCanvasElement, img: HTMLImageElement): { ox: number; oy: number } {
  const cr = canvas.getBoundingClientRect();
  const ir = img.getBoundingClientRect();
  const dpr = typeof window !== "undefined" ? window.devicePixelRatio || 1 : 1;
  const cssCanvasW = canvas.width > 0 ? canvas.width / dpr : cr.width;
  const cssCanvasH = canvas.height > 0 ? canvas.height / dpr : cr.height;
  if (cr.width <= 0 || cr.height <= 0) return { ox: 0, oy: 0 };
  const scaleX = cssCanvasW / cr.width;
  const scaleY = cssCanvasH / cr.height;
  return {
    ox: (ir.left - cr.left) * scaleX,
    oy: (ir.top - cr.top) * scaleY,
  };
}

const CIRCLE_BOUNDING_CORNER_SIZE = 10;

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
  const lp = clientPointToSvgUser(svg, clientX, clientY);
  if (!lp) return "grab";

  const d = diameterPx;
  const vbW = svg.viewBox?.baseVal?.width || d;
  const vbH = svg.viewBox?.baseVal?.height || d;
  const lcx = vbW / 2;
  const lcy = vbH / 2;
  const lr = Math.max(4, d / 2 - 4);
  const boxL = lcx - lr;
  const boxT = lcy - lr;
  const boxWi = 2 * lr;
  const boxHi = 2 * lr;

  if (handlesVisible) {
    const cornerSz = CIRCLE_BOUNDING_CORNER_SIZE;
    const cornerHalf = cornerSz / 2;
    const cornerHitHalf = cornerHalf + Math.max(7, d * 0.04);
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
        lp.x >= bx - cornerHitHalf &&
        lp.x <= bx + cornerHitHalf &&
        lp.y >= by - cornerHitHalf &&
        lp.y <= by + cornerHitHalf
      ) {
        return cornerCursors[i];
      }
    }
    const edgeDepth = Math.max(10, Math.min(22, d * 0.12));
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
    if (inTop || inBottom || inLeft || inRight) {
      // Edge handles are axis-aligned in SVG space; when the oval is rotated, the visual "top"
      // may be detected by left/right bands. Resolve by screen-facing side around center.
      const srect = svg.getBoundingClientRect();
      const scx = srect.left + srect.width / 2;
      const scy = srect.top + srect.height / 2;
      const dx0 = clientX - scx;
      const dy0 = clientY - scy;
      const edgeKindScreen: "top" | "bottom" | "left" | "right" =
        Math.abs(dy0) >= Math.abs(dx0)
          ? dy0 <= 0
            ? "top"
            : "bottom"
          : dx0 <= 0
            ? "left"
            : "right";
      return edgeKindScreen === "top" || edgeKindScreen === "bottom" ? "ns-resize" : "ew-resize";
    }
  }

  const srect = svg.getBoundingClientRect();
  const scx = srect.left + srect.width / 2;
  const scy = srect.top + srect.height / 2;
  const scaleX = srect.width / vbW;
  const scaleY = srect.height / vbH;
  const rxPix = lr * scaleX;
  const ryPix = lr * scaleY;
  const inCircle = pointInRotatedEllipse(clientX, clientY, scx, scy, rotateDeg, rxPix, ryPix);
  const r0 = Math.max(0.01, Math.hypot(clientX - scx, clientY - scy));
  const rEdge = (rxPix + ryPix) / 2;
  const edgeBand = Math.max(12, rEdge * 0.16);
  const nearCircleRim = Math.abs(r0 - rEdge) <= edgeBand;

  if (!(inCircle || nearCircleRim)) return "grab";
  if (shiftKey || nearCircleRim) return "ns-resize";
  if (altKey) return OVAL_ROTATE_CURSOR;
  return "grab";
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

    if (inTop || inBottom || inLeft || inRight) {
      // Match cursor to the visual side of the (possibly rotated) bounding box.
      const srect = svg.getBoundingClientRect();
      const scx = srect.left + srect.width / 2;
      const scy = srect.top + srect.height / 2;
      const dx0 = clientX - scx;
      const dy0 = clientY - scy;
      const edgeKindScreen: "top" | "bottom" | "left" | "right" =
        Math.abs(dy0) >= Math.abs(dx0)
          ? dy0 <= 0
            ? "top"
            : "bottom"
          : dx0 <= 0
            ? "left"
            : "right";
      return edgeKindScreen === "top" || edgeKindScreen === "bottom" ? "ns-resize" : "ew-resize";
    }
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

const OVAL_SHADE_LIGHT: [number, number, number] = [255, 255, 255];
const OVAL_SHADE_DARK: [number, number, number] = [8, 10, 18];

function lerpRgbChannel(a: number, b: number, t: number): number {
  return Math.round(a + (b - a) * t);
}

function lerpRgbStr(
  from: [number, number, number],
  to: [number, number, number],
  t: number
): string {
  const u = Math.max(0, Math.min(1, t));
  return `rgb(${lerpRgbChannel(from[0], to[0], u)},${lerpRgbChannel(from[1], to[1], u)},${lerpRgbChannel(from[2], to[2], u)})`;
}

/** Radial + weak diagonal overlay to read as a lit ellipsoid; all inputs 0–100. */
function computeOvalEllipsoidShading(highlightPct: number, shadowPct: number, formPct: number) {
  const h = Math.max(0, Math.min(100, highlightPct)) / 100;
  const s = Math.max(0, Math.min(100, shadowPct)) / 100;
  const f = Math.max(0, Math.min(100, formPct)) / 100;

  const rPct = `${Math.round(50 + (1 - f) * 36)}%`;
  const cxPct = `${36 - f * 8}%`;
  const cyPct = `${30 - f * 8}%`;
  const fxPct = `${28 - f * 10}%`;
  const fyPct = `${20 - f * 8}%`;

  const mix0 = s * 0.12;
  const mix1 = s * 0.28;
  const mix2 = s * 0.52;
  const mix3 = s * 0.78;
  const mix4 = s * 0.96;

  const op0 = 0.22 + h * 0.58;
  const op1 = 0.14 + h * 0.34;
  const op2 = 0.14 + h * 0.14 + s * 0.22;
  const op3 = 0.15 + h * 0.08 + s * 0.3;
  const op4 = 0.2 + s * 0.45;

  const radialStops = [
    { offset: "0%", color: lerpRgbStr(OVAL_SHADE_LIGHT, OVAL_SHADE_DARK, mix0), opacity: op0 },
    { offset: "28%", color: lerpRgbStr(OVAL_SHADE_LIGHT, OVAL_SHADE_DARK, mix1), opacity: op1 },
    { offset: "52%", color: lerpRgbStr(OVAL_SHADE_LIGHT, OVAL_SHADE_DARK, mix2), opacity: op2 },
    { offset: "76%", color: lerpRgbStr(OVAL_SHADE_LIGHT, OVAL_SHADE_DARK, mix3), opacity: op3 },
    { offset: "100%", color: lerpRgbStr(OVAL_SHADE_LIGHT, OVAL_SHADE_DARK, mix4), opacity: op4 },
  ] as const;

  const linEndOp = Math.min(1, 0.24 + s * 0.62);
  const linMidOp = s * 0.14;
  let overlayOpacity = 0.32 + f * 0.5 + s * 0.28;
  overlayOpacity *= 1 - h * 0.14;
  overlayOpacity = Math.max(0, Math.min(0.94, overlayOpacity));

  const linearStops = [
    { offset: "0%", color: "rgb(255,255,255)", opacity: 0 },
    { offset: "48%", color: "rgb(255,255,255)", opacity: linMidOp * 0.55 },
    { offset: "100%", color: lerpRgbStr(OVAL_SHADE_LIGHT, OVAL_SHADE_DARK, 0.92), opacity: linEndOp },
  ] as const;

  return {
    cxPct,
    cyPct,
    rPct,
    fxPct,
    fyPct,
    radialStops,
    linearStops,
    overlayOpacity,
  };
}

function resolveOvalSvgPointerCursor(
  svg: SVGSVGElement,
  clientX: number,
  clientY: number,
  altKey: boolean,
  shiftKey: boolean,
  widthPx: number,
  heightPx: number,
  rotateDeg: number,
  handlesVisible: boolean
): string {
  const lp = clientPointToSvgUser(svg, clientX, clientY);
  if (!lp) return "grab";

  const vbW = widthPx;
  const vbH = heightPx;
  const lcx = vbW / 2;
  const lcy = vbH / 2;
  const lerx = Math.max(4, widthPx / 2 - 4);
  const lery = Math.max(4, heightPx / 2 - 4);
  const boxL = lcx - lerx;
  const boxT = lcy - lery;
  const boxWi = 2 * lerx;
  const boxHi = 2 * lery;

  if (handlesVisible) {
    const cornerSz = Math.min(14, Math.max(5, Math.min(widthPx, heightPx) * 0.06));
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
    const edgeDepth = Math.max(6, Math.min(18, Math.min(widthPx, heightPx) * 0.09));
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
    if (inTop || inBottom || inLeft || inRight) {
      // Match cursor to the visual side of the rotated bounding box.
      const srect = svg.getBoundingClientRect();
      const scx = srect.left + srect.width / 2;
      const scy = srect.top + srect.height / 2;
      const dx0 = clientX - scx;
      const dy0 = clientY - scy;
      const edgeKindScreen: "top" | "bottom" | "left" | "right" =
        Math.abs(dy0) >= Math.abs(dx0)
          ? dy0 <= 0
            ? "top"
            : "bottom"
          : dx0 <= 0
            ? "left"
            : "right";
      return edgeKindScreen === "top" || edgeKindScreen === "bottom" ? "ns-resize" : "ew-resize";
    }

    const chHalf = Math.max(10, Math.min(widthPx, heightPx) * 0.11);
    if (Math.hypot(lp.x - lcx, lp.y - lcy) <= chHalf + 10) return "move";
  }

  const srect = svg.getBoundingClientRect();
  const scx = srect.left + srect.width / 2;
  const scy = srect.top + srect.height / 2;
  const scaleX = srect.width / vbW;
  const scaleY = srect.height / vbH;
  const rxPix = lerx * scaleX;
  const ryPix = lery * scaleY;
  const inOval = pointInRotatedEllipse(clientX, clientY, scx, scy, rotateDeg, rxPix, ryPix);
  const u = ellipseNormDistance(clientX, clientY, scx, scy, rotateDeg, rxPix, ryPix);
  const edgeBand = Math.max(12, Math.min(rxPix, ryPix) * 0.2);
  const nearRim = Math.abs(u - 1) * Math.min(rxPix, ryPix) <= edgeBand;

  if (!(inOval || nearRim)) return "grab";
  if (shiftKey || nearRim) return "ns-resize";
  if (altKey) return OVAL_ROTATE_CURSOR;
  return "grab";
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
  /** Mirrors `bareNonPencilMigrationVersion` in `.gesture-slideshow-slides.json` for writes after load. */
  const bareNonPencilMigrationVersionRef = useRef(PER_IMAGE_BARE_NON_PENCIL_VERSION);
  /** Last mouse position over the slide stage (client coords). Used to spawn shapes at cursor. */
  const lastStageClientPointRef = useRef<{ x: number; y: number } | null>(null);
  const [files, setFiles] = useState<FileHandleEntry[]>([]);
  const [order, setOrder] = useState<number[]>([]);
  const [idxInOrder, setIdxInOrder] = useState(0);
  /** Always matches idxInOrder so interval callbacks can compute advance synchronously (React may defer setState updaters). */
  const idxInOrderRef = useRef(0);
  idxInOrderRef.current = idxInOrder;
  /** Pending stroke-based auto-advance after N strokes (cleared on slide/settings change). */
  const strokeAdvanceTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const storedSettings = useMemo(() => loadStoredSettings(), []);

  const [isRunning, setIsRunning] = useState(false);
  const [intervalSec, setIntervalSec] = useState(storedSettings.intervalSec);
  const [timerMode, setTimerMode] = useState<TimerMode>(parseTimerMode(storedSettings.timerMode));
  /** Remaining classic slot counts per tier; each completed interval decrements the tier that was active. */
  const [classicSlots, setClassicSlots] = useState<ClassicSlots>(() => ({ ...CLASSIC_SLOTS_INITIAL }));
  const prevTimerModeRef = useRef<TimerMode>(parseTimerMode(storedSettings.timerMode));
  const [timeRemaining, setTimeRemaining] = useState(0);
  const [elapsedSec, setElapsedSec] = useState(storedSettings.elapsedSec);
  /** Auto-advance intervals that completed (each counts as one slide step in loop mode; classic counts the same tiers as slot decrements). */
  const [intervalsCompleted, setIntervalsCompleted] = useState(0);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [currentUrl, setCurrentUrl] = useState<string | null>(null);
  const currentUrlRef = useRef<string | null>(null);
  /** Blob URLs for next/prev slides; warmed with Image.decode() for faster transitions. */
  const slidePrefetchRef = useRef<Map<string, string>>(new Map());
  const prefetchKeepRef = useRef<Set<string>>(new Set());
  const timerRef = useRef<number | null>(null);
  /** Tier (seconds) for the auto-advance interval currently scheduled — used when a classic slot completes. */
  const classicAdvanceTierRef = useRef<ClassicTierSec>(CLASSIC_FIRST_TIER);
  const countdownRef = useRef<number | null>(null);
  const imageContainerRef = useRef<HTMLDivElement | null>(null);
  const fullscreenContainerRef = useRef<HTMLDivElement | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const currentImgRef = useRef<HTMLImageElement | null>(null);
  const poseCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const pencilCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const pencilStrokesByImageRef = useRef<Record<string, PencilStroke[]>>({});
  const pencilDraftRef = useRef<PencilStroke | null>(null);
  const perImageSlideDataRef = useRef<Record<string, PerImageSlideData>>({});
  /** Per-image snapshots for ⌘Z (shapes, pencil, pan/zoom in overlay snapshot). */
  const undoStackByImageRef = useRef<Record<string, PerImageSlideData[]>>({});
  const MAX_UNDO_STACK = 50;
  /** Assigned each render after overlay snapshot + flush exist (see below). */
  const pushUndoSnapshotRef = useRef<() => void>(() => {});
  const overlaySnapshotRef = useRef<PerImageSlideData | null>(null);
  const prevSlideIdentityForAggregateRef = useRef<string>("");
  const prevImageStorageKeyForAggregateRef = useRef<string>("");
  const currentImageKeyRef = useRef<string>("");
  const perImageAggregateFlushTimerRef = useRef<number | null>(null);
  const poseLandmarkerRef = useRef<PoseLandmarker | null>(null);
  const [poseReady, setPoseReady] = useState(false);
  const [poseNonce, setPoseNonce] = useState(0);
  const ovalHitAreaRef = useRef<HTMLDivElement | null>(null);
  /** Primary + extra oval layers (absolute overlay); used to ignore mousedown on shapes before selection refs update. */
  const ovalLayersRef = useRef<HTMLDivElement | null>(null);
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
  const [isFolderLoading, setIsFolderLoading] = useState(false);
  const [folderLoadStatus, setFolderLoadStatus] = useState("Waiting…");
  const folderLoadProgressRef = useRef({ hashed: 0, lastUiAt: 0 });
  const [pencilCanvasVisible, setPencilCanvasVisible] = useState(false);
  const pencilCanvasVisibleRef = useRef(false);
  const [loadedImageUrl, setLoadedImageUrl] = useState<string | null>(null);
  const [currentUrlSlideIdentity, setCurrentUrlSlideIdentity] = useState<string | null>(null);
  const [loadedSlideIdentity, setLoadedSlideIdentity] = useState<string | null>(null);

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
  const [imagePlacementEnabled, setImagePlacementEnabled] = useState(
    storedSettings.imagePlacementEnabled === true
  );
  const [imagePlacement, setImagePlacement] = useState<"left" | "center" | "right">(() => {
    const v = storedSettings.imagePlacement;
    return v === "left" || v === "right" || v === "center" ? v : "center";
  });
  const [pencilEnabled, setPencilEnabled] = useState(storedSettings.pencilEnabled === true);
  const [pencilSize, setPencilSize] = useState(
    Math.min(24, Math.max(1, Number(storedSettings.pencilSize) || 4))
  );
  const [pencilColor, setPencilColor] = useState(
    typeof storedSettings.pencilColor === "string" && storedSettings.pencilColor ? storedSettings.pencilColor : "#ff3b30"
  );
  const [pencilCurveSensitivity, setPencilCurveSensitivity] = useState(() => {
    const v = Number(storedSettings.pencilCurveSensitivity);
    return Math.min(100, Math.max(0, Number.isFinite(v) ? v : DEFAULT_SETTINGS.pencilCurveSensitivity));
  });
  const [strokeAdvanceTarget, setStrokeAdvanceTarget] = useState(() => {
    const t = Math.floor(Number(storedSettings.strokeAdvanceTarget));
    return Number.isFinite(t) ? Math.min(999, Math.max(0, t)) : DEFAULT_SETTINGS.strokeAdvanceTarget;
  });
  const [strokeAdvanceDeleteMarks, setStrokeAdvanceDeleteMarks] = useState(
    storedSettings.strokeAdvanceDeleteMarks === true
  );
  const strokeAdvanceTargetRef = useRef(strokeAdvanceTarget);
  strokeAdvanceTargetRef.current = strokeAdvanceTarget;
  const [pencilNonce, setPencilNonce] = useState(0);
  const [pencilMoveAllMode, setPencilMoveAllMode] = useState(false);
  /** Bumps when the per-image undo stack is pushed so sidebar can refresh "Undo" enabled state. */
  const [undoStackVersion, setUndoStackVersion] = useState(0);
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
  type OvalExtra = {
    id: string;
    width: number;
    heightPx: number;
    rotateDeg: number;
    offsetX: number;
    offsetY: number;
    shadeHighlight: number;
    shadeShadow: number;
    shadeForm: number;
    shadeOpacity: number;
  };
  const [extraOvals, setExtraOvals] = useState<OvalExtra[]>([]);
  const extraOvalIdCounterRef = useRef(1);
  const newOvalSpawnCounterRef = useRef(0);
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
  const [ovalShadeHighlight, setOvalShadeHighlight] = useState(() => {
    const v = Number(storedSettings.ovalShadeHighlight);
    return Math.min(100, Math.max(0, Number.isFinite(v) ? v : DEFAULT_SETTINGS.ovalShadeHighlight));
  });
  const [ovalShadeShadow, setOvalShadeShadow] = useState(() => {
    const v = Number(storedSettings.ovalShadeShadow);
    return Math.min(100, Math.max(0, Number.isFinite(v) ? v : DEFAULT_SETTINGS.ovalShadeShadow));
  });
  const [ovalShadeForm, setOvalShadeForm] = useState(() => {
    const v = Number(storedSettings.ovalShadeForm);
    return Math.min(100, Math.max(0, Number.isFinite(v) ? v : DEFAULT_SETTINGS.ovalShadeForm));
  });
  const [ovalShadeOpacity, setOvalShadeOpacity] = useState(() => {
    const v = Number(storedSettings.ovalShadeOpacity);
    return Math.min(100, Math.max(0, Number.isFinite(v) ? v : DEFAULT_SETTINGS.ovalShadeOpacity));
  });
  /** Selected after clicking the Oval overlay; yellow outline. Cleared by clicking outside it. */
  const [ovalSelected, setOvalSelected] = useState(false);
  const ovalSelectedRef = useRef(ovalSelected);
  ovalSelectedRef.current = ovalSelected;
  /** Extra ribcage ovals with yellow outline; Shift-click to add. */
  const [selectedExtraOvalIds, setSelectedExtraOvalIds] = useState<string[]>([]);
  const selectedExtraOvalIdsRef = useRef<string[]>([]);
  selectedExtraOvalIdsRef.current = selectedExtraOvalIds;
  // SVG <defs> ids must be unique across multiple ovals (IDs are global within the document).
  const primaryOvalGradBodyId = "gesture-oval-body-shade-primary";
  const primaryOvalGradAmbientId = "gesture-oval-ambient-shade-primary";
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
  const ovalCx = useMemo(() => ovalWidth / 2, [ovalWidth]);
  const ovalCy = useMemo(() => ovalHeightPx / 2, [ovalHeightPx]);
  const ovalRxGeom = useMemo(() => Math.max(4, ovalWidth / 2 - 4), [ovalWidth]);
  const ovalRyGeom = useMemo(() => Math.max(4, ovalHeightPx / 2 - 4), [ovalHeightPx]);
  const ovalHandleCorners = useMemo((): [number, number][] => {
    const lcx = ovalWidth / 2;
    const lcy = ovalHeightPx / 2;
    const lerx = Math.max(4, ovalWidth / 2 - 4);
    const lery = Math.max(4, ovalHeightPx / 2 - 4);
    return [
      [lcx - lerx, lcy - lery],
      [lcx + lerx, lcy - lery],
      [lcx + lerx, lcy + lery],
      [lcx - lerx, lcy + lery],
    ];
  }, [ovalWidth, ovalHeightPx]);
  const ovalFrontInnerPoly = useMemo(
    () => shrinkQuad(ovalHandleCorners, Math.max(0.82, 1 - 8 / Math.min(ovalWidth, ovalHeightPx))),
    [ovalHandleCorners, ovalWidth, ovalHeightPx]
  );
  const ovalCrosshairHalf = useMemo(
    () => Math.max(10, Math.min(ovalWidth, ovalHeightPx) * 0.11),
    [ovalWidth, ovalHeightPx]
  );
  const ovalStrokeColor = ovalSelected ? "#facc15" : "#ffffff";
  const ovalBoundingCornerSize = useMemo(
    () => Math.min(14, Math.max(5, Math.min(ovalWidth, ovalHeightPx) * 0.06)),
    [ovalWidth, ovalHeightPx]
  );
  const ovalBoundingCornerHalf = ovalBoundingCornerSize / 2;
  const ovalEllipsoidShade = useMemo(
    () => computeOvalEllipsoidShading(ovalShadeHighlight, ovalShadeShadow, ovalShadeForm),
    [ovalShadeHighlight, ovalShadeShadow, ovalShadeForm]
  );
  const circleStrokeColor = circleSelected ? "#facc15" : "#ffffff";
  const circleRGeom = Math.max(4, circleDiameterPx / 2 - 4);
  /** Match oval outline (2) and cuboid wire (~1.4–2.2); non-scaling under image zoom. */
  const circleSvgStrokeWidth = 2;
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
  const circleBoundingCornerSize = CIRCLE_BOUNDING_CORNER_SIZE;
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

  const applyGroupPanDelta = useCallback(
    (
      dx: number,
      dy: number,
      snap: {
        moveOval: boolean;
        moveCircle: boolean;
        moveRectangle: boolean;
        moveBox3d: boolean;
        startOvalX: number;
        startOvalY: number;
        startCircleX: number;
        startCircleY: number;
        startRectX: number;
        startRectY: number;
        startBox3dX: number;
        startBox3dY: number;
        extraOvalPan?: { ids: string[]; startById: Record<string, { x: number; y: number }> };
      }
    ) => {
      if (snap.moveOval) {
        setOvalOffsetX(snap.startOvalX + dx);
        setOvalOffsetY(snap.startOvalY + dy);
      }
      if (snap.extraOvalPan?.ids.length) {
        const { startById } = snap.extraOvalPan;
        setExtraOvals((prev) =>
          prev.map((o) => {
            const st = startById[o.id];
            if (!st) return o;
            return { ...o, offsetX: st.x + dx, offsetY: st.y + dy };
          })
        );
      }
      if (snap.moveCircle) {
        setCircleOffsetX(snap.startCircleX + dx);
        setCircleOffsetY(snap.startCircleY + dy);
      }
      if (snap.moveRectangle) {
        setRectangleOffsetX(snap.startRectX + dx);
        setRectangleOffsetY(snap.startRectY + dy);
      }
      if (snap.moveBox3d) {
        setBox3dOffsetX(snap.startBox3dX + dx);
        setBox3dOffsetY(snap.startBox3dY + dy);
      }
    },
    []
  );

  const handleOvalPointerDown = useCallback(
    (e: React.PointerEvent<SVGSVGElement>) => {
      setPencilEnabled(false);
      const svg = e.currentTarget;
      const rw = ovalWidth;
      const rh = ovalHeightPx;
      const srect = svg.getBoundingClientRect();
      const scx = srect.left + srect.width / 2;
      const scy = srect.top + srect.height / 2;
      const scaleX = srect.width / rw;
      const scaleY = srect.height / rh;
      const lerxGeom = Math.max(4, rw / 2 - 4);
      const leryGeom = Math.max(4, rh / 2 - 4);
      const rxPix = lerxGeom * scaleX;
      const ryPix = leryGeom * scaleY;

      const lp = clientPointToSvgUser(svg, e.clientX, e.clientY);
      if (!lp) return;

      const lcx = rw / 2;
      const lcy = rh / 2;
      const lerx = lerxGeom;
      const lery = leryGeom;
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
      if (e.button === 0) {
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
      }

      const edgeDepth = Math.max(6, Math.min(18, Math.min(rw, rh) * 0.09));
      const edgeInset = cornerHalf + 2;
      let edgeKind: "top" | "bottom" | "left" | "right" | null = null;
      if (cornerIndex === null && e.button === 0) {
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
      }

      const inOval = pointInRotatedEllipse(
        e.clientX,
        e.clientY,
        scx,
        scy,
        ovalRotateDeg,
        rxPix,
        ryPix
      );
      const u0 = ellipseNormDistance(e.clientX, e.clientY, scx, scy, ovalRotateDeg, rxPix, ryPix);
      const edgeBand = Math.max(12, Math.min(rxPix, ryPix) * 0.2);
      const nearRim = Math.abs(u0 - 1) * Math.min(rxPix, ryPix) <= edgeBand;

      const crosshairBand = 3;
      const chHalf = Math.max(10, Math.min(rw, rh) * 0.11);
      const inCrosshair =
        (Math.abs(lp.x - lcx) <= crosshairBand && Math.abs(lp.y - lcy) <= chHalf + crosshairBand) ||
        (Math.abs(lp.y - lcy) <= crosshairBand && Math.abs(lp.x - lcx) <= chHalf + crosshairBand);

      const inBoundingBox =
        lp.x >= boxL && lp.x <= boxL + boxWi && lp.y >= boxT && lp.y <= boxT + boxHi;

      if (cornerIndex === null && edgeKind === null && !inOval && !nearRim && !inCrosshair && !inBoundingBox)
        return;

      e.preventDefault();
      e.stopPropagation();
      pushUndoSnapshotRef.current();
      const pointerId = e.pointerId;
      svg.setPointerCapture(pointerId);

      const primaryWasSelected = ovalSelectedRef.current;
      const circleWasSelected = circleSelectedRef.current;
      const rectangleWasSelected = rectangleSelectedRef.current;
      const box3dWasSelected = box3dSelectedRef.current;
      const selectedExtrasBefore = [...selectedExtraOvalIdsRef.current];
      const shiftAdd = e.shiftKey;
      /** False when clicking primary again while already selected (e.g. drag) — keep multi-selection. */
      const clearOtherShapes = !shiftAdd && !primaryWasSelected;

      if (shiftAdd) {
        setOvalSelected(true);
      } else if (clearOtherShapes) {
        setOvalSelected(true);
        setCircleSelected(false);
        setRectangleSelected(false);
        setBox3dSelected(false);
        setSelectedExtraOvalIds([]);
      } else {
        setOvalSelected(true);
      }

      const extrasForPan =
        shiftAdd || primaryWasSelected ? selectedExtrasBefore : [];
      const extraOvalPan = buildExtraOvalPanRecord(extrasForPan, extraOvals);

      const ovalCountBefore =
        (primaryWasSelected ? 1 : 0) + selectedExtrasBefore.length;
      const multiOvalSelection = ovalCountBefore > 1;

      const panSnap = {
        moveOval: true,
        moveCircle:
          !clearOtherShapes && circleWasSelected && (shiftAdd || primaryWasSelected),
        moveRectangle:
          !clearOtherShapes && rectangleWasSelected && (shiftAdd || primaryWasSelected),
        moveBox3d:
          !clearOtherShapes && box3dWasSelected && (shiftAdd || primaryWasSelected),
        startOvalX: ovalOffsetX,
        startOvalY: ovalOffsetY,
        startCircleX: circleOffsetX,
        startCircleY: circleOffsetY,
        startRectX: rectangleOffsetX,
        startRectY: rectangleOffsetY,
        startBox3dX: box3dOffsetX,
        startBox3dY: box3dOffsetY,
        ...(extraOvalPan ? { extraOvalPan } : {}),
      };

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

      if (
        multiOvalSelection &&
        e.button === 0 &&
        !e.shiftKey &&
        !e.altKey &&
        inBoundingBox
      ) {
        const startX = e.clientX;
        const startY = e.clientY;
        const flipX = 1;
        const flipY = 1;
        bindGesture((ev: PointerEvent) => {
          const dx = (ev.clientX - startX) * flipX;
          const dy = (ev.clientY - startY) * flipY;
          applyGroupPanDelta(dx, dy, panSnap);
        }, "move");
        return;
      }

      const otherShapeSelectedForShiftScale =
        circleWasSelected ||
        rectangleWasSelected ||
        box3dWasSelected ||
        selectedExtrasBefore.length > 0;

      if (
        !multiOvalSelection &&
        e.shiftKey &&
        !e.altKey &&
        e.button === 0 &&
        inOval &&
        !otherShapeSelectedForShiftScale
      ) {
        const r0 = Math.max(10, Math.hypot(e.clientX - scx, e.clientY - scy));
        const startW = rw;
        const startH = rh;
        bindGesture((ev: PointerEvent) => {
          const r = Math.max(10, Math.hypot(ev.clientX - scx, ev.clientY - scy));
          const factor = r / r0;
          const w = Math.min(560, Math.max(80, Math.round((startW * factor) / 4) * 4));
          const h = Math.min(560, Math.max(48, Math.round(startH * factor)));
          setOvalWidth(w);
          setOvalHeightPx(h);
        }, "ns-resize");
        return;
      }

      if (
        !multiOvalSelection &&
        cornerIndex === null &&
        edgeKind === null &&
        !e.shiftKey &&
        !e.altKey &&
        e.button === 0 &&
        inOval &&
        nearRim
      ) {
        const r0 = Math.max(10, Math.hypot(e.clientX - scx, e.clientY - scy));
        const startW = rw;
        const startH = rh;
        bindGesture((ev: PointerEvent) => {
          const r = Math.max(10, Math.hypot(ev.clientX - scx, ev.clientY - scy));
          const factor = r / r0;
          const w = Math.min(560, Math.max(80, Math.round((startW * factor) / 4) * 4));
          const h = Math.min(560, Math.max(48, Math.round(startH * factor)));
          setOvalWidth(w);
          setOvalHeightPx(h);
        }, "ns-resize");
        return;
      }

      if (cornerIndex !== null && !multiOvalSelection) {
        const startW = rw;
        const startH = rh;
        const startClientX = e.clientX;
        const startClientY = e.clientY;
        const flipX = 1;
        const flipY = 1;
        const mults = [
          [-2, -2],
          [2, -2],
          [2, 2],
          [-2, 2],
        ] as const;
        const [mx, my] = mults[cornerIndex];
        const cursors = ["nwse-resize", "nesw-resize", "nwse-resize", "nesw-resize"] as const;
        bindGesture((ev: PointerEvent) => {
          const dxScreen = (ev.clientX - startClientX) * flipX;
          const dyScreen = (ev.clientY - startClientY) * flipY;
          // Convert screen delta → local delta (undo zoomContainer scale only).
          // We intentionally do NOT undo `imageRotate` or `ovalRotateDeg` so resizing follows the
          // mouse pull direction on screen, regardless of current orientation.
          const invScale = 1 / Math.max(1e-6, imageScaleRef.current || 1);
          const dx = dxScreen * invScale;
          const dy = dyScreen * invScale;
          const w = Math.min(560, Math.max(80, Math.round((startW + mx * dx) / 4) * 4));
          const h = Math.min(560, Math.max(48, Math.round(startH + my * dy)));
          setOvalWidth(w);
          setOvalHeightPx(h);
        }, cursors[cornerIndex]);
        return;
      }

      if (edgeKind !== null && !multiOvalSelection) {
        const startW = rw;
        const startH = rh;
        const startClientX = e.clientX;
        const startClientY = e.clientY;
        const flipX = 1;
        const flipY = 1;
        // "Top" should mean screen-north. When the oval is rotated, the screen-north edge may
        // correspond more to its width than its height.
        const dx0 = e.clientX - scx;
        const dy0 = e.clientY - scy;
        const edgeKindScreen: "top" | "bottom" | "left" | "right" =
          Math.abs(dy0) >= Math.abs(dx0)
            ? dy0 <= 0
              ? "top"
              : "bottom"
            : dx0 <= 0
              ? "left"
              : "right";
        const cursor =
          edgeKindScreen === "top" || edgeKindScreen === "bottom" ? "ns-resize" : "ew-resize";
        bindGesture((ev: PointerEvent) => {
          const dxScreen = (ev.clientX - startClientX) * flipX;
          const dyScreen = (ev.clientY - startClientY) * flipY;
          // Convert screen delta → local delta (undo zoomContainer scale only).
          // We intentionally do NOT undo `imageRotate` or `ovalRotateDeg` so resizing follows the
          // mouse pull direction on screen, regardless of current orientation.
          const invScale = 1 / Math.max(1e-6, imageScaleRef.current || 1);
          const dx = dxScreen * invScale;
          const dy = dyScreen * invScale;
          const applyWidth = (delta: number) =>
            setOvalWidth(Math.min(560, Math.max(80, Math.round((startW + delta) / 4) * 4)));
          const applyHeight = (delta: number) =>
            setOvalHeightPx(Math.min(560, Math.max(48, Math.round(startH + delta))));
          const θo = (ovalRotateDeg * Math.PI) / 180;
          const cO = Math.cos(θo);
          const sO = Math.sin(θo);
          // Screen vertical aligns with local height when |cos| dominates, otherwise aligns with local width.
          const verticalResizesHeight = Math.abs(cO) >= Math.abs(sO);
          const resizeVertical = (delta: number) => (verticalResizesHeight ? applyHeight(delta) : applyWidth(delta));
          const resizeHorizontal = (delta: number) => (verticalResizesHeight ? applyWidth(delta) : applyHeight(delta));

          if (edgeKindScreen === "top") {
            resizeVertical(-2 * dy);
          } else if (edgeKindScreen === "bottom") {
            resizeVertical(2 * dy);
          } else if (edgeKindScreen === "left") {
            resizeHorizontal(-2 * dx);
          } else {
            resizeHorizontal(2 * dx);
          }
        }, cursor);
        return;
      }

      if (e.shiftKey && e.altKey && e.button === 0 && inOval) {
        const startX = e.clientX;
        const startY = e.clientY;
        const flipX = 1;
        const flipY = 1;
        bindGesture((ev: PointerEvent) => {
          const dx = (ev.clientX - startX) * flipX;
          const dy = (ev.clientY - startY) * flipY;
          applyGroupPanDelta(dx, dy, panSnap);
        }, "move");
        return;
      }

      if (!multiOvalSelection && e.altKey && !e.shiftKey && e.button === 0 && inOval) {
        const startRotDeg = ovalRotateDeg;
        const rotSign = 1;
        const θ0 = Math.atan2(e.clientY - scy, e.clientX - scx);
        bindGesture((ev: PointerEvent) => {
          const θ = Math.atan2(ev.clientY - scy, ev.clientX - scx);
          const deltaDeg = ((θ - θ0) * 180) / Math.PI;
          setOvalRotateDeg(normalizeDeg(startRotDeg + rotSign * deltaDeg));
        }, "grabbing");
        return;
      }

      if (e.button === 0 && !e.shiftKey && !e.altKey && inOval) {
        if (Math.hypot(lp.x - lcx, lp.y - lcy) <= chHalf + 10) {
          const startX = e.clientX;
          const startY = e.clientY;
          const flipX = 1;
          const flipY = 1;
          bindGesture((ev: PointerEvent) => {
            const dx = (ev.clientX - startX) * flipX;
            const dy = (ev.clientY - startY) * flipY;
            applyGroupPanDelta(dx, dy, panSnap);
          }, "move");
          return;
        }
      }

      const startX = e.clientX;
      const startY = e.clientY;
      const flipX = 1;
      const flipY = 1;
      bindGesture((ev: PointerEvent) => {
        const dx = (ev.clientX - startX) * flipX;
        const dy = (ev.clientY - startY) * flipY;
        applyGroupPanDelta(dx, dy, panSnap);
      }, "move");
    },
    [
      applyGroupPanDelta,
      ovalWidth,
      ovalHeightPx,
      ovalRotateDeg,
      ovalOffsetX,
      ovalOffsetY,
      circleOffsetX,
      circleOffsetY,
      rectangleOffsetX,
      rectangleOffsetY,
      box3dOffsetX,
      box3dOffsetY,
      extraOvals,
    ]
  );

  const handleCirclePointerDown = useCallback(
    (e: React.PointerEvent<SVGSVGElement>) => {
      setPencilEnabled(false);
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
      const cornerSz = CIRCLE_BOUNDING_CORNER_SIZE;
      const cornerHalf = cornerSz / 2;
      const cornerHitHalf = cornerHalf + Math.max(7, d * 0.04);

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
          lp.x >= bx - cornerHitHalf &&
          lp.x <= bx + cornerHitHalf &&
          lp.y >= by - cornerHitHalf &&
          lp.y <= by + cornerHitHalf
        ) {
          cornerIndex = i;
          break;
        }
      }
      const edgeDepth = Math.max(10, Math.min(22, d * 0.12));
      const edgeInset = cornerHalf + 2;
      const inTopEdge =
        lp.x >= boxL + edgeInset &&
        lp.x <= boxL + boxWi - edgeInset &&
        lp.y >= boxT - edgeDepth &&
        lp.y <= boxT + edgeDepth;
      const inBottomEdge =
        lp.x >= boxL + edgeInset &&
        lp.x <= boxL + boxWi - edgeInset &&
        lp.y >= boxT + boxHi - edgeDepth &&
        lp.y <= boxT + boxHi + edgeDepth;
      const inLeftEdge =
        lp.x >= boxL - edgeDepth &&
        lp.x <= boxL + edgeDepth &&
        lp.y >= boxT + edgeInset &&
        lp.y <= boxT + boxHi - edgeInset;
      const inRightEdge =
        lp.x >= boxL + boxWi - edgeDepth &&
        lp.x <= boxL + boxWi + edgeDepth &&
        lp.y >= boxT + edgeInset &&
        lp.y <= boxT + boxHi - edgeInset;
      const edgeCursor = inTopEdge || inBottomEdge ? "ns-resize" : inLeftEdge || inRightEdge ? "ew-resize" : null;

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
      const r0 = Math.max(0.01, Math.hypot(e.clientX - scx, e.clientY - scy));
      const rEdge = (rxPix + ryPix) / 2;
      const edgeBand = Math.max(12, rEdge * 0.16);
      const nearCircleRim = Math.abs(r0 - rEdge) <= edgeBand;

      const inBoundingBox =
        lp.x >= boxL && lp.x <= boxL + boxWi && lp.y >= boxT && lp.y <= boxT + boxHi;

      if (
        cornerIndex === null &&
        edgeCursor === null &&
        !inCircle &&
        !inCrosshair &&
        !nearCircleRim &&
        !inBoundingBox
      )
        return;

      e.preventDefault();
      e.stopPropagation();
      pushUndoSnapshotRef.current();
      const pointerId = e.pointerId;
      svg.setPointerCapture(pointerId);

      const ovalWasSelected = ovalSelectedRef.current;
      const rectangleWasSelected = rectangleSelectedRef.current;
      const box3dWasSelected = box3dSelectedRef.current;
      const selectedExtrasBefore = [...selectedExtraOvalIdsRef.current];
      const shiftAdd = e.shiftKey;

      if (shiftAdd) {
        setCircleSelected(true);
      } else {
        setCircleSelected(true);
        setOvalSelected(false);
        setRectangleSelected(false);
        setBox3dSelected(false);
        setSelectedExtraOvalIds([]);
      }

      const extraOvalPan = buildExtraOvalPanRecord(
        shiftAdd && ovalWasSelected ? selectedExtrasBefore : [],
        extraOvals
      );

      const panSnap = {
        moveOval: shiftAdd && ovalWasSelected,
        moveCircle: true,
        moveRectangle: shiftAdd && rectangleWasSelected,
        moveBox3d: shiftAdd && box3dWasSelected,
        startOvalX: ovalOffsetX,
        startOvalY: ovalOffsetY,
        startCircleX: circleOffsetX,
        startCircleY: circleOffsetY,
        startRectX: rectangleOffsetX,
        startRectY: rectangleOffsetY,
        startBox3dX: box3dOffsetX,
        startBox3dY: box3dOffsetY,
        ...(extraOvalPan ? { extraOvalPan } : {}),
      };

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

      const otherShapeSelectedForShiftScale =
        ovalWasSelected ||
        rectangleWasSelected ||
        box3dWasSelected ||
        selectedExtrasBefore.length > 0;

      if (e.shiftKey && inCircle && !otherShapeSelectedForShiftScale) {
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
        edgeCursor === null &&
        !e.shiftKey &&
        !e.altKey &&
        e.button === 0 &&
        inCircle
      ) {
        if (nearCircleRim) {
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

      if (edgeCursor !== null) {
        const startD = circleDiameterPx;
        const r0 = Math.max(0.01, Math.hypot(e.clientX - scx, e.clientY - scy));
        bindGesture((ev: PointerEvent) => {
          const r = Math.max(0.01, Math.hypot(ev.clientX - scx, ev.clientY - scy));
          const nd = Math.min(560, Math.max(48, Math.round(((startD * r) / r0) / 4) * 4));
          setCircleDiameterPx(nd);
        }, edgeCursor);
        return;
      }

      if (e.altKey && inCircle) {
        const startRotDeg = circleRotateDeg;
        const rotSign = 1;
        const θ0 = Math.atan2(e.clientY - scy, e.clientX - scx);
        bindGesture((ev: PointerEvent) => {
          const θ = Math.atan2(ev.clientY - scy, ev.clientX - scx);
          const deltaDeg = ((θ - θ0) * 180) / Math.PI;
          setCircleRotateDeg(normalizeDeg(startRotDeg + rotSign * deltaDeg));
        }, "grabbing");
        return;
      }

      const startX = e.clientX;
      const startY = e.clientY;
      const flipX = 1;
      const flipY = 1;
      bindGesture((ev: PointerEvent) => {
        const dx = (ev.clientX - startX) * flipX;
        const dy = (ev.clientY - startY) * flipY;
        applyGroupPanDelta(dx, dy, panSnap);
      }, "move");
    },
    [
      applyGroupPanDelta,
      circleDiameterPx,
      circleSvgSize,
      circleCrosshairHalf,
      circleRotateDeg,
      circleOffsetX,
      circleOffsetY,
      ovalOffsetX,
      ovalOffsetY,
      rectangleOffsetX,
      rectangleOffsetY,
      box3dOffsetX,
      box3dOffsetY,
      extraOvals,
    ]
  );

  const handleRectanglePointerDown = useCallback(
    (e: React.PointerEvent<SVGSVGElement>) => {
      setPencilEnabled(false);
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

      const inRect = pointInRotatedRect(
        e.clientX,
        e.clientY,
        scx,
        scy,
        rectangleRotateDeg,
        hxPix,
        hyPix
      );

      const inBoundingBox =
        lp.x >= boxL && lp.x <= boxL + boxWi && lp.y >= boxT && lp.y <= boxT + boxHi;

      if (cornerIndex === null && edgeKind === null && !inRect && !inBoundingBox) return;

      e.preventDefault();
      e.stopPropagation();
      pushUndoSnapshotRef.current();
      const pointerId = e.pointerId;
      svg.setPointerCapture(pointerId);

      const ovalWasSelected = ovalSelectedRef.current;
      const circleWasSelected = circleSelectedRef.current;
      const box3dWasSelected = box3dSelectedRef.current;
      const selectedExtrasBefore = [...selectedExtraOvalIdsRef.current];
      const shiftAdd = e.shiftKey;

      if (shiftAdd) {
        setRectangleSelected(true);
      } else {
        setRectangleSelected(true);
        setOvalSelected(false);
        setCircleSelected(false);
        setBox3dSelected(false);
        setSelectedExtraOvalIds([]);
      }

      const extraOvalPan = buildExtraOvalPanRecord(
        shiftAdd && ovalWasSelected ? selectedExtrasBefore : [],
        extraOvals
      );

      const panSnap = {
        moveOval: shiftAdd && ovalWasSelected,
        moveCircle: shiftAdd && circleWasSelected,
        moveRectangle: true,
        moveBox3d: shiftAdd && box3dWasSelected,
        startOvalX: ovalOffsetX,
        startOvalY: ovalOffsetY,
        startCircleX: circleOffsetX,
        startCircleY: circleOffsetY,
        startRectX: rectangleOffsetX,
        startRectY: rectangleOffsetY,
        startBox3dX: box3dOffsetX,
        startBox3dY: box3dOffsetY,
        ...(extraOvalPan ? { extraOvalPan } : {}),
      };

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

      const otherShapeSelectedForShiftScale =
        ovalWasSelected ||
        circleWasSelected ||
        box3dWasSelected ||
        selectedExtrasBefore.length > 0;

      if (e.shiftKey && inRect && !otherShapeSelectedForShiftScale) {
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
        const flipX = 1;
        const flipY = 1;
        const mults = [
          [-2, -2],
          [2, -2],
          [2, 2],
          [-2, 2],
        ] as const;
        const [mx, my] = mults[cornerIndex];
        const cursors = ["nwse-resize", "nesw-resize", "nwse-resize", "nesw-resize"] as const;
        bindGesture((ev: PointerEvent) => {
          const dx = (ev.clientX - startClientX) * flipX;
          const dy = (ev.clientY - startClientY) * flipY;
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
        const flipX = 1;
        const flipY = 1;
        if (edgeKind === "top" || edgeKind === "bottom") {
          const my = edgeKind === "top" ? -2 : 2;
          bindGesture((ev: PointerEvent) => {
            const dy = (ev.clientY - startClientY) * flipY;
            const h = Math.min(560, Math.max(48, Math.round(startH + my * dy)));
            setRectangleHeightPx(h);
          }, "ns-resize");
          return;
        }
        const mx = edgeKind === "left" ? -2 : 2;
        bindGesture((ev: PointerEvent) => {
          const dx = (ev.clientX - startClientX) * flipX;
          const w = Math.min(560, Math.max(80, Math.round((startW + mx * dx) / 4) * 4));
          setRectangleWidth(w);
        }, "ew-resize");
        return;
      }

      if (e.altKey && inRect) {
        const startRotDeg = rectangleRotateDeg;
        const rotSign = 1;
        const θ0 = Math.atan2(e.clientY - scy, e.clientX - scx);
        bindGesture((ev: PointerEvent) => {
          const θ = Math.atan2(ev.clientY - scy, ev.clientX - scx);
          const deltaDeg = ((θ - θ0) * 180) / Math.PI;
          setRectangleRotateDeg(normalizeDeg(startRotDeg + rotSign * deltaDeg));
        }, "grabbing");
        return;
      }

      const startX = e.clientX;
      const startY = e.clientY;
      const flipX = 1;
      const flipY = 1;
      bindGesture((ev: PointerEvent) => {
        const dx = (ev.clientX - startX) * flipX;
        const dy = (ev.clientY - startY) * flipY;
        applyGroupPanDelta(dx, dy, panSnap);
      }, "move");
    },
    [
      applyGroupPanDelta,
      rectangleWidth,
      rectangleHeightPx,
      rectangleRotateDeg,
      rectangleOffsetX,
      rectangleOffsetY,
      ovalOffsetX,
      ovalOffsetY,
      circleOffsetX,
      circleOffsetY,
      box3dOffsetX,
      box3dOffsetY,
      extraOvals,
    ]
  );

  const handleBox3dPointerDown = useCallback(
    (e: React.PointerEvent<SVGSVGElement>) => {
      setPencilEnabled(false);
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

      const inViewBox =
        lp.x >= 0 && lp.x <= layout.vbW && lp.y >= 0 && lp.y <= layout.vbH;
      if (cornerIndex === null && edgeIndex === null && !inBox3d && !inViewBox) return;
      if (e.button !== 0 && e.button !== 1 && e.button !== 2) return;

      e.preventDefault();
      e.stopPropagation();
      pushUndoSnapshotRef.current();
      const pointerId = e.pointerId;
      svg.setPointerCapture(pointerId);

      const ovalWasSelected = ovalSelectedRef.current;
      const circleWasSelected = circleSelectedRef.current;
      const rectangleWasSelected = rectangleSelectedRef.current;
      const selectedExtrasBefore = [...selectedExtraOvalIdsRef.current];
      const shiftAdd = e.shiftKey;

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
      if (!shiftAdd) {
        setOvalSelected(false);
        setCircleSelected(false);
        setRectangleSelected(false);
        setSelectedExtraOvalIds([]);
      }

      const extraOvalPan = buildExtraOvalPanRecord(
        shiftAdd && ovalWasSelected ? selectedExtrasBefore : [],
        extraOvals
      );

      const panSnap = {
        moveOval: shiftAdd && ovalWasSelected,
        moveCircle: shiftAdd && circleWasSelected,
        moveRectangle: shiftAdd && rectangleWasSelected,
        moveBox3d: true,
        startOvalX: ovalOffsetX,
        startOvalY: ovalOffsetY,
        startCircleX: circleOffsetX,
        startCircleY: circleOffsetY,
        startRectX: rectangleOffsetX,
        startRectY: rectangleOffsetY,
        startBox3dX: box3dOffsetX,
        startBox3dY: box3dOffsetY,
        ...(extraOvalPan ? { extraOvalPan } : {}),
      };

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

      const otherShapeSelectedForShiftScale =
        ovalWasSelected ||
        circleWasSelected ||
        rectangleWasSelected ||
        selectedExtrasBefore.length > 0;

      if (
        e.shiftKey &&
        !e.altKey &&
        e.button === 0 &&
        inBox3d &&
        !otherShapeSelectedForShiftScale
      ) {
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
        const flipX = 1;
        const flipY = 1;
        const mults = [
          [-2, -2],
          [2, -2],
          [2, 2],
          [-2, 2],
        ] as const;
        const [mx, my] = mults[cornerIndex];
        const cursors = ["nwse-resize", "nesw-resize", "nwse-resize", "nesw-resize"] as const;
        bindGesture((ev: PointerEvent) => {
          const dx = (ev.clientX - startClientX) * flipX;
          const dy = (ev.clientY - startClientY) * flipY;
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
        const flipX = 1;
        const flipY = 1;
        bindGesture((ev: PointerEvent) => {
          const dx = (ev.clientX - startX) * flipX;
          const dy = (ev.clientY - startY) * flipY;
          applyGroupPanDelta(dx, dy, panSnap);
        }, "move");
        return;
      }

      if (e.altKey && !e.shiftKey && e.button === 0 && inBox3d) {
        const startRotDeg = box3dRotateDeg;
        const rotSign = 1;
        const θ0 = Math.atan2(e.clientY - scy, e.clientX - scx);
        bindGesture((ev: PointerEvent) => {
          const θ = Math.atan2(ev.clientY - scy, ev.clientX - scx);
          const deltaDeg = ((θ - θ0) * 180) / Math.PI;
          setBox3dRotateDeg(normalizeDeg(startRotDeg + rotSign * deltaDeg));
        }, "grabbing");
        return;
      }

      if (e.button === 0 && !e.shiftKey && !e.altKey && inBox3d) {
        const ccx = layout.vbW / 2;
        const ccy = layout.vbH / 2;
        const chHalf = Math.max(10, Math.min(rw, rh) * 0.11);
        if (Math.hypot(lp.x - ccx, lp.y - ccy) <= chHalf + 10) {
          const startX = e.clientX;
          const startY = e.clientY;
          const flipX = 1;
          const flipY = 1;
          bindGesture((ev: PointerEvent) => {
            const dx = (ev.clientX - startX) * flipX;
            const dy = (ev.clientY - startY) * flipY;
            applyGroupPanDelta(dx, dy, panSnap);
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
    [
      applyGroupPanDelta,
      box3dWidth,
      box3dHeightPx,
      box3dDepthPx,
      box3dYawDeg,
      box3dPitchDeg,
      box3dRotateDeg,
      box3dOffsetX,
      box3dOffsetY,
      box3dActiveEdgeIndex,
      ovalOffsetX,
      ovalOffsetY,
      circleOffsetX,
      circleOffsetY,
      rectangleOffsetX,
      rectangleOffsetY,
      extraOvals,
    ]
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
        true
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
        ovalRotateDeg,
        true
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
        true
      );
    },
    [circleDiameterPx, circleRotateDeg]
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
        true
      );
    },
    [circleDiameterPx, circleRotateDeg]
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
        true
      );
    },
    [rectangleWidth, rectangleHeightPx, rectangleRotateDeg]
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
        true
      );
    },
    [rectangleWidth, rectangleHeightPx, rectangleRotateDeg]
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
        true
      );
    },
    [box3dWidth, box3dHeightPx, box3dDepthPx, box3dYawDeg, box3dPitchDeg]
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
        true
      );
    },
    [box3dWidth, box3dHeightPx, box3dDepthPx, box3dYawDeg, box3dPitchDeg]
  );

  const handleBox3dSvgPointerLeave = useCallback(() => {
    pointerInsideBox3dSvgRef.current = false;
    lastPointerOnBox3dSvgRef.current = null;
    const svg = box3dSvgRef.current;
    if (svg) svg.style.cursor = "grab";
  }, []);

  useEffect(() => {
    if (!currentUrl || !showOval) return;
    const syncModifierCursor = (e: KeyboardEvent) => {
      if (!["Alt", "Shift"].includes(e.key)) return;
      if (!pointerInsideOvalSvgRef.current) return;
      const svg = ovalSvgRef.current;
      const pt = lastPointerOnOvalSvgRef.current;
      if (!svg || !pt) return;
      svg.style.cursor = resolveOvalSvgPointerCursor(
        svg,
        pt.x,
        pt.y,
        e.altKey,
        e.shiftKey,
        ovalWidth,
        ovalHeightPx,
        ovalRotateDegRef.current,
        true
      );
    };
    window.addEventListener("keydown", syncModifierCursor);
    window.addEventListener("keyup", syncModifierCursor);
    return () => {
      window.removeEventListener("keydown", syncModifierCursor);
      window.removeEventListener("keyup", syncModifierCursor);
    };
  }, [currentUrl, showOval, ovalWidth, ovalHeightPx]);

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
        true
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
        true
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
        true
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
      setSelectedExtraOvalIds([]);
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
        // circleHitAreaRef can be larger than the drawn circle (we extend crosshairs).
        // Treat any actionable circle hit zone (rim/corners/edges/body) as "inside"
        // so dragging square handles never falls through to deselect/rotate-from-outside.
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
          const lp = clientPointToSvgUser(svg, ev.clientX, ev.clientY);
          const inEllipse = pointInRotatedEllipse(
            ev.clientX,
            ev.clientY,
            scx,
            scy,
            circleRotateDegRef.current,
            rxPix,
            ryPix
          );
          const r0 = Math.max(0.01, Math.hypot(ev.clientX - scx, ev.clientY - scy));
          const rEdge = (rxPix + ryPix) / 2;
          const edgeBand = Math.max(12, rEdge * 0.16);
          const nearCircleRim = Math.abs(r0 - rEdge) <= edgeBand;
          let inCornerOrEdge = false;
          if (lp) {
            const d = circleDiameterPx;
            const lcx = circleSvgSize / 2;
            const lcy = circleSvgSize / 2;
            const lr = Math.max(4, d / 2 - 4);
            const boxL = lcx - lr;
            const boxT = lcy - lr;
            const boxWi = 2 * lr;
            const boxHi = 2 * lr;
            const cornerSz = CIRCLE_BOUNDING_CORNER_SIZE;
            const cornerHalf = cornerSz / 2;
            const cornerHitHalf = cornerHalf + Math.max(7, d * 0.04);
            const cornerPts = [
              [boxL, boxT],
              [boxL + boxWi, boxT],
              [boxL + boxWi, boxT + boxHi],
              [boxL, boxT + boxHi],
            ] as const;
            for (let i = 0; i < 4; i++) {
              const [bx, by] = cornerPts[i];
              if (
                lp.x >= bx - cornerHitHalf &&
                lp.x <= bx + cornerHitHalf &&
                lp.y >= by - cornerHitHalf &&
                lp.y <= by + cornerHitHalf
              ) {
                inCornerOrEdge = true;
                break;
              }
            }
            if (!inCornerOrEdge) {
              const edgeDepth = Math.max(10, Math.min(22, d * 0.12));
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
              inCornerOrEdge = inTop || inBottom || inLeft || inRight;
            }
          }
          if (inEllipse || nearCircleRim || inCornerOrEdge) return;
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

      const multiSelectCount =
        (ovalSelectedRef.current ? 1 : 0) +
        (circleSelectedRef.current ? 1 : 0) +
        (rectangleSelectedRef.current ? 1 : 0) +
        (box3dSelectedRef.current ? 1 : 0) +
        selectedExtraOvalIdsRef.current.length;
      if (multiSelectCount > 1) return;

      const useOval = ovalSelectedRef.current;
      const useCircle = circleSelectedRef.current;
      const useRectangle = rectangleSelectedRef.current;
      const useBox3d = box3dSelectedRef.current;

      const stage = slideshowStageRef.current;
      const t = ev.target;
      if (!(t instanceof Node) || !stage?.contains(t)) {
        ovalSelectedRef.current = false;
        setOvalSelected(false);
        setSelectedExtraOvalIds([]);
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
          setSelectedExtraOvalIds([]);
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
        setSelectedExtraOvalIds([]);
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
            setSelectedExtraOvalIds([]);
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
    if (
      !ovalSelected &&
      selectedExtraOvalIds.length === 0 &&
      !circleSelected &&
      !rectangleSelected &&
      !box3dSelected
    )
      setDeckCursorMode("grab");
  }, [ovalSelected, selectedExtraOvalIds.length, circleSelected, rectangleSelected, box3dSelected]);

  useEffect(() => {
    if (!showPose) return;
    let cancelled = false;
    (async () => {
      try {
        if (poseLandmarkerRef.current) {
          if (!cancelled) setPoseReady(true);
          return;
        }
        const { FilesetResolver, PoseLandmarker } = await import("@mediapipe/tasks-vision");
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

        // hands (wrist -> thumb/index/pinky; plus a simple palm edge)
        line(15, 21); // left thumb
        line(15, 19); // left index
        line(15, 17); // left pinky
        line(17, 19); // left palm
        line(16, 22); // right thumb
        line(16, 20); // right index
        line(16, 18); // right pinky
        line(18, 20); // right palm

        // feet (ankle -> heel/toe; plus heel-to-toe edge)
        line(27, 29); // left heel
        line(27, 31); // left toe
        line(29, 31); // left foot
        line(28, 30); // right heel
        line(28, 32); // right toe
        line(30, 32); // right foot

        // Finger/toe indications (Pose Landmarker doesn't provide full finger/toe chains).
        // We draw short "fans" from the available tips to make hands/feet read more clearly.
        const nrm = (x: number, y: number): [number, number] => {
          const len = Math.hypot(x, y);
          if (len < 1e-6) return [1, 0];
          return [x / len, y / len];
        };
        const seg = (a: [number, number], b: [number, number]) => {
          ctx.beginPath();
          ctx.moveTo(a[0], a[1]);
          ctx.lineTo(b[0], b[1]);
          ctx.stroke();
        };
        const extendRay = (from: [number, number], through: [number, number], lenPx: number): [number, number] => {
          const [ux, uy] = nrm(through[0] - from[0], through[1] - from[1]);
          return [through[0] + ux * lenPx, through[1] + uy * lenPx];
        };
        const fanFromTip = (base: [number, number], tip: [number, number], lenPx: number, spread: number) => {
          const [ux, uy] = nrm(tip[0] - base[0], tip[1] - base[1]);
          const [px, py] = [-uy, ux];
          const end = [tip[0] + ux * lenPx, tip[1] + uy * lenPx] as [number, number];
          const endL = [end[0] + px * spread, end[1] + py * spread] as [number, number];
          const endR = [end[0] - px * spread, end[1] - py * spread] as [number, number];
          seg(tip, endL);
          seg(tip, end);
          seg(tip, endR);
        };

        // Fingers: use wrist (15/16) and thumb/index/pinky tips.
        const lw = toXY(15);
        const lt = toXY(21);
        const li = toXY(19);
        const lp = toXY(17);
        if (lw && lt) fanFromTip(lw, lt, 12, 2.2);
        if (lw && li) fanFromTip(lw, li, 14, 2.6);
        if (lw && lp) fanFromTip(lw, lp, 12, 2.2);
        const rw = toXY(16);
        const rt = toXY(22);
        const ri = toXY(20);
        const rp = toXY(18);
        if (rw && rt) fanFromTip(rw, rt, 12, 2.2);
        if (rw && ri) fanFromTip(rw, ri, 14, 2.6);
        if (rw && rp) fanFromTip(rw, rp, 12, 2.2);

        // Toes: use ankle->toe direction to place a small 3-toe spread at toe tip.
        const la = toXY(27);
        const ltoe = toXY(31);
        if (la && ltoe) {
          const [ux, uy] = nrm(ltoe[0] - la[0], ltoe[1] - la[1]);
          const [px, py] = [-uy, ux];
          const t1 = extendRay(la, ltoe, 10);
          const t2 = [t1[0] + px * 4, t1[1] + py * 4] as [number, number];
          const t3 = [t1[0] - px * 4, t1[1] - py * 4] as [number, number];
          seg(ltoe, t2);
          seg(ltoe, t1);
          seg(ltoe, t3);
        }
        const ra = toXY(28);
        const rtoe = toXY(32);
        if (ra && rtoe) {
          const [ux, uy] = nrm(rtoe[0] - ra[0], rtoe[1] - ra[1]);
          const [px, py] = [-uy, ux];
          const t1 = extendRay(ra, rtoe, 10);
          const t2 = [t1[0] + px * 4, t1[1] + py * 4] as [number, number];
          const t3 = [t1[0] - px * 4, t1[1] - py * 4] as [number, number];
          seg(rtoe, t2);
          seg(rtoe, t1);
          seg(rtoe, t3);
        }

        const neck = mid(11, 12);
        const pelvis = mid(23, 24);
        if (neck && pelvis) {
          ctx.beginPath();
          ctx.moveTo(neck[0], neck[1]);
          ctx.lineTo(pelvis[0], pelvis[1]);
          ctx.stroke();
        }

        // Distinct pelvis marker (helpful for figure drawing): diamond centered on hip midpoint.
        const hipL = toXY(23);
        const hipR = toXY(24);
        if (pelvis && hipL && hipR) {
          const halfW = Math.max(6, Math.hypot(hipL[0] - hipR[0], hipL[1] - hipR[1]) * 0.18);
          const halfH = Math.max(4, halfW * 0.6);
          ctx.save();
          ctx.fillStyle = "rgba(255, 170, 0, 0.35)";
          ctx.strokeStyle = "rgba(255, 170, 0, 0.95)";
          ctx.lineWidth = 2.2;
          ctx.beginPath();
          ctx.moveTo(pelvis[0], pelvis[1] - halfH);
          ctx.lineTo(pelvis[0] + halfW, pelvis[1]);
          ctx.lineTo(pelvis[0], pelvis[1] + halfH);
          ctx.lineTo(pelvis[0] - halfW, pelvis[1]);
          ctx.closePath();
          ctx.fill();
          ctx.stroke();
          ctx.restore();
        } else if (pelvis) {
          ctx.save();
          ctx.fillStyle = "rgba(255, 170, 0, 0.95)";
          ctx.beginPath();
          ctx.arc(pelvis[0], pelvis[1], 5.5, 0, Math.PI * 2);
          ctx.fill();
          ctx.restore();
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
        for (const i of [17, 19, 21, 18, 20, 22, 29, 31, 30, 32]) dot(i, 2.8);
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
          : selectedExtraOvalIdsRef.current.length > 0
            ? ovalLayersRef.current
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
  }, [
    currentUrl,
    showOval,
    showCircle,
    showRectangle,
    showBox3d,
    ovalSelected,
    selectedExtraOvalIds.length,
    circleSelected,
    rectangleSelected,
    box3dSelected,
  ]);

  useEffect(() => {
    const el = ovalSvgRef.current;
    if (!el || !currentUrl || !showOval) return;
    const rw = ovalWidth;
    const rh = ovalHeightPx;
    const rot = ovalRotateDeg;
    const onWheel = (ev: WheelEvent) => {
      const srect = el.getBoundingClientRect();
      const scx = srect.left + srect.width / 2;
      const scy = srect.top + srect.height / 2;
      const scaleX = srect.width / rw;
      const scaleY = srect.height / rh;
      const lerxGeom = Math.max(4, rw / 2 - 4);
      const leryGeom = Math.max(4, rh / 2 - 4);
      const rxPix = lerxGeom * scaleX;
      const ryPix = leryGeom * scaleY;
      if (!pointInRotatedEllipse(ev.clientX, ev.clientY, scx, scy, rot, rxPix, ryPix)) return;
      pushUndoSnapshotRef.current();
      ev.preventDefault();
      ev.stopPropagation();
      setOvalSelected(true);
      setSelectedExtraOvalIds([]);
      setCircleSelected(false);
      setRectangleSelected(false);
      setBox3dSelected(false);
      const dir = ev.deltaY > 0 ? -1 : 1;
      const step = ev.shiftKey ? 16 : 8;
      if (ev.shiftKey) {
        setOvalHeightPx((h) => Math.min(560, Math.max(48, Math.round(h + dir * step))));
      } else {
        setOvalWidth((w) => Math.min(560, Math.max(80, Math.round((w + dir * step) / 4) * 4)));
      }
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
      pushUndoSnapshotRef.current();
      ev.preventDefault();
      ev.stopPropagation();
      setCircleSelected(true);
      setOvalSelected(false);
      setSelectedExtraOvalIds([]);
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
      pushUndoSnapshotRef.current();
      ev.preventDefault();
      ev.stopPropagation();
      setRectangleSelected(true);
      setOvalSelected(false);
      setSelectedExtraOvalIds([]);
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
      pushUndoSnapshotRef.current();
      ev.preventDefault();
      ev.stopPropagation();
      setBox3dSelected(true);
      setOvalSelected(false);
      setSelectedExtraOvalIds([]);
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
  /** Shared transform for image + overlays, excluding flips.
   *  This keeps shapes independent when the image is mirrored (flip H/V).
   */
  const imageComposeTransform = useMemo(
    () =>
      `translate(${panX}px, ${panY}px) scale(${imageScale}) rotate(${imageRotate}deg)`,
    [panX, panY, imageScale, imageRotate]
  );
  const imagePlacementJustify = !imagePlacementEnabled
    ? "center"
    : imagePlacement === "left"
      ? "flex-start"
      : imagePlacement === "right"
        ? "flex-end"
        : "center";
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
  /** Hides only the raster slide; pencil, pose, and vector overlays stay. */
  const [mainImageHidden, setMainImageHidden] = useState(false);
  const [imageInfoExpanded, setImageInfoExpanded] = useState(false);
  const [imagePlacementExpanded, setImagePlacementExpanded] = useState(false);
  const [sidebarPanelTab, setSidebarPanelTab] = useState<"main" | "archive">("main");
  const [gridExpanded, setGridExpanded] = useState(false);
  const [centerFrameExpanded, setCenterFrameExpanded] = useState(false);
  const [ovalExpanded, setOvalExpanded] = useState(false);
  const [circleExpanded, setCircleExpanded] = useState(false);
  const [poseExpanded, setPoseExpanded] = useState(false);
  const [rectangleExpanded, setRectangleExpanded] = useState(false);
  const [box3dExpanded, setBox3dExpanded] = useState(false);
  const [pencilExpanded, setPencilExpanded] = useState(false);
  const [strokeCounterExpanded, setStrokeCounterExpanded] = useState(true);
  const [adjustImageExpanded, setAdjustImageExpanded] = useState(false);
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

  const spawnNewOval = useCallback(() => {
    pushUndoSnapshotRef.current();
    // Keep existing ovals as-is by pushing the current primary into extra ovals first.
    if (showOval) {
      const newId = String(extraOvalIdCounterRef.current++);
      setExtraOvals((prev) => [
        ...prev,
        {
          id: newId,
          width: ovalWidth,
          heightPx: ovalHeightPx,
          rotateDeg: ovalRotateDeg,
          offsetX: ovalOffsetX,
          offsetY: ovalOffsetY,
          shadeHighlight: ovalShadeHighlight,
          shadeShadow: ovalShadeShadow,
          shadeForm: ovalShadeForm,
          shadeOpacity: ovalShadeOpacity,
        },
      ]);
    }

    setShowOval(true);
    newOvalSpawnCounterRef.current += 1;
    const spawnStep = 24;
    const spawnOffset = spawnStep * newOvalSpawnCounterRef.current;

    // Default "new oval" should match the circle head dimensions.
    setOvalWidth(DEFAULT_SETTINGS.circleDiameterPx);
    setOvalHeightPx(DEFAULT_SETTINGS.circleDiameterPx);
    setOvalRotateDeg(DEFAULT_SETTINGS.ovalRotateDeg);
    const pt = lastStageClientPointRef.current;
    const z = zoomContainerRef.current;
    if (pt && z) {
      const r = z.getBoundingClientRect();
      const cx = r.left + r.width / 2;
      const cy = r.top + r.height / 2;
      const dxScreen = pt.x - cx;
      const dyScreen = pt.y - cy;
      const invScale = 1 / Math.max(1e-6, imageScaleRef.current || 1);
      const dx = dxScreen * invScale;
      const dy = dyScreen * invScale;
      const rad = (-imageRotate * Math.PI) / 180;
      const cos = Math.cos(rad);
      const sin = Math.sin(rad);
      const rx = dx * cos - dy * sin;
      const ry = dx * sin + dy * cos;
      setOvalOffsetX(rx);
      setOvalOffsetY(ry);
    } else {
      setOvalOffsetX(DEFAULT_SETTINGS.ovalOffsetX + spawnOffset);
      setOvalOffsetY(DEFAULT_SETTINGS.ovalOffsetY + spawnOffset);
    }
    setOvalShadeHighlight(DEFAULT_SETTINGS.ovalShadeHighlight);
    setOvalShadeShadow(DEFAULT_SETTINGS.ovalShadeShadow);
    setOvalShadeForm(DEFAULT_SETTINGS.ovalShadeForm);
    setOvalShadeOpacity(DEFAULT_SETTINGS.ovalShadeOpacity);

    setOvalSelected(true);
    setSelectedExtraOvalIds([]);
    setCircleSelected(false);
    setRectangleSelected(false);
    setBox3dSelected(false);
  }, [
    showOval,
    ovalWidth,
    ovalHeightPx,
    ovalRotateDeg,
    ovalOffsetX,
    ovalOffsetY,
    ovalShadeHighlight,
    ovalShadeShadow,
    ovalShadeForm,
    ovalShadeOpacity,
    imageRotate,
  ]);

  // Auto-open the last saved folder on refresh (if we have a prior valid handle).
  const didAutoOpenLastFolderRef = useRef(false);
  useEffect(() => {
    if (!supported) return;
    if (didAutoOpenLastFolderRef.current) return;
    const lastName = getLastFolderName();
    if (!lastName) return;

    didAutoOpenLastFolderRef.current = true;
    openLastFolder().catch(() => {
      // openLastFolder already alerts on failures; ignore here.
    });
  }, [supported]);

  useEffect(() => {
    if (prevTimerModeRef.current === "loop" && timerMode === "classic") {
      setClassicSlots({ ...CLASSIC_SLOTS_INITIAL });
      setIntervalSec(CLASSIC_FIRST_TIER);
      setIntervalsCompleted(0);
    }
    if (prevTimerModeRef.current === "classic" && timerMode === "loop") {
      setClassicSlots({ ...CLASSIC_SLOTS_INITIAL });
      setIntervalsCompleted(0);
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
    setImagePlacementEnabled(s.imagePlacementEnabled === true);
    setImagePlacement(
      s.imagePlacement === "left" || s.imagePlacement === "right" || s.imagePlacement === "center"
        ? s.imagePlacement
        : "center"
    );
    setPencilEnabled(s.pencilEnabled === true);
    setPencilSize(Math.min(24, Math.max(1, Number(s.pencilSize) || 4)));
    setPencilColor(typeof s.pencilColor === "string" && s.pencilColor ? s.pencilColor : "#ff3b30");
    {
      const v = Number(s.pencilCurveSensitivity);
      setPencilCurveSensitivity(
        Math.min(100, Math.max(0, Number.isFinite(v) ? v : DEFAULT_SETTINGS.pencilCurveSensitivity))
      );
    }
    {
      const t = Math.floor(Number(s.strokeAdvanceTarget));
      setStrokeAdvanceTarget(
        Number.isFinite(t) ? Math.min(999, Math.max(0, t)) : DEFAULT_SETTINGS.strokeAdvanceTarget
      );
    }
    setStrokeAdvanceDeleteMarks(s.strokeAdvanceDeleteMarks === true);
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
    {
      const hi = Number(s.ovalShadeHighlight);
      setOvalShadeHighlight(
        Math.min(100, Math.max(0, Number.isFinite(hi) ? hi : DEFAULT_SETTINGS.ovalShadeHighlight))
      );
      const sh = Number(s.ovalShadeShadow);
      setOvalShadeShadow(
        Math.min(100, Math.max(0, Number.isFinite(sh) ? sh : DEFAULT_SETTINGS.ovalShadeShadow))
      );
      const fo = Number(s.ovalShadeForm);
      setOvalShadeForm(Math.min(100, Math.max(0, Number.isFinite(fo) ? fo : DEFAULT_SETTINGS.ovalShadeForm)));
      const op = Number(s.ovalShadeOpacity);
      setOvalShadeOpacity(Math.min(100, Math.max(0, Number.isFinite(op) ? op : DEFAULT_SETTINGS.ovalShadeOpacity)));
    }
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
      imagePlacementEnabled,
      imagePlacement,
      pencilEnabled,
      pencilSize,
      pencilColor,
      pencilCurveSensitivity,
      strokeAdvanceTarget,
      strokeAdvanceDeleteMarks,
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
      ovalShadeHighlight,
      ovalShadeShadow,
      ovalShadeForm,
      ovalShadeOpacity,
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
      settingsSchemaVersion: SETTINGS_SCHEMA_VERSION,
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
    imagePlacementEnabled,
    imagePlacement,
    pencilEnabled,
    pencilSize,
    pencilColor,
    pencilCurveSensitivity,
    strokeAdvanceTarget,
    strokeAdvanceDeleteMarks,
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
    ovalShadeHighlight,
    ovalShadeShadow,
    ovalShadeForm,
    ovalShadeOpacity,
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

  useEffect(() => {
    setMainImageHidden(false);
  }, [currentFile?.name]);

  const hudNeighborFiles = useMemo(
    () => hudNeighborWindow(files, order, idxInOrder, currentFile?.key),
    [files, order, idxInOrder, currentFile?.key],
  );

  const goToHudNeighborFile = useCallback(
    (file: FileHandleEntry | null) => {
      if (!file || !order.length) return;
      const pos = order.findIndex((fi) => files[fi]?.name === file.name);
      if (pos < 0) return;
      setIdxInOrder(pos);
    },
    [files, order],
  );

  const [hudNeighborUrls, setHudNeighborUrls] = useState<Record<HudNeighborKey, string | null>>({
    p0: null,
    p1: null,
    n0: null,
    n1: null,
  });
  const [prevHudMinimized, setPrevHudMinimized] = useState(false);
  const [nextHudMinimized, setNextHudMinimized] = useState(false);
  /** Timer, transport, progress, and status — mini previews stay visible when false. */
  const [bottomHudChromeVisible, setBottomHudChromeVisible] = useState(true);

  useEffect(() => {
    const slots: { key: HudNeighborKey; file: FileHandleEntry | null }[] = [
      { key: "p0", file: hudNeighborFiles.p0 },
      { key: "p1", file: hudNeighborFiles.p1 },
      { key: "n0", file: hudNeighborFiles.n0 },
      { key: "n1", file: hudNeighborFiles.n1 },
    ];
    let cancelled = false;
    const created: string[] = [];
    void (async () => {
      const next: Record<HudNeighborKey, string | null> = {
        p0: null,
        p1: null,
        n0: null,
        n1: null,
      };
      for (const { key, file } of slots) {
        if (!file) continue;
        if (cancelled) return;
        const fname = file.name;
        const fromPrefetch = slidePrefetchRef.current.get(fname);
        if (fromPrefetch) {
          next[key] = fromPrefetch;
          continue;
        }
        try {
          const blob = await file.handle.getFile();
          if (cancelled) return;
          const u = URL.createObjectURL(blob);
          if (cancelled) {
            URL.revokeObjectURL(u);
            return;
          }
          const pref = slidePrefetchRef.current.get(fname);
          if (pref) {
            URL.revokeObjectURL(u);
            next[key] = pref;
          } else {
            created.push(u);
            next[key] = u;
          }
        } catch {
          next[key] = null;
        }
      }
      if (!cancelled) setHudNeighborUrls(next);
    })();
    return () => {
      cancelled = true;
      for (const u of created) URL.revokeObjectURL(u);
    };
  }, [
    hudNeighborFiles.p0?.name,
    hudNeighborFiles.p1?.name,
    hudNeighborFiles.n0?.name,
    hudNeighborFiles.n1?.name,
  ]);

  const hudPreviewStrip = Boolean(
    hudNeighborFiles.p0 ||
      hudNeighborFiles.p1 ||
      hudNeighborFiles.n0 ||
      hudNeighborFiles.n1,
  );
  const bottomHudDoubleRow = hudPreviewStrip && bottomHudChromeVisible;

  const renderBottomHudChromeToggle = (extraStyle: React.CSSProperties) => (
    <button
      type="button"
      aria-expanded={bottomHudChromeVisible}
      aria-label={
        bottomHudChromeVisible
          ? "Hide bottom controls (timer, transport, progress)"
          : "Show bottom controls"
      }
      onClick={(e) => {
        e.stopPropagation();
        setBottomHudChromeVisible((v) => !v);
      }}
      style={{
        ...btn(false),
        width: 30,
        height: 30,
        minWidth: 30,
        minHeight: 30,
        padding: 0,
        boxSizing: "border-box",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        pointerEvents: "auto",
        opacity: 0.92,
        flexShrink: 0,
        ...extraStyle,
      }}
      title={
        bottomHudChromeVisible
          ? "Hide timer, transport, progress, and status (keep mini previews)"
          : "Show bottom controls"
      }
    >
      <span
        style={{
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
          width: 14,
          height: 14,
          transform: bottomHudChromeVisible ? "rotate(0deg)" : "rotate(180deg)",
          transition: "transform 0.2s ease",
        }}
        aria-hidden
      >
        <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden>
          <path
            d="M2.5 4.25L6 7.75l3.5-3.5"
            stroke="currentColor"
            strokeWidth="1.75"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </span>
    </button>
  );

  const strokesForHudNeighborImage = useCallback(
    (imageName: string | undefined) => {
      if (!imageName) return EMPTY_PENCIL_PREVIEW;
      const live = pencilStrokesByImageRef.current[imageName];
      if (live?.length) return live;
      const saved = perImageSlideDataRef.current[imageName]?.pencilStrokes;
      return saved?.length ? saved : EMPTY_PENCIL_PREVIEW;
    },
    [pencilNonce, undoStackVersion],
  );

  const currentImageKey = currentFile?.key ?? "";
  const currentSlideIdentity = currentFile?.name ?? "";
  currentImageKeyRef.current = currentImageKey;

  const setPencilVisibility = useCallback((next: boolean) => {
    if (pencilCanvasVisibleRef.current === next) return;
    pencilCanvasVisibleRef.current = next;
    if (!next) {
      const canvas = pencilCanvasRef.current;
      const ctx = canvas?.getContext("2d");
      if (canvas && ctx) ctx.clearRect(0, 0, canvas.width, canvas.height);
    }
    setPencilCanvasVisible(next);
  }, []);

  useEffect(() => {
    setPencilVisibility(false);
  }, [currentSlideIdentity, currentUrl, setPencilVisibility]);

  useEffect(() => {
    setLoadedImageUrl(null);
    setLoadedSlideIdentity(null);
  }, [currentUrl]);

  useEffect(() => {
    return () => {
      if (strokeAdvanceTimeoutRef.current) {
        clearTimeout(strokeAdvanceTimeoutRef.current);
        strokeAdvanceTimeoutRef.current = null;
      }
    };
  }, [currentSlideIdentity, strokeAdvanceTarget]);

  const clearPencilDrawingForCurrentImage = useCallback(() => {
    const key = currentImageKeyRef.current;
    if (!key) return;
    if (strokeAdvanceTimeoutRef.current) {
      clearTimeout(strokeAdvanceTimeoutRef.current);
      strokeAdvanceTimeoutRef.current = null;
    }
    pencilStrokesByImageRef.current[key] = [];
    pencilDraftRef.current = null;
    setPencilNonce((n) => n + 1);
  }, []);

  const applyPerImageSlideData = useCallback((d: PerImageSlideData) => {
    setPanX(d.panX);
    setPanY(d.panY);
    setImageScale(d.imageScale);
    setImageBrightness(d.imageBrightness);
    setImageContrast(d.imageContrast);
    setImageRotate(d.imageRotate);
    setImageFlipH(d.imageFlipH);
    setImageFlipV(d.imageFlipV);
    setImageGrayscale(d.imageGrayscale);
    setImageSaturation(d.imageSaturation);
    setImageBlur(d.imageBlur);
    setShowCenterFrame(d.showCenterFrame);
    setShowGrid(d.showGrid);
    setGridCellSize(d.gridCellSize);
    setCenterFrameSize(d.centerFrameSize);
    setCenterFrameLabelSize(d.centerFrameLabelSize);
    setShowOval(d.showOval);
    setOvalWidth(d.ovalWidth);
    setOvalHeightPx(d.ovalHeightPx);
    setOvalRotateDeg(d.ovalRotateDeg);
    setOvalOffsetX(d.ovalOffsetX);
    setOvalOffsetY(d.ovalOffsetY);
    setOvalShadeHighlight(d.ovalShadeHighlight);
    setOvalShadeShadow(d.ovalShadeShadow);
    setOvalShadeForm(d.ovalShadeForm);
    setOvalShadeOpacity(d.ovalShadeOpacity);
    let maxOvalId = 0;
    for (const ex of d.extraOvals) {
      const n = parseInt(ex.id, 10);
      if (Number.isFinite(n)) maxOvalId = Math.max(maxOvalId, n);
    }
    extraOvalIdCounterRef.current = Math.max(extraOvalIdCounterRef.current, maxOvalId + 1);
    setExtraOvals(d.extraOvals.map((o) => ({ ...o })));
    setShowCircle(d.showCircle);
    setShowPose(d.showPose);
    setPoseFigureMode(d.poseFigureMode);
    setPoseMinConfidence(d.poseMinConfidence);
    setPoseOffsetX(d.poseOffsetX);
    setPoseOffsetY(d.poseOffsetY);
    setCircleDiameterPx(d.circleDiameterPx);
    setCircleRotateDeg(d.circleRotateDeg);
    setCircleOffsetX(d.circleOffsetX);
    setCircleOffsetY(d.circleOffsetY);
    setShowRectangle(d.showRectangle);
    setRectangleWidth(d.rectangleWidth);
    setRectangleHeightPx(d.rectangleHeightPx);
    setRectangleRotateDeg(d.rectangleRotateDeg);
    setRectangleOffsetX(d.rectangleOffsetX);
    setRectangleOffsetY(d.rectangleOffsetY);
    setShowBox3d(d.showBox3d);
    setBox3dWidth(d.box3dWidth);
    setBox3dHeightPx(d.box3dHeightPx);
    setBox3dDepthPx(d.box3dDepthPx);
    setBox3dRotateDeg(d.box3dRotateDeg);
    setBox3dYawDeg(d.box3dYawDeg);
    setBox3dPitchDeg(d.box3dPitchDeg);
    setBox3dOffsetX(d.box3dOffsetX);
    setBox3dOffsetY(d.box3dOffsetY);
    setOvalSelected(false);
    setSelectedExtraOvalIds([]);
    setCircleSelected(false);
    setRectangleSelected(false);
    setBox3dSelected(false);
    setBox3dActiveEdgeIndex(null);
    setBox3dActiveEdgeColor(null);
  }, []);

  const flushPerImageAggregateToDisk = useCallback(() => {
    const pencilOnly: Record<string, PerImageSlideData> = {};
    for (const [key, d] of Object.entries(perImageSlideDataRef.current)) {
      if (!d) continue;
      if (!hasPencilMarkings(d)) continue;
      // Persist only pencil marks; shapes/guides/grids remain per-image but non-persistent.
      pencilOnly[key] = {
        ...defaultPerImageSlideData(),
        pencilStrokesUv: d.pencilStrokesUv ?? true,
        pencilStrokes: structuredClone(d.pencilStrokes ?? []),
      };
    }
    writePerImageAggregateToAppStorage(pencilOnly, {
      bareNonPencilMigrationVersion: bareNonPencilMigrationVersionRef.current,
    }).catch((err) => console.warn("gesture-slideshow: writing per-image aggregate failed", err));
  }, []);

  const schedulePerImageAggregateFlush = useCallback(() => {
    if (perImageAggregateFlushTimerRef.current != null) {
      window.clearTimeout(perImageAggregateFlushTimerRef.current);
    }
    perImageAggregateFlushTimerRef.current = window.setTimeout(() => {
      perImageAggregateFlushTimerRef.current = null;
      flushPerImageAggregateToDisk();
    }, 480);
  }, [flushPerImageAggregateToDisk]);

  pushUndoSnapshotRef.current = () => {
    const key = currentImageKeyRef.current;
    if (!key) return;
    const base = overlaySnapshotRef.current;
    if (!base) return;
    const full: PerImageSlideData = {
      ...base,
      pencilStrokesUv: perImageSlideDataRef.current[key]?.pencilStrokesUv ?? true,
      pencilStrokes: structuredClone(pencilStrokesByImageRef.current[key] ?? []),
    };
    try {
      const clone = structuredClone(full);
      const arr = undoStackByImageRef.current[key] ?? [];
      if (arr.length >= MAX_UNDO_STACK) arr.shift();
      arr.push(clone);
      undoStackByImageRef.current[key] = arr;
      setUndoStackVersion((v) => v + 1);
    } catch {
      /* ignore */
    }
  };

  useEffect(() => {
    const prevSlideIdentity = prevSlideIdentityForAggregateRef.current;
    const prevStorageKey = prevImageStorageKeyForAggregateRef.current;
    if (prevSlideIdentity && prevSlideIdentity !== currentSlideIdentity && prevStorageKey && overlaySnapshotRef.current) {
      const snap: PerImageSlideData = {
        ...overlaySnapshotRef.current,
        pencilStrokesUv: perImageSlideDataRef.current[prevStorageKey]?.pencilStrokesUv ?? true,
        pencilStrokes: structuredClone(pencilStrokesByImageRef.current[prevStorageKey] ?? []),
      };
      perImageSlideDataRef.current = { ...perImageSlideDataRef.current, [prevStorageKey]: snap };
      schedulePerImageAggregateFlush();
    }
    prevSlideIdentityForAggregateRef.current = currentSlideIdentity;
    prevImageStorageKeyForAggregateRef.current = currentImageKey;

    if (!currentImageKey) return;

    const saved = perImageSlideDataRef.current[currentImageKey];
    if (saved) {
      applyPerImageSlideData(saved);
      pencilStrokesByImageRef.current[currentImageKey] = structuredClone(saved.pencilStrokes ?? []);
      setPencilNonce((n) => n + 1);
    } else {
      // Ensure overlays/shapes are unique per image (no bleed from the previous slide).
      const def = defaultPerImageSlideData();
      applyPerImageSlideData(def);
      pencilStrokesByImageRef.current[currentImageKey] = [];
      setPencilNonce((n) => n + 1);
    }
  }, [currentSlideIdentity, currentImageKey, applyPerImageSlideData, schedulePerImageAggregateFlush]);

  useLayoutEffect(() => {
    const snap: PerImageSlideData = {
      panX,
      panY,
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
      ovalShadeHighlight,
      ovalShadeShadow,
      ovalShadeForm,
      ovalShadeOpacity,
      extraOvals: extraOvals.map((o) => ({ ...o })),
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
      pencilStrokesUv: true,
      pencilStrokes: [],
    };
    overlaySnapshotRef.current = snap;

    if (!currentImageKey) return;

    const key = currentImageKey;
    const timer = window.setTimeout(() => {
      if (currentImageKeyRef.current !== key) return;
      const base = overlaySnapshotRef.current;
      if (!base) return;
      const priorSlide = perImageSlideDataRef.current[key];
      perImageSlideDataRef.current[key] = {
        ...base,
        pencilStrokesUv: priorSlide?.pencilStrokesUv ?? true,
        pencilStrokes: structuredClone(pencilStrokesByImageRef.current[key] ?? []),
      };
      schedulePerImageAggregateFlush();
    }, 480);

    return () => window.clearTimeout(timer);
  }, [
    currentImageKey,
    schedulePerImageAggregateFlush,
    panX,
    panY,
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
    ovalShadeHighlight,
    ovalShadeShadow,
    ovalShadeForm,
    ovalShadeOpacity,
    extraOvals,
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
    pencilNonce,
  ]);

  const redrawPencilCanvas = useCallback(() => {
    const img = currentImgRef.current;
    const canvas = pencilCanvasRef.current;
    const zoom = zoomContainerRef.current;
    if (!canvas || !zoom) return;
    const cssW = zoom.clientWidth;
    const cssH = zoom.clientHeight;
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
    ctx.save();
    ctx.scale(dpr, dpr);
    const oxoy =
      img && img.complete && img.naturalWidth && img.naturalHeight
        ? imageOriginInPencilCanvasCss(canvas, img)
        : { ox: 0, oy: 0 };
    ctx.translate(oxoy.ox, oxoy.oy);
    const cw = img?.clientWidth ?? 0;
    const ch = img?.clientHeight ?? 0;
    const imageReady = !!(img && img.complete && img.naturalWidth && img.naturalHeight && cw > 0 && ch > 0);
    if (!imageReady) {
      setPencilVisibility(false);
      ctx.restore();
      return;
    }
    const slideUv = perImageSlideDataRef.current[currentImageKey]?.pencilStrokesUv ?? true;
    const strokes = pencilStrokesByImageRef.current[currentImageKey] ?? [];
    const draft = pencilDraftRef.current;
    for (const stroke of strokes) {
      if (draft && stroke === draft) drawSmoothPencilStroke(ctx, stroke);
      else if (slideUv && cw > 0 && ch > 0)
        drawSmoothPencilStroke(ctx, pencilStrokeToDisplayPixels(stroke, cw, ch));
      else if (!slideUv) drawSmoothPencilStroke(ctx, stroke);
      // slideUv but image not laid out yet: skip (raw UV would draw as ~0–1 px at top-left).
    }
    ctx.restore();
    setPencilVisibility(true);
  }, [
    currentImageKey,
    setPencilVisibility,
  ]);

  useEffect(() => {
    redrawPencilCanvas();
  }, [
    redrawPencilCanvas,
    currentUrl,
    pencilNonce,
    panX,
    panY,
    imageScale,
    imageRotate,
    imageFlipH,
    imageFlipV,
    mainImageHidden,
  ]);

  useEffect(() => {
    const onResize = () => redrawPencilCanvas();
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [redrawPencilCanvas]);

  useEffect(() => {
    const zoom = zoomContainerRef.current;
    if (!zoom || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => redrawPencilCanvas());
    ro.observe(zoom);
    return () => ro.disconnect();
  }, [redrawPencilCanvas]);

  useEffect(() => {
    if (!pencilEnabled && pencilMoveAllMode) setPencilMoveAllMode(false);
  }, [pencilEnabled, pencilMoveAllMode]);

  useLayoutEffect(() => {
    const key = currentImageKey;
    if (!key) return;
    const d = perImageSlideDataRef.current[key];
    const live = pencilStrokesByImageRef.current[key];
    if (!d || !live?.length || d.pencilStrokesUv) return;
    const img = currentImgRef.current;
    if (!img?.complete || !img.naturalWidth || !img.naturalHeight) return;
    const cw = img.clientWidth;
    const ch = img.clientHeight;
    if (!cw || !ch) return;
    migrateLegacyPencilStrokesToUv(live, cw, ch);
    d.pencilStrokes = structuredClone(live);
    d.pencilStrokesUv = true;
    setPencilNonce((n) => n + 1);
    schedulePerImageAggregateFlush();
  }, [currentImageKey, currentUrl, imageMeta.width, imageMeta.height, schedulePerImageAggregateFlush]);

  const handlePencilPointerDown = useCallback((e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!pencilEnabled || !currentImageKey) return;
    const canvas = e.currentTarget;
    const toSlidePencilPoint = (clientX: number, clientY: number): PencilPoint => {
      const rect = canvas.getBoundingClientRect();
      const dpr = window.devicePixelRatio || 1;
      const cssW = canvas.width / dpr || rect.width || 1;
      const cssH = canvas.height / dpr || rect.height || 1;
      const sx = rect.width > 0 ? cssW / rect.width : 1;
      const sy = rect.height > 0 ? cssH / rect.height : 1;
      const px = (clientX - rect.left) * sx;
      const py = (clientY - rect.top) * sy;
      const img = currentImgRef.current;
      if (!img || !img.complete) return { x: px, y: py };
      const { ox, oy } = imageOriginInPencilCanvasCss(canvas, img);
      return { x: px - ox, y: py - oy };
    };
    if (pencilMoveAllMode) {
      const all = pencilStrokesByImageRef.current[currentImageKey] ?? [];
      if (!all.length) return;
      pushUndoSnapshotRef.current();
      e.preventDefault();
      e.stopPropagation();
      const pointerId = e.pointerId;
      canvas.setPointerCapture(pointerId);
      let prev = toSlidePencilPoint(e.clientX, e.clientY);
      const onMove = (ev: PointerEvent) => {
        const next = toSlidePencilPoint(ev.clientX, ev.clientY);
        const dx = next.x - prev.x;
        const dy = next.y - prev.y;
        if (Math.hypot(dx, dy) < 0.01) return;
        const imgM = currentImgRef.current;
        const icw = imgM?.clientWidth ?? 1;
        const ich = imgM?.clientHeight ?? 1;
        const slideUv = perImageSlideDataRef.current[currentImageKey]?.pencilStrokesUv ?? true;
        if (slideUv) {
          const du = dx / icw;
          const dv = dy / ich;
          for (const stroke of all) {
            for (const p of stroke.points) {
              p.x += du;
              p.y += dv;
            }
          }
        } else {
          for (const stroke of all) {
            for (const p of stroke.points) {
              p.x += dx;
              p.y += dy;
            }
          }
        }
        prev = next;
        redrawPencilCanvas();
      };
      const onUp = () => {
        try {
          if (canvas.hasPointerCapture(pointerId)) canvas.releasePointerCapture(pointerId);
        } catch {
          /* ignore */
        }
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
        window.removeEventListener("pointercancel", onUp);
        redrawPencilCanvas();
        setPencilNonce((n) => n + 1);
      };
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
      window.addEventListener("pointercancel", onUp);
      return;
    }
    const point = toSlidePencilPoint(e.clientX, e.clientY);
    pushUndoSnapshotRef.current();
    const stroke: PencilStroke = {
      color: pencilColor,
      size: pencilSize,
      points: [point],
    };
    const all = pencilStrokesByImageRef.current[currentImageKey] ?? [];
    all.push(stroke);
    pencilStrokesByImageRef.current[currentImageKey] = all;
    pencilDraftRef.current = stroke;
    e.preventDefault();
    e.stopPropagation();
    const pointerId = e.pointerId;
    canvas.setPointerCapture(pointerId);
    redrawPencilCanvas();
    setPencilNonce((n) => n + 1);
    const onMove = (ev: PointerEvent) => {
      const draft = pencilDraftRef.current;
      if (!draft) return;
      const next = toSlidePencilPoint(ev.clientX, ev.clientY);
      const prev = draft.points[draft.points.length - 1]!;
      if (Math.hypot(next.x - prev.x, next.y - prev.y) < 0.5) return;
      draft.points.push(next);
      redrawPencilCanvas();
    };
    const onUp = () => {
      const finalized = pencilDraftRef.current;
      let finishedStroke = false;
      if (finalized) {
        finishedStroke = true;
        // 0% = follow user input more closely (more points, less simplification)
        // 100% = more solid/smoothed curve (fewer points, more simplification)
        const smoothStrength = Math.max(0, Math.min(1, pencilCurveSensitivity / 100));
        const detailStrength = 1 - smoothStrength;
        const jitterStep = Math.max(0.15, finalized.size * (0.03 + 0.22 * smoothStrength));
        const rdpTolerance = Math.max(0.18, finalized.size * (0.02 + 0.16 * smoothStrength));
        const base = simplifyPencilPointsRdp(
          simplifyPencilPoints(finalized.points, jitterStep),
          rdpTolerance
        );
        const snappedEllipse = trySnapStrokeToEllipse(base, finalized.size);
        if (snappedEllipse) {
          finalized.points = snappedEllipse;
        } else if (base.length >= 3) {
          // Smooth as vectors (polyline), not curves.
          const iterations = Math.min(8, Math.max(0, Math.round(smoothStrength * 8)));
          finalized.points = smoothPencilPoints(base, iterations);
        } else {
          finalized.points = base;
        }
        const imgFin = currentImgRef.current;
        const rowKey = currentImageKeyRef.current;
        if (imgFin && imgFin.clientWidth > 0 && imgFin.clientHeight > 0) {
          const fcw = imgFin.clientWidth;
          const fch = imgFin.clientHeight;
          const fm = Math.min(fcw, fch);
          for (const p of finalized.points) {
            p.x /= fcw;
            p.y /= fch;
          }
          finalized.size /= fm;
          if (rowKey) {
            if (!perImageSlideDataRef.current[rowKey]) {
              perImageSlideDataRef.current[rowKey] = defaultPerImageSlideData();
            }
            perImageSlideDataRef.current[rowKey]!.pencilStrokesUv = true;
          }
        } else if (rowKey) {
          if (!perImageSlideDataRef.current[rowKey]) {
            perImageSlideDataRef.current[rowKey] = defaultPerImageSlideData();
          }
          // Strokes are still image-local CSS pixels; do not mark UV until we convert.
          perImageSlideDataRef.current[rowKey]!.pencilStrokesUv = false;
        }
      }
      pencilDraftRef.current = null;
      try {
        if (canvas.hasPointerCapture(pointerId)) canvas.releasePointerCapture(pointerId);
      } catch {
        /* ignore */
      }
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
      redrawPencilCanvas();
      setPencilNonce((n) => n + 1);
      if (finishedStroke && order.length > 0 && strokeAdvanceTarget > 0) {
        const rk = currentImageKeyRef.current;
        if (rk) {
          const nStrokes = pencilStrokesByImageRef.current[rk]?.length ?? 0;
          if (nStrokes === strokeAdvanceTarget) {
            const len = Math.max(1, order.length);
            if (strokeAdvanceTimeoutRef.current) {
              clearTimeout(strokeAdvanceTimeoutRef.current);
              strokeAdvanceTimeoutRef.current = null;
            }
            if (strokeAdvanceDeleteMarks) clearPencilDrawingForCurrentImage();
            // Let the finalized stroke paint, then advance immediately.
            requestAnimationFrame(() => {
              requestAnimationFrame(() => {
                setIdxInOrder((v) => (v + 1) % len);
              });
            });
          }
        }
      }
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
  }, [
    currentImageKey,
    pencilEnabled,
    pencilMoveAllMode,
    pencilColor,
    pencilSize,
    pencilCurveSensitivity,
    strokeAdvanceTarget,
    strokeAdvanceDeleteMarks,
    order,
    redrawPencilCanvas,
    clearPencilDrawingForCurrentImage,
  ]);

  const pencilUndoStrokeOnly = useCallback(() => {
    if (!currentImageKey) return;
    const key = currentImageKey;
    const all = pencilStrokesByImageRef.current[key];
    if (!all?.length) {
      pencilDraftRef.current = null;
      setPencilNonce((n) => n + 1);
      return;
    }
    if (pencilDraftRef.current) {
      all.pop();
      pencilDraftRef.current = null;
    } else {
      all.pop();
    }
    pencilStrokesByImageRef.current[key] = all;
    redrawPencilCanvas();
    setPencilNonce((n) => n + 1);
  }, [currentImageKey, redrawPencilCanvas]);

  const handleGlobalUndo = useCallback(() => {
    const key = currentImageKey;
    if (!key) return;
    const arr = undoStackByImageRef.current[key];
    if (arr?.length) {
      const snap = arr.pop()!;
      undoStackByImageRef.current[key] = arr;
      applyPerImageSlideData(snap);
      pencilStrokesByImageRef.current[key] = structuredClone(snap.pencilStrokes ?? []);
      pencilDraftRef.current = null;
      perImageSlideDataRef.current[key] = structuredClone(snap);
      setPencilNonce((n) => n + 1);
      schedulePerImageAggregateFlush();
      setUndoStackVersion((v) => v + 1);
      return;
    }
    pencilUndoStrokeOnly();
  }, [currentImageKey, applyPerImageSlideData, schedulePerImageAggregateFlush, pencilUndoStrokeOnly]);

  async function collectImagesRecursive(
    dir: FileSystemDirectoryHandle,
    pathPrefix: string
  ): Promise<FileHandleEntry[]> {
    const collected: FileHandleEntry[] = [];
    // @ts-expect-error: values() exists on FileSystemDirectoryHandle but types may be incomplete
    for await (const entry of dir.values()) {
      if (entry.kind === "file" && isImageFileName(entry.name)) {
        const name = pathPrefix ? `${pathPrefix}/${entry.name}` : entry.name;
        let key = name;
        try {
          key = await computeFileContentHash(entry);
        } catch (err) {
          console.warn("gesture-slideshow: failed to hash image, falling back to path key", name, err);
        }
        folderLoadProgressRef.current.hashed += 1;
        const now = typeof performance !== "undefined" ? performance.now() : Date.now();
        if (now - folderLoadProgressRef.current.lastUiAt > 120) {
          folderLoadProgressRef.current.lastUiAt = now;
          setFolderLoadStatus(`Scanning + hashing images… ${folderLoadProgressRef.current.hashed}`);
        }
        collected.push({ name, key, handle: entry });
      } else if (entry.kind === "directory" && !IGNORED_DIRS.has(entry.name)) {
        const subPath = pathPrefix ? `${pathPrefix}/${entry.name}` : entry.name;
        const subFiles = await collectImagesRecursive(entry, subPath);
        collected.push(...subFiles);
      }
    }
    return collected;
  }

  async function applyFolder(handle: FileSystemDirectoryHandle) {
    setIsFolderLoading(true);
    setFolderLoadStatus(`Loading folder “${handle.name}”…`);
    folderLoadProgressRef.current = { hashed: 0, lastUiAt: 0 };
    try {
      revokeSlidePrefetchMap(slidePrefetchRef.current);
      setDirHandle(handle);
      const collected = await collectImagesRecursive(handle, "");
      if (!collected.length) {
        alert("No images found in that folder. Try a folder with .jpg/.png/.webp etc.");
        setFiles([]);
        setOrder([]);
        setIdxInOrder(0);
        setClassicSlots({ ...CLASSIC_SLOTS_INITIAL });
        setIntervalsCompleted(0);
        setIsRunning(false);
        perImageSlideDataRef.current = {};
        bareNonPencilMigrationVersionRef.current = PER_IMAGE_BARE_NON_PENCIL_VERSION;
        undoStackByImageRef.current = {};
        setUndoStackVersion((v) => v + 1);
        prevSlideIdentityForAggregateRef.current = "";
        prevImageStorageKeyForAggregateRef.current = "";
        return;
      }
      setFolderLoadStatus(`Loading saved annotations… ${collected.length} images`);
      const parsed = await readPerImageAggregateFromAppStorage();
      let aggregate = parsed.images;
      let bareVer = parsed.bareNonPencilMigrationVersion;
      if (bareVer < PER_IMAGE_BARE_NON_PENCIL_VERSION) {
        const { next } = resetNonPencilSlidesToBare(aggregate);
        aggregate = next;
        bareVer = PER_IMAGE_BARE_NON_PENCIL_VERSION;
        writePerImageAggregateToAppStorage(aggregate, { bareNonPencilMigrationVersion: bareVer }).catch((err) =>
          console.warn("gesture-slideshow: writing bare non-pencil migration failed", err)
        );
      }
      setFolderLoadStatus("Merging saved data and preparing slideshow…");
      const aggregateByHash: Record<string, PerImageSlideData> = {};
      for (const fe of collected) {
        const byHash = aggregate[fe.key];
        const byLegacyPath = aggregate[fe.name];
        if (byHash && byLegacyPath) {
          aggregateByHash[fe.key] = pickRicherSlideData(byHash, byLegacyPath);
        } else if (byHash) {
          aggregateByHash[fe.key] = byHash;
        } else if (byLegacyPath) {
          aggregateByHash[fe.key] = byLegacyPath;
        }
      }
      for (const [k, d] of Object.entries(aggregate)) {
        if (!k.startsWith("sha256:") && !aggregateByHash[k]) continue;
        if (!aggregateByHash[k]) aggregateByHash[k] = d;
        else aggregateByHash[k] = pickRicherSlideData(aggregateByHash[k]!, d);
      }
      perImageSlideDataRef.current = aggregateByHash;
      bareNonPencilMigrationVersionRef.current = bareVer;
      undoStackByImageRef.current = {};
      setUndoStackVersion((v) => v + 1);
      prevSlideIdentityForAggregateRef.current = "";
      prevImageStorageKeyForAggregateRef.current = "";
      pencilStrokesByImageRef.current = {};
      pencilDraftRef.current = null;
      setPencilNonce((n) => n + 1);
      setFiles(collected);
      setOrder(orderWithoutAdjacentDuplicateHashes(collected, shuffle(collected.map((_, i) => i))));
      setIdxInOrder(0);
      setClassicSlots({ ...CLASSIC_SLOTS_INITIAL });
      setIntervalsCompleted(0);
      setIsRunning(false);
    } finally {
      setIsFolderLoading(false);
    }
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
    setOrder(orderWithoutAdjacentDuplicateHashes(files, shuffle(files.map((_, i) => i))));
    setIdxInOrder(0);
    setClassicSlots({ ...CLASSIC_SLOTS_INITIAL });
    setIntervalsCompleted(0);
  }

  function next() {
    if (!order.length) return;
    setIdxInOrder((v) => (v + 1) % order.length);
  }

  function prev() {
    if (!order.length) return;
    setIdxInOrder((v) => (v - 1 + order.length) % order.length);
  }

  function getSlideDataForMarkupScore(key: string): PerImageSlideData | null {
    if (key === currentImageKeyRef.current) {
      const base = overlaySnapshotRef.current;
      if (!base) return perImageSlideDataRef.current[key] ?? null;
      return {
        ...base,
        pencilStrokesUv: perImageSlideDataRef.current[key]?.pencilStrokesUv ?? true,
        pencilStrokes: structuredClone(pencilStrokesByImageRef.current[key] ?? []),
      };
    }
    return perImageSlideDataRef.current[key] ?? null;
  }

  /** Unique hashed slides with markup in current deck order (first occurrence per hash). */
  function getMarkedSlidesInDeckOrder(): { orderIndex: number; score: number }[] {
    if (!files.length || !order.length) return [];
    const firstByKey = new Map<string, { orderIndex: number; score: number }>();
    for (let orderIndex = 0; orderIndex < order.length; orderIndex++) {
      const fileIndex = order[orderIndex]!;
      const fe = files[fileIndex];
      if (!fe) continue;
      const data = getSlideDataForMarkupScore(fe.key);
      const score = data ? perImageMarkupScore(data) : 0;
      if (score <= 0) continue;
      if (!firstByKey.has(fe.key)) firstByKey.set(fe.key, { orderIndex, score });
    }
    return Array.from(firstByKey.values()).sort((a, b) => a.orderIndex - b.orderIndex);
  }

  /** Jump among slides that have saved markup; cycles in order of most markup first (ties: deck order). */
  function goToNextMarkedUpSlide() {
    if (!order.length) return;
    const marked = getMarkedSlidesInDeckOrder();
    if (marked.length === 0) return;
    setPencilVisibility(false);
    const cur = idxInOrder % order.length;
    const curKey = files[order[cur] ?? -1]?.key ?? "";
    const i = marked.findIndex((s) => {
      const fileIndex = order[s.orderIndex];
      return curKey && files[fileIndex ?? -1]?.key === curKey;
    });
    if (i === -1) {
      setIdxInOrder(marked[0]!.orderIndex);
      return;
    }
    setIdxInOrder(marked[(i + 1) % marked.length]!.orderIndex);
  }

  /** Restart the markup tour from the first marked slide in deck order. */
  function resetMarkupTourToTop() {
    const marked = getMarkedSlidesInDeckOrder();
    if (marked.length === 0) return;
    setPencilVisibility(false);
    setIdxInOrder(marked[0]!.orderIndex);
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
    revokeSlidePrefetchMap(slidePrefetchRef.current);
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
      setOrder(orderWithoutAdjacentDuplicateHashes(newFiles, newOrder));
      setIdxInOrder((v) => Math.min(v, Math.max(0, newOrder.length - 1)));
      if (newFiles.length === 0) {
        revokeSlidePrefetchMap(slidePrefetchRef.current);
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

  // Prefetch next/prev slides: blob URL + decode so the swap is ready before advance.
  useEffect(() => {
    if (!files.length || !order.length || !currentFile) return;
    let cancelled = false;
    const n = order.length;
    const keep = new Set<string>([currentFile.name]);
    const seen = new Set<string>();
    const targets: FileHandleEntry[] = [];
    for (const rel of [1, -1, 2, -2]) {
      const idx = order[(idxInOrder + rel + n * 64) % n]!;
      const fe = files[idx];
      if (!fe || fe.name === currentFile.name || seen.has(fe.name)) continue;
      seen.add(fe.name);
      keep.add(fe.name);
      targets.push(fe);
    }
    prefetchKeepRef.current = keep;
    const m = slidePrefetchRef.current;
    for (const [k, url] of m) {
      if (!keep.has(k)) {
        URL.revokeObjectURL(url);
        m.delete(k);
      }
    }
    for (const entry of targets) {
      const key = entry.name;
      if (m.has(key)) continue;
      void (async () => {
        try {
          const file = await entry.handle.getFile();
          const url = URL.createObjectURL(file);
          if (cancelled) {
            URL.revokeObjectURL(url);
            return;
          }
          const img = new Image();
          img.src = url;
          await img.decode();
          if (cancelled) {
            URL.revokeObjectURL(url);
            return;
          }
          if (key === currentImageKeyRef.current) {
            URL.revokeObjectURL(url);
            return;
          }
          if (!prefetchKeepRef.current.has(key)) {
            URL.revokeObjectURL(url);
            return;
          }
          if (m.has(key)) {
            URL.revokeObjectURL(url);
            return;
          }
          m.set(key, url);
        } catch {
          // decode or file read failed — skip prefetch for this slide
        }
      })();
    }
    return () => {
      cancelled = true;
    };
  }, [files, order, idxInOrder, currentFile]);

  // Load/display current image
  useEffect(() => {
    let cancelled = false;

    async function load() {
      if (!currentFile) return;

      const prefetched = slidePrefetchRef.current.get(currentFile.name);
      if (prefetched) {
        slidePrefetchRef.current.delete(currentFile.name);
        if (currentUrlRef.current) {
          URL.revokeObjectURL(currentUrlRef.current);
          currentUrlRef.current = null;
        }
        if (cancelled) {
          URL.revokeObjectURL(prefetched);
          return;
        }
        const file = await currentFile.handle.getFile();
        setCurrentUrlSlideIdentity(currentFile.name);
        currentUrlRef.current = prefetched;
        setCurrentUrl(prefetched);
        setImageMeta((prev) => ({
          ...prev,
          fileSize: file.size,
          lastModified: file.lastModified,
          width: undefined,
          height: undefined,
        }));
        return;
      }

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

      setCurrentUrlSlideIdentity(currentFile.name);
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
        if (advanced) {
          setIntervalsCompleted((n) => n + 1);
        }
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
      // Don't steal keys from real text fields (not range/checkbox inputs — those often keep focus after canvas clicks).
      const isTextField = isEditableTextKeyboardTarget(e.target);

      if (!isTextField && e.key === "Escape") {
        if (e.repeat) return;
        e.preventDefault();
        e.stopPropagation();
        setOvalSelected(false);
        setSelectedExtraOvalIds([]);
        setCircleSelected(false);
        setRectangleSelected(false);
        setBox3dSelected(false);
        setBox3dActiveEdgeIndex(null);
        setBox3dActiveEdgeColor(null);
        return;
      }

      if (!isTextField && (e.key === "o" || e.key === "O")) {
        if (!currentUrl) return;
        e.preventDefault();
        e.stopPropagation();
        spawnNewOval();
        return;
      }

      // P: deselect any active shape, then enable pencil (ignore with Ctrl/Cmd so browser Print still works).
      if (!isTextField && e.code === "KeyP" && !e.ctrlKey && !e.metaKey) {
        if (!currentUrl) return;
        if (e.repeat) return;
        e.preventDefault();
        e.stopPropagation();
        setOvalSelected(false);
        setSelectedExtraOvalIds([]);
        setCircleSelected(false);
        setRectangleSelected(false);
        setBox3dSelected(false);
        setPencilEnabled(true);
        setPencilExpanded(true);
        setShowOverlays(true);
        return;
      }

      // X: clear all pencil marks on this slide (ignore with Ctrl/Cmd so cut still works).
      if (!isTextField && e.code === "KeyX" && !e.ctrlKey && !e.metaKey) {
        if (!currentUrl) return;
        if (e.repeat) return;
        if (!currentImageKeyRef.current) return;
        e.preventDefault();
        e.stopPropagation();
        clearPencilDrawingForCurrentImage();
        return;
      }

      // M: markup tour — next marked slide in deck order (ignore with Ctrl/Cmd).
      if (!isTextField && e.code === "KeyM" && !e.ctrlKey && !e.metaKey) {
        if (!currentUrl) return;
        if (e.repeat) return;
        e.preventDefault();
        e.stopPropagation();
        goToNextMarkedUpSlide();
        return;
      }

      // H: toggle slide photo visibility (ignore with Ctrl/Cmd).
      if (!isTextField && e.code === "KeyH" && !e.ctrlKey && !e.metaKey) {
        if (!currentUrl) return;
        if (e.repeat) return;
        e.preventDefault();
        e.stopPropagation();
        setMainImageHidden((v) => !v);
        return;
      }

      if (!isTextField && (e.key === "Delete" || e.key === "Backspace")) {
        if (selectedExtraOvalIdsRef.current.length > 0 && !ovalSelectedRef.current) {
          e.preventDefault();
          e.stopPropagation();
          const remove = new Set(selectedExtraOvalIdsRef.current);
          setExtraOvals((prev) => prev.filter((o) => !remove.has(o.id)));
          setSelectedExtraOvalIds([]);
          return;
        }
        if (ovalSelectedRef.current) {
          e.preventDefault();
          e.stopPropagation();
          setOvalSelected(false);
          setSelectedExtraOvalIds([]);
          setShowOval(false);
          return;
        }
        if (circleSelectedRef.current) {
          e.preventDefault();
          e.stopPropagation();
          setCircleSelected(false);
          setShowCircle(false);
          return;
        }
        if (rectangleSelectedRef.current) {
          e.preventDefault();
          e.stopPropagation();
          setRectangleSelected(false);
          setShowRectangle(false);
          return;
        }
        if (box3dSelectedRef.current) {
          e.preventDefault();
          e.stopPropagation();
          setBox3dSelected(false);
          setShowBox3d(false);
          return;
        }
      }

      if (!isTextField && (e.key === "f" || e.key === "F")) {
        e.preventDefault();
        e.stopPropagation();
        if (files.length && order.length) {
          if (document.fullscreenElement) exitFullscreen();
          else enterFullscreen();
        }
        return;
      }

      // Undo: ⌘Z / Ctrl+Z, or Z alone (same as Undo; not in text fields; Alt+Z ignored).
      if (
        !isTextField &&
        e.code === "KeyZ" &&
        !e.shiftKey &&
        ((e.metaKey || e.ctrlKey) || (!e.metaKey && !e.ctrlKey && !e.altKey))
      ) {
        if (!currentUrl) return;
        if (e.repeat && !e.metaKey && !e.ctrlKey) return;
        e.preventDefault();
        e.stopPropagation();
        handleGlobalUndo();
        return;
      }

      // Space: toggle timer run/pause (ignore with modifiers and while typing in text fields).
      if (
        !isTextField &&
        (e.code === "Space" || e.key === " ") &&
        !e.ctrlKey &&
        !e.metaKey &&
        !e.altKey
      ) {
        if (e.repeat) return;
        e.preventDefault();
        e.stopPropagation();
        if (files.length && order.length) setIsRunning((v) => !v);
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
  }, [files.length, order.length, currentUrl, spawnNewOval, handleGlobalUndo, goToNextMarkedUpSlide, clearPencilDrawingForCurrentImage]);

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
        {
          const markupData = getSlideDataForMarkupScore(currentFile.key);
          const markupScore = markupData != null ? perImageMarkupScore(markupData) : 0;
          return (
            <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
              <MetaRow label="File name" value={currentFile.name.split("/").pop() ?? currentFile.name} />
              <MetaRow label="Path" value={currentFile.name} />
              <MetaRow label="Image hash" value={currentFile.key || "—"} />
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
              <MetaRow label="Markup score" value={String(markupScore)} />
            </div>
          );
        }
      case "imagePlacement":
        return (
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            <label style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer", fontSize: 12, opacity: 0.9 }}>
              <input
                type="checkbox"
                checked={imagePlacementEnabled}
                onChange={(e) => setImagePlacementEnabled(e.target.checked)}
              />
              <span>Enable image placement</span>
            </label>
            <div style={{ display: "flex", gap: 6 }}>
              {(["left", "center", "right"] as const).map((option) => {
                const active = imagePlacement === option;
                return (
                  <button
                    key={option}
                    type="button"
                    onClick={() => setImagePlacement(option)}
                    disabled={!imagePlacementEnabled}
                    style={{
                      flex: 1,
                      padding: "6px 8px",
                      fontSize: 12,
                      borderRadius: 6,
                      border: "1px solid rgba(255,255,255,0.2)",
                      background: active ? "rgba(255,255,255,0.18)" : "rgba(255,255,255,0.07)",
                      color: "white",
                      cursor: imagePlacementEnabled ? "pointer" : "not-allowed",
                      opacity: imagePlacementEnabled ? 1 : 0.5,
                      textTransform: "capitalize",
                    }}
                  >
                    {option}
                  </button>
                );
              })}
            </div>
            <p style={{ margin: 0, fontSize: 11, lineHeight: 1.4, opacity: 0.78 }}>
              Center is the default. Enable this to place slides against the left or right side of the canvas.
            </p>
          </div>
        );
      case "grid":
        return (
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
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
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
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
      case "oval": {
        const hideAllOvalsDisabled =
          files.length === 0 ||
          files.every((fe) => {
            if (fe.key === currentImageKey) {
              return !showOval && extraOvals.length === 0;
            }
            const d = perImageSlideDataRef.current[fe.key] ?? defaultPerImageSlideData();
            return !d.showOval && (d.extraOvals?.length ?? 0) === 0;
          });
        return (
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            <label style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer", fontSize: 12, opacity: 0.9 }}>
              <input
                type="checkbox"
                checked={!showOval}
                onChange={(e) => {
                  const nextShowOval = !e.target.checked;
                  setShowOval(nextShowOval);
                  if (!nextShowOval) {
                    setExtraOvals([]);
                    setSelectedExtraOvalIds([]);
                  }
                }}
              />
              <span>Hide oval</span>
            </label>
            <button
              type="button"
              onClick={() => {
                pushUndoSnapshotRef.current();
                for (const fe of files) {
                  const prev = perImageSlideDataRef.current[fe.key];
                  const base = prev ?? defaultPerImageSlideData();
                  perImageSlideDataRef.current[fe.key] = {
                    ...base,
                    showOval: false,
                    extraOvals: [],
                  };
                }
                setShowOval(false);
                setExtraOvals([]);
                setSelectedExtraOvalIds([]);
                setOvalSelected(false);
                schedulePerImageAggregateFlush();
              }}
              disabled={hideAllOvalsDisabled}
              style={{
                alignSelf: "flex-start",
                padding: "6px 10px",
                fontSize: 12,
                borderRadius: 6,
                border: "1px solid rgba(255,255,255,0.2)",
                background: "rgba(255,255,255,0.08)",
                color: "white",
                cursor: hideAllOvalsDisabled ? "not-allowed" : "pointer",
                opacity: hideAllOvalsDisabled ? 0.45 : 1,
              }}
              title="Hide the primary ribcage oval and remove all extra ovals on every image in this folder."
            >
              Hide all ovals
            </button>
            <SliderRow label="Width" value={ovalWidth} min={80} max={560} step={4} format={(v) => `${Math.round(v)}×${ovalHeightPx} px`} onChange={setOvalWidth} onRangePointerDown={() => pushUndoSnapshotRef.current()} />
            <SliderRow label="Height" value={ovalHeightPx} min={48} max={560} step={4} format={(v) => `${Math.round(v)}px`} onChange={setOvalHeightPx} onRangePointerDown={() => pushUndoSnapshotRef.current()} />
            <SliderRow label="Rotation" value={ovalRotateDeg} min={-180} max={180} step={1} format={(v) => `${Math.round(v)}°`} onChange={setOvalRotateDeg} onRangePointerDown={() => pushUndoSnapshotRef.current()} />
            <div style={{ display: "flex", flexDirection: "column", gap: 8, paddingTop: 4, borderTop: "1px solid rgba(255,255,255,0.12)" }}>
              <span style={{ fontSize: 11, opacity: 0.82 }}>3D shading (ellipsoid)</span>
              <SliderRow
                label="Highlight (white)"
                value={ovalShadeHighlight}
                min={0}
                max={100}
                step={1}
                format={(v) => `${Math.round(v)}`}
                onChange={setOvalShadeHighlight}
                onRangePointerDown={() => pushUndoSnapshotRef.current()}
              />
              <SliderRow
                label="Shadow (black)"
                value={ovalShadeShadow}
                min={0}
                max={100}
                step={1}
                format={(v) => `${Math.round(v)}`}
                onChange={setOvalShadeShadow}
                onRangePointerDown={() => pushUndoSnapshotRef.current()}
              />
              <SliderRow
                label="Form / curvature"
                value={ovalShadeForm}
                min={0}
                max={100}
                step={1}
                format={(v) => `${Math.round(v)}`}
                onChange={setOvalShadeForm}
                onRangePointerDown={() => pushUndoSnapshotRef.current()}
              />
              <SliderRow
                label="Shading opacity"
                value={ovalShadeOpacity}
                min={0}
                max={100}
                step={1}
                format={(v) => `${Math.round(v)}%`}
                onChange={setOvalShadeOpacity}
                onRangePointerDown={() => pushUndoSnapshotRef.current()}
              />
            </div>
            <p style={{ margin: 0, fontSize: 11, lineHeight: 1.45, opacity: 0.78 }}>
              Transparent fill uses a radial highlight plus a diagonal falloff so it reads like a lit ellipsoid. Raise Shadow for a darker terminator, Highlight
              for a brighter center patch, and Form for tighter curvature. Shading opacity scales both layers together (outline stays solid). Drag inside to move;
              Alt + drag to rotate; Shift + drag (or rim) to scale; wheel resizes width (Shift + wheel: height).
            </p>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              <button
                type="button"
                onClick={() => {
                  spawnNewOval();
                }}
                style={{
                  alignSelf: "flex-start",
                  padding: "6px 10px",
                  fontSize: 12,
                  borderRadius: 6,
                  border: "1px solid rgba(255,255,255,0.22)",
                  background: "rgba(59,130,246,0.18)",
                  color: "white",
                  cursor: "pointer",
                }}
              >
                New Oval
              </button>
              <button
                type="button"
                onClick={() => {
                  pushUndoSnapshotRef.current();
                  setOvalWidth(DEFAULT_SETTINGS.ovalWidth);
                  setOvalHeightPx(DEFAULT_SETTINGS.ovalHeightPx);
                  setOvalRotateDeg(DEFAULT_SETTINGS.ovalRotateDeg);
                  setOvalOffsetX(DEFAULT_SETTINGS.ovalOffsetX);
                  setOvalOffsetY(DEFAULT_SETTINGS.ovalOffsetY);
                  setOvalShadeHighlight(DEFAULT_SETTINGS.ovalShadeHighlight);
                  setOvalShadeShadow(DEFAULT_SETTINGS.ovalShadeShadow);
                  setOvalShadeForm(DEFAULT_SETTINGS.ovalShadeForm);
                  setOvalShadeOpacity(DEFAULT_SETTINGS.ovalShadeOpacity);
                  setOvalSelected(false);
                  setSelectedExtraOvalIds([]);
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
            </div>
          </div>
        );
      }
      case "circle":
        return (
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            <label style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer", fontSize: 12, opacity: 0.9 }}>
              <input type="checkbox" checked={!showCircle} onChange={(e) => setShowCircle(!e.target.checked)} />
              <span>Hide head</span>
            </label>
            <SliderRow label="Diameter" value={circleDiameterPx} min={48} max={560} step={4} format={(v) => `${Math.round(v)}px`} onChange={setCircleDiameterPx} onRangePointerDown={() => pushUndoSnapshotRef.current()} />
            <SliderRow label="Rotation" value={circleRotateDeg} min={-180} max={180} step={1} format={(v) => `${Math.round(v)}°`} onChange={setCircleRotateDeg} onRangePointerDown={() => pushUndoSnapshotRef.current()} />
          </div>
        );
      case "pose":
        return (
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
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
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            <label style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer", fontSize: 12, opacity: 0.9 }}>
              <input type="checkbox" checked={!showRectangle} onChange={(e) => setShowRectangle(!e.target.checked)} />
              <span>Hide rectangle</span>
            </label>
            <SliderRow label="Width" value={rectangleWidth} min={80} max={560} step={4} format={(v) => `${Math.round(v)}×${rectangleHeightPx} px`} onChange={setRectangleWidth} onRangePointerDown={() => pushUndoSnapshotRef.current()} />
            <SliderRow label="Height" value={rectangleHeightPx} min={48} max={560} step={4} format={(v) => `${Math.round(v)}px`} onChange={setRectangleHeightPx} onRangePointerDown={() => pushUndoSnapshotRef.current()} />
            <SliderRow label="Rotation" value={rectangleRotateDeg} min={-180} max={180} step={1} format={(v) => `${Math.round(v)}°`} onChange={setRectangleRotateDeg} onRangePointerDown={() => pushUndoSnapshotRef.current()} />
            <button
              type="button"
              onClick={() => {
                pushUndoSnapshotRef.current();
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
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            <label style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer", fontSize: 12, opacity: 0.9 }}>
              <input type="checkbox" checked={!showBox3d} onChange={(e) => setShowBox3d(!e.target.checked)} />
              <span>Hide 3D box</span>
            </label>
            <SliderRow label="Width" value={box3dWidth} min={80} max={560} step={4} format={(v) => `${Math.round(v)}×${box3dHeightPx}×${box3dDepthPx} px`} onChange={setBox3dWidth} onRangePointerDown={() => pushUndoSnapshotRef.current()} />
            <SliderRow label="Height" value={box3dHeightPx} min={48} max={560} step={4} format={(v) => `${Math.round(v)}px`} onChange={setBox3dHeightPx} onRangePointerDown={() => pushUndoSnapshotRef.current()} />
            <SliderRow label="Depth" value={box3dDepthPx} min={24} max={560} step={4} format={(v) => `${Math.round(v)}px`} onChange={setBox3dDepthPx} onRangePointerDown={() => pushUndoSnapshotRef.current()} />
            <SliderRow label="Slide rotation" value={box3dRotateDeg} min={-180} max={180} step={1} format={(v) => `${Math.round(v)}°`} onChange={setBox3dRotateDeg} onRangePointerDown={() => pushUndoSnapshotRef.current()} />
            <SliderRow label="Lateral (yaw)" value={box3dYawDeg} min={-180} max={180} step={1} format={(v) => `${Math.round(v)}°`} onChange={setBox3dYawDeg} onRangePointerDown={() => pushUndoSnapshotRef.current()} />
            <SliderRow label="Vertical (pitch)" value={box3dPitchDeg} min={-180} max={180} step={1} format={(v) => `${Math.round(v)}°`} onChange={setBox3dPitchDeg} onRangePointerDown={() => pushUndoSnapshotRef.current()} />
            <p style={{ margin: 0, fontSize: 11, lineHeight: 1.45, opacity: 0.78 }}>
              On the slide: drag faces to orbit, or drag any wireframe edge so movement along that edge adjusts yaw and movement perpendicular adjusts
              pitch (and the other way around on vertical edges); when selected, drag the crosshair to pan; Alt + drag rotates the box on the slide; Shift +
              Alt + drag moves it; middle- or right-drag also orbit; Shift + drag scales (not while holding Alt). When selected, drag corners to resize
              the front face; when selected, drag outside the box on the image to rotate it on the slide.
            </p>
            <button
              type="button"
              onClick={() => {
                pushUndoSnapshotRef.current();
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
      case "pencil": {
        void undoStackVersion;
        const stackLen = currentImageKey ? (undoStackByImageRef.current[currentImageKey]?.length ?? 0) : 0;
        const canUndoPencil =
          !!currentImageKey &&
          (stackLen > 0 ||
            (pencilStrokesByImageRef.current[currentImageKey]?.length ?? 0) > 0 ||
            pencilDraftRef.current != null);
        return (
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            <label style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer", fontSize: 12, opacity: 0.9 }}>
              <input type="checkbox" checked={pencilEnabled} onChange={(e) => setPencilEnabled(e.target.checked)} />
              <span>Enable pencil tool</span>
            </label>
            <SliderRow
              label="Pencil size"
              value={pencilSize}
              min={1}
              max={24}
              step={1}
              format={(v) => `${Math.round(v)}px`}
              onChange={(v) => setPencilSize(Math.round(v))}
            />
            <SliderRow
              label="Curve sensitivity"
              value={pencilCurveSensitivity}
              min={0}
              max={100}
              step={1}
              format={(v) => `${Math.round(v)}%`}
              onChange={setPencilCurveSensitivity}
            />
            <label style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, fontSize: 12, opacity: 0.9 }}>
              <span>Pencil color</span>
              <input
                type="color"
                value={pencilColor}
                onChange={(e) => setPencilColor(e.target.value)}
                style={{ width: 42, height: 28, border: "none", background: "transparent", cursor: "pointer" }}
              />
            </label>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 8, alignSelf: "flex-start" }}>
              <button
                type="button"
                onClick={() => setPencilMoveAllMode((v) => !v)}
                disabled={!currentImageKey}
                style={{
                  padding: "6px 10px",
                  fontSize: 12,
                  borderRadius: 6,
                  border: "1px solid rgba(255,255,255,0.2)",
                  background: pencilMoveAllMode ? "rgba(115,170,255,0.22)" : "rgba(255,255,255,0.08)",
                  color: "white",
                  cursor: currentImageKey ? "pointer" : "not-allowed",
                  opacity: currentImageKey ? 1 : 0.45,
                }}
                title="When enabled, drag on the drawing to move all pencil marks on this image together."
              >
                {pencilMoveAllMode ? "Move all: ON" : "Move all"}
              </button>
              <button
                type="button"
                onClick={handleGlobalUndo}
                disabled={!canUndoPencil}
                style={{
                  padding: "6px 10px",
                  fontSize: 12,
                  borderRadius: 6,
                  border: "1px solid rgba(255,255,255,0.2)",
                  background: "rgba(255,255,255,0.08)",
                  color: "white",
                  cursor: "pointer",
                  opacity: canUndoPencil ? 1 : 0.45,
                }}
              >
                Undo
              </button>
              <button
                type="button"
                onClick={() => {
                  if (!currentImageKey) return;
                  clearPencilDrawingForCurrentImage();
                }}
                style={{ padding: "6px 10px", fontSize: 12, borderRadius: 6, border: "1px solid rgba(255,255,255,0.2)", background: "rgba(255,255,255,0.08)", color: "white", cursor: "pointer" }}
              >
                Clear drawing
              </button>
            </div>
            <p style={{ margin: 0, fontSize: 11, lineHeight: 1.45, opacity: 0.78 }}>
              Draw on the current slide; enable Move all to drag every pencil mark on this image together. Strokes are kept per image and saved with overlay layout in{" "}
              <code style={{ fontSize: 10 }}>{PER_IMAGE_AGGREGATE_FILENAME}</code> in the app folder.
            </p>
          </div>
        );
      }
      case "strokeCounter": {
        void pencilNonce;
        void undoStackVersion;
        const key = currentImageKey;
        const strokes = key ? (pencilStrokesByImageRef.current[key] ?? []) : [];
        const draft = pencilDraftRef.current;
        const n =
          strokes.length && draft && strokes[strokes.length - 1] === draft
            ? strokes.length - 1
            : strokes.length;
        return (
          <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
            <div
              aria-live="polite"
              style={{
                fontSize: 28,
                fontWeight: 700,
                lineHeight: 1.1,
                fontVariantNumeric: "tabular-nums",
                letterSpacing: "-0.02em",
              }}
            >
              {n}
            </div>
            <p style={{ margin: 0, fontSize: 11, lineHeight: 1.35, opacity: 0.78 }}>
              Strokes on this slide{key ? ` (${currentFile?.name.split("/").pop() ?? key})` : ""}. Updates when you finish a stroke, undo, clear, or change slide.
            </p>
            <label style={{ display: "flex", flexDirection: "column", gap: 3, fontSize: 11, opacity: 0.9 }}>
              <span>Advance after N strokes (0 = off).</span>
              <input
                type="number"
                inputMode="numeric"
                min={0}
                max={999}
                step={1}
                value={strokeAdvanceTarget}
                onChange={(e) => {
                  const v = Math.floor(Number(e.target.value));
                  if (!Number.isFinite(v)) return;
                  setStrokeAdvanceTarget(Math.min(999, Math.max(0, v)));
                }}
                style={{
                  width: "100%",
                  maxWidth: 120,
                  padding: "4px 8px",
                  borderRadius: 4,
                  border: "1px solid rgba(255,255,255,0.2)",
                  background: "rgba(0,0,0,0.25)",
                  color: "white",
                  fontSize: 12,
                  fontVariantNumeric: "tabular-nums",
                }}
              />
            </label>
            <label style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer", fontSize: 11, opacity: 0.9 }}>
              <input
                type="checkbox"
                checked={strokeAdvanceDeleteMarks}
                onChange={(e) => setStrokeAdvanceDeleteMarks(e.target.checked)}
              />
              <span>Delete this slide&apos;s pencil marks before auto-advance</span>
            </label>
            <p style={{ margin: 0, fontSize: 10, lineHeight: 1.35, opacity: 0.65 }}>
              When you finish a stroke (lift the pointer) and the count reaches exactly N, the deck advances to the next image after that line is drawn — not while the stroke is still in progress. Turn off delete to keep marks on this slide.
            </p>
          </div>
        );
      }
      case "adjustImage":
        return (
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
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
                setImagePlacementEnabled(DEFAULT_SETTINGS.imagePlacementEnabled);
                setImagePlacement(DEFAULT_SETTINGS.imagePlacement);
                setPencilEnabled(DEFAULT_SETTINGS.pencilEnabled);
                setPencilSize(DEFAULT_SETTINGS.pencilSize);
                setPencilColor(DEFAULT_SETTINGS.pencilColor);
                setPencilCurveSensitivity(DEFAULT_SETTINGS.pencilCurveSensitivity);
                setPanX(0);
                setPanY(0);
                setShowCenterFrame(DEFAULT_SETTINGS.showCenterFrame);
                setShowGrid(DEFAULT_SETTINGS.showGrid);
                setGridCellSize(DEFAULT_SETTINGS.gridCellSize);
                setCenterFrameSize(DEFAULT_SETTINGS.centerFrameSize);
                setCenterFrameLabelSize(DEFAULT_SETTINGS.centerFrameLabelSize);
                setShowOval(DEFAULT_SETTINGS.showOval);
                setExtraOvals([]);
                setSelectedExtraOvalIds([]);
                setOvalWidth(DEFAULT_SETTINGS.ovalWidth);
                setOvalHeightPx(DEFAULT_SETTINGS.ovalHeightPx);
                setOvalRotateDeg(DEFAULT_SETTINGS.ovalRotateDeg);
                setOvalOffsetX(DEFAULT_SETTINGS.ovalOffsetX);
                setOvalOffsetY(DEFAULT_SETTINGS.ovalOffsetY);
                setOvalShadeHighlight(DEFAULT_SETTINGS.ovalShadeHighlight);
                setOvalShadeShadow(DEFAULT_SETTINGS.ovalShadeShadow);
                setOvalShadeForm(DEFAULT_SETTINGS.ovalShadeForm);
                setOvalShadeOpacity(DEFAULT_SETTINGS.ovalShadeOpacity);
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
                pencilStrokesByImageRef.current = {};
                pencilDraftRef.current = null;
                setPencilNonce((n) => n + 1);
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
      case "imagePlacement": return imagePlacementExpanded;
      case "grid": return gridExpanded;
      case "centerFrame": return centerFrameExpanded;
      case "oval": return ovalExpanded;
      case "circle": return circleExpanded;
      case "pose": return poseExpanded;
      case "rectangle": return rectangleExpanded;
      case "box3d": return box3dExpanded;
      case "pencil": return pencilExpanded;
      case "strokeCounter": return strokeCounterExpanded;
      case "adjustImage": return adjustImageExpanded;
      default: return true;
    }
  }

  function setExpanded(sectionId: SidebarSectionId, next: boolean) {
    switch (sectionId) {
      case "imageInfo": setImageInfoExpanded(next); break;
      case "imagePlacement": setImagePlacementExpanded(next); break;
      case "grid": setGridExpanded(next); break;
      case "centerFrame": setCenterFrameExpanded(next); break;
      case "oval": setOvalExpanded(next); break;
      case "circle": setCircleExpanded(next); break;
      case "pose": setPoseExpanded(next); break;
      case "rectangle": setRectangleExpanded(next); break;
      case "box3d": setBox3dExpanded(next); break;
      case "pencil": setPencilExpanded(next); break;
      case "strokeCounter": setStrokeCounterExpanded(next); break;
      case "adjustImage": setAdjustImageExpanded(next); break;
    }
  }

  function renderSidebarTabBar(): React.ReactNode {
    const tabBtn = (active: boolean) =>
      ({
        flex: 1,
        padding: "4px 8px",
        fontSize: 11,
        fontWeight: 600,
        borderRadius: 6,
        border: "1px solid rgba(255,255,255,0.2)",
        cursor: "pointer",
        background: active ? "rgba(255,255,255,0.14)" : "rgba(255,255,255,0.05)",
        color: "white",
        opacity: active ? 1 : 0.82,
      }) as const;
    return (
      <div
        role="tablist"
        aria-label="Sidebar panels"
        style={{ display: "flex", gap: 4, flexShrink: 0, borderBottom: "1px solid rgba(255,255,255,0.12)", paddingBottom: 5 }}
      >
        <button
          type="button"
          role="tab"
          aria-selected={sidebarPanelTab === "main"}
          onClick={() => setSidebarPanelTab("main")}
          style={tabBtn(sidebarPanelTab === "main")}
        >
          Main
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={sidebarPanelTab === "archive"}
          onClick={() => setSidebarPanelTab("archive")}
          style={tabBtn(sidebarPanelTab === "archive")}
        >
          Archive
        </button>
      </div>
    );
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
              style={index === 0 ? undefined : { marginTop: 6, paddingTop: 6, borderTop: "1px solid rgba(255,255,255,0.1)" }}
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
                    style={{ display: "flex", alignItems: "center", justifyContent: "space-between", width: "100%", padding: "4px 0", marginBottom: expanded ? 4 : 0, border: "none", background: "transparent", color: "white", font: "inherit", fontWeight: 600, opacity: 0.95, cursor: "pointer", textAlign: "left" }}
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
  /** When drawing, top/side HUD shells use pointer-events:none so strokes reach the stage; controls opt in with auto. */
  const topHudPencilPassthrough = Boolean(currentUrl && pencilEnabled && showOverlays);

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
      {isFolderLoading ? (
        <div
          style={{
            position: "absolute",
            inset: 0,
            zIndex: 2000,
            background: "rgba(8,12,20,0.72)",
            backdropFilter: "blur(2px)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            pointerEvents: "auto",
          }}
        >
          <div
            style={{
              minWidth: 280,
              maxWidth: 520,
              padding: "14px 16px",
              borderRadius: 10,
              border: "1px solid rgba(255,255,255,0.18)",
              background: "rgba(12,20,35,0.9)",
              boxShadow: "0 8px 26px rgba(0,0,0,0.35)",
              display: "flex",
              flexDirection: "column",
              gap: 8,
            }}
          >
            <div style={{ fontSize: 13, fontWeight: 600, opacity: 0.96 }}>Loading folder…</div>
            <div style={{ fontSize: 12, opacity: 0.8 }}>{folderLoadStatus || "Working…"}</div>
          </div>
        </div>
      ) : null}
      {!currentUrl ? (
        // Landing page
        <div
          style={{
            maxWidth: 600,
            margin: "0 auto",
            height: "100vh",
            display: "flex",
            flexDirection: "column",
            justifyContent: "center",
            alignItems: "center",
            padding: 40,
            textAlign: "center",
          }}
        >
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
              gap: 6,
            }}
          >
            <img src="/logo.png" alt="" style={{ height: 32, width: "auto", display: "block", filter: "brightness(0) invert(1)" }} />
            Gesture Trainer <span style={{ fontSize: 18, opacity: 0.7, fontWeight: 400 }}>β {APP_VERSION}</span>
          </h1>
          <p
            style={{
              margin: "0 0 32px",
              fontSize: 16,
              opacity: 0.7,
              lineHeight: 1.5,
              animation: "landingFadeIn 0.5s ease-out 0.08s both",
            }}
          >
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
              Your browser doesn&apos;t support folder picking. Use Chrome/Edge on desktop.
            </div>
          )}

          <div
            style={{
              display: "flex",
              gap: 6,
              flexWrap: "wrap",
              justifyContent: "center",
              alignItems: "center",
              animation: "landingFadeIn 0.5s ease-out 0.16s both",
            }}
          >
            <button
              onClick={openLastFolder}
              disabled={!supported || !lastFolderName || isFolderLoading}
              style={{
                ...btn(!supported || !lastFolderName || isFolderLoading),
                padding: "14px 28px",
                fontSize: 16,
                fontWeight: 600,
              }}
            >
              {isFolderLoading ? "Loading…" : "Open Last"}
            </button>
            <button
              onClick={pickFolder}
              disabled={!supported || isFolderLoading}
              style={{
                ...btn(!supported || isFolderLoading),
                padding: "14px 28px",
                fontSize: 16,
                fontWeight: 600,
              }}
            >
              {isFolderLoading ? "Loading…" : "Pick Folder"}
            </button>
          </div>
          {lastFolderName ? (
            <p
              style={{
                marginTop: 10,
                fontSize: 13,
                opacity: 0.65,
                maxWidth: 400,
                wordBreak: "break-all",
                animation: "landingFadeIn 0.5s ease-out 0.2s both",
              }}
            >
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
              padding: currentUrl ? "6px 8px 0" : "0 0 20px",
              display: "flex",
              alignItems: "baseline",
              gap: 6,
              opacity: showOverlays ? 1 : 0,
              pointerEvents: !showOverlays ? "none" : topHudPencilPassthrough ? "none" : "auto",
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
                fontSize: 15,
                fontWeight: 500,
                opacity: 0.9,
                cursor: "pointer",
                display: "flex",
                alignItems: "center",
                gap: 6,
                pointerEvents: showOverlays ? "auto" : "none",
              }}
            >
              <img src="/logo.png" alt="" style={{ height: 15, width: "auto", display: "block", filter: "brightness(0) invert(1)" }} />
              Gesture Trainer <span style={{ fontSize: 12, opacity: 0.6, fontWeight: 400 }}>β {APP_VERSION}</span>
            </h1>
          </div>

          <div
            style={{
              display: "flex",
              gap: 4,
              flexWrap: "wrap",
              alignItems: "center",
              justifyContent: currentUrl ? "flex-end" : "flex-start",
              marginBottom: currentUrl ? 0 : 20,
              padding: currentUrl ? "6px 8px 0 0" : 0,
              opacity: showOverlays ? 1 : 0,
              pointerEvents: !showOverlays ? "none" : topHudPencilPassthrough ? "none" : "auto",
              transition: "opacity 0.3s ease",
              position: currentUrl ? "absolute" : "relative",
              top: currentUrl ? 0 : "auto",
              right: currentUrl ? 0 : "auto",
              left: currentUrl ? "auto" : "auto",
              bottom: currentUrl ? "auto" : "auto",
              zIndex: 10,
            }}
          >
            <button
              onClick={pickFolder}
              disabled={!supported || isFolderLoading}
              style={{ ...btn(!supported || isFolderLoading), pointerEvents: showOverlays ? "auto" : "none" }}
            >
              {isFolderLoading ? "Loading…" : dirHandle ? "Change Folder" : "Pick Folder"}
            </button>

            <button
              onClick={reshuffle}
              disabled={!canRun}
              style={{ ...btn(!canRun), pointerEvents: showOverlays ? "auto" : "none" }}
            >
              ↻
            </button>

            <button
              type="button"
              onClick={goToNextMarkedUpSlide}
              disabled={!canRun}
              style={{
                ...btn(!canRun),
                fontSize: 12,
                padding: "6px 10px",
                pointerEvents: showOverlays ? "auto" : "none",
              }}
              title="Jump through images with saved markup (pencil, extra ovals, shapes, pan/zoom, adjustments) in deck order. Skips images with no saved changes and dedupes repeated files with the same image hash. Keyboard: M."
            >
              Markup
            </button>

            <button
              type="button"
              onClick={resetMarkupTourToTop}
              disabled={!canRun}
              style={{
                ...btn(!canRun),
                fontSize: 12,
                padding: "6px 10px",
                pointerEvents: showOverlays ? "auto" : "none",
              }}
              title="Jump to the first marked slide in deck order. Restarts the markup tour from the top."
            >
              Markup reset
            </button>

            <button
              type="button"
              onClick={() => setMainImageHidden((v) => !v)}
              disabled={!currentUrl}
              style={{
                ...btn(!currentUrl),
                fontSize: 12,
                padding: "6px 10px",
                pointerEvents: showOverlays ? "auto" : "none",
              }}
              title={
                mainImageHidden
                  ? "Show the slide photo again (keyboard: H)"
                  : "Hide the slide photo — pencil, pose, and shape overlays stay visible (keyboard: H)"
              }
            >
              {mainImageHidden ? "Show image" : "Hide image"}
            </button>

            <div
              style={{
                marginLeft: "auto",
                opacity: 0.7,
                fontSize: 12,
                pointerEvents: topHudPencilPassthrough ? "none" : showOverlays ? "auto" : "none",
              }}
            >
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
              background: "#0b1220",
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
                  top: 38,
                  bottom: 0,
                  width: 220,
                  padding: "6px 8px",
                  background: "transparent",
                  zIndex: 5,
                  overflow: "hidden",
                  fontSize: 12,
                  lineHeight: 1.35,
                  display: "flex",
                  flexDirection: "column",
                  opacity: showOverlays ? 1 : 0,
                  pointerEvents: !showOverlays ? "none" : topHudPencilPassthrough ? "none" : "auto",
                  transition: "opacity 0.3s ease",
                }}
              >
                <div
                  style={{
                    flex: 1,
                    minHeight: 0,
                    overflow: "auto",
                    display: "flex",
                    flexDirection: "column",
                    gap: 6,
                    width: "fit-content",
                    maxWidth: "100%",
                    alignSelf: "flex-start",
                    pointerEvents: showOverlays && topHudPencilPassthrough ? "auto" : undefined,
                  }}
                >
                  {renderSidebarTabBar()}
                  {renderSidebarColumn("left", sidebarOrderForTab(sidebarPanelTab, leftPanelSectionOrder))}
                </div>
              </div>
            )}
            {currentFile && (
              <div
                style={{
                  position: "absolute",
                  right: 0,
                  top: 38,
                  bottom: 0,
                  width: 220,
                  padding: "6px 8px",
                  background: "transparent",
                  zIndex: 5,
                  overflow: "hidden",
                  fontSize: 12,
                  lineHeight: 1.35,
                  display: "flex",
                  flexDirection: "column",
                  opacity: showOverlays ? 1 : 0,
                  pointerEvents: !showOverlays ? "none" : topHudPencilPassthrough ? "none" : "auto",
                  transition: "opacity 0.3s ease",
                }}
              >
                <div
                  style={{
                    flex: 1,
                    minHeight: 0,
                    overflow: "auto",
                    display: "flex",
                    flexDirection: "column",
                    gap: 6,
                    width: "fit-content",
                    maxWidth: "100%",
                    alignSelf: "flex-end",
                    pointerEvents: showOverlays && topHudPencilPassthrough ? "auto" : undefined,
                  }}
                >
                  {renderSidebarTabBar()}
                  {renderSidebarColumn("right", sidebarOrderForTab(sidebarPanelTab, rightPanelSectionOrder))}
                </div>
              </div>
            )}
            <div
              ref={slideshowStageRef}
              style={{
                flex: 1,
                display: "flex",
                alignItems: "center",
                justifyContent: imagePlacementJustify,
                minWidth: 0,
                minHeight: 0,
                overflow: "hidden",
                touchAction: "none",
                position: "relative",
              }}
              onMouseMove={(e) => {
                if (!currentUrl) return;
                lastStageClientPointRef.current = { x: e.clientX, y: e.clientY };
              }}
            >
              <div
                ref={zoomContainerRef}
                style={{
                  position: "relative",
                  height: "100%",
                  width: "100%",
                  maxHeight: "100%",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: imagePlacementJustify,
                  transform: imageComposeTransform,
                  transformOrigin: "center center",
                  cursor: isPanning
                    ? "grabbing"
                    : pencilEnabled
                        ? pencilMoveAllMode
                          ? "grab"
                          : PENCIL_TOOL_CURSOR
                        : deckCursorMode === "rotate"
                          ? OVAL_ROTATE_CURSOR
                          : "grab",
                  userSelect: "none",
                  touchAction: "none",
                }}
                onMouseDown={(e) => {
                  if (e.button !== 0) return;
                  const t = e.target;
                  // Pointer handlers stop pointerdown propagation; mousedown still bubbles here.
                  // When the shape is not yet selected, refs are still false — skip pan so the first drag works.
                  if (t instanceof Node) {
                    if (ovalLayersRef.current?.contains(t)) return;
                    if (circleHitAreaRef.current?.contains(t)) return;
                    if (rectangleHitAreaRef.current?.contains(t)) return;
                    if (box3dHitAreaRef.current?.contains(t)) return;
                    if (pencilEnabled && pencilCanvasRef.current?.contains(t)) return;
                  }
                  if (
                    (showOval && ovalSelectedRef.current) ||
                    selectedExtraOvalIdsRef.current.length > 0 ||
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
                <div style={{ position: "relative", display: "inline-block", zIndex: 1 }}>
                  <img
                    ref={currentImgRef}
                    src={currentUrl}
                    alt={currentFile?.name || "gesture"}
                    fetchPriority="high"
                    draggable={false}
                    onLoad={(e) => {
                      const img = e.currentTarget;
                      setPencilVisibility(false);
                      setMainImageHidden(false);
                      setLoadedImageUrl(img.currentSrc || currentUrl);
                      setLoadedSlideIdentity(currentSlideIdentity || null);
                      setImageMeta((prev) => ({
                        ...prev,
                        width: img.naturalWidth,
                        height: img.naturalHeight,
                      }));
                      setPoseNonce((n) => n + 1);
                      setPencilNonce((n) => n + 1);
                    }}
                    style={{
                      height: "100vh",
                      width: "auto",
                      maxWidth: "none",
                      objectFit: "contain",
                      objectPosition: "center",
                      display: "block",
                      background: "black",
                      transform: `scaleX(${imageFlipH ? -1 : 1}) scaleY(${imageFlipV ? -1 : 1})`,
                      transformOrigin: "center center",
                      filter: `brightness(${imageBrightness}) contrast(${imageContrast}) grayscale(${imageGrayscale}) saturate(${imageSaturation}) blur(${imageBlur}px)`,
                      visibility: mainImageHidden ? "hidden" : "visible",
                    }}
                    aria-hidden={mainImageHidden}
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
                <canvas
                  ref={pencilCanvasRef}
                  aria-label="Pencil drawing canvas"
                  onPointerDown={handlePencilPointerDown}
                  style={{
                    position: "absolute",
                    left: 0,
                    top: 0,
                    right: 0,
                    bottom: 0,
                    width: "100%",
                    height: "100%",
                    pointerEvents: pencilEnabled ? "auto" : "none",
                    touchAction: "none",
                    cursor: pencilEnabled ? (pencilMoveAllMode ? "grab" : PENCIL_TOOL_CURSOR) : "default",
                    zIndex: 6,
                    opacity: pencilCanvasVisible ? 1 : 0,
                    transition: "opacity 90ms linear",
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
            {currentUrl && !pencilEnabled && (showOval || extraOvals.length > 0) && (
              <div
                ref={ovalLayersRef}
                style={{
                  position: "absolute",
                  inset: 0,
                  pointerEvents: "none",
                  zIndex: 4,
                  transform: imageComposeTransform,
                  transformOrigin: "center center",
                }}
              >
                {extraOvals.map((ov) => {
                  const extraBodyId = `gesture-oval-body-shade-${ov.id}`;
                  const extraAmbientId = `gesture-oval-ambient-shade-${ov.id}`;
                  const extraEllipsoidShade = computeOvalEllipsoidShading(
                    ov.shadeHighlight,
                    ov.shadeShadow,
                    ov.shadeForm
                  );
                  const extraCx = ov.width / 2;
                  const extraCy = ov.heightPx / 2;
                  const extraRxGeom = Math.max(4, ov.width / 2 - 4);
                  const extraRyGeom = Math.max(4, ov.heightPx / 2 - 4);
                  const extraSelected = selectedExtraOvalIds.includes(ov.id);
                  const extraStroke = extraSelected ? "#facc15" : "#ffffff";
                  return (
                    <div
                      key={ov.id}
                      style={{
                        position: "absolute",
                        left: "50%",
                        top: "50%",
                        transform: `translate(-50%, -50%) translate(${ov.offsetX}px, ${ov.offsetY}px)`,
                        flexShrink: 0,
                        pointerEvents: "auto",
                        touchAction: "none",
                      }}
                    >
                      <div
                        style={{
                          transform: `rotate(${ov.rotateDeg}deg)`,
                          transformOrigin: "center center",
                        }}
                      >
                        <svg
                          width={ov.width}
                          height={ov.heightPx}
                          viewBox={`0 0 ${ov.width} ${ov.heightPx}`}
                          style={{ display: "block", cursor: "grab" }}
                          role="img"
                          aria-selected={extraSelected}
                          onPointerDown={(e) => {
                            if (e.button !== 0) return;
                            setPencilEnabled(false);
                            e.preventDefault();
                            e.stopPropagation();
                            pushUndoSnapshotRef.current();

                            const clicked = ov;
                            const ovalWasSelected = ovalSelectedRef.current;
                            const selectedExtrasBefore = [...selectedExtraOvalIdsRef.current];
                            const shiftAdd = e.shiftKey;
                            const clickedExtraWasSelected = selectedExtrasBefore.includes(clicked.id);
                            const multiOvalBefore =
                              (ovalWasSelected ? 1 : 0) + selectedExtrasBefore.length > 1;

                            if (shiftAdd) {
                              setSelectedExtraOvalIds((prev) =>
                                prev.includes(clicked.id) ? prev : [...prev, clicked.id]
                              );
                            } else if (multiOvalBefore && clickedExtraWasSelected) {
                              /* keep selection — drag moves the whole group */
                            } else {
                              setOvalSelected(false);
                              setSelectedExtraOvalIds([clicked.id]);
                              setCircleSelected(false);
                              setRectangleSelected(false);
                              setBox3dSelected(false);
                            }

                            const idsToMove = shiftAdd
                              ? new Set([...selectedExtrasBefore, clicked.id])
                              : multiOvalBefore && clickedExtraWasSelected
                                ? new Set(selectedExtrasBefore)
                                : new Set([clicked.id]);
                            const movePrimary =
                              (shiftAdd && ovalWasSelected) ||
                              (!shiftAdd && multiOvalBefore && clickedExtraWasSelected && ovalWasSelected);

                            const startPrimary = { x: ovalOffsetX, y: ovalOffsetY };
                            const extraStarts = new Map<string, { x: number; y: number }>();
                            for (const id of idsToMove) {
                              const o = extraOvals.find((x) => x.id === id);
                              if (o) extraStarts.set(id, { x: o.offsetX, y: o.offsetY });
                            }

                            const startX = e.clientX;
                            const startY = e.clientY;

                            const onMove = (moveEv: PointerEvent) => {
                              const dx = moveEv.clientX - startX;
                              const dy = moveEv.clientY - startY;
                              if (movePrimary) {
                                setOvalOffsetX(startPrimary.x + dx);
                                setOvalOffsetY(startPrimary.y + dy);
                              }
                              setExtraOvals((prev) =>
                                prev.map((o) => {
                                  if (!idsToMove.has(o.id)) return o;
                                  const st = extraStarts.get(o.id);
                                  if (!st) return o;
                                  return { ...o, offsetX: st.x + dx, offsetY: st.y + dy };
                                })
                              );
                            };
                            const onUp = () => {
                              window.removeEventListener("pointermove", onMove);
                              window.removeEventListener("pointerup", onUp);
                              window.removeEventListener("pointercancel", onUp);
                            };
                            window.addEventListener("pointermove", onMove);
                            window.addEventListener("pointerup", onUp);
                            window.addEventListener("pointercancel", onUp);
                          }}
                          onContextMenu={(ev) => ev.preventDefault()}
                        >
                          <defs>
                            <radialGradient
                              id={extraBodyId}
                              cx={extraEllipsoidShade.cxPct}
                              cy={extraEllipsoidShade.cyPct}
                              r={extraEllipsoidShade.rPct}
                              fx={extraEllipsoidShade.fxPct}
                              fy={extraEllipsoidShade.fyPct}
                              gradientUnits="objectBoundingBox"
                            >
                              {extraEllipsoidShade.radialStops.map((st, i) => (
                                <stop
                                  key={`xr${ov.id}-${i}`}
                                  offset={st.offset}
                                  stopColor={st.color}
                                  stopOpacity={st.opacity}
                                />
                              ))}
                            </radialGradient>
                            <linearGradient
                              id={extraAmbientId}
                              x1="14%"
                              y1="10%"
                              x2="88%"
                              y2="92%"
                              gradientUnits="objectBoundingBox"
                            >
                              {extraEllipsoidShade.linearStops.map((st, i) => (
                                <stop
                                  key={`xl${ov.id}-${i}`}
                                  offset={st.offset}
                                  stopColor={st.color}
                                  stopOpacity={st.opacity}
                                />
                              ))}
                            </linearGradient>
                          </defs>
                          <g opacity={ov.shadeOpacity / 100}>
                            <ellipse
                              cx={extraCx}
                              cy={extraCy}
                              rx={extraRxGeom}
                              ry={extraRyGeom}
                              fill={`url(#${extraBodyId})`}
                              stroke="none"
                            />
                            <ellipse
                              cx={extraCx}
                              cy={extraCy}
                              rx={extraRxGeom}
                              ry={extraRyGeom}
                              fill={`url(#${extraAmbientId})`}
                              opacity={extraEllipsoidShade.overlayOpacity}
                              pointerEvents="none"
                            />
                          </g>
                          <ellipse
                            cx={extraCx}
                            cy={extraCy}
                            rx={extraRxGeom}
                            ry={extraRyGeom}
                            fill="none"
                            stroke={extraStroke}
                            strokeWidth={2}
                            vectorEffect="non-scaling-stroke"
                            pointerEvents="none"
                          />
                        </svg>
                      </div>
                    </div>
                  );
                })}
                {showOval ? (
                  <div
                    ref={ovalHitAreaRef}
                    style={{
                      position: "absolute",
                      left: "50%",
                      top: "50%",
                      transform: `translate(-50%, -50%) translate(${ovalOffsetX}px, ${ovalOffsetY}px)`,
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
                        aria-label="Oval: ellipsoid-style shaded fill and white outline; shading strength and opacity adjustable in sidebar. Alt + drag rotates; drag to move; wheel resizes."
                        aria-selected={ovalSelected}
                        onPointerDown={handleOvalPointerDown}
                        onPointerMove={handleOvalSvgPointerMove}
                        onPointerEnter={handleOvalSvgPointerEnter}
                        onPointerLeave={handleOvalSvgPointerLeave}
                        onContextMenu={(ev) => ev.preventDefault()}
                      >
                      <defs>
                        <radialGradient
                          id={primaryOvalGradBodyId}
                          cx={ovalEllipsoidShade.cxPct}
                          cy={ovalEllipsoidShade.cyPct}
                          r={ovalEllipsoidShade.rPct}
                          fx={ovalEllipsoidShade.fxPct}
                          fy={ovalEllipsoidShade.fyPct}
                          gradientUnits="objectBoundingBox"
                        >
                          {ovalEllipsoidShade.radialStops.map((st, i) => (
                            <stop
                              key={`r${i}`}
                              offset={st.offset}
                              stopColor={st.color}
                              stopOpacity={st.opacity}
                            />
                          ))}
                        </radialGradient>
                        <linearGradient
                          id={primaryOvalGradAmbientId}
                          x1="14%"
                          y1="10%"
                          x2="88%"
                          y2="92%"
                          gradientUnits="objectBoundingBox"
                        >
                          {ovalEllipsoidShade.linearStops.map((st, i) => (
                            <stop
                              key={`l${i}`}
                              offset={st.offset}
                              stopColor={st.color}
                              stopOpacity={st.opacity}
                            />
                          ))}
                        </linearGradient>
                      </defs>
                          <g opacity={ovalShadeOpacity / 100}>
                        <ellipse
                          cx={ovalCx}
                          cy={ovalCy}
                          rx={ovalRxGeom}
                          ry={ovalRyGeom}
                          fill={`url(#${primaryOvalGradBodyId})`}
                          stroke="none"
                          style={{ cursor: "inherit" }}
                        />
                        <ellipse
                          cx={ovalCx}
                          cy={ovalCy}
                          rx={ovalRxGeom}
                          ry={ovalRyGeom}
                          fill={`url(#${primaryOvalGradAmbientId})`}
                          opacity={ovalEllipsoidShade.overlayOpacity}
                          pointerEvents="none"
                        />
                      </g>
                      <ellipse
                        cx={ovalCx}
                        cy={ovalCy}
                        rx={ovalRxGeom}
                        ry={ovalRyGeom}
                        fill="none"
                        stroke="#ffffff"
                        strokeWidth={2}
                        vectorEffect="non-scaling-stroke"
                        pointerEvents="none"
                      />
                      {ovalSelected ? (
                        <>
                          <polygon
                            points={ovalFrontInnerPoly.map(([x, y]) => `${x},${y}`).join(" ")}
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
                          {ovalHandleCorners.map(([bx, by], i) => (
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
                ) : null}
              </div>
            )}
            {currentUrl && !pencilEnabled && showCircle && (
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
                        strokeWidth={circleSvgStrokeWidth}
                        vectorEffect="non-scaling-stroke"
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
                        vectorEffect="non-scaling-stroke"
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
                        vectorEffect="non-scaling-stroke"
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
            {currentUrl && !pencilEnabled && showRectangle && (
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
            {currentUrl && !pencilEnabled && showBox3d && (
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
                  // Let the pencil canvas keep receiving pointer events under the HUD.
                  // We re-enable pointer events on the actual controls container below.
                  pointerEvents: "none",
                }}
              >
                <div
                  style={{
                    display: "grid",
                    gridTemplateColumns: "minmax(0, max-content) minmax(0, 1fr) minmax(0, max-content)",
                    gridTemplateRows: bottomHudDoubleRow ? "auto auto" : "auto",
                    columnGap: 12,
                    rowGap: bottomHudDoubleRow ? 8 : 0,
                    alignItems: "center",
                    marginBottom: bottomHudChromeVisible ? 10 : 6,
                    // Keep empty HUD regions transparent to drawing.
                    pointerEvents: "none",
                  }}
                >
                  {hudNeighborFiles.p0 || hudNeighborFiles.p1 ? (
                    <div
                      style={{
                        gridColumn: 1,
                        gridRow:
                          !bottomHudChromeVisible || !prevHudMinimized ? 1 : 2,
                        justifySelf: "start",
                        alignSelf: prevHudMinimized ? "center" : "start",
                        display: "flex",
                        flexDirection: "row",
                        alignItems: prevHudMinimized ? "center" : "flex-start",
                        gap: 8,
                        pointerEvents: "none",
                        zIndex: 2,
                      }}
                    >
                      {hudNeighborFiles.p0 && hudNeighborUrls.p0 ? (
                        <HudMiniSlidePreview
                          outerStyle={{
                            transform: prevHudMinimized ? "translateY(-34px)" : "none",
                            flexShrink: 0,
                          }}
                          imageUrl={hudNeighborUrls.p0}
                          label="−2"
                          regionTitle={`2 back: ${hudNeighborFiles.p0.name.split("/").pop() ?? hudNeighborFiles.p0.name}`}
                          minimized={prevHudMinimized}
                          onToggleMinimized={() => setPrevHudMinimized((m) => !m)}
                          strokes={strokesForHudNeighborImage(hudNeighborFiles.p0.key)}
                          pencilRevision={pencilNonce + undoStackVersion}
                          corner="left"
                          onPickSlide={() => goToHudNeighborFile(hudNeighborFiles.p0)}
                          pencilStrokesUv={perImageSlideDataRef.current[hudNeighborFiles.p0.key]?.pencilStrokesUv ?? true}
                        />
                      ) : null}
                      {hudNeighborFiles.p1 && hudNeighborUrls.p1 ? (
                        <HudMiniSlidePreview
                          outerStyle={{
                            transform: prevHudMinimized ? "translateY(-34px)" : "none",
                            flexShrink: 0,
                          }}
                          imageUrl={hudNeighborUrls.p1}
                          label="−1"
                          regionTitle={`1 back: ${hudNeighborFiles.p1.name.split("/").pop() ?? hudNeighborFiles.p1.name}`}
                          minimized={prevHudMinimized}
                          onToggleMinimized={() => setPrevHudMinimized((m) => !m)}
                          strokes={strokesForHudNeighborImage(hudNeighborFiles.p1.key)}
                          pencilRevision={pencilNonce + undoStackVersion}
                          corner="left"
                          onPickSlide={() => goToHudNeighborFile(hudNeighborFiles.p1)}
                          pencilStrokesUv={perImageSlideDataRef.current[hudNeighborFiles.p1.key]?.pencilStrokesUv ?? true}
                        />
                      ) : null}
                      {renderBottomHudChromeToggle({ alignSelf: prevHudMinimized ? "center" : "flex-start" })}
                    </div>
                  ) : null}
                  {!(hudNeighborFiles.p0 || hudNeighborFiles.p1)
                    ? renderBottomHudChromeToggle({
                        gridColumn: 2,
                        gridRow: !bottomHudChromeVisible ? 1 : hudPreviewStrip ? 2 : 1,
                        justifySelf: "start",
                        alignSelf: "center",
                      })
                    : null}
                  {hudNeighborFiles.n0 || hudNeighborFiles.n1 ? (
                    <div
                      style={{
                        gridColumn: 3,
                        gridRow:
                          !bottomHudChromeVisible || !nextHudMinimized ? 1 : 2,
                        justifySelf: "end",
                        alignSelf: nextHudMinimized ? "center" : "start",
                        display: "flex",
                        flexDirection: "row",
                        alignItems: nextHudMinimized ? "center" : "flex-start",
                        gap: 8,
                        pointerEvents: "none",
                        zIndex: 2,
                      }}
                    >
                      {hudNeighborFiles.n0 && hudNeighborUrls.n0 ? (
                        <HudMiniSlidePreview
                          outerStyle={{
                            transform: nextHudMinimized ? "translateY(-34px)" : "none",
                            flexShrink: 0,
                          }}
                          imageUrl={hudNeighborUrls.n0}
                          label="+1"
                          regionTitle={`Next: ${hudNeighborFiles.n0.name.split("/").pop() ?? hudNeighborFiles.n0.name}`}
                          minimized={nextHudMinimized}
                          onToggleMinimized={() => setNextHudMinimized((m) => !m)}
                          strokes={strokesForHudNeighborImage(hudNeighborFiles.n0.key)}
                          pencilRevision={pencilNonce + undoStackVersion}
                          corner="right"
                          onPickSlide={() => goToHudNeighborFile(hudNeighborFiles.n0)}
                          pencilStrokesUv={perImageSlideDataRef.current[hudNeighborFiles.n0.key]?.pencilStrokesUv ?? true}
                        />
                      ) : null}
                      {hudNeighborFiles.n1 && hudNeighborUrls.n1 ? (
                        <HudMiniSlidePreview
                          outerStyle={{
                            transform: nextHudMinimized ? "translateY(-34px)" : "none",
                            flexShrink: 0,
                          }}
                          imageUrl={hudNeighborUrls.n1}
                          label="+2"
                          regionTitle={`2 ahead: ${hudNeighborFiles.n1.name.split("/").pop() ?? hudNeighborFiles.n1.name}`}
                          minimized={nextHudMinimized}
                          onToggleMinimized={() => setNextHudMinimized((m) => !m)}
                          strokes={strokesForHudNeighborImage(hudNeighborFiles.n1.key)}
                          pencilRevision={pencilNonce + undoStackVersion}
                          corner="right"
                          onPickSlide={() => goToHudNeighborFile(hudNeighborFiles.n1)}
                          pencilStrokesUv={perImageSlideDataRef.current[hudNeighborFiles.n1.key]?.pencilStrokesUv ?? true}
                        />
                      ) : null}
                    </div>
                  ) : null}
                  <div
                    style={{
                      display: bottomHudChromeVisible ? "flex" : "none",
                      gap: 6,
                      flexWrap: "wrap",
                      alignItems: "center",
                      gridColumn: 1,
                      gridRow: hudPreviewStrip ? 2 : 1,
                      pointerEvents: "auto",
                    }}
                  >
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
                          setIntervalsCompleted(0);
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
                      display: bottomHudChromeVisible ? "flex" : "none",
                      alignItems: "center",
                      gap: 8,
                      whiteSpace: "nowrap",
                      gridColumn: 3,
                      gridRow: hudPreviewStrip ? 2 : 1,
                      justifySelf: "end",
                      pointerEvents: "auto",
                    }}
                  >
                    <button
                      type="button"
                      onClick={() => {
                        if (!isRunning && timerMode === "classic" && classicSlotsExhausted(classicSlots)) {
                          setClassicSlots({ ...CLASSIC_SLOTS_INITIAL });
                          setIntervalSec(CLASSIC_FIRST_TIER);
                          setIntervalsCompleted(0);
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
                      onClick={() => {
                        setElapsedSec(0);
                        setIntervalsCompleted(0);
                      }}
                      disabled={!canRun}
                      style={{
                        ...btn(!canRun),
                        padding: "4px 8px",
                        fontSize: 12,
                        minWidth: 28,
                        opacity: 0.85,
                      }}
                      title="Reset total elapsed and completed-interval count"
                    >
                      ↺
                    </button>
                    <span style={{ fontSize: 13, opacity: 0.85 }}>
                      Total elapsed {formatElapsed(elapsedSec)}
                      {" · "}
                      {intervalsCompleted} interval{intervalsCompleted === 1 ? "" : "s"} completed
                    </span>
                  </div>
                </div>
                {bottomHudChromeVisible ? (
                  <>
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
                  </>
                ) : null}
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
    padding: "4px 8px",
    borderRadius: 4,
    border: "1px solid rgba(255,255,255,0.12)",
    background: disabled ? "rgba(255,255,255,0.04)" : "rgba(255,255,255,0.08)",
    color: "white",
    cursor: disabled ? "not-allowed" : "pointer",
    opacity: disabled ? 0.5 : 0.9,
    fontWeight: 500,
    fontSize: 12,
    transition: "opacity 0.2s",
  };
}
