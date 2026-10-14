import maplibregl, {
  type CustomLayerInterface,
  type ExpressionSpecification,
  type FilterSpecification,
  type GeoJSONSource,
} from 'maplibre-gl';
import { windowOf, windowRange } from './fills/windows';
import 'maplibre-gl/dist/maplibre-gl.css';
import type { Feature, FeatureCollection } from 'geojson';

/** A documented record: one polity's shape for a span of years. */
export interface PolityProps {
  id: number;
  name: string;
  from: number;
  to: number;
  src: 'clio' | 'basemaps';
  wiki: string;
  color: string;
  pal?: number;
  area: number;
}

// Layers whose visibility depends on the calendar year. Fills are drawn by the custom fill layer.
const YEAR_LAYERS = ['record-hit', 'record-line', 'record-label'];

function yearConditions(year: number): ExpressionSpecification[] {
  return [
    ['<=', ['get', 'from'], year],
    ['>=', ['get', 'to'], year],
  ];
}

const HOVER: ExpressionSpecification = ['boolean', ['feature-state', 'hover'], false];

export function createMap(
  container: string | HTMLElement,
  options: Partial<maplibregl.MapOptions> = {},
): maplibregl.Map {
  return new maplibregl.Map({
    container,
    center: [30, 30],
    zoom: 2.2,
    keyboard: false, // arrow keys scrub time instead
    ...options,
    attributionControl: options.attributionControl ?? {
      compact: true,
      customAttribution: [
        '<a href="https://github.com/Seshat-Global-History-Databank/cliopatria">Cliopatria</a> (Seshat, CC BY 4.0)',
        '<a href="https://github.com/aourednik/historical-basemaps">historical-basemaps</a> (GPL-3.0)',
        '<a href="https://www.naturalearthdata.com/">Natural Earth</a>',
      ],
    },
    style: {
      version: 8,
      projection: { type: 'globe' },
      glyphs: 'https://demotiles.maplibre.org/font/{fontstack}/{range}.pbf',
      sky: {
        'sky-color': '#0b1020',
        'horizon-color': '#24304d',
        'atmosphere-blend': ['interpolate', ['linear'], ['zoom'], 0, 0.9, 5, 0.4, 8, 0],
      },
      sources: {},
      layers: [{ id: 'ocean', type: 'background', paint: { 'background-color': '#0f1a2b' } }],
    },
  });
}

const EMPTY: FeatureCollection = { type: 'FeatureCollection', features: [] };

/**
 * Adds land, borders and labels. Territory fills come from the custom layer, inserted beneath the
 * borders; an invisible fill layer remains for hover and click hit-testing.
 */
export function addHistoryLayers(map: maplibregl.Map, land: FeatureCollection, fills: CustomLayerInterface): void {
  map.addSource('land', { type: 'geojson', data: land });
  map.addSource('records', { type: 'geojson', data: EMPTY });
  map.addSource('labels', { type: 'geojson', data: EMPTY });

  map.addLayer({ id: 'land', type: 'fill', source: 'land', paint: { 'fill-color': '#2a3140' } });
  map.addLayer(fills);
  map.addLayer({
    id: 'record-hit',
    type: 'fill',
    source: 'records',
    layout: { 'fill-sort-key': ['-', ['get', 'area']] }, // small polities win hit-tests
    paint: { 'fill-color': '#000', 'fill-opacity': 0 },
  });
  // Documented borders: never interpolated, snap on the record's year.
  map.addLayer({
    id: 'record-line',
    type: 'line',
    source: 'records',
    paint: {
      'line-color': ['case', HOVER, '#ffffff', 'rgba(8, 11, 18, 0.9)'],
      'line-width': ['case', HOVER, 1.8, 0.7],
    },
  });
  map.addLayer({
    id: 'record-label',
    type: 'symbol',
    source: 'labels',
    layout: {
      'text-field': ['get', 'name'],
      'text-font': ['Open Sans Semibold'],
      'text-size': ['interpolate', ['linear'], ['get', 'area'], 1e4, 10, 1e6, 13, 1e7, 17],
      'text-max-width': 8,
      'symbol-sort-key': ['-', ['get', 'area']],
      'text-padding': 4,
    },
    paint: {
      'text-color': '#f4efe4',
      'text-halo-color': 'rgba(10, 14, 24, 0.85)',
      'text-halo-width': 1.4,
    },
  });
}

