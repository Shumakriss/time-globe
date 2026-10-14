// Polity search: type a name, pick a match, and the globe flies there. If the polity doesn't exist
// in the current year, time moves to the nearest year it does.
import type maplibregl from 'maplibre-gl';
import type { FeatureCollection, Point } from 'geojson';
import { goTo } from './motion';
import { getYear } from './state';
import { formatYear } from './timeScale';

interface LabelProps {
  id: number;
  name: string;
  from: number;
  to: number;
  area: number;
}

interface Span {
  id: number;
  from: number;
  to: number;
  area: number;
  at: [number, number]; // label point
}

interface Entry {
  name: string;
  key: string; // normalized name
  spans: Span[]; // sorted by start
  area: number; // largest extent, for ranking
}

const MAX_RESULTS = 8;

const normalize = (s: string) =>
  s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

/** The record to show for `year`: the one alive then, else the nearest in time. */
export function nearestSpan<T extends { from: number; to: number }>(spans: T[], year: number): T {
  let best = spans[0];
  let bestGap = Infinity;
  for (const s of spans) {
    const gap = year < s.from ? s.from - year : year > s.to ? year - s.to : 0;
    if (gap < bestGap) {
      best = s;
      bestGap = gap;
    }
  }
  return best;
}

/** Zoom that roughly frames a polity of `areaKm2` in a viewport `widthPx` wide (when bounds are unknown). */
function zoomFor(areaKm2: number, widthPx: number): number {
  const extentKm = Math.sqrt(Math.max(areaKm2, 1e4)) * 4;
  const z = Math.log2((40075 * (widthPx / 512)) / extentKm);
  return Math.min(5.5, Math.max(1.6, z));
}

export function createSearch(
  root: HTMLElement,
  map: maplibregl.Map,
  labels: FeatureCollection,
  onFound: (recordId: number) => void,
  boundsOf: (recordId: number) => [number, number, number, number] | null,
): void {
  const byName = new Map<string, Entry>();
  for (const f of labels.features) {
    const p = f.properties as LabelProps;
    let e = byName.get(p.name);
    if (!e) {
      e = { name: p.name, key: normalize(p.name), spans: [], area: 0 };
      byName.set(p.name, e);
    }
    e.spans.push({ id: p.id, from: p.from, to: p.to, area: p.area, at: (f.geometry as Point).coordinates as [number, number] });
    e.area = Math.max(e.area, p.area);
  }
  const entries = [...byName.values()];
  for (const e of entries) e.spans.sort((a, b) => a.from - b.from);

  root.innerHTML = `
    <input class="search-input" type="search" placeholder="Search empires, kingdoms, peoples…"
      aria-label="Search polities" autocomplete="off" spellcheck="false" />
    <ul class="search-results" role="listbox" hidden></ul>
  `;
  const input = root.querySelector<HTMLInputElement>('.search-input')!;
  const list = root.querySelector<HTMLUListElement>('.search-results')!;
  let results: Entry[] = [];
  let active = 0;

  const rank = (q: string, key: string): number => {
    if (key === q) return 0;
    if (key.startsWith(q)) return 1;
    if (key.includes(` ${q}`)) return 2;
    if (key.includes(q)) return 3;
    return -1;
  };

  const render = () => {
    if (!results.length) {
      list.hidden = !input.value.trim();
      list.innerHTML = input.value.trim() ? '<li class="search-empty">No matches</li>' : '';
      return;
    }
    const year = getYear();
    list.hidden = false;
    list.innerHTML = results
      .map((e, i) => {
        const first = e.spans[0].from;
        const last = e.spans[e.spans.length - 1].to;
        const alive = e.spans.some((s) => s.from <= year && s.to >= year);
        return `<li role="option" data-i="${i}" class="${i === active ? 'active' : ''}" aria-selected="${i === active}">
          <span class="search-name">${escapeHtml(e.name)}</span>
          <span class="search-years ${alive ? 'alive' : ''}">${formatYear(first)} – ${formatYear(last)}</span>
        </li>`;
      })
      .join('');
  };

  const update = () => {
    const q = normalize(input.value);
    active = 0;
    if (!q) {
      results = [];
      render();
      return;
    }
    results = entries
      .map((e) => ({ e, r: rank(q, e.key) }))
      .filter((x) => x.r >= 0)
      .sort((a, b) => a.r - b.r || b.e.area - a.e.area)
      .slice(0, MAX_RESULTS)
      .map((x) => x.e);
    render();
  };

  const choose = (e: Entry) => {
    const year = getYear();
    const span = nearestSpan(e.spans, year);
    const target = Math.min(span.to, Math.max(span.from, year));
    if (target !== year) goTo(target);
    const bounds = boundsOf(span.id);
    const container = map.getContainer();
    const camera = bounds
      ? map.cameraForBounds(bounds, {
          padding: { top: 80, bottom: 60, left: Math.min(340, container.clientWidth / 4), right: Math.min(380, container.clientWidth / 4) },
          maxZoom: 5.5,
        })
      : undefined;
    map.flyTo({
      center: span.at, // the label point sits inside the polity, unlike a bounding-box centre
      zoom: Math.max(1.6, camera?.zoom ?? zoomFor(span.area, container.clientWidth)),
      duration: 1600,
      essential: true,
    });
    onFound(span.id);
    input.value = e.name;
    results = [];
    list.hidden = true;
    input.blur();
  };

  input.addEventListener('input', update);
  input.addEventListener('focus', update);
  input.addEventListener('keydown', (ev) => {
    if (ev.key === 'ArrowDown' || ev.key === 'ArrowUp') {
      ev.preventDefault();
      if (!results.length) return;
      active = (active + (ev.key === 'ArrowDown' ? 1 : -1) + results.length) % results.length;
      render();
    } else if (ev.key === 'Enter') {
      if (results[active]) choose(results[active]);
    } else if (ev.key === 'Escape') {
      results = [];
      list.hidden = true;
      input.blur();
    }
  });
  // pointerdown (not click) so the choice lands before the input's blur hides the list.
  list.addEventListener('pointerdown', (ev) => {
    const li = (ev.target as HTMLElement).closest<HTMLLIElement>('li[data-i]');
    if (!li) return;
    ev.preventDefault();
    choose(results[Number(li.dataset.i)]);
  });
  input.addEventListener('blur', () => setTimeout(() => (list.hidden = true), 100));
  // "/" focuses search, like many sites.
  window.addEventListener('keydown', (ev) => {
    if (ev.key === '/' && document.activeElement !== input) {
      ev.preventDefault();
      input.focus();
      input.select();
    }
  });
}
