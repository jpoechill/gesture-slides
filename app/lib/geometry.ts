/** Hit-test point (viewport) against ellipse centered at (cx,cy) with rotation rotDeg (deg). */
export function pointInRotatedEllipse(
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
export function pointInRotatedRect(
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

export function clientPointToSvgUser(
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

/** Snapshot start positions for group-panning extra ovals by id (primary oval uses separate state). */
export function buildExtraOvalPanRecord(
  ids: string[],
  extraOvalsList: { id: string; offsetX: number; offsetY: number }[]
): { ids: string[]; startById: Record<string, { x: number; y: number }> } | undefined {
  if (ids.length === 0) return undefined;
  const startById: Record<string, { x: number; y: number }> = {};
  for (const o of extraOvalsList) {
    if (ids.includes(o.id)) startById[o.id] = { x: o.offsetX, y: o.offsetY };
  }
  const filteredIds = Object.keys(startById);
  if (filteredIds.length === 0) return undefined;
  return { ids: filteredIds, startById };
}

export function normalizeDeg(deg: number): number {
  let d = deg % 360;
  if (d > 180) d -= 360;
  if (d < -180) d += 360;
  return d;
}

/** Normalized ellipse distance: 1 on the rim (rx, ry in pixels). */
export function ellipseNormDistance(
  clientX: number,
  clientY: number,
  cx: number,
  cy: number,
  rotDeg: number,
  rx: number,
  ry: number
): number {
  const dx = clientX - cx;
  const dy = clientY - cy;
  const rad = (rotDeg * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  const xl = dx * cos + dy * sin;
  const yl = -dx * sin + dy * cos;
  const rxs = Math.max(1e-6, rx);
  const rys = Math.max(1e-6, ry);
  return Math.hypot(xl / rxs, yl / rys);
}
