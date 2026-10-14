// Glides the display year to a target over a short, fixed time, so wheel notches and jumps move
// smoothly but arrive promptly (an open-ended ease made the calendar year trail the wheel).
import { getDisplayYear, setDisplayYear } from './state';
import { normalizeYear } from './timeScale';

const GLIDE_MS = 220;

let from = 1;
let target = 1;
let start = 0;
let raf = 0;

const easeOutCubic = (x: number) => 1 - (1 - x) ** 3;

function frame(now: number) {
  const k = Math.min(1, (now - start) / GLIDE_MS);
  setDisplayYear(from + (target - from) * easeOutCubic(k));
  raf = k < 1 ? requestAnimationFrame(frame) : 0;
}

/** The year motion is heading toward (or the current year when at rest). */
export function getTarget(): number {
  return raf ? target : normalizeYear(Math.round(getDisplayYear()));
}

/** Glide to `year`. Retargeting mid-glide continues from the current position. */
export function goTo(year: number): void {
  from = getDisplayYear();
  target = normalizeYear(year);
  start = performance.now();
  if (!raf) raf = requestAnimationFrame(frame);
}

/** Set the display year immediately (slider drag, playback), cancelling any glide. */
export function jump(year: number): void {
  if (raf) cancelAnimationFrame(raf);
  raf = 0;
  target = normalizeYear(Math.round(year));
  setDisplayYear(year);
}
