// Profiles fill-mesh building per time window: npx tsx scripts/bench-mesh.ts [window...]
import { readFileSync } from 'node:fs';
import { feature } from 'topojson-client';
import type { Topology } from 'topojson-specification';
import { buildMesh } from '../src/fills/mesh.ts';
import { collectItems } from '../src/fills/items.ts';
import { windowRange } from '../src/fills/windows.ts';

const topo = JSON.parse(readFileSync('public/data/polities.topojson', 'utf8')) as Topology;
const records = (feature(topo, topo.objects.polities) as any).features;
const pieces = (feature(topo, topo.objects.pieces) as any).features;
const windows = process.argv.slice(2).map(Number);
const cache = new Map();
for (const w of windows.length ? windows : [0, 10, 20, 25, 28, 32, 40, 45, 46]) {
  const items = collectItems(records, pieces, windowRange(w));
  const t0 = performance.now();
  const mesh = buildMesh(items, cache);
  const [a, b] = windowRange(w);
  console.log(`window ${w} (${a}..${b}): ${items.length} items, ${mesh.vertices.length / 12} verts, ${Math.round(performance.now() - t0)}ms`);
}
