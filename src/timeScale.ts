// Years are integers: negative = BCE, positive = CE. There is no year 0 (1 BCE is followed by 1 CE).

export const MIN_YEAR = -123000;
export const MAX_YEAR = 2024;

// Piecewise-linear mapping between slider position [0, 1] and year, so deep prehistory
// doesn't swallow the bar. Each stop is [position, year].
const STOPS: [number, number][] = [
  [0, MIN_YEAR],
  [0.1, -10000],
  [0.2, -3400],
  [1, MAX_YEAR],
];

export function normalizeYear(y: number): number {
  const r = Math.round(y);
  const clamped = Math.min(MAX_YEAR, Math.max(MIN_YEAR, r));
  return clamped === 0 ? 1 : clamped;
}

export function posToYear(pos: number): number {
  const p = Math.min(1, Math.max(0, pos));
  for (let i = 1; i < STOPS.length; i++) {
    const [p0, y0] = STOPS[i - 1];
    const [p1, y1] = STOPS[i];
    if (p <= p1) return normalizeYear(y0 + ((p - p0) / (p1 - p0)) * (y1 - y0));
  }
  return MAX_YEAR;
}

export function yearToPos(year: number): number {
  const y = Math.min(MAX_YEAR, Math.max(MIN_YEAR, year));
  for (let i = 1; i < STOPS.length; i++) {
    const [p0, y0] = STOPS[i - 1];
    const [p1, y1] = STOPS[i];
    if (y <= y1) return p0 + ((y - y0) / (y1 - y0)) * (p1 - p0);
  }
  return 1;
}

/** Years per wheel notch / arrow press: finer where the data is finer. */
export function stepFor(year: number): number {
  if (year >= -3400) return 1;
  if (year >= -10000) return 10;
  return 500;
}

/** Move `notches` steps forward (positive) or backward (negative), skipping year 0. */
export function stepYear(year: number, notches: number, multiplier = 1): number {
  let y = year;
  const dir = Math.sign(notches);
  for (let i = 0; i < Math.abs(notches); i++) {
    // Use the step of the era we're moving into, so stepping back across a boundary is symmetric.
    const step = stepFor(dir > 0 ? y : y - 1) * multiplier;
    const next = y + dir * step;
    // Crossing zero: -1 + 1 => 1, and 1 - 1 => -1.
    y = (y < 0 && next >= 0) || (y > 0 && next <= 0) ? next + dir : next;
    y = normalizeYear(y);
  }
  return y;
}

export function formatYear(year: number): string {
  const n = Math.abs(year).toLocaleString('en-US');
  return year < 0 ? `${n} BCE` : `${n} CE`;
}
