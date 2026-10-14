import { feature } from 'topojson-client';
import type { FeatureCollection } from 'geojson';
import type { Topology } from 'topojson-specification';
import './style.css';
import { addHistoryLayers, bindPolityInteraction, createMap, createYearController, type PolityProps } from './map';
import { createFillLayer } from './fills/fillLayer';
import { createMeshFeed } from './fills/meshFeed';
import { createFarSide, type FarSide } from './farSide';
import { createInfoPanel } from './infoPanel';
import { paletteCss, type ColorScheme } from './palette';
import { createSearch } from './search';
import { goTo, jump } from './motion';
import { getDisplayYear, getYear, onDisplayYear, onYear } from './state';
import { createTimeline } from './timeline';
import { normalizeYear } from './timeScale';

const DEFAULT_YEAR = 117;

// Per-viewer preferences (best effort: storage may be unavailable).
function loadPref<T extends string>(key: string, fallback: T, allowed: readonly T[]): T {
  try {
    const v = localStorage.getItem(key) as T | null;
    return v && allowed.includes(v) ? v : fallback;
  } catch {
    return fallback;
  }
}
function savePref(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    // ignore
  }
}

function yearFromHash(): number | null {
  const m = location.hash.match(/y=(-?\d+)/);
  return m ? normalizeYear(Number(m[1])) : null;
}

async function loadJson<T>(url: string): Promise<T> {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${url}: ${r.status}`);
  return r.json() as Promise<T>;
}

async function main() {
  const loading = document.getElementById('loading')!;
  jump(yearFromHash() ?? DEFAULT_YEAR);

  const map = createMap('map');
  if (import.meta.env.DEV) Object.assign(window, { __map: map, __jump: jump });
  createTimeline(document.getElementById('timeline')!);
  let scheme = loadPref<ColorScheme>('scheme', 'map', ['map', 'pretty']);
  const showInfo = createInfoPanel(document.getElementById('info')!, (p) =>
    scheme === 'pretty' ? paletteCss(p.pal ?? 0) : p.color,
  );

  const [topo, labels, land] = await Promise.all([
    loadJson<Topology>('data/polities.topojson'),
    loadJson<FeatureCollection>('data/labels.geojson'),
    loadJson<FeatureCollection>('data/land.geojson'),
    new Promise((r) => map.once('load', r)),
  ]);
  const records = feature(topo, topo.objects.polities) as FeatureCollection;

  // Fills (custom GPU layer) follow the continuous year every frame; borders and labels snap per year.
  let fillsReady = false;
  const feed = createMeshFeed();
  const fills = createFillLayer(map, feed, { scheme, onFirstMesh: () => (fillsReady = true) });
  fills.setYear(getDisplayYear());
  onDisplayYear((y) => fills.setYear(y));
  addHistoryLayers(map, land, fills);
  const applyYear = createYearController(map, { records, labels });
  applyYear(getYear());
  onYear(applyYear);
  bindPolityInteraction(map, (id) => fills.setHover(id), showInfo);

  // Search: fly to a polity, moving time to when it existed if needed.
  const recordById = new Map(records.features.map((f) => [(f.properties as PolityProps).id, f.properties as PolityProps]));
  const boundsById = new Map<number, [number, number, number, number]>();
  for (const f of records.features) {
    const b: [number, number, number, number] = [Infinity, Infinity, -Infinity, -Infinity];
    const walk = (c: unknown): void => {
      if (typeof (c as number[])[0] === 'number') {
        const [x, y] = c as number[];
        if (x < b[0]) b[0] = x;
        if (y < b[1]) b[1] = y;
        if (x > b[2]) b[2] = x;
        if (y > b[3]) b[3] = y;
      } else (c as unknown[]).forEach(walk);
    };
    if (f.geometry && 'coordinates' in f.geometry) walk(f.geometry.coordinates);
    // Shapes spanning the antimeridian would get a world-wide box; fall back to the area estimate.
    if (b[2] - b[0] < 180) boundsById.set((f.properties as PolityProps).id, b);
  }
  createSearch(
    document.getElementById('search')!,
    map,
    labels,
    (id) => showInfo(recordById.get(id) ?? null),
    (id) => boundsById.get(id) ?? null,
  );

  // Toggles: colour scheme and the far-side globe.
  const schemeBtn = document.getElementById('scheme-toggle') as HTMLButtonElement;
  const farBtn = document.getElementById('far-toggle') as HTMLButtonElement;
  const farEl = document.getElementById('far-side')!;
  let far: FarSide | null = null;
  const renderToggles = () => {
    schemeBtn.textContent = scheme === 'pretty' ? 'Colours: Pretty' : 'Colours: Map';
    schemeBtn.setAttribute('aria-pressed', String(scheme === 'pretty'));
    farBtn.setAttribute('aria-pressed', String(!!far));
  };
  schemeBtn.addEventListener('click', () => {
    scheme = scheme === 'pretty' ? 'map' : 'pretty';
    savePref('scheme', scheme);
    fills.setScheme(scheme);
    far?.setScheme(scheme);
    renderToggles();
  });
  const setFarSide = (on: boolean) => {
    if (on === !!far) return;
    farEl.hidden = !on;
    if (on) far = createFarSide(farEl.querySelector('.far-map') as HTMLElement, map, feed, { records, labels, land }, scheme);
    else {
      far?.destroy();
      far = null;
    }
    savePref('farSide', on ? 'on' : 'off');
    renderToggles();
  };
  farBtn.addEventListener('click', () => setFarSide(!far));
  setFarSide(loadPref('farSide', 'off', ['on', 'off']) === 'on');
  renderToggles();

  let hashTimer = 0;
  onYear((y) => {
    clearTimeout(hashTimer);
    hashTimer = window.setTimeout(() => history.replaceState(null, '', `#y=${y}`), 250);
  });
  window.addEventListener('hashchange', () => {
    const y = yearFromHash();
    if (y !== null && y !== getYear()) goTo(y);
  });

  // Reveal once borders are drawn and the first fill mesh has arrived from the worker.
  const reveal = () => (fillsReady ? loading.remove() : setTimeout(reveal, 50));
  map.once('idle', reveal);
}

main().catch((e) => {
  console.error(e);
  document.getElementById('loading')!.textContent = `Failed to load: ${e.message}. Did you run "npm run data"?`;
});
