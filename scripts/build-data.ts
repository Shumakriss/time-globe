// Normalizes raw sources into public/data/{polities,labels,land}.geojson + meta.json.
import { copyFileSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import polylabel from '@mapbox/polylabel';
import { simplifyGeometry } from './lib/simplify.ts';
import { buildPieces } from './lib/pieces.ts';
import type { Feature, FeatureCollection, MultiPolygon, Polygon, Position } from 'geojson';

const RAW = 'data-raw';
const OUT = 'public/data';
const MAX_BYTES = 10 * 1024 ** 3;

// Keep in sync with scripts/fetch-data.ts. Each snapshot lasts until the next one.
const BASEMAP_YEARS = [-123000, -10000, -8000, -5000, -4000];
const CLIO_START = -3400;

// Geometry budget: ~2 km tolerance, ~1 km coordinate grid, drop islets under ~25 km².
const SIMPLIFY_TOL = 0.02; // degrees // degrees // degrees // degrees
const PRECISION = 0.01; // degrees
const MIN_POLY_AREA = 0.002; // deg²

export interface PolityProps {
  id: number;
  name: string;
  from: number;
  to: number;
  src: 'clio' | 'basemaps';
  wiki: string;
  color: string;
  area: number;
  split?: boolean; // solid fill comes from core piece(s) instead of the record itself
}

type Poly = Polygon | MultiPolygon;

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, 'utf8')) as T;
}

function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function colorFor(name: string, src: PolityProps['src']): string {
  const h = hash(name);
  const hue = h % 360;
  if (src === 'basemaps') return `hsl(${hue}, 30%, 55%)`; // muted for prehistoric cultures
  const sat = 55 + ((h >>> 9) % 25);
  const light = 50 + ((h >>> 17) % 15);
  return `hsl(${hue}, ${sat}%, ${light}%)`;
}

// Approximate area in km² (equirectangular with cos(lat) correction), used only for label priority.
function ringArea(ring: Position[]): number {
  let a = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [x1, y1] = ring[j];
    const [x2, y2] = ring[i];
    a += (x1 * y2 - x2 * y1) * Math.cos((((y1 + y2) / 2) * Math.PI) / 180);
  }
  return Math.abs(a / 2) * 111.32 * 111.32;
}

function polygons(g: Poly): Position[][][] {
  return g.type === 'Polygon' ? [g.coordinates] : g.coordinates;
}

