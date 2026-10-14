// Splits records into fill "pieces" that animate each polity toward its next record:
//   core   (k=0): R ∩ Next — solid for the whole span
//   lost   (k=1): R − Next — recedes toward the next border
//   gained (k=2): Next − R — grows outward from the current border
//   yield  (k=3): part of R taken by a *neighbour's* gain — vanishes exactly as that gain arrives,
//                 so handovers replace one colour with the other instead of blending or leaving holes
// First appearances grow out of the polity's heartland (a gain measured from a point, `o`) in the
// years before its first record; final records shrink back toward it (a loss measured from `o`).
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
  o?: Position; // births/deaths: the front is measured from this point instead of a record's border
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

/**
 * Years over which a polity grows in before its first record (or shrinks away after its last),
 * from the length of its unbroken run of records.
 */
export function emergeYears(lifetime: number, year: number): number {
  const base = Math.min(20, Math.max(5, Math.round(lifetime * 0.5)));
  return year < -3400 ? base * 10 : base; // prehistory moves in 10-year steps
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

type AddPiece = (
  r: RecordLike, k: PieceKind, polys: Polys, rs: number, re: number, ref: number,
  front?: number, o?: Position, span?: [number, number],
) => PieceProps | undefined;

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
  births: number;
  deaths: number;
}

interface Piece {
  props: PieceProps;
  polys: Polys;
}

/** Builds pieces for every record. `records` may be in any order. */
export function buildPieces(
  records: Feature<Poly, RecordLike>[],
  origins: Map<number, Position>, // record id -> heartland point (label point)
  timeline: { min: number; max: number },
): {
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
  const stats: PiecesStats = { interpolated: 0, snapped: 0, failed: 0, yields: 0, births: 0, deaths: 0 };
  const add: AddPiece = (r, k, polys, rs, re, ref, front, o, span) => {
    if (!polys.length) return undefined;
    const pid = nextPid++;
    const props: PieceProps = {
      pid, rid: r.id, k, from: span?.[0] ?? r.from, to: span?.[1] ?? r.to, rs, re, ref, front: front ?? pid,
      ...(o ? { o } : {}), color: r.color, area: r.area,
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

  // Births: the first record after a gap grows out of its heartland in the preceding years.
  for (const list of byName.values()) {
    list.forEach((f, i) => {
      const r = f.properties;
      const prev = list[i - 1];
      const gap = prev ? r.from - (prev.properties.to + 1) : Infinity;
      const o = origins.get(r.id);
      if (gap <= 0 || r.from <= timeline.min || !o) return;
      let last = i;
      while (list[last + 1] && list[last + 1].properties.from === list[last].properties.to + 1) last++;
      const years = Math.min(gap, emergeYears(list[last].properties.to + 1 - r.from, r.from));
      // A gain measured from a point; neighbours' land it covers becomes yields (see carveYields).
      add(r, PieceKind.Gained, polysOf(f.geometry), r.from - years, r.from, r.id, undefined, o, [r.from - years, r.from - 1]);
      stats.births++;
    });
  }

  carveYields(pieces, records, split, add, stats);
  shrinkDeaths(pieces, byName, split, add, origins, timeline, stats);
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
  add: AddPiece,
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
          add(v, PieceKind.Yield, taken, g.p.props.rs, g.p.props.re, g.p.props.ref, g.p.props.front, g.p.props.o);
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
 * A polity's final record (followed by a gap or the end of its history) shrinks back toward its
 * heartland. Land a neighbour or a newborn takes over is already a yield; only the rest shrinks.
 */
function shrinkDeaths(
  pieces: Piece[],
  byName: Map<string, Feature<Poly, RecordLike>[]>,
  split: Set<number>,
  add: AddPiece,
  origins: Map<number, Position>,
  timeline: { min: number; max: number },
  stats: PiecesStats,
): void {
  const cores = new Map<number, Piece[]>();
  for (const p of pieces) {
    if (p.props.k !== PieceKind.Core) continue;
    const list = cores.get(p.props.rid) ?? [];
    list.push(p);
    cores.set(p.props.rid, list);
  }
  for (const list of byName.values()) {
    list.forEach((f, i) => {
      const r = f.properties;
      const next = list[i + 1];
      const end = r.to + 1;
      const o = origins.get(r.id);
      if ((next && next.properties.from === end) || r.to >= timeline.max || !o) return;
      let first = i;
      while (list[first - 1] && list[first - 1].properties.to + 1 === list[first].properties.from) first--;
      const rs = end - Math.min(end - r.from, emergeYears(end - list[first].properties.from, r.from));
      if (split.has(r.id)) {
        // Only yields and a core remain (no successor means no ordinary gains or losses).
        for (const c of cores.get(r.id) ?? []) {
          Object.assign(c.props, { k: PieceKind.Lost, rs, re: end, o });
        }
      } else {
        split.add(r.id);
        add(r, PieceKind.Lost, polysOf(f.geometry), rs, end, r.id, undefined, o);
      }
      stats.deaths++;
    });
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
