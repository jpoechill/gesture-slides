import { DEFAULT_SETTINGS } from "./settings";

export type PencilPoint = { x: number; y: number };
export type PencilStroke = { color: string; size: number; points: PencilPoint[] };

/** One aggregate JSON file at the opened folder root (File System Access API). */
export const PER_IMAGE_AGGREGATE_FILENAME = ".gesture-slideshow-slides.json" as const;
export const PER_IMAGE_AGGREGATE_VERSION = 1;
/** Increment when a one-time migration should run on existing aggregate files (see `resetNonPencilSlidesToBare`). */
export const PER_IMAGE_BARE_NON_PENCIL_VERSION = 1;

export type SerializableOvalExtra = {
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

export type PerImageSlideData = {
  panX: number;
  panY: number;
  imageScale: number;
  imageBrightness: number;
  imageContrast: number;
  imageRotate: number;
  imageFlipH: boolean;
  imageFlipV: boolean;
  imageGrayscale: number;
  imageSaturation: number;
  imageBlur: number;
  showCenterFrame: boolean;
  showGrid: boolean;
  gridCellSize: number;
  centerFrameSize: number;
  centerFrameLabelSize: number;
  showOval: boolean;
  ovalWidth: number;
  ovalHeightPx: number;
  ovalRotateDeg: number;
  ovalOffsetX: number;
  ovalOffsetY: number;
  ovalShadeHighlight: number;
  ovalShadeShadow: number;
  ovalShadeForm: number;
  ovalShadeOpacity: number;
  extraOvals: SerializableOvalExtra[];
  showCircle: boolean;
  showPose: boolean;
  poseFigureMode: boolean;
  poseMinConfidence: number;
  poseOffsetX: number;
  poseOffsetY: number;
  circleDiameterPx: number;
  circleRotateDeg: number;
  circleOffsetX: number;
  circleOffsetY: number;
  showRectangle: boolean;
  rectangleWidth: number;
  rectangleHeightPx: number;
  rectangleRotateDeg: number;
  rectangleOffsetX: number;
  rectangleOffsetY: number;
  showBox3d: boolean;
  box3dWidth: number;
  box3dHeightPx: number;
  box3dDepthPx: number;
  box3dRotateDeg: number;
  box3dYawDeg: number;
  box3dPitchDeg: number;
  box3dOffsetX: number;
  box3dOffsetY: number;
  /**
   * When true, each stroke point is (x,y) in 0–1 of the slide image's rendered width/height at draw time,
   * and stroke.size is line width relative to min(rendered width, height). Legacy false = image-local CSS pixels.
   */
  pencilStrokesUv: boolean;
  pencilStrokes: PencilStroke[];
};

export function defaultPerImageSlideData(): PerImageSlideData {
  return {
    panX: 0,
    panY: 0,
    imageScale: DEFAULT_SETTINGS.imageScale,
    imageBrightness: DEFAULT_SETTINGS.imageBrightness,
    imageContrast: DEFAULT_SETTINGS.imageContrast,
    imageRotate: DEFAULT_SETTINGS.imageRotate,
    imageFlipH: DEFAULT_SETTINGS.imageFlipH,
    imageFlipV: DEFAULT_SETTINGS.imageFlipV,
    imageGrayscale: DEFAULT_SETTINGS.imageGrayscale,
    imageSaturation: DEFAULT_SETTINGS.imageSaturation,
    imageBlur: DEFAULT_SETTINGS.imageBlur,
    showCenterFrame: DEFAULT_SETTINGS.showCenterFrame !== false,
    showGrid: DEFAULT_SETTINGS.showGrid !== false,
    gridCellSize: DEFAULT_SETTINGS.gridCellSize,
    centerFrameSize: DEFAULT_SETTINGS.centerFrameSize,
    centerFrameLabelSize: DEFAULT_SETTINGS.centerFrameLabelSize,
    showOval: DEFAULT_SETTINGS.showOval !== false,
    ovalWidth: DEFAULT_SETTINGS.ovalWidth,
    ovalHeightPx: DEFAULT_SETTINGS.ovalHeightPx,
    ovalRotateDeg: DEFAULT_SETTINGS.ovalRotateDeg,
    ovalOffsetX: DEFAULT_SETTINGS.ovalOffsetX,
    ovalOffsetY: DEFAULT_SETTINGS.ovalOffsetY,
    ovalShadeHighlight: DEFAULT_SETTINGS.ovalShadeHighlight,
    ovalShadeShadow: DEFAULT_SETTINGS.ovalShadeShadow,
    ovalShadeForm: DEFAULT_SETTINGS.ovalShadeForm,
    ovalShadeOpacity: DEFAULT_SETTINGS.ovalShadeOpacity,
    extraOvals: [],
    showCircle: DEFAULT_SETTINGS.showCircle !== false,
    showPose: DEFAULT_SETTINGS.showPose === true,
    poseFigureMode: DEFAULT_SETTINGS.poseFigureMode !== false,
    poseMinConfidence: DEFAULT_SETTINGS.poseMinConfidence,
    poseOffsetX: DEFAULT_SETTINGS.poseOffsetX,
    poseOffsetY: DEFAULT_SETTINGS.poseOffsetY,
    circleDiameterPx: DEFAULT_SETTINGS.circleDiameterPx,
    circleRotateDeg: DEFAULT_SETTINGS.circleRotateDeg,
    circleOffsetX: DEFAULT_SETTINGS.circleOffsetX,
    circleOffsetY: DEFAULT_SETTINGS.circleOffsetY,
    showRectangle: DEFAULT_SETTINGS.showRectangle !== false,
    rectangleWidth: DEFAULT_SETTINGS.rectangleWidth,
    rectangleHeightPx: DEFAULT_SETTINGS.rectangleHeightPx,
    rectangleRotateDeg: DEFAULT_SETTINGS.rectangleRotateDeg,
    rectangleOffsetX: DEFAULT_SETTINGS.rectangleOffsetX,
    rectangleOffsetY: DEFAULT_SETTINGS.rectangleOffsetY,
    showBox3d: DEFAULT_SETTINGS.showBox3d !== false,
    box3dWidth: DEFAULT_SETTINGS.box3dWidth,
    box3dHeightPx: DEFAULT_SETTINGS.box3dHeightPx,
    box3dDepthPx: DEFAULT_SETTINGS.box3dDepthPx,
    box3dRotateDeg: DEFAULT_SETTINGS.box3dRotateDeg,
    box3dYawDeg: DEFAULT_SETTINGS.box3dYawDeg,
    box3dPitchDeg: DEFAULT_SETTINGS.box3dPitchDeg,
    box3dOffsetX: DEFAULT_SETTINGS.box3dOffsetX,
    box3dOffsetY: DEFAULT_SETTINGS.box3dOffsetY,
    pencilStrokesUv: true,
    pencilStrokes: [],
  };
}

/** True if this slide has at least one pencil stroke with a point. */
export function hasPencilMarkings(d: PerImageSlideData): boolean {
  for (const st of d.pencilStrokes ?? []) {
    if ((st.points?.length ?? 0) > 0) return true;
  }
  return false;
}

/**
 * For every saved slide with no pencil ink, replace data with {@link defaultPerImageSlideData}
 * so overlays, pan/zoom tweaks, and shape state are cleared (bare photo + defaults only).
 * Slides with any pencil stroke are left unchanged.
 */
export function resetNonPencilSlidesToBare(aggregate: Record<string, PerImageSlideData>): {
  next: Record<string, PerImageSlideData>;
  changed: boolean;
} {
  const next: Record<string, PerImageSlideData> = { ...aggregate };
  let changed = false;
  for (const key of Object.keys(next)) {
    const d = next[key];
    if (!d) continue;
    if (hasPencilMarkings(d)) continue;
    next[key] = defaultPerImageSlideData();
    changed = true;
  }
  return { next, changed };
}

/** Higher = more pencil ink, extra ovals, and non-default overlay / adjustment state (saved JSON footprint). */
export function perImageMarkupScore(d: PerImageSlideData): number {
  const def = defaultPerImageSlideData();
  let score = 0;
  for (const st of d.pencilStrokes ?? []) {
    score += (st.points?.length ?? 0) + 6;
  }
  score += 140 * (d.extraOvals?.length ?? 0);
  const fields: (keyof PerImageSlideData)[] = [
    "panX",
    "panY",
    "imageScale",
    "imageBrightness",
    "imageContrast",
    "imageRotate",
    "imageFlipH",
    "imageFlipV",
    "imageGrayscale",
    "imageSaturation",
    "imageBlur",
    "showCenterFrame",
    "showGrid",
    "gridCellSize",
    "centerFrameSize",
    "centerFrameLabelSize",
    "showOval",
    "ovalWidth",
    "ovalHeightPx",
    "ovalRotateDeg",
    "ovalOffsetX",
    "ovalOffsetY",
    "ovalShadeHighlight",
    "ovalShadeShadow",
    "ovalShadeForm",
    "ovalShadeOpacity",
    "showCircle",
    "showPose",
    "poseFigureMode",
    "poseMinConfidence",
    "poseOffsetX",
    "poseOffsetY",
    "circleDiameterPx",
    "circleRotateDeg",
    "circleOffsetX",
    "circleOffsetY",
    "showRectangle",
    "rectangleWidth",
    "rectangleHeightPx",
    "rectangleRotateDeg",
    "rectangleOffsetX",
    "rectangleOffsetY",
    "showBox3d",
    "box3dWidth",
    "box3dHeightPx",
    "box3dDepthPx",
    "box3dRotateDeg",
    "box3dYawDeg",
    "box3dPitchDeg",
    "box3dOffsetX",
    "box3dOffsetY",
    "pencilStrokesUv",
  ];
  for (const k of fields) {
    const a = d[k];
    const b = def[k];
    if (typeof a === "number" && typeof b === "number") {
      if (Math.abs(a - b) > 1e-5) score += 2;
    } else if (a !== b) {
      score += 2;
    }
  }
  return score;
}

/** Legacy strokes: image-local CSS pixels + absolute line width. Converts in place to UV + relative size. */
export function migrateLegacyPencilStrokesToUv(strokes: PencilStroke[], cw: number, ch: number) {
  if (!cw || !ch) return;
  const m = Math.min(cw, ch) || 1;
  for (const st of strokes) {
    for (const p of st.points) {
      p.x /= cw;
      p.y /= ch;
    }
    st.size /= m;
  }
}

/** Map UV-space stroke to current image CSS pixel box (for canvas draw). */
export function pencilStrokeToDisplayPixels(stroke: PencilStroke, cw: number, ch: number): PencilStroke {
  const m = Math.min(cw, ch) || 1;
  return {
    color: stroke.color,
    size: stroke.size * m,
    points: stroke.points.map((p) => ({ x: p.x * cw, y: p.y * ch })),
  };
}

export function sanitizePencilStrokes(raw: unknown): PencilStroke[] {
  if (!Array.isArray(raw)) return [];
  const out: PencilStroke[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const o = item as Record<string, unknown>;
    const color = typeof o.color === "string" && o.color ? o.color : "#ff3b30";
    const size = Math.min(24, Math.max(1, Number(o.size) || 4));
    const ptsRaw = o.points;
    if (!Array.isArray(ptsRaw)) continue;
    const points: PencilPoint[] = [];
    for (const p of ptsRaw) {
      if (!p || typeof p !== "object") continue;
      const pr = p as Record<string, unknown>;
      const x = Number(pr.x);
      const y = Number(pr.y);
      if (Number.isFinite(x) && Number.isFinite(y)) points.push({ x, y });
    }
    if (points.length) out.push({ color, size, points });
  }
  return out;
}

export function sanitizeSerializableOvals(raw: unknown): SerializableOvalExtra[] {
  if (!Array.isArray(raw)) return [];
  const out: SerializableOvalExtra[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const o = item as Record<string, unknown>;
    const id = typeof o.id === "string" && o.id ? o.id : String(out.length + 1);
    const width = Math.min(560, Math.max(80, Number(o.width) || DEFAULT_SETTINGS.ovalWidth));
    const heightPx = Math.min(560, Math.max(48, Number(o.heightPx) || DEFAULT_SETTINGS.ovalHeightPx));
    const rotateDeg = Math.min(180, Math.max(-180, Number(o.rotateDeg) || 0));
    const offsetX = Number.isFinite(Number(o.offsetX)) ? Number(o.offsetX) : 0;
    const offsetY = Number.isFinite(Number(o.offsetY)) ? Number(o.offsetY) : 0;
    const shadeHighlight = Math.min(100, Math.max(0, Number(o.shadeHighlight) || DEFAULT_SETTINGS.ovalShadeHighlight));
    const shadeShadow = Math.min(100, Math.max(0, Number(o.shadeShadow) || DEFAULT_SETTINGS.ovalShadeShadow));
    const shadeForm = Math.min(100, Math.max(0, Number(o.shadeForm) || DEFAULT_SETTINGS.ovalShadeForm));
    const shadeOpacity = Math.min(100, Math.max(0, Number(o.shadeOpacity) || DEFAULT_SETTINGS.ovalShadeOpacity));
    out.push({
      id,
      width,
      heightPx,
      rotateDeg,
      offsetX,
      offsetY,
      shadeHighlight,
      shadeShadow,
      shadeForm,
      shadeOpacity,
    });
  }
  return out;
}

export function sanitizePerImageSlideData(raw: unknown): PerImageSlideData | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const d = defaultPerImageSlideData();
  const num = (v: unknown, fallback: number, min: number, max: number) => {
    const n = Number(v);
    return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
  };
  const bool = (v: unknown, fallback: boolean) => (typeof v === "boolean" ? v : fallback);
  d.panX = num(o.panX, d.panX, -20000, 20000);
  d.panY = num(o.panY, d.panY, -20000, 20000);
  d.imageScale = num(o.imageScale, d.imageScale, 0.25, 3);
  d.imageBrightness = num(o.imageBrightness, d.imageBrightness, 0, 2);
  d.imageContrast = num(o.imageContrast, d.imageContrast, 0, 3);
  d.imageRotate = num(o.imageRotate, d.imageRotate, 0, 360);
  d.imageFlipH = bool(o.imageFlipH, d.imageFlipH);
  d.imageFlipV = bool(o.imageFlipV, d.imageFlipV);
  d.imageGrayscale = num(o.imageGrayscale, d.imageGrayscale, 0, 1);
  d.imageSaturation = num(o.imageSaturation, d.imageSaturation, 0, 2);
  d.imageBlur = num(o.imageBlur, d.imageBlur, 0, 10);
  d.showCenterFrame = bool(o.showCenterFrame, d.showCenterFrame);
  d.showGrid = bool(o.showGrid, d.showGrid);
  d.gridCellSize = num(o.gridCellSize, d.gridCellSize, 16, 200);
  d.centerFrameSize = num(o.centerFrameSize, d.centerFrameSize, 48, 480);
  d.centerFrameLabelSize = num(o.centerFrameLabelSize, d.centerFrameLabelSize, 8, 300);
  d.showOval = bool(o.showOval, d.showOval);
  d.ovalWidth = num(o.ovalWidth, d.ovalWidth, 80, 560);
  d.ovalHeightPx = num(o.ovalHeightPx, d.ovalHeightPx, 48, 560);
  d.ovalRotateDeg = num(o.ovalRotateDeg, d.ovalRotateDeg, -180, 180);
  d.ovalOffsetX = num(o.ovalOffsetX, d.ovalOffsetX, -4000, 4000);
  d.ovalOffsetY = num(o.ovalOffsetY, d.ovalOffsetY, -4000, 4000);
  d.ovalShadeHighlight = num(o.ovalShadeHighlight, d.ovalShadeHighlight, 0, 100);
  d.ovalShadeShadow = num(o.ovalShadeShadow, d.ovalShadeShadow, 0, 100);
  d.ovalShadeForm = num(o.ovalShadeForm, d.ovalShadeForm, 0, 100);
  d.ovalShadeOpacity = num(o.ovalShadeOpacity, d.ovalShadeOpacity, 0, 100);
  d.extraOvals = sanitizeSerializableOvals(o.extraOvals);
  d.showCircle = bool(o.showCircle, d.showCircle);
  d.showPose = bool(o.showPose, d.showPose);
  d.poseFigureMode = bool(o.poseFigureMode, d.poseFigureMode);
  d.poseMinConfidence = num(o.poseMinConfidence, d.poseMinConfidence, 0.05, 0.95);
  d.poseOffsetX = num(o.poseOffsetX, d.poseOffsetX, -4000, 4000);
  d.poseOffsetY = num(o.poseOffsetY, d.poseOffsetY, -4000, 4000);
  d.circleDiameterPx = num(o.circleDiameterPx, d.circleDiameterPx, 48, 560);
  d.circleRotateDeg = num(o.circleRotateDeg, d.circleRotateDeg, -180, 180);
  d.circleOffsetX = num(o.circleOffsetX, d.circleOffsetX, -4000, 4000);
  d.circleOffsetY = num(o.circleOffsetY, d.circleOffsetY, -4000, 4000);
  d.showRectangle = bool(o.showRectangle, d.showRectangle);
  d.rectangleWidth = num(o.rectangleWidth, d.rectangleWidth, 80, 560);
  d.rectangleHeightPx = num(o.rectangleHeightPx, d.rectangleHeightPx, 48, 560);
  d.rectangleRotateDeg = num(o.rectangleRotateDeg, d.rectangleRotateDeg, -180, 180);
  d.rectangleOffsetX = num(o.rectangleOffsetX, d.rectangleOffsetX, -4000, 4000);
  d.rectangleOffsetY = num(o.rectangleOffsetY, d.rectangleOffsetY, -4000, 4000);
  d.showBox3d = bool(o.showBox3d, d.showBox3d);
  d.box3dWidth = num(o.box3dWidth, d.box3dWidth, 80, 560);
  d.box3dHeightPx = num(o.box3dHeightPx, d.box3dHeightPx, 48, 560);
  d.box3dDepthPx = num(o.box3dDepthPx, d.box3dDepthPx, 24, 560);
  d.box3dRotateDeg = num(o.box3dRotateDeg, d.box3dRotateDeg, -180, 180);
  d.box3dYawDeg = num(o.box3dYawDeg, d.box3dYawDeg, -180, 180);
  d.box3dPitchDeg = num(o.box3dPitchDeg, d.box3dPitchDeg, -180, 180);
  d.box3dOffsetX = num(o.box3dOffsetX, d.box3dOffsetX, -4000, 4000);
  d.box3dOffsetY = num(o.box3dOffsetY, d.box3dOffsetY, -4000, 4000);
  d.pencilStrokes = sanitizePencilStrokes(o.pencilStrokes);
  if (!d.pencilStrokes.length) {
    d.pencilStrokesUv = true;
  } else {
    d.pencilStrokesUv = bool(o.pencilStrokesUv, false);
  }
  return d;
}

