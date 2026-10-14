// Splits records into fill "pieces" that animate each polity toward its next record:
//   core   (k=0): R ∩ Next — solid for the whole span
//   lost   (k=1): R − Next — recedes toward the next border
//   gained (k=2): Next − R — grows outward from the current border
//   yield  (k=3): part of R taken by a *neighbour's* gain — vanishes exactly as that gain arrives,
//                 so handovers replace one colour with the other instead of blending or leaving holes
// A record that needs no pieces keeps its own geometry as its solid fill ("unsplit").
// Borders are never interpolated; they come from the records themselves.
import polygonClipping, { type Geom } from 'polygon-clipping';
import type { Feature, MultiPolygon, Polygon, Position } from 'geojson';

export const PieceKind = { Core: 0, Lost: 1, Gained: 2, Yield: 3 } as const;
export type PieceKind = (typeof PieceKind)[keyof typeof PieceKind];

export interface RecordLike {
  id: number;
  name: string;
  from: number;
  to: number;
  color: string;
  area: number;
}

export interface PieceProps {
  pid: number; // piece id
  rid: number; // record id (borders, labels, info panel)
  k: PieceKind;
  from: number; // visible while the record is active
  to: number;
  rs: number; // ramp start (fractional year where the change begins)
  re: number; // ramp end (= next record's start)
  ref: number; // record whose border the front is measured from (gained/yield: old shape; lost: new shape)
  front: number; // pieces sharing a front normalize distances together (a gain and the yields it causes)
  color: string;
  area: number; // record area, for draw order
}

type Poly = Polygon | MultiPolygon;
type Polys = Position[][][];

// Slivers narrower than this (deg; ~2.5 km half-width) or smaller than MIN_AREA are
// re-digitization noise between records, not real territorial change.
const MIN_HALF_WIDTH = 0.025;
const MIN_AREA = 0.005; // deg²

/** Years over which a record animates toward its successor. */
export function rampYears(span: number): number {
  return Math.min(span, Math.max(100, span * 0.25));
}

const polysOf = (g: Poly): Polys => (g.type === 'Polygon' ? [g.coordinates] : g.coordinates);
const asGeom = (p: Polys) => p as Geom;

function ringMetrics(ring: Position[]): { area: number; perimeter: number } {
  let a = 0;
  let p = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    a += ring[j][0] * ring[i][1] - ring[i][0] * ring[j][1];
    p += Math.hypot(ring[i][0] - ring[j][0], ring[i][1] - ring[j][1]);
  }
  return { area: Math.abs(a / 2), perimeter: p };
}

function isSignificant(poly: Position[][]): boolean {
  const { area, perimeter } = ringMetrics(poly[0]);
  return area >= MIN_AREA && area / perimeter >= MIN_HALF_WIDTH;
}

function toGeometry(polys: Polys): Poly | null {
  if (!polys.length) return null;
  return polys.length === 1 ? { type: 'Polygon', coordinates: polys[0] } : { type: 'MultiPolygon', coordinates: polys };
}

type BBox = [number, number, number, number];

function bboxOf(polys: Polys): BBox {
  const b: BBox = [Infinity, Infinity, -Infinity, -Infinity];
  for (const poly of polys) {
    for (const [x, y] of poly[0]) {
      if (x < b[0]) b[0] = x;
      if (y < b[1]) b[1] = y;
      if (x > b[2]) b[2] = x;
      if (y > b[3]) b[3] = y;
    }
  }
  return b;
}

const bboxesOverlap = (a: BBox, b: BBox) => a[0] < b[2] && b[0] < a[2] && a[1] < b[3] && b[1] < a[3];

export interface PiecesStats {
  interpolated: number;
  snapped: number;
  failed: number;
  yields: number;
}

interface Piece {
  props: PieceProps;
  polys: Polys;
}

/** Builds pieces for every record. `records` may be in any order. */
export function buildPieces(records: Feature<Poly, RecordLike>[]): {
  pieces: Feature<Poly, PieceProps>[];
  split: Set<number>; // ids of records whose solid fill comes from core pieces
  stats: PiecesStats;
} {
  const byName = new Map<string, Feature<Poly, RecordLike>[]>();
  for (const f of records) {
    const list = byName.get(f.properties.name) ?? [];
    list.push(f);
    byName.set(f.properties.name, list);
  }

  let nextPid = 1;
  const pieces: Piece[] = [];
  const split = new Set<number>();
  const stats: PiecesStats = { interpolated: 0, snapped: 0, failed: 0, yields: 0 };
  const add = (r: RecordLike, k: PieceKind, polys: Polys, rs: number, re: number, ref: number, front?: number) => {
    if (!polys.length) return undefined;
    const pid = nextPid++;
    const props: PieceProps = {
      pid, rid: r.id, k, from: r.from, to: r.to, rs, re, ref, front: front ?? pid, color: r.color, area: r.area,
    };
    pieces.push({ props, polys });
    return props;
  };

  for (const list of byName.values()) {
    list.sort((a, b) => a.properties.from - b.properties.from);
    list.forEach((f, i) => {
      const r = f.properties;
      const next = list[i + 1];
      const end = r.to + 1;

      // Births, deaths and gaps snap: there is no documented shape to animate toward.
      if (!next || next.properties.from !== end) {
        stats.snapped++;
        return;
      }

      const rs = end - rampYears(end - r.from);
      try {
        const a = asGeom(polysOf(f.geometry));
        const b = asGeom(polysOf(next.geometry));
        const core = polygonClipping.intersection(a, b) as Polys;
        const lost = polygonClipping.difference(a, b) as Polys;
        const gained = polygonClipping.difference(b, a) as Polys;
        // Insignificant lost slivers stay solid (folded into core); insignificant gains are dropped.
        const lostSig = lost.filter(isSignificant);
        if (lostSig.length) {
          split.add(r.id);
          add(r, PieceKind.Core, [...core, ...lost.filter((p) => !isSignificant(p))], rs, end, r.id);
          add(r, PieceKind.Lost, lostSig, rs, end, next.properties.id);
        }
        add(r, PieceKind.Gained, gained.filter(isSignificant), rs, end, r.id);
        stats.interpolated++;
      } catch {
        // Degenerate geometry: fall back to snapping (the record fills itself).
        stats.failed++;
      }
    });
  }

  carveYields(pieces, records, split, add, stats);
  syncLossesToBirths(pieces, byName);

  const features: Feature<Poly, PieceProps>[] = [];
  for (const p of pieces) {
    const geometry = toGeometry(p.polys);
    if (geometry) features.push({ type: 'Feature', geometry, properties: p.props });
  }
  return { pieces: features, split, stats };
}

