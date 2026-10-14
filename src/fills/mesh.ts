// Builds GPU meshes for territory fills. Pure functions, run inside the mesh worker.
import earcut from 'earcut';
import KDBush from 'kdbush';
import { around, distance as greatCircleKm } from 'geokdbush';
import type { Position } from 'geojson';

/** Fill kinds (see scripts/lib/pieces.ts): solid, lost (recedes), gained (grows), yield (taken by a neighbour). */
export const KIND_SOLID = 0;
export const KIND_LOST = 1;
export const KIND_GAINED = 2;
export const KIND_YIELD = 3;

// Draw order: solids, then receding land, then gains on top.
const DRAW_ORDER = [0, 1, 3, 2];

export interface FillItem {
  key: string; // stable id (record or piece), for caching
  polygons: Position[][][]; // [polygon][ring][point] in lng/lat
  kind: number;
  rid: number; // record id (hover)
  from: number; // visible for display years in [from, end)
  end: number;
  rs: number; // growth ramp, in display years
  re: number;
  color: [number, number, number]; // 0..1
  /** For animated kinds: the border the front spreads from (gained/yield) or recedes toward (lost). */
  reference?: { key: number; polygons: Position[][][] };
  /** Items with the same front key share one distance scale, so a gain and its yields move together. */
  front?: number;
}

// Interleaved vertex layout (floats).
export const VERTEX_FLOATS = 12;
// x, y (mercator 0..1), d (0..1 front distance), kind, rs, re, from, end, r, g, b, rid

export interface Mesh {
  vertices: Float32Array;
  indices: Uint32Array;
}

const MAX_LAT = 85;

export function mercatorX(lng: number): number {
  return (lng + 180) / 360;
}

export function mercatorY(lat: number): number {
  const phi = (Math.max(-MAX_LAT, Math.min(MAX_LAT, lat)) * Math.PI) / 180;
  return (1 - Math.log(Math.tan(Math.PI / 4 + phi / 2)) / Math.PI) / 2;
}

/** Sutherland–Hodgman clip of an open ring against an axis-aligned rectangle. */
export function clipRing(ring: Position[], x0: number, y0: number, x1: number, y1: number): Position[] {
  let out = ring;
  const edges: [(p: Position) => boolean, (a: Position, b: Position) => Position][] = [
    [(p) => p[0] >= x0, (a, b) => [x0, a[1] + ((b[1] - a[1]) * (x0 - a[0])) / (b[0] - a[0])]],
    [(p) => p[0] <= x1, (a, b) => [x1, a[1] + ((b[1] - a[1]) * (x1 - a[0])) / (b[0] - a[0])]],
    [(p) => p[1] >= y0, (a, b) => [a[0] + ((b[0] - a[0]) * (y0 - a[1])) / (b[1] - a[1]), y0]],
    [(p) => p[1] <= y1, (a, b) => [a[0] + ((b[0] - a[0]) * (y1 - a[1])) / (b[1] - a[1]), y1]],
  ];
  for (const [inside, intersect] of edges) {
    if (!out.length) break;
    const input = out;
    out = [];
    let prev = input[input.length - 1];
    for (const cur of input) {
      const cIn = inside(cur);
      const pIn = inside(prev);
      if (cIn) {
        if (!pIn) out.push(intersect(prev, cur));
        out.push(cur);
      } else if (pIn) {
        out.push(intersect(prev, cur));
      }
      prev = cur;
    }
  }
  return out;
}

function openRing(ring: Position[]): Position[] {
  const n = ring.length;
  return n > 1 && ring[0][0] === ring[n - 1][0] && ring[0][1] === ring[n - 1][1] ? ring.slice(0, -1) : ring;
}

function bbox(polygon: Position[][]): [number, number, number, number] {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const [x, y] of polygon[0]) {
    if (x < x0) x0 = x;
    if (y < y0) y0 = y;
    if (x > x1) x1 = x;
    if (y > y1) y1 = y;
  }
  return [x0, y0, x1, y1];
}

/**
 * Splits a polygon into grid cells and triangulates each one. The grid keeps triangles small enough
 * to follow the globe's curvature and provides interior vertices for smooth growth gradients.
 * Clips into rows first, then each row into cells, so cost scales with rows + columns, not their product.
 * Calls `emit` with each cell's flat lng/lat coordinates and triangle indices.
 */
