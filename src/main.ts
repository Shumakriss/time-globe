import { feature } from 'topojson-client';
import type { FeatureCollection } from 'geojson';
import type { Topology } from 'topojson-specification';
import './style.css';
import { addHistoryLayers, bindPolityInteraction, createMap, createYearController } from './map';
import { createFillLayer } from './fills/fillLayer';
import { createInfoPanel } from './infoPanel';
import { goTo, jump } from './motion';
import { getDisplayYear, getYear, onDisplayYear, onYear } from './state';
import { createTimeline } from './timeline';
import { normalizeYear } from './timeScale';

const DEFAULT_YEAR = 117;

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
  const showInfo = createInfoPanel(document.getElementById('info')!);

  const [topo, labels, land] = await Promise.all([
    loadJson<Topology>('data/polities.topojson'),
    loadJson<FeatureCollection>('data/labels.geojson'),
    loadJson<FeatureCollection>('data/land.geojson'),
    new Promise((r) => map.once('load', r)),
  ]);
  const records = feature(topo, topo.objects.polities) as FeatureCollection;

  // Fills (custom GPU layer) follow the continuous year every frame; borders and labels snap per year.
  let fillsReady = false;
  const fills = createFillLayer(map, () => (fillsReady = true));
  fills.setYear(getDisplayYear());
  onDisplayYear((y) => fills.setYear(y));
  addHistoryLayers(map, land, fills);
  const applyYear = createYearController(map, { records, labels });
  applyYear(getYear());
  onYear(applyYear);
  bindPolityInteraction(map, (id) => fills.setHover(id), showInfo);

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
