// Time windows: the map only holds data overlapping the current window, swapped as time moves.
// Windows are shorter where records are denser, so each window's data is roughly the same size.
import { MAX_YEAR, MIN_YEAR } from '../timeScale';

const ERAS: [start: number, size: number][] = [
  [-3400, 200],
  [500, 100],
  [1500, 50],
  [1800, 25],
];

// Window start years. Window 0 is all of prehistory (a handful of snapshots).
const STARTS: number[] = [MIN_YEAR];
for (let e = 0; e < ERAS.length; e++) {
  const [start, size] = ERAS[e];
  const end = ERAS[e + 1]?.[0] ?? MAX_YEAR + 1;
  for (let y = start; y < end; y += size) STARTS.push(y);
}

export const WINDOW_COUNT = STARTS.length;

export function windowOf(year: number): number {
  let lo = 0;
  let hi = STARTS.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (STARTS[mid] <= year) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

/** Overlap with neighbouring windows, so a swap never leaves a gap while new data is prepared. */
function marginOf(w: number): number {
  const size = (STARTS[w + 1] ?? MAX_YEAR + 1) - STARTS[w];
  return Math.min(20, Math.ceil(size * 0.4));
}

/** Inclusive year range of data needed to render any year in window `w`. */
export function windowRange(w: number): [number, number] {
  const start = STARTS[w];
  const end = (STARTS[w + 1] ?? MAX_YEAR + 1) - 1;
  const m = marginOf(w);
  return [w === 0 ? -Infinity : start - m, end + m];
}

/** Years before a window boundary at which to start preparing the next window. */
export function prefetchYears(w: number): number {
  return marginOf(w) + Math.min(30, (STARTS[w + 1] ?? MAX_YEAR + 1) - STARTS[w]) / 2;
}