interface Spanned {
  from: number;
  to: number;
}

/**
 * Keeps a GeoJSON source holding exactly the features overlapping a year range. After the first
 * load it sends only the difference, so crossing a window boundary doesn't re-send shared features.
 * Features must have unique `id`s.
 */
function createWindowedSource(map: maplibregl.Map, sourceId: string, features: Feature[]) {
  let current = new Set<number>();
  return ([start, end]: [number, number]) => {
    const inRange = features.filter((f) => {
      const p = f.properties as Spanned;
      return p.from <= end && p.to >= start;
    });
    const next = new Set(inRange.map((f) => f.id as number));
    const source = map.getSource<GeoJSONSource>(sourceId)!;
    if (!current.size) {
      source.setData({ type: 'FeatureCollection', features: inRange });
    } else {
      source.updateData({
        remove: [...current].filter((id) => !next.has(id)),
        add: inRange.filter((f) => !current.has(f.id as number)),
      });
    }
    current = next;
  };
}

/**
 * Returns a function that shows the given calendar year: swaps source data when the year enters a
 * new window, and applies the year filter at most once per frame, only when the visible set changes.
 */
export function createYearController(
  map: maplibregl.Map,
  data: { records: FeatureCollection; labels: FeatureCollection },
): (year: number) => void {
  // Unique feature ids: records and labels use the record id (also used for hover state).
  data.records.features.forEach((f) => (f.id = (f.properties as PolityProps).id));
  data.labels.features.forEach((f) => (f.id = (f.properties as PolityProps).id));

  const boundaries = new Set<number>();
  for (const f of data.records.features) {
    const p = f.properties as PolityProps;
    boundaries.add(p.from);
    boundaries.add(p.to + 1);
  }
  const sorted = Float64Array.from(boundaries).sort();
  const intervalOf = (y: number) => {
    let lo = 0;
    let hi = sorted.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (sorted[mid] <= y) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  };

  const windowed = [
    createWindowedSource(map, 'records', data.records.features),
    createWindowedSource(map, 'labels', data.labels.features),
  ];

  let pending: number | null = null;
  let appliedWindow: number | null = null;
  let appliedInterval = -1;
  return (year: number) => {
    const first = pending === null;
    pending = year;
    if (!first) return;
    requestAnimationFrame(() => {
      const y = pending!;
      pending = null;
      const w = windowOf(y);
      if (w !== appliedWindow) {
        appliedWindow = w;
        const range = windowRange(w);
        for (const update of windowed) update(range);
      }
      const interval = intervalOf(y);
      if (interval === appliedInterval) return;
      appliedInterval = interval;
      const filter: FilterSpecification = ['all', ...yearConditions(y)];
      for (const id of YEAR_LAYERS) map.setFilter(id, filter);
    });
  };
}

/** Hover highlight + click callback. */
export function bindPolityInteraction(
  map: maplibregl.Map,
  onHover: (recordId: number | null) => void,
  onSelect: (props: PolityProps | null) => void,
): void {
  const pick = (point: maplibregl.PointLike) => map.queryRenderedFeatures(point, { layers: ['record-hit'] })[0];

  let hovered: number | undefined;
  const setHover = (id: number | undefined) => {
    if (hovered !== undefined) map.setFeatureState({ source: 'records', id: hovered }, { hover: false });
    hovered = id;
    if (id !== undefined) map.setFeatureState({ source: 'records', id }, { hover: true });
    onHover(id ?? null);
  };

  map.on('mousemove', (e) => {
    const f = pick(e.point);
    map.getCanvas().style.cursor = f ? 'pointer' : '';
    const id = f ? (f.properties as PolityProps).id : undefined;
    if (id !== hovered) setHover(id);
  });
  map.on('mouseout', () => setHover(undefined));
  map.on('click', (e) => {
    const f = pick(e.point);
    onSelect(f ? (f.properties as PolityProps) : null);
  });
}
