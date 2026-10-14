// Builds territory-fill meshes per time window, off the main thread.
import { feature } from 'topojson-client';
import type { Feature, FeatureCollection, MultiPolygon, Polygon } from 'geojson';
import type { Topology } from 'topojson-specification';
import { buildMesh, type ItemMesh } from './mesh';
import { collectItems, type PieceProps, type RecordProps } from './items';
import { windowRange } from './windows';

/** The windows the view wants, most urgent first. Replaces any previous request. */
export interface FocusRequest {
  type: 'focus';
  windows: number[];
}
export interface BuildResult {
  type: 'built';
  window: number;
  vertices: Float32Array;
  indices: Uint32Array;
  ms: number;
}

type Poly = Polygon | MultiPolygon;

const ready: Promise<{ records: Feature<Poly, RecordProps>[]; pieces: Feature<Poly, PieceProps>[] }> = (async () => {
  const topo = (await (await fetch(new URL('/data/polities.topojson', self.location.origin))).json()) as Topology;
  const records = (feature(topo, topo.objects.polities) as FeatureCollection<Poly, RecordProps>).features;
  const pieces = (feature(topo, topo.objects.pieces) as FeatureCollection<Poly, PieceProps>).features;
  return { records, pieces };
})();

// Item meshes are cached so neighbouring windows reuse shared records and pieces.
const cache = new Map<string, ItemMesh>();
const MAX_CACHED_ITEMS = 20000;

let queue: number[] = [];
let building: number | null = null;
let running = false;

async function drain() {
  if (running) return;
  running = true;
  const { records, pieces } = await ready;
  while (queue.length) {
    const w = queue.shift()!;
    building = w;
    const t0 = performance.now();
    const mesh = buildMesh(collectItems(records, pieces, windowRange(w)), cache);
    if (cache.size > MAX_CACHED_ITEMS) cache.clear();
    const result: BuildResult = {
      type: 'built',
      window: w,
      vertices: mesh.vertices,
      indices: mesh.indices,
      ms: Math.round(performance.now() - t0),
    };
    (self as unknown as Worker).postMessage(result, [mesh.vertices.buffer, mesh.indices.buffer]);
    building = null;
    // Yield so a newer focus request can reorder or drop what's left.
    await new Promise((r) => setTimeout(r, 0));
  }
  running = false;
}

self.onmessage = (e: MessageEvent<FocusRequest>) => {
  queue = e.data.windows.filter((w) => w !== building); // already on its way
  drain();
};