export function triangulateGrid(
  polygon: Position[][],
  cell: number,
  emit: (coords: number[], triangles: number[]) => void,
): void {
  const rings = polygon.map(openRing).filter((r) => r.length >= 3);
  if (!rings.length) return;
  const [bx0, by0, bx1, by1] = bbox(rings);
  const emitRings = (clipped: Position[][]) => {
    if (clipped[0].length < 3) return;
    const coords: number[] = [];
    const holes: number[] = [];
    clipped.forEach((r, i) => {
      if (r.length < 3) return;
      if (i > 0) holes.push(coords.length / 2);
      for (const p of r) coords.push(p[0], p[1]);
    });
    const triangles = earcut(coords, holes.length ? holes : undefined, 2);
    if (triangles.length) emit(coords, triangles);
  };
  if (bx1 - bx0 <= cell && by1 - by0 <= cell) {
    emitRings(rings);
    return;
  }
  const gx0 = Math.floor(bx0 / cell) * cell;
  const gy0 = Math.floor(by0 / cell) * cell;
  for (let y = gy0; y < by1; y += cell) {
    const row = rings.map((r) => clipRing(r, -Infinity, y, Infinity, y + cell));
    if (row[0].length < 3) continue;
    const [rx0, , rx1] = bbox(row);
    for (let x = gx0; x < rx1; x += cell) {
      if (x + cell <= rx0) continue;
      emitRings(row.map((r) => (r.length >= 3 ? clipRing(r, x, -Infinity, x + cell, Infinity) : r)));
    }
  }
}

/**
 * Nearest great-circle distance (km) to the boundary of a reference shape. The boundary is thinned
 * to roughly one point per `spacing` degrees (the gradient doesn't need more) and indexed in a k-d tree.
 */
export function createDistanceField(reference: Position[][][], spacing = 0.25): (lng: number, lat: number) => number {
  const sample: Position[] = [];
  for (const poly of reference) {
    for (const ring of poly) {
      let last: Position | null = null;
      for (const p of ring) {
        if (!last || Math.abs(p[0] - last[0]) + Math.abs(p[1] - last[1]) >= spacing) {
          sample.push(p);
          last = p;
        }
      }
    }
  }
  if (!sample.length) return () => 0;
  const index = new KDBush(sample.length);
  for (const p of sample) index.add(p[0], p[1]);
  index.finish();
  return (lng, lat) => {
    const [nearest] = around(index, lng, lat, 1);
    const p = sample[nearest];
    return greatCircleKm(lng, lat, p[0], p[1]);
  };
}

const SOLID_CELL = 6; // degrees: just enough subdivision to follow the globe's curvature (~6 km sag)

/** Cell size for animated areas: ~10 cells across the piece, enough for a smooth front. */
function frontCell(polygons: Position[][][]): number {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const poly of polygons) {
    const [a, b, c, d] = bbox(poly);
    x0 = Math.min(x0, a);
    y0 = Math.min(y0, b);
    x1 = Math.max(x1, c);
    y1 = Math.max(y1, d);
  }
  return Math.min(1.5, Math.max(0.3, Math.max(x1 - x0, y1 - y0) / 10));
}

/** One item's triangulated geometry, before per-front normalization. Cacheable across windows. */
interface ItemMesh {
  vertices: Float32Array; // VERTEX_FLOATS per vertex; d is raw (unnormalized) distance
  indices: Uint32Array; // local to this item
  maxD: number;
}

class Floats {
  data: Float32Array;
  length = 0;
  constructor(capacity = 1 << 12) {
    this.data = new Float32Array(capacity);
  }
  reserve(n: number) {
    if (this.length + n <= this.data.length) return;
    let cap = this.data.length * 2;
    while (cap < this.length + n) cap *= 2;
    const next = new Float32Array(cap);
    next.set(this.data.subarray(0, this.length));
    this.data = next;
  }
}