function wikiTitleFromUrl(url: unknown): string {
  if (typeof url !== 'string') return '';
  const m = url.match(/wikipedia\.org\/wiki\/([^\s#?,;]+)/);
  return m ? decodeURIComponent(m[1]).replace(/_/g, ' ') : '';
}

function main() {
  mkdirSync(OUT, { recursive: true });
  const features: Feature<Poly, PolityProps>[] = [];
  let id = 1;

  // Cliopatria: one record per polity per span of years with a stable shape.
  const clio = readJson<FeatureCollection<Poly>>(join(RAW, 'cliopatria.geojson'));
  for (const f of clio.features) {
    const p = f.properties ?? {};
    if (p.Type !== 'POLITY' || !f.geometry) continue;
    const name = String(p.Name);
    features.push({
      type: 'Feature',
      geometry: f.geometry,
      properties: {
        id: id++,
        name,
        from: p.FromYear,
        to: p.ToYear,
        src: 'clio',
        wiki: p.Wikipedia || '',
        color: colorFor(name, 'clio'),
        area: Math.round(p.Area ?? 0),
      },
    });
  }

  // historical-basemaps: prehistoric snapshots, each valid until the next snapshot.
  BASEMAP_YEARS.forEach((year, i) => {
    const to = (BASEMAP_YEARS[i + 1] ?? CLIO_START) - 1;
    const fc = readJson<FeatureCollection<Poly>>(join(RAW, `world_bc${-year}.geojson`));
    for (const f of fc.features) {
      const p = f.properties ?? {};
      if (!p.NAME || !f.geometry) continue;
      const name = String(p.NAME);
      features.push({
        type: 'Feature',
        geometry: f.geometry,
        properties: {
          id: id++,
          name,
          from: year,
          to,
          src: 'basemaps',
          wiki: wikiTitleFromUrl(p.weblnks),
          color: colorFor(name, 'basemaps'),
          area: 0,
        },
      });
    }
  });

  // Simplify each feature independently (records from different years overlap by design).
  const simplified = features.flatMap((f) => {
    const geometry = simplifyGeometry(f.geometry, SIMPLIFY_TOL, PRECISION, MIN_POLY_AREA);
    return geometry ? [{ ...f, geometry }] : [];
  });
  console.log(`Simplified ${simplified.length}/${features.length} features`);

  // Label points from simplified geometry: polylabel of each feature's largest polygon.
  const labels: Feature[] = [];
  for (const f of simplified) {
    if (!f.geometry) continue;
    let best: Position[][] | null = null;
    let bestArea = -1;
    let total = 0;
    for (const poly of polygons(f.geometry)) {
      const a = ringArea(poly[0]);
      total += a;
      if (a > bestArea) {
        bestArea = a;
        best = poly;
      }
    }
    if (!best) continue;
    const pt = polylabel(best as number[][][], 0.05);
    const p = f.properties;
    if (!p.area) p.area = Math.round(total);
    labels.push({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [+pt[0].toFixed(3), +pt[1].toFixed(3)] },
      properties: { id: p.id, name: p.name, from: p.from, to: p.to, area: p.area },
    });
  }

  // Fill pieces for interpolating each record toward the polity's next record.
  const t0 = Date.now();
  const { pieces, split, stats: pieceStats } = buildPieces(simplified);
  for (const f of simplified) if (split.has(f.properties.id)) f.properties.split = true;
  console.log(`Built ${pieces.length} pieces in ${((Date.now() - t0) / 1000).toFixed(1)}s`, pieceStats);

  // Encode as TopoJSON: consecutive-year records of a polity share most of their borders,
  // and shared arcs are stored once (~4x smaller than GeoJSON). Pieces share arcs with records too.
  const tmpRecords = join(RAW, 'polities.simplified.geojson');
  const tmpPieces = join(RAW, 'pieces.geojson');
  writeFileSync(tmpRecords, JSON.stringify({ type: 'FeatureCollection', features: simplified }));
  writeFileSync(tmpPieces, JSON.stringify({ type: 'FeatureCollection', features: pieces }));
  execFileSync(
    'npx',
    [
      'mapshaper', '-i', tmpRecords, tmpPieces, 'combine-files',
      '-rename-layers', 'polities,pieces',
      '-o', join(OUT, 'polities.topojson'), 'format=topojson', 'quantization=200000',
    ],
    { stdio: 'inherit', env: { ...process.env, NODE_OPTIONS: '--max-old-space-size=8192' } },
  );
  writeFileSync(join(OUT, 'labels.geojson'), JSON.stringify({ type: 'FeatureCollection', features: labels }));
  copyFileSync(join(RAW, 'ne_50m_land.geojson'), join(OUT, 'land.geojson'));

  const sizes = Object.fromEntries(
    ['polities.topojson', 'labels.geojson', 'land.geojson'].map((n) => [n, statSync(join(OUT, n)).size]),
  );
  const totalBytes = Object.values(sizes).reduce((a, b) => a + b, 0);
  if (totalBytes > MAX_BYTES) throw new Error('Output exceeds 10 GB budget — review required.');

  const meta = {
    minYear: Math.min(...features.map((f) => f.properties.from)),
    maxYear: Math.max(...features.map((f) => f.properties.to)),
    counts: {
      clio: features.filter((f) => f.properties.src === 'clio').length,
      basemaps: features.filter((f) => f.properties.src === 'basemaps').length,
      labels: labels.length,
      pieces: pieces.length,
      ...pieceStats,
    },
    sizesMB: Object.fromEntries(Object.entries(sizes).map(([k, v]) => [k, +(v / 1e6).toFixed(1)])),
  };
  writeFileSync(join(OUT, 'meta.json'), JSON.stringify(meta, null, 2));
  console.log(meta);
}

main();
