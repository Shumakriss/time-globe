// Runs before `npm run dev` / `build` / `preview`: explains how to get the data if it's missing.
import { existsSync } from 'node:fs';

const REQUIRED = ['polities.topojson', 'labels.geojson', 'land.geojson'].map((f) => `public/data/${f}`);
const missing = REQUIRED.filter((f) => !existsSync(f));

if (missing.length) {
  console.error(`
  Time Globe needs its map data, which isn't in the repository.

  Run:  npm run data

  This downloads ~50 MB of open historical map data (Cliopatria, historical-basemaps,
  Natural Earth) into data-raw/ and builds public/data/ (~2 minutes, ~360 MB on disk).

  Missing: ${missing.join(', ')}
`);
  process.exit(1);
}