/**
 * Where a polity's gain covers another polity's land at the same handover year, carve that land out
 * of the loser's fill as a "yield" piece driven by the winner's front. Yield fades exactly as the
 * gain appears, so the winner's colour replaces the loser's point by point.
 */
function carveYields(
  pieces: Piece[],
  records: Feature<Poly, RecordLike>[],
  split: Set<number>,
  add: (r: RecordLike, k: PieceKind, polys: Polys, rs: number, re: number, ref: number, front?: number) => PieceProps | undefined,
  stats: PiecesStats,
): void {
  const nameOf = new Map(records.map((r) => [r.properties.id, r.properties.name]));
  const gainsByYear = new Map<number, { p: Piece; box: BBox }[]>();
  for (const p of pieces) {
    if (p.props.k !== PieceKind.Gained) continue;
    const list = gainsByYear.get(p.props.re) ?? [];
    list.push({ p, box: bboxOf(p.polys) });
    gainsByYear.set(p.props.re, list);
  }
  const piecesByRecord = new Map<number, Piece[]>();
  for (const p of pieces) {
    const list = piecesByRecord.get(p.props.rid) ?? [];
    list.push(p);
    piecesByRecord.set(p.props.rid, list);
  }

  for (const rec of records) {
    const v = rec.properties;
    const gains = gainsByYear.get(v.to + 1);
    if (!gains) continue;
    const vBox = bboxOf(polysOf(rec.geometry));
    const rivals = gains.filter((g) => nameOf.get(g.p.props.rid) !== v.name && bboxesOverlap(vBox, g.box));
    if (!rivals.length) continue;

    // The loser's current fills: its core/lost pieces, or (if unsplit) the whole record as core.
    let fills = (piecesByRecord.get(v.id) ?? []).filter((p) => p.props.k === PieceKind.Core || p.props.k === PieceKind.Lost);
    let wholeRecord: Piece | null = null;
    if (!split.has(v.id)) {
      const end = v.to + 1;
      wholeRecord = {
        props: { pid: -1, rid: v.id, k: PieceKind.Core, from: v.from, to: v.to, rs: end, re: end, ref: v.id, front: -1, color: v.color, area: v.area },
        polys: polysOf(rec.geometry),
      };
      fills = [wholeRecord];
    }

    let carved = false;
    for (const f of fills) {
      for (const g of rivals) {
        try {
          const taken = (polygonClipping.intersection(asGeom(f.polys), asGeom(g.p.polys)) as Polys).filter(isSignificant);
          if (!taken.length) continue;
          f.polys = polygonClipping.difference(asGeom(f.polys), asGeom(taken)) as Polys;
          add(v, PieceKind.Yield, taken, g.p.props.rs, g.p.props.re, g.p.props.ref, g.p.props.front);
          carved = true;
          stats.yields++;
        } catch {
          // Leave this pair blended rather than fail the build.
        }
      }
    }
    if (carved && wholeRecord) {
      split.add(v.id);
      const w = wholeRecord.props;
      add(v, PieceKind.Core, wholeRecord.polys, w.rs, w.re, w.ref);
    }
  }
}

/**
 * Land lost to a polity that newly appears (and so snaps into existence) stays solid until the
 * handover year; fading it early would leave an empty hole.
 */
function syncLossesToBirths(pieces: Piece[], byName: Map<string, Feature<Poly, RecordLike>[]>): void {
  const birthsByYear = new Map<number, { name: string; polys: Polys; box: BBox }[]>();
  for (const [name, list] of byName) {
    list.forEach((f, i) => {
      const prev = list[i - 1];
      if (prev && prev.properties.to + 1 === f.properties.from) return;
      const polys = polysOf(f.geometry);
      const l = birthsByYear.get(f.properties.from) ?? [];
      l.push({ name, polys, box: bboxOf(polys) });
      birthsByYear.set(f.properties.from, l);
    });
  }
  const nameOfRecord = new Map<number, string>();
  for (const [name, list] of byName) for (const f of list) nameOfRecord.set(f.properties.id, name);

  for (const p of pieces) {
    if (p.props.k !== PieceKind.Lost || !p.polys.length) continue;
    const box = bboxOf(p.polys);
    const name = nameOfRecord.get(p.props.rid);
    for (const b of birthsByYear.get(p.props.re) ?? []) {
      if (b.name === name || !bboxesOverlap(box, b.box)) continue;
      try {
        if ((polygonClipping.intersection(asGeom(p.polys), asGeom(b.polys)) as Polys).some(isSignificant)) {
          p.props.rs = p.props.re; // stays solid, swaps at the handover year
          break;
        }
      } catch {
        // ignore
      }
    }
  }
}
