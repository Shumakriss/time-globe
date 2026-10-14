// Selects the fill items (solids and animated pieces) needed to render a time window.
import type { Feature, MultiPolygon, Polygon, Position } from 'geojson';
import { KIND_SOLID, parseColor, type FillItem } from './mesh';

type Poly = Polygon | MultiPolygon;
export interface RecordProps {
  id: number;
  from: number;
  to: number;
  color: string;
  pal?: number;
  split?: boolean;
}
export interface PieceProps {
  pid: number;
  rid: number;
  ref: number;
  front: number;
  k: number;
  from: number;
  to: number;
  rs: number;
  re: number;
  o?: Position; // births/deaths grow from / shrink toward this point
  color: string;
}

const polygonsOf = (g: Poly): Position[][][] => (g.type === 'Polygon' ? [g.coordinates] : g.coordinates);

export function collectItems(
  records: Feature<Poly, RecordProps>[],
  pieces: Feature<Poly, PieceProps>[],
  [start, end]: [number, number],
): FillItem[] {
  const overlaps = (p: { from: number; to: number }) => p.from <= end && p.to >= start;
  const byId = new Map<number, Feature<Poly, RecordProps>>();
  for (const r of records) byId.set(r.properties.id, r);

  const items: FillItem[] = [];
  for (const r of records) {
    const p = r.properties;
    // Split records get their solid fill from core pieces instead.
    if (!overlaps(p) || p.split || !r.geometry) continue;
    items.push({
      key: `r${p.id}`,
      polygons: polygonsOf(r.geometry),
      kind: KIND_SOLID,
      rid: p.id,
      from: p.from,
      end: p.to + 1,
      rs: p.to + 1,
      re: p.to + 1,
      color: parseColor(p.color),
      pal: p.pal ?? 0,
    });
  }
  for (const f of pieces) {
    const p = f.properties;
    if (!overlaps(p) || !f.geometry) continue;
    // Gains (and the yields they cause) spread from the old border; losses recede toward the new one.
    const ref = p.k === KIND_SOLID || p.o ? undefined : byId.get(p.ref);
    items.push({
      key: `p${p.pid}`,
      polygons: polygonsOf(f.geometry),
      kind: p.k,
      rid: p.rid,
      from: p.from,
      end: p.to + 1,
      rs: p.rs,
      re: p.re,
      color: parseColor(p.color),
      pal: byId.get(p.rid)?.properties.pal ?? 0,
      reference: p.o
        ? { key: -p.front, polygons: [[[p.o]]] } // a point: distances measured from the heartland
        : ref?.geometry
          ? { key: p.ref, polygons: polygonsOf(ref.geometry) }
          : undefined,
      front: p.front,
    });
  }
  return items;
}
