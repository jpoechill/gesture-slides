import type { TimerMode } from "./classicTimer";
import {
  DEFAULT_SIDEBAR_LEFT,
  DEFAULT_SIDEBAR_RIGHT,
  normalizeSidebarColumns,
  type SidebarSectionId,
} from "./sidebar";

export const SETTINGS_STORAGE_KEY = "gesture-slideshow-settings";

/**
 * Bump when `loadStoredSettings` should run a one-time migration for existing localStorage.
 * Version 2: reset overlay visibility (grids, guides, shapes, pose) to current defaults.
 */
export const SETTINGS_SCHEMA_VERSION = 2;

/**
 * App defaults: keep the canvas clean until the user opts in.
 * - Grids + center frame (guides): off
 * - Geometric overlays (oval, circle, rectangle, 3D box) + pose: off
 * `defaultPerImageSlideData()` mirrors these for new per-image slide rows.
 */
export const DEFAULT_SETTINGS = {
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
  pencilEnabled: false,
  pencilSize: 4,
  pencilColor: "#ff3b30",
  /** 0–100: higher = smoother curves / more simplification. */
  pencilCurveSensitivity: 65,
  showCenterFrame: false,
  showGrid: false,
  gridCellSize: 48,
  centerFrameSize: 136,
  centerFrameLabelSize: 50,
  showOval: false,
  ovalWidth: 139,
  ovalHeightPx: 240,
  ovalRotateDeg: 0,
  ovalOffsetX: 0,
  ovalOffsetY: 0,
  /** 0–100: bright center (white) of the ellipsoid highlight. */
  ovalShadeHighlight: 58,
  /** 0–100: shaded side strength (mix toward black on the falloff). */
  ovalShadeShadow: 48,
  /** 0–100: curvature / terminator tightness (reads more like a solid ellipsoid when higher). */
  ovalShadeForm: 64,
  /** 0–100: master opacity for both shading layers (radial + ambient); outline unchanged. */
  ovalShadeOpacity: 100,
  showCircle: false,
  showPose: false,
  poseFigureMode: true,
  poseMinConfidence: 0.45,
  poseOffsetX: -6,
  poseOffsetY: -6,
  circleDiameterPx: 200,
  circleRotateDeg: 0,
  circleOffsetX: 0,
  circleOffsetY: 0,
  showRectangle: false,
  rectangleWidth: 200,
  rectangleHeightPx: 140,
  rectangleRotateDeg: 0,
  rectangleOffsetX: 0,
  rectangleOffsetY: 0,
  showBox3d: false,
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
  settingsSchemaVersion: SETTINGS_SCHEMA_VERSION,
};

export type AppSettings = typeof DEFAULT_SETTINGS;

export function loadStoredSettings(): typeof DEFAULT_SETTINGS {
  if (typeof window === "undefined") return DEFAULT_SETTINGS;
  try {
    const raw = localStorage.getItem(SETTINGS_STORAGE_KEY);
    if (!raw) return DEFAULT_SETTINGS;
    const parsed = JSON.parse(raw) as Partial<typeof DEFAULT_SETTINGS>;
    const needsMigration =
      parsed.settingsSchemaVersion === undefined || parsed.settingsSchemaVersion < SETTINGS_SCHEMA_VERSION;
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
    if (needsMigration) {
      merged.showCenterFrame = DEFAULT_SETTINGS.showCenterFrame;
      merged.showGrid = DEFAULT_SETTINGS.showGrid;
      merged.showOval = DEFAULT_SETTINGS.showOval;
      merged.showCircle = DEFAULT_SETTINGS.showCircle;
      merged.showRectangle = DEFAULT_SETTINGS.showRectangle;
      merged.showBox3d = DEFAULT_SETTINGS.showBox3d;
      merged.showPose = DEFAULT_SETTINGS.showPose;
      merged.settingsSchemaVersion = SETTINGS_SCHEMA_VERSION;
      saveStoredSettings(merged);
    }
    return merged;
  } catch {
    return DEFAULT_SETTINGS;
  }
}

export function saveStoredSettings(settings: typeof DEFAULT_SETTINGS) {
  if (typeof window === "undefined") return;
  try {
    localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(settings));
  } catch {
    // ignore quota or other errors
  }
}
