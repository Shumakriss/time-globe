# Time Globe

A spinnable 3D globe with a time slider showing polities, empires, and cultures from 123,000 BCE to 2024 CE.

```sh
npm install
npm run data   # downloads ~50 MB of source data (~230 MB on disk) and builds public/data/
npm run dev
```

- **Globe:** drag to rotate, scroll over the globe to zoom, click a region for details.
- **Borders vs. fills:** border lines are the documented records and snap on their year. Fills grow and
  recede smoothly between records: gains spread out from the old border, losses recede toward the new
  one, and land changing hands is replaced by the winner's colour along the same front.
- **Time:** scroll over the bottom bar (Shift = 10×), drag the slider, use ← →, or press Space / ▶ to play. Click an era band to jump to it. The URL keeps the year (`#y=-500`).

## Data
| Source | Coverage | License |
|---|---|---|
| [Cliopatria](https://github.com/Seshat-Global-History-Databank/cliopatria) (Seshat) | ~1,600 polities, year-level borders, 3400 BCE–2024 | CC BY 4.0 |
| [historical-basemaps](https://github.com/aourednik/historical-basemaps) | Prehistoric cultures, 5 snapshots before 3400 BCE | GPL-3.0 |
| [Natural Earth](https://www.naturalearthdata.com/) | Land base layer | Public domain |

`scripts/lib/pieces.ts` splits each record into core / lost / gained pieces relative to the polity's next
record, plus "yield" pieces where a neighbour's gain takes its land (births, deaths and gaps snap).
Fills are drawn by a custom WebGL layer (`src/fills/`): a worker triangulates each time window and
records each vertex's distance from the relevant border; the shader animates the growth front from a
single year uniform, so motion costs nothing per frame. Borders and labels are ordinary MapLibre layers.
Finer source data needs no client changes: shorter records simply produce shorter, smaller changes.

`scripts/build-data.ts` simplifies each record (~2 km tolerance) and encodes everything as TopoJSON
(`public/data/polities.topojson`, ~34 MB / ~7.5 MB gzipped including animation pieces). Consecutive-year records share borders,
and TopoJSON stores shared arcs once. In the browser, MapLibre only receives records overlapping the current
time window (`src/fills/windows.ts`; shorter windows in denser eras).
Both data scripts refuse to proceed past 10 GB.

`npx tsx scripts/bench-mesh.ts [window…]` profiles fill-mesh building per window.