export type ParsedPerImageAggregate = {
  images: Record<string, PerImageSlideData>;
  /** 0 = legacy file without this field; >= {@link PER_IMAGE_BARE_NON_PENCIL_VERSION} after migration. */
  bareNonPencilMigrationVersion: number;
};

export function parsePerImageAggregateJSON(text: string): ParsedPerImageAggregate {
  try {
    const parsed = JSON.parse(text) as unknown;
    if (!parsed || typeof parsed !== "object") {
      return { images: {}, bareNonPencilMigrationVersion: 0 };
    }
    const root = parsed as Record<string, unknown>;
    const imagesRaw = root.images;
    if (!imagesRaw || typeof imagesRaw !== "object") {
      return { images: {}, bareNonPencilMigrationVersion: 0 };
    }
    const v = Number(root.bareNonPencilMigrationVersion);
    const bareNonPencilMigrationVersion =
      Number.isFinite(v) && v >= 0 ? Math.floor(v) : 0;
    const out: Record<string, PerImageSlideData> = {};
    for (const [pathKey, val] of Object.entries(imagesRaw)) {
      if (!pathKey) continue;
      const s = sanitizePerImageSlideData(val);
      if (s) out[pathKey] = s;
    }
    return { images: out, bareNonPencilMigrationVersion };
  } catch {
    return { images: {}, bareNonPencilMigrationVersion: 0 };
  }
}