function meshItem(item: FillItem, field: ((lng: number, lat: number) => number) | null): ItemMesh {
  const verts = new Floats();
  const idx: number[] = [];
  let maxD = 0;
  const cell = item.kind === KIND_SOLID ? SOLID_CELL : frontCell(item.polygons);
  const [r, g, b] = item.color;
  for (const polygon of item.polygons) {
    triangulateGrid(polygon, cell, (coords, triangles) => {
      const base = verts.length / VERTEX_FLOATS;
      verts.reserve((coords.length / 2) * VERTEX_FLOATS);
      const v = verts.data;
      let o = verts.length;
      for (let i = 0; i < coords.length; i += 2) {
        const lng = coords[i];
        const lat = coords[i + 1];
        const d = field ? field(lng, lat) : 0;
        if (d > maxD) maxD = d;
        v[o++] = mercatorX(lng); v[o++] = mercatorY(lat); v[o++] = d; v[o++] = item.kind;
        v[o++] = item.rs; v[o++] = item.re; v[o++] = item.from; v[o++] = item.end;
        v[o++] = r; v[o++] = g; v[o++] = b; v[o++] = item.rid;
      }
      verts.length = o;
      for (const t of triangles) idx.push(base + t);
    });
  }
  return { vertices: verts.data.slice(0, verts.length), indices: Uint32Array.from(idx), maxD };
}

/**
 * Builds one interleaved mesh for all items, solids first so changes draw on top.
 * `cache` (keyed by item key) lets consecutive windows reuse items they share.
 */
export function buildMesh(items: FillItem[], cache?: Map<string, ItemMesh>): Mesh {
  const ordered = [...items].sort((a, b) => DRAW_ORDER.indexOf(a.kind) - DRAW_ORDER.indexOf(b.kind));
  const fields = new Map<number, (lng: number, lat: number) => number>();
  const meshes: ItemMesh[] = [];
  const maxByFront = new Map<number | string, number>();
  let vertexCount = 0;
  let indexCount = 0;
  for (const item of ordered) {
    let m = cache?.get(item.key);
    if (!m) {
      let field: ((lng: number, lat: number) => number) | null = null;
      if (item.kind !== KIND_SOLID && item.reference) {
        field = fields.get(item.reference.key) ?? createDistanceField(item.reference.polygons);
        fields.set(item.reference.key, field);
      }
      m = meshItem(item, field);
      cache?.set(item.key, m);
    }
    meshes.push(m);
    const front = item.front ?? item.key;
    maxByFront.set(front, Math.max(maxByFront.get(front) ?? 0, m.maxD));
    vertexCount += m.vertices.length / VERTEX_FLOATS;
    indexCount += m.indices.length;
  }

  const vertices = new Float32Array(vertexCount * VERTEX_FLOATS);
  const indices = new Uint32Array(indexCount);
  let vo = 0;
  let io = 0;
  ordered.forEach((item, i) => {
    const m = meshes[i];
    const base = vo / VERTEX_FLOATS;
    vertices.set(m.vertices, vo);
    // Normalize front distance to 0..1 per front (a gain and its yields share one scale).
    const maxD = maxByFront.get(item.front ?? item.key)!;
    if (maxD > 0) for (let k = vo + 2; k < vo + m.vertices.length; k += VERTEX_FLOATS) vertices[k] /= maxD;
    for (let k = 0; k < m.indices.length; k++) indices[io + k] = m.indices[k] + base;
    vo += m.vertices.length;
    io += m.indices.length;
  });
  return { vertices, indices };
}

export type { ItemMesh };

/** Parses `hsl(h, s%, l%)` (as written by the data build) to RGB 0..1. */
export function parseColor(css: string): [number, number, number] {
  const m = css.match(/hsl\(\s*([\d.]+)\s*,\s*([\d.]+)%\s*,\s*([\d.]+)%\s*\)/);
  if (!m) return [0.6, 0.6, 0.6];
  const h = Number(m[1]) / 360;
  const s = Number(m[2]) / 100;
  const l = Number(m[3]) / 100;
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const hue = (t: number) => {
    const u = t < 0 ? t + 1 : t > 1 ? t - 1 : t;
    if (u < 1 / 6) return p + (q - p) * 6 * u;
    if (u < 1 / 2) return q;
    if (u < 2 / 3) return p + (q - p) * (2 / 3 - u) * 6;
    return p;
  };
  return [hue(h + 1 / 3), hue(h), hue(h - 1 / 3)];
}
