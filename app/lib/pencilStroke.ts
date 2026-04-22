import type { PencilPoint, PencilStroke } from "./perImageSlide";

export function drawSmoothPencilStroke(ctx: CanvasRenderingContext2D, stroke: PencilStroke) {
  const pts = stroke.points;
  if (pts.length === 0) return;
  ctx.strokeStyle = stroke.color;
  ctx.fillStyle = stroke.color;
  ctx.lineWidth = stroke.size;
  ctx.lineJoin = "round";
  ctx.lineCap = "round";
  if (pts.length === 1) {
    const p = pts[0]!;
    ctx.beginPath();
    ctx.arc(p.x, p.y, Math.max(0.5, stroke.size / 2), 0, Math.PI * 2);
    ctx.fill();
    return;
  }
  const finite = pts.filter((p) => p && Number.isFinite(p.x) && Number.isFinite(p.y));
  if (finite.length < 2) return;
  const p0 = finite[0]!;
  const pl = finite[finite.length - 1]!;
  const closeEps = Math.max(1e-3, stroke.size * 0.05);
  const closed =
    finite.length >= 3 && Math.hypot(p0.x - pl.x, p0.y - pl.y) < closeEps;
  // Always draw as a polyline (vectors), not a Bezier curve.
  ctx.beginPath();
  ctx.moveTo(p0.x, p0.y);
  const end = closed ? finite.length - 1 : finite.length;
  for (let i = 1; i < end; i++) ctx.lineTo(finite[i]!.x, finite[i]!.y);
  if (closed) ctx.closePath();
  ctx.stroke();
}

export function smoothPencilPoints(points: PencilPoint[], iterations: number): PencilPoint[] {
  if (points.length < 3 || iterations <= 0) return points;
  let out = points;
  for (let t = 0; t < iterations; t++) {
    const next = out.map((p) => ({ ...p }));
    for (let i = 1; i < out.length - 1; i++) {
      const a = out[i - 1]!;
      const b = out[i]!;
      const c = out[i + 1]!;
      // Laplacian-like smoothing; keeps point count fixed.
      next[i] = {
        x: 0.2 * a.x + 0.6 * b.x + 0.2 * c.x,
        y: 0.2 * a.y + 0.6 * b.y + 0.2 * c.y,
      };
    }
    out = next;
  }
  return out;
}

function perpendicularDistanceToSegment(p: PencilPoint, a: PencilPoint, b: PencilPoint): number {
  const vx = b.x - a.x;
  const vy = b.y - a.y;
  const wx = p.x - a.x;
  const wy = p.y - a.y;
  const vv = vx * vx + vy * vy;
  if (vv < 1e-8) return Math.hypot(wx, wy);
  const t = Math.max(0, Math.min(1, (wx * vx + wy * vy) / vv));
  const qx = a.x + t * vx;
  const qy = a.y + t * vy;
  return Math.hypot(p.x - qx, p.y - qy);
}

export function simplifyPencilPointsRdp(points: PencilPoint[], epsilon: number): PencilPoint[] {
  if (points.length < 3 || epsilon <= 0) return points;
  const keep = new Array(points.length).fill(false);
  keep[0] = true;
  keep[points.length - 1] = true;
  const stack: Array<[number, number]> = [[0, points.length - 1]];
  while (stack.length > 0) {
    const [start, end] = stack.pop()!;
    let maxDist = -1;
    let idx = -1;
    const a = points[start]!;
    const b = points[end]!;
    for (let i = start + 1; i < end; i++) {
      const d = perpendicularDistanceToSegment(points[i]!, a, b);
      if (d > maxDist) {
        maxDist = d;
        idx = i;
      }
    }
    if (idx !== -1 && maxDist > epsilon) {
      keep[idx] = true;
      if (idx - start > 1) stack.push([start, idx]);
      if (end - idx > 1) stack.push([idx, end]);
    }
  }
  const out: PencilPoint[] = [];
  for (let i = 0; i < points.length; i++) if (keep[i]) out.push(points[i]!);
  return out.length >= 2 ? out : [points[0]!, points[points.length - 1]!];
}

export function simplifyPencilPoints(points: PencilPoint[], minStepPx: number): PencilPoint[] {
  if (points.length < 3) return points;
  const out: PencilPoint[] = [points[0]!];
  const minStep2 = minStepPx * minStepPx;
  let last = points[0]!;
  for (let i = 1; i < points.length - 1; i++) {
    const p = points[i]!;
    const dx = p.x - last.x;
    const dy = p.y - last.y;
    if (dx * dx + dy * dy >= minStep2) {
      out.push(p);
      last = p;
    }
  }
  out.push(points[points.length - 1]!);
  return out;
}

