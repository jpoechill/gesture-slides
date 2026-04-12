export const APP_VERSION = "0.6.0";

export const VERSION_HISTORY: { version: string; date: string; changes: string[] }[] = [
  {
    version: "0.6.0",
    date: "2026-04-05",
    changes: [
      "⌘Z / Ctrl+Z undoes overlay changes: shape moves/resizes/rotations (canvas + sidebar sliders), wheel tweaks, new ribcage spawn, and pencil strokes",
      "P enables the pencil tool (sidebar opens); not combined with Ctrl/Cmd (print)",
      "With pencil on, shape overlays ignore pointer events so you can draw over ribcage/head/rectangle/3D box",
      "X turns the pencil off (when it is on); Ctrl/Cmd+X still cuts in inputs",
      "Keyboard shortcuts (P, O, etc.) ignore range/checkbox inputs so focus there does not block them after using shapes",
      "P clears shape selection (yellow) then turns the pencil on",
      "Shift-click another shape while one is selected to multi-select; dragging moves every selected shape together",
      "Extra ribcage ovals: Shift-click to select several (yellow outline); drag moves all selected extras together, or with the primary oval when it is also selected",
      "Dragging the primary ribcage after multi-selecting ovals (no Shift on the drag) keeps the selection and moves every selected oval together",
      "With several ovals selected, a plain click-drag on any of them moves the whole group (resize/rotate handles apply only when a single oval is selected)",
      "Escape deselects all overlays (ribcage, head, rectangle, 3D box, extra ovals)",
    ],
  },
  {
    version: "0.5.9",
    date: "2026-04-05",
    changes: [
      "⌘Z / Ctrl+Z undoes the last pencil stroke (same as Undo stroke in the sidebar)",
    ],
  },
  {
    version: "0.5.8",
    date: "2026-04-05",
    changes: [
      "Hold Space: grab cursor and pan the canvas (over shapes/pencil); fullscreen is now F (was Space)",
    ],
  },
  {
    version: "0.5.7",
    date: "2026-04-05",
    changes: [
      "Per-folder .gesture-slideshow-slides.json stores overlay layout, image adjustments, extra ovals, and pencil strokes per image path; restored when revisiting a slide",
    ],
  },
  {
    version: "0.5.6",
    date: "2026-04-01",
    changes: [
      "Ribcage: full 3D ellipsoid (oval) with latitude/longitude contour lines; smooth shaded mesh underneath",
    ],
  },
  {
    version: "0.5.5",
    date: "2026-04-01",
    changes: [
      "Ribcage: 3D egg mesh with four tinted quadrants, wireframe (emphasized quadrant meridians), depth + yaw/pitch; orbit and edge-drag behavior aligned with the 3D box",
    ],
  },
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
      "Keyboard: arrows, F (fullscreen), Space (hold to pan); preset intervals 15s–1h",
      "Left overlay: image metadata (name, path, size, resolution, last modified)",
      "Right overlay: scale, brightness, contrast, rotate, flip, grayscale, saturation, blur, opacity",
      "Pinch zoom (acceleratable), pan, scale/position memory across slides",
      "Full-width progress timer; advance sound on slide change",
      "Delete moves image to _Deleted; fullscreen keeps header visible",
      "Landscape images fill height; portrait/landscape fit without cropping",
    ],
  },
];
