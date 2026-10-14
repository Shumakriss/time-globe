// A small second globe showing the opposite side of the world, kept in sync with the main globe.
// Clicking it flips the main globe around.
import type maplibregl from 'maplibre-gl';
import type { FeatureCollection } from 'geojson';
import { addHistoryLayers, createMap, createYearController } from './map';
import { createFillLayer, type FillLayer } from './fills/fillLayer';
import type { MeshFeed } from './fills/meshFeed';
import type { ColorScheme } from './palette';
import { getDisplayYear, getYear, onDisplayYear, onYear } from './state';

export interface FarSide {
  setScheme(scheme: ColorScheme): void;
  destroy(): void;
}

const antipode = (c: maplibregl.LngLat): [number, number] => [c.lng > 0 ? c.lng - 180 : c.lng + 180, -c.lat];

/** Zoom at which the whole globe fits the container with a small margin. */
function fitZoom(sizePx: number, lat: number): number {
  // MapLibre's globe radius is worldSize / (2π) at the equator and grows by 1/cos(lat) with the
  // center latitude (it matches Mercator scale there), so compensate to keep the globe one size.
  const radius = (sizePx / 2) * 0.86;
  return Math.log2((radius * 2 * Math.PI) / 512) + Math.log2(Math.cos((lat * Math.PI) / 180));
}

export function createFarSide(
  container: HTMLElement,
  main: maplibregl.Map,
  feed: MeshFeed,
  data: { records: FeatureCollection; labels: FeatureCollection; land: FeatureCollection },
  scheme: ColorScheme,
): FarSide {
  const size = () => container.clientWidth;
  const camera = () => {
    const [lng, lat] = antipode(main.getCenter());
    return { center: [lng, lat] as [number, number], zoom: fitZoom(size(), lat), bearing: main.getBearing() };
  };
  const map = createMap(container, {
    ...camera(),
    interactive: false,
    attributionControl: false,
    minZoom: -2,
    fadeDuration: 0,
  });

  let fills: FillLayer | null = null;
  const cleanups: (() => void)[] = [];
  const sync = () => map.jumpTo(camera());
  main.on('move', sync);
  cleanups.push(() => main.off('move', sync));

  map.once('load', () => {
    fills = createFillLayer(map, feed, { id: 'far-fills', scheme });
    fills.setYear(getDisplayYear());
    cleanups.push(onDisplayYear((y) => fills!.setYear(y)));
    addHistoryLayers(map, data.land, fills);
    map.setLayoutProperty('record-label', 'text-size', ['interpolate', ['linear'], ['get', 'area'], 1e6, 9, 1e7, 12]);
    const applyYear = createYearController(map, { records: data.records, labels: data.labels });
    applyYear(getYear());
    cleanups.push(onYear(applyYear));
  });

  // Click: bring the far side to the front.
  const flip = () => main.easeTo({ center: antipode(main.getCenter()), duration: 1200 });
  container.addEventListener('click', flip);

  return {
    setScheme(s) {
      fills?.setScheme(s);
      scheme = s;
    },
    destroy() {
      container.removeEventListener('click', flip);
      for (const c of cleanups) c();
      map.remove();
    },
  };
}
