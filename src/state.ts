// Single source of truth for time. `displayYear` is continuous (drives smooth motion and
// interpolation); `year` is the integer calendar year derived from it (drives borders, readout).
import { MAX_YEAR, MIN_YEAR, normalizeYear } from './timeScale';

type Listener = (year: number) => void;

let display = 1;
let current = 1;
const yearListeners = new Set<Listener>();
const displayListeners = new Set<Listener>();

export function getYear(): number {
  return current;
}

export function getDisplayYear(): number {
  return display;
}

export function setDisplayYear(y: number): void {
  const clamped = Math.min(MAX_YEAR, Math.max(MIN_YEAR, y));
  if (clamped === display) return;
  display = clamped;
  for (const l of displayListeners) l(display);
  const year = normalizeYear(Math.floor(display));
  if (year !== current) {
    current = year;
    for (const l of yearListeners) l(current);
  }
}

/** Fires when the integer year changes. */
export function onYear(l: Listener): () => void {
  yearListeners.add(l);
  return () => yearListeners.delete(l);
}

/** Fires on every change of the continuous display year (up to once per frame while moving). */
export function onDisplayYear(l: Listener): () => void {
  displayListeners.add(l);
  return () => displayListeners.delete(l);
}