export function resamplePencilPoints(points: PencilPoint[], spacingPx: number): PencilPoint[] {
  if (points.length < 2) return points;
  const out: PencilPoint[] = [points[0]!];
  let carry = 0;
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1]!;
    const b = points[i]!;
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const segLen = Math.hypot(dx, dy);
    if (segLen < 1e-6) continue;
    let dist = spacingPx - carry;
    while (dist <= segLen) {
      const t = dist / segLen;
      out.push({ x: a.x + dx * t, y: a.y + dy * t });
      dist += spacingPx;
    }
    carry = segLen - (dist - spacingPx);
  }
  const last = points[points.length - 1]!;
  const end = out[out.length - 1]!;
  if (Math.hypot(last.x - end.x, last.y - end.y) > 0.25) out.push(last);
  return out;
}

function normalizeVec(x: number, y: number): PencilPoint {
  const len = Math.hypot(x, y);
  if (len < 1e-8) return { x: 1, y: 0 };
  return { x: x / len, y: y / len };
}

export function fitSingleCubicBezier(points: PencilPoint[]): [PencilPoint, PencilPoint, PencilPoint, PencilPoint] {
  const p0 = points[0]!;
  const p3 = points[points.length - 1]!;
  if (points.length < 3) {
    const d = Math.hypot(p3.x - p0.x, p3.y - p0.y) / 3;
    return [p0, { x: p0.x + d, y: p0.y }, { x: p3.x - d, y: p3.y }, p3];
  }
  let i1 = 1;
  while (i1 < points.length && Math.hypot(points[i1]!.x - p0.x, points[i1]!.y - p0.y) < 1e-6) i1++;
  let i2 = points.length - 2;
  while (i2 >= 0 && Math.hypot(points[i2]!.x - p3.x, points[i2]!.y - p3.y) < 1e-6) i2--;
  const tanL = i1 < points.length ? normalizeVec(points[i1]!.x - p0.x, points[i1]!.y - p0.y) : { x: 1, y: 0 };
  const tanR = i2 >= 0 ? normalizeVec(points[i2]!.x - p3.x, points[i2]!.y - p3.y) : { x: -1, y: 0 };

  const u: number[] = [0];
  let total = 0;
  for (let i = 1; i < points.length; i++) {
    total += Math.hypot(points[i]!.x - points[i - 1]!.x, points[i]!.y - points[i - 1]!.y);
    u.push(total);
  }
  if (total < 1e-6) {
    return [p0, p0, p3, p3];
  }
  for (let i = 0; i < u.length; i++) u[i] = u[i]! / total;

  let c00 = 0;
  let c01 = 0;
  let c11 = 0;
  let x0 = 0;
  let x1 = 0;
  for (let i = 0; i < points.length; i++) {
    const t = u[i]!;
    const mt = 1 - t;
    const b0 = mt * mt * mt;
    const b1 = 3 * t * mt * mt;
    const b2 = 3 * t * t * mt;
    const b3 = t * t * t;
    const a1x = tanL.x * b1;
    const a1y = tanL.y * b1;
    const a2x = tanR.x * b2;
    const a2y = tanR.y * b2;
    c00 += a1x * a1x + a1y * a1y;
    c01 += a1x * a2x + a1y * a2y;
    c11 += a2x * a2x + a2y * a2y;
    const tmpx = points[i]!.x - (p0.x * (b0 + b1) + p3.x * (b2 + b3));
    const tmpy = points[i]!.y - (p0.y * (b0 + b1) + p3.y * (b2 + b3));
    x0 += a1x * tmpx + a1y * tmpy;
    x1 += a2x * tmpx + a2y * tmpy;
  }
  const det = c00 * c11 - c01 * c01;
  const base = total / 3;
  let alpha = base;
  let beta = base;
  if (Math.abs(det) > 1e-8) {
    alpha = (x0 * c11 - x1 * c01) / det;
    beta = (c00 * x1 - c01 * x0) / det;
  }
  if (!Number.isFinite(alpha) || alpha < 1e-3) alpha = base;
  if (!Number.isFinite(beta) || beta < 1e-3) beta = base;
  const p1 = { x: p0.x + tanL.x * alpha, y: p0.y + tanL.y * alpha };
  const p2 = { x: p3.x + tanR.x * beta, y: p3.y + tanR.y * beta };
  return [p0, p1, p2, p3];
}

