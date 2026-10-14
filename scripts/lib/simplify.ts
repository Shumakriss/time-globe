// Per-feature geometry simplification. Overlapping year-records share no topology,
// so a simple Douglas–Peucker per ring is both faster and more effective than topology-aware tools.
import type { MultiPolygon, Polygon, Position } from 'geojson';

function sqSegDist(p: Position, a: Position, b: Position): number {
  let [x, y] = a;
  let dx = b[0] - x;
  let dy = b[1] - y;
  if (dx !== 0 || dy !== 0) {
    const t = ((p[0] - x) * dx + (p[1] - y) * dy) / (dx * dx + dy * dy);
    if (t > 1) [x, y] = b;
    else if (t > 0) {
      x += dx * t;
      y += dy * t;
    }
  }
  dx = p[0] - x;
  dy = p[1] - y;
  return dx * dx + dy * dy;
}

function douglasPeucker(pts: Position[], sqTol: number): Position[] {
  const keep = new Uint8Array(pts.length);
  keep[0] = keep[pts.length - 1] = 1;
  const stack: [number, number][] = [[0, pts.length - 1]];
  while (stack.length) {
    const [first, last] = stack.pop()!;
    let maxD = 0;
    let idx = 0;
    for (let i = first + 1; i < last; i++) {
      const d = sqSegDist(pts[i], pts[first], pts[last]);
      if (d > maxD) {
        maxD = d;
        idx = i;
      }
    }
    if (maxD > sqTol) {
      keep[idx] = 1;
      stack.push([first, idx], [idx, last]);
    }
  }
  return pts.filter((_, i) => keep[i]);
}

function quantize(ring: Position[], precision: number): Position[] {
  const out: Position[] = [];
  for (const [x, y] of ring) {
    const q: Position = [Math.round(x / precision) * precision, Math.round(y / precision) * precision];
    q[0] = +q[0].toFixed(4);
    q[1] = +q[1].toFixed(4);
    const prev = out[out.length - 1];
    if (!prev || prev[0] !== q[0] || prev[1] !== q[1]) out.push(q);
  }
  return out;
}

function planarArea(ring: Position[]): number {
  let a = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) a += ring[j][0] * ring[i][1] - ring[i][0] * ring[j][1];
  return Math.abs(a / 2);
}

function simplifyRing(ring: Position[], tol: number, precision: number): Position[] | null {
  // Split the closed ring in two so DP has distinct endpoints.
  const open = ring.slice(0, -1);
  if (open.length < 3) return null;
  const mid = Math.floor(open.length / 2);
  const a = douglasPeucker(open.slice(0, mid + 1), tol * tol);
  const b = douglasPeucker([...open.slice(mid), open[0]], tol * tol);
  const q = quantize([...a, ...b.slice(1)], precision);
  if (q.length < 4) return null;
  const first = q[0];
  const last = q[q.length - 1];
  if (first[0] !== last[0] || first[1] !== last[1]) q.push([first[0], first[1]]);
  return q.length >= 4 ? q : null;
}

/** Simplify a (Multi)Polygon. Drops polygons smaller than minArea (deg²) unless it would empty the feature. */
export function simplifyGeometry(
  g: Polygon | MultiPolygon,
  tol: number,
  precision: number,
  minArea: number,
): Polygon | MultiPolygon | null {
  const polys = g.type === 'Polygon' ? [g.coordinates] : g.coordinates;
  const out: Position[][][] = [];
  let biggest: Position[][] | null = null;
  let biggestArea = -1;
  for (const poly of polys) {
    const outer = simplifyRing(poly[0], tol, precision);
    if (!outer) continue;
    const area = planarArea(outer);
    const holes = poly
      .slice(1)
      .map((r) => simplifyRing(r, tol, precision))
      .filter((r): r is Position[] => !!r && planarArea(r) >= minArea);
    const simplified = [outer, ...holes];
    if (area > biggestArea) {
      biggestArea = area;
      biggest = simplified;
    }
    if (area >= minArea) out.push(simplified);
  }
  if (!out.length && biggest) out.push(biggest);
  if (!out.length) return null;
  return out.length === 1 ? { type: 'Polygon', coordinates: out[0] } : { type: 'MultiPolygon', coordinates: out };
}