export async function readPerImageAggregateFromDirectory(
  dir: FileSystemDirectoryHandle
): Promise<ParsedPerImageAggregate> {
  try {
    const fh = await dir.getFileHandle(PER_IMAGE_AGGREGATE_FILENAME);
    const file = await fh.getFile();
    const text = await file.text();
    return parsePerImageAggregateJSON(text);
  } catch {
    /** No file yet: treat as already migrated so we do not write a bare migration for empty folders. */
    return { images: {}, bareNonPencilMigrationVersion: PER_IMAGE_BARE_NON_PENCIL_VERSION };
  }
}

export async function writePerImageAggregateToDirectory(
  dir: FileSystemDirectoryHandle,
  images: Record<string, PerImageSlideData>,
  opts?: { bareNonPencilMigrationVersion?: number }
): Promise<void> {
  const bareNonPencilMigrationVersion =
    opts?.bareNonPencilMigrationVersion ?? PER_IMAGE_BARE_NON_PENCIL_VERSION;
  const fh = await dir.getFileHandle(PER_IMAGE_AGGREGATE_FILENAME, { create: true });
  const stream = await fh.createWritable();
  await stream.write(
    JSON.stringify(
      {
        version: PER_IMAGE_AGGREGATE_VERSION,
        bareNonPencilMigrationVersion,
        images,
      },
      null,
      2
    )
  );
  await stream.close();
}