export function sampleCubicBezier(
  c0: PencilPoint,
  c1: PencilPoint,
  c2: PencilPoint,
  c3: PencilPoint,
  steps: number
): PencilPoint[] {
  const out: PencilPoint[] = [];
  const n = Math.max(2, steps);
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    const mt = 1 - t;
    const x =
      mt * mt * mt * c0.x + 3 * mt * mt * t * c1.x + 3 * mt * t * t * c2.x + t * t * t * c3.x;
    const y =
      mt * mt * mt * c0.y + 3 * mt * mt * t * c1.y + 3 * mt * t * t * c2.y + t * t * t * c3.y;
    out.push({ x, y });
  }
  return out;
}

export function trySnapStrokeToEllipse(points: PencilPoint[], strokeSize: number): PencilPoint[] | null {
  if (points.length < 12) return null;
  let minX = points[0]!.x;
  let maxX = points[0]!.x;
  let minY = points[0]!.y;
  let maxY = points[0]!.y;
  for (const p of points) {
    if (p.x < minX) minX = p.x;
    if (p.x > maxX) maxX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.y > maxY) maxY = p.y;
  }
  const diag = Math.hypot(maxX - minX, maxY - minY);
  if (diag < Math.max(20, strokeSize * 4)) return null;
  const start = points[0]!;
  const end = points[points.length - 1]!;
  const endGap = Math.hypot(end.x - start.x, end.y - start.y);
  if (endGap > Math.max(26, diag * 0.28, strokeSize * 3.5)) return null;

  let cx = 0;
  let cy = 0;
  for (const p of points) {
    cx += p.x;
    cy += p.y;
  }
  cx /= points.length;
  cy /= points.length;

  let xx = 0;
  let xy = 0;
  let yy = 0;
  for (const p of points) {
    const dx = p.x - cx;
    const dy = p.y - cy;
    xx += dx * dx;
    xy += dx * dy;
    yy += dy * dy;
  }
  xx /= points.length;
  xy /= points.length;
  yy /= points.length;

  const theta = 0.5 * Math.atan2(2 * xy, xx - yy);
  const c = Math.cos(theta);
  const s = Math.sin(theta);
  let su2 = 0;
  let sv2 = 0;
  for (const p of points) {
    const dx = p.x - cx;
    const dy = p.y - cy;
    const u = c * dx + s * dy;
    const v = -s * dx + c * dy;
    su2 += u * u;
    sv2 += v * v;
  }
  let rx = Math.sqrt((2 * su2) / points.length);
  let ry = Math.sqrt((2 * sv2) / points.length);
  if (!Number.isFinite(rx) || !Number.isFinite(ry)) return null;
  if (rx < Math.max(8, strokeSize * 1.2) || ry < Math.max(8, strokeSize * 1.2)) return null;
  const ratio = rx > ry ? rx / ry : ry / rx;
  if (ratio < 1.18) {
    const r = (rx + ry) / 2;
    rx = r;
    ry = r;
  }

  let meanErr = 0;
  for (const p of points) {
    const dx = p.x - cx;
    const dy = p.y - cy;
    const u = c * dx + s * dy;
    const v = -s * dx + c * dy;
    const rr = Math.sqrt((u * u) / (rx * rx) + (v * v) / (ry * ry));
    meanErr += Math.abs(rr - 1);
  }
  meanErr /= points.length;
  if (meanErr > 0.23) return null;

  /**
   * Axis-aligned box fit in a rotated frame: mean |max(|u|/hu,|v|/hv) − 1|.
   * PCA orientation is wrong for squares (isotropic covariance → arbitrary θ); edge midpoints
   * then sit "inside" the PCA box and inflate error. Scan φ ∈ [0, π/2) to find the box that
   * actually matches the stroke.
   */
  const rectOrientSteps = 48;
  let bestRectErr = Infinity;
  let bestRc = 1;
  let bestRs = 0;
  const thetaPca = Math.atan2(s, c);
  const extraPhis = [thetaPca, thetaPca + Math.PI / 4];
  const tryPhi = (phi: number) => {
    const rc = Math.cos(phi);
    const rs = Math.sin(phi);
    let lhu = 0;
    let lhv = 0;
    for (const p of points) {
      const dx = p.x - cx;
      const dy = p.y - cy;
      const u = rc * dx + rs * dy;
      const v = -rs * dx + rc * dy;
      const au = Math.abs(u);
      const av = Math.abs(v);
      if (au > lhu) lhu = au;
      if (av > lhv) lhv = av;
    }
    if (lhu < 1e-6 || lhv < 1e-6) return;
    let err = 0;
    for (const p of points) {
      const dx = p.x - cx;
      const dy = p.y - cy;
      const u = rc * dx + rs * dy;
      const v = -rs * dx + rc * dy;
      const m = Math.max(Math.abs(u) / lhu, Math.abs(v) / lhv);
      err += Math.abs(m - 1);
    }
    err /= points.length;
    if (err < bestRectErr) {
      bestRectErr = err;
      bestRc = rc;
      bestRs = rs;
    }
  };
  const modHalfPi = (phi: number) => ((phi % (Math.PI / 2)) + Math.PI / 2) % (Math.PI / 2);
  for (const phi of extraPhis) tryPhi(modHalfPi(phi));
  for (let k = 0; k < rectOrientSteps; k++) tryPhi((k / rectOrientSteps) * (Math.PI / 2));

  const preferRectangle =
    Number.isFinite(bestRectErr) && bestRectErr < meanErr + 0.01 && bestRectErr < 0.15;

  if (preferRectangle) {
    /**
     * Use the axis-aligned bbox in the best φ frame (min/max of u,v about the stroke mean),
     * not ±max|u|,±max|v| about the centroid. The mean is rarely the rectangle center when
     * sampling along edges is uneven; the old box was shifted and could shoot a corner to
     * the image origin (top-left in image-relative coords).
     */
    let uMin = Infinity;
    let uMax = -Infinity;
    let vMin = Infinity;
    let vMax = -Infinity;
    for (const p of points) {
      const dx = p.x - cx;
      const dy = p.y - cy;
      const u = bestRc * dx + bestRs * dy;
      const v = -bestRs * dx + bestRc * dy;
      if (u < uMin) uMin = u;
      if (u > uMax) uMax = u;
      if (v < vMin) vMin = v;
      if (v > vMax) vMax = v;
    }
    const du = uMax - uMin;
    const dv = vMax - vMin;
    if (
      du >= Math.max(8, strokeSize * 1.2) &&
      dv >= Math.max(8, strokeSize * 1.2) &&
      du > 1e-6 &&
      dv > 1e-6
    ) {
      /** Walk perimeter CCW in (u,v): top edge u_max→u_min at v_max, etc. */
      const cornersUv: PencilPoint[] = [
        { x: uMax, y: vMax },
        { x: uMin, y: vMax },
        { x: uMin, y: vMin },
        { x: uMax, y: vMin },
      ];
      const corners = cornersUv.map(({ x: uu, y: vv }) => ({
        x: cx + bestRc * uu - bestRs * vv,
        y: cy + bestRs * uu + bestRc * vv,
      }));
      let best = 0;
      let bestD2 = Infinity;
      for (let i = 0; i < 4; i++) {
        const q = corners[i]!;
        const d2 = (q.x - start.x) * (q.x - start.x) + (q.y - start.y) * (q.y - start.y);
        if (d2 < bestD2) {
          bestD2 = d2;
          best = i;
        }
      }
      const out: PencilPoint[] = [];
      for (let k = 0; k <= 4; k++) {
        const j = (best + k) % 4;
        const q = corners[j]!;
        // Clone each vertex: k=0 and k=4 reuse the same corner index but must be
        // separate objects — finalize divides every point by image size; a shared ref
        // would be divided twice and land near the top-left (wrong closing point).
        out.push({ x: q.x, y: q.y });
      }
      return out;
    }
    // Degenerate in uv; fall through to ellipse.
  }

  const perimeterApprox = 2 * Math.PI * Math.sqrt((rx * rx + ry * ry) / 2);
  const samples = Math.min(220, Math.max(72, Math.round(perimeterApprox / 3)));
  const out: PencilPoint[] = [];
  for (let i = 0; i <= samples; i++) {
    const t = (i / samples) * Math.PI * 2;
    const u = rx * Math.cos(t);
    const v = ry * Math.sin(t);
    out.push({
      x: cx + c * u - s * v,
      y: cy + s * u + c * v,
    });
  }
  return out;
}
