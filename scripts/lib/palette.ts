// Assigns each polity name a slot in the "pretty" palette so that polities bordering each other at
// the same time rarely share a colour. Adjacency is approximate: two records are neighbours when
// their boundaries pass through the same grid cell while both exist.
import type { Feature, MultiPolygon, Polygon, Position } from 'geojson';

type Poly = Polygon | MultiPolygon;

interface Rec {
  name: string;
  from: number;
  to: number;
  area: number;
}

const CELL = 0.5; // degrees
const STEP = 0.2; // boundary sampling, degrees

function boundaryCells(g: Poly): Set<number> {
  const cells = new Set<number>();
  const add = (x: number, y: number) => cells.add(Math.floor((y + 90) / CELL) * 1000 + Math.floor((x + 180) / CELL));
  const polys: Position[][][] = g.type === 'Polygon' ? [g.coordinates] : g.coordinates;
  for (const poly of polys) {
    for (const ring of poly) {
      for (let i = 1; i < ring.length; i++) {
        const [x0, y0] = ring[i - 1];
        const [x1, y1] = ring[i];
        const n = Math.max(1, Math.ceil(Math.hypot(x1 - x0, y1 - y0) / STEP));
        for (let k = 0; k <= n; k++) add(x0 + ((x1 - x0) * k) / n, y0 + ((y1 - y0) * k) / n);
      }
    }
  }
  return cells;
}

function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

export function assignPalette(records: Feature<Poly, Rec>[], size: number): Map<string, number> {
  // Cell -> records whose boundary passes through it.
  const byCell = new Map<number, number[]>();
  records.forEach((f, i) => {
    for (const c of boundaryCells(f.geometry)) {
      const list = byCell.get(c);
      if (list) list.push(i);
      else byCell.set(c, [i]);
    }
  });

  // Name adjacency weights: shared boundary cells between records alive at the same time.
  const weights = new Map<string, Map<string, number>>();
  const bump = (a: string, b: string) => {
    const m = weights.get(a) ?? new Map<string, number>();
    m.set(b, (m.get(b) ?? 0) + 1);
    weights.set(a, m);
  };
  for (const list of byCell.values()) {
    list.sort((a, b) => records[a].properties.from - records[b].properties.from);
    for (let i = 0; i < list.length; i++) {
      const a = records[list[i]].properties;
      for (let j = i + 1; j < list.length; j++) {
        const b = records[list[j]].properties;
        if (b.from > a.to) break; // sorted by start: no later record overlaps a
        if (a.name === b.name) continue;
        bump(a.name, b.name);
        bump(b.name, a.name);
      }
    }
  }

  // Greedy colouring, biggest polities first: each takes the slot its coloured neighbours use least.
  const areaOf = new Map<string, number>();
  for (const f of records) areaOf.set(f.properties.name, Math.max(areaOf.get(f.properties.name) ?? 0, f.properties.area));
  const names = [...areaOf.keys()].sort((a, b) => areaOf.get(b)! - areaOf.get(a)!);
  const slot = new Map<string, number>();
  for (const name of names) {
    const cost = new Array<number>(size).fill(0);
    for (const [other, w] of weights.get(name) ?? []) {
      const s = slot.get(other);
      if (s !== undefined) cost[s] += w;
    }
    // Rotate the starting slot by name so ties spread across the palette.
    const start = hash(name) % size;
    let best = start;
    for (let k = 1; k < size; k++) {
      const s = (start + k) % size;
      if (cost[s] < cost[best]) best = s;
    }
    slot.set(name, best);
  }
  return slot;
}
