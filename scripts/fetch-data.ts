// Downloads raw source data into data-raw/. Skips files that already exist.
// Aborts before downloading if the total would exceed the size budget.
import { existsSync, mkdirSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

const RAW = 'data-raw';
const MAX_BYTES = 10 * 1024 ** 3; // 10 GB — larger requires user approval

const BASEMAPS = 'https://raw.githubusercontent.com/aourednik/historical-basemaps/master/geojson';
// Prehistoric snapshots only; Cliopatria takes over at 3400 BCE.
export const BASEMAP_YEARS = [-123000, -10000, -8000, -5000, -4000];

const files: { name: string; url: string }[] = [
  {
    name: 'cliopatria.geojson.zip',
    url: 'https://raw.githubusercontent.com/Seshat-Global-History-Databank/cliopatria/main/cliopatria.geojson.zip',
  },
  {
    name: 'ne_50m_land.geojson',
    url: 'https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/ne_50m_land.geojson',
  },
  ...BASEMAP_YEARS.map((y) => ({
    name: `world_bc${-y}.geojson`,
    url: `${BASEMAPS}/world_bc${-y}.geojson`,
  })),
];

async function headSize(url: string): Promise<number> {
  const res = await fetch(url, { method: 'HEAD', redirect: 'follow' });
  if (!res.ok) throw new Error(`HEAD ${url} -> ${res.status}`);
  return Number(res.headers.get('content-length') ?? 0);
}

async function main() {
  mkdirSync(RAW, { recursive: true });
  const todo = files.filter((f) => !existsSync(join(RAW, f.name)));

  const sizes = await Promise.all(todo.map((f) => headSize(f.url)));
  const total = sizes.reduce((a, b) => a + b, 0);
  // Unzipped GeoJSON is roughly 5x the zip; budget for that too.
  const projected = total + (todo.some((f) => f.name.endsWith('.zip')) ? sizes[0] * 6 : 0);
  console.log(`Downloading ${todo.length} files, ${(total / 1e6).toFixed(1)} MB (projected on disk ~${(projected / 1e6).toFixed(0)} MB)`);
  if (projected > MAX_BYTES) {
    console.error(`Projected size exceeds ${MAX_BYTES / 1024 ** 3} GB. Stopping for review.`);
    process.exit(2);
  }

  for (const f of todo) {
    process.stdout.write(`  ${f.name} ... `);
    const res = await fetch(f.url);
    if (!res.ok) throw new Error(`GET ${f.url} -> ${res.status}`);
    writeFileSync(join(RAW, f.name), Buffer.from(await res.arrayBuffer()));
    console.log('ok');
  }

  const zip = join(RAW, 'cliopatria.geojson.zip');
  const unzipped = join(RAW, 'cliopatria.geojson');
  if (!existsSync(unzipped)) {
    // The archive's inner filename is versioned (e.g. cliopatria_polities_only_v021.geojson).
    const inner = execFileSync('unzip', ['-Z1', zip], { encoding: 'utf8' })
      .split('\n')
      .find((n) => n.endsWith('.geojson'));
    if (!inner) throw new Error(`No .geojson inside ${zip}`);
    execFileSync('unzip', ['-o', '-q', zip, inner, '-d', RAW], { stdio: 'inherit' });
    renameSync(join(RAW, inner), unzipped);
  }
  console.log(`cliopatria.geojson: ${(statSync(unzipped).size / 1e6).toFixed(0)} MB`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
