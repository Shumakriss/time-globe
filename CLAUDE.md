# Time Globe: guide for coding agents

This is a 3D historical globe built with Vite, TypeScript and MapLibre GL. It has no framework. Read
README.md for the user-facing overview. This file covers what an agent needs to set up, change and
verify the project.

## Setup

```sh
npm run setup   # npm install + npm run data (download ~50 MB, build ~2 min)
npm run dev     # http://localhost:5173
```

- **Data isn't committed.** `data-raw/` (raw downloads) and `public/data/` (built app data) are
  git-ignored. `npm run dev` and `npm run build` fail with instructions if `public/data/` is missing.
  The fix is `npm run data`.
- **Size rule:** don't download or generate more than **10 GB** of data without asking the user
  first. Both data scripts enforce this limit. Keep it if you change them.
- **Node 20.15+ works.** Vite is pinned to 6 and Vitest to 3 on purpose: Vite 8 needs Node ≥ 20.19.
  Don't upgrade them without checking the Node version.
- **`unzip`:** `data:fetch` shells out to it.
- **Memory:** `data:build` runs mapshaper with an 8 GB heap limit.

## Commands

| Command | Use |
|---|---|
| `npm test` | Vitest unit tests (`tests/`) |
| `npx tsc --noEmit` | Type-check (src, scripts, tests) |
| `npm run build` | Type-check plus production build |
| `npm run data:fetch` / `data:build` | Each half of the data pipeline. Re-run `data:build` after changing anything in `scripts/` |
| `npx tsx scripts/bench-mesh.ts [windows…]` | Time the fill-mesh builds per time window |

## Layout

```
scripts/
  fetch-data.ts      download sources into data-raw/ (skips existing files; checks the size limit)
  build-data.ts      normalize -> simplify -> labels -> palette -> pieces -> public/data/*
  check-data.ts      pre-dev/pre-build check that the data exists
  lib/simplify.ts    per-feature Douglas–Peucker (mapshaper can't simplify overlapping years)
  lib/pieces.ts      animation pieces: core / lost / gained / yield, births and deaths
  lib/palette.ts     "pretty" palette slot per polity name (neighbour-aware greedy colouring)
src/
  main.ts            wires everything together
  map.ts             MapLibre map, border/label layers, windowed sources, year filters, hover/click
  fills/             custom WebGL fill layer
    fillLayer.ts       shaders and the GPU side; one u_year uniform drives all animation
    meshFeed.ts        one shared worker for all globes
    meshWorker.ts      builds meshes per time window
    mesh.ts            triangulation and distance-to-border per vertex
    items.ts           picks the records and pieces needed for a window
    windows.ts         variable-size time windows
  state.ts / motion.ts   continuous display year + integer calendar year; fixed 220 ms glide
  timeline.ts        slider, wheel, playback, era band;  timeScale.ts: non-linear year scale (no year 0)
  search.ts, farSide.ts, palette.ts, infoPanel.ts, eras.ts, style.css
```

## Things that will bite you

- **No year 0.** Years go 1 BCE → 1 CE. Use `normalizeYear` and `stepYear` from `timeScale.ts`.
- **Borders and fills move on different clocks.** Fills follow the continuous display year every
  frame. Borders and labels follow the integer year and change only when a record boundary is
  crossed.
- **Per-frame MapLibre paint updates are slow.** Don't drive anything per frame through MapLibre
  paint properties, `setGlobalStateProperty` or `setFilter`: they re-lay-out the whole source and
  caused multi-second lag before. Per-frame animation belongs in the custom layer's uniforms.
- **The custom layer uses MapLibre's projection prelude.** It relies on `shaderData.vertexShaderPrelude`
  and `projectTile()` with `defaultProjectionData`. Don't add `#define PI`; the prelude already
  declares it.
- **Pieces live in the data build, not the client.** Changing pieces, palette or simplification
  means editing `scripts/lib/*` and re-running `npm run data:build`. The client only reads the result.
- **Data size:** `polities.topojson` is ~38 MB (~9 MB gzipped). Keep an eye on it when adding piece
  types or lowering the simplification tolerance.
- **The browser can't fully check fills.** Headless checks need real WebGL (for example
  playwright-core with system Chrome and `--use-angle=metal` on macOS). In development the page
  exposes `window.__map` and `window.__jump(year)` for scripted checks. `#y=<year>` in the URL sets
  the year.

## Before you finish a change

1. `npx tsc --noEmit && npm test`
2. If you touched `scripts/`: `npm run data:build`, and check the printed sizes and stats.
3. If you touched rendering: look at it in a browser. Good test spots:
   - The Mongols, 1186–1260 (around `[100, 45]`).
   - Europe, 1500 and 1800–1900.
   - Prehistory, before 3400 BCE.
   - Playback at 25× should stay smooth.
4. `npm run build` for anything that affects the production bundle or the worker.
