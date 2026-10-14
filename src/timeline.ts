import { ERAS, eraAt } from './eras';
import { getDisplayYear, getYear, onDisplayYear, onYear } from './state';
import { getTarget, goTo, jump } from './motion';
import { formatYear, MAX_YEAR, MIN_YEAR, posToYear, stepFor, stepYear, yearToPos } from './timeScale';

const SLIDER_RES = 100000;
const TICKS = [-100000, -10000, -5000, -3000, -2000, -1000, 1, 1000, 2000];
// Playback speeds in wheel-steps per second (1 step = 1 yr in recorded history, more in prehistory).
const SPEEDS = [
  { label: '½×', steps: 1 },
  { label: '1×', steps: 2 },
  { label: '2×', steps: 4 },
  { label: '5×', steps: 10 },
  { label: '25×', steps: 50 },
  { label: '100×', steps: 200 },
];
const PIXELS_PER_NOTCH = 100; // Chrome and Firefox report ~100px per mouse-wheel notch

export function createTimeline(root: HTMLElement): void {
  root.innerHTML = `
    <div class="tl-controls">
      <button class="tl-play" aria-label="Play">▶</button>
      <select class="tl-speed" aria-label="Playback speed">
        ${SPEEDS.map((s, i) => `<option value="${i}" ${s.label === '5×' ? 'selected' : ''}>${s.label}</option>`).join('')}
      </select>
      <div class="tl-readout">
        <span class="tl-year"></span>
        <span class="tl-era"></span>
      </div>
      <div class="tl-hint">Scroll here to move through time · Shift = 10× · ← →</div>
    </div>
    <div class="tl-track">
      <input class="tl-slider" type="range" min="0" max="${SLIDER_RES}" step="1" aria-label="Year" />
      <div class="tl-eras"></div>
      <div class="tl-ticks"></div>
    </div>
  `;
  const $ = <T extends HTMLElement>(sel: string) => root.querySelector(sel) as T;
  const slider = $<HTMLInputElement>('.tl-slider');
  const yearEl = $('.tl-year');
  const eraEl = $('.tl-era');
  const playBtn = $<HTMLButtonElement>('.tl-play');
  const speedSel = $<HTMLSelectElement>('.tl-speed');

  // Era band + ticks, positioned on the same non-linear scale as the slider.
  $('.tl-eras').innerHTML = ERAS.map((e) => {
    const left = yearToPos(e.start) * 100;
    const width = (yearToPos(e.end) - yearToPos(e.start)) * 100;
    return `<button class="tl-era-seg" style="left:${left}%;width:${width}%;background:${e.color}"
      data-start="${e.start}" title="${e.name}: ${formatYear(e.start)} – ${formatYear(e.end)} (approximate, varies by region)">
      <span>${e.name}</span></button>`;
  }).join('');
  $('.tl-ticks').innerHTML = TICKS.map(
    (y) => `<span style="left:${yearToPos(y) * 100}%">${formatYear(y).replace(' CE', '').replace(',000', 'k')}</span>`,
  ).join('');
  root.querySelectorAll<HTMLButtonElement>('.tl-era-seg').forEach((b) =>
    b.addEventListener('click', () => {
      stopPlayback();
      goTo(Math.max(MIN_YEAR, Number(b.dataset.start)));
    }),
  );

  // The thumb follows the continuous year; the readout shows the calendar year.
  const renderThumb = (display: number) => {
    slider.value = String(Math.round(yearToPos(display) * SLIDER_RES));
  };
  const renderReadout = (year: number) => {
    yearEl.textContent = formatYear(year);
    eraEl.textContent = eraAt(year)?.name ?? '';
  };
  onDisplayYear(renderThumb);
  onYear(renderReadout);
  renderThumb(getDisplayYear());
  renderReadout(getYear());

  slider.addEventListener('input', () => jump(posToYear(Number(slider.value) / SLIDER_RES)));

  // Mouse wheel / trackpad: accumulate deltas so trackpads don't race; one notch = one step.
  let accum = 0;
  root.addEventListener(
    'wheel',
    (e) => {
      e.preventDefault();
      const px = e.deltaMode === 1 ? e.deltaY * 33 : e.deltaMode === 2 ? e.deltaY * 400 : e.deltaY;
      accum += px;
      const notches = Math.trunc(accum / PIXELS_PER_NOTCH);
      if (!notches) return;
      accum -= notches * PIXELS_PER_NOTCH;
      stopPlayback();
      goTo(stepYear(getTarget(), notches, e.shiftKey ? 10 : 1));
    },
    { passive: false },
  );

  window.addEventListener('keydown', (e) => {
    if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement) return;
    if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
      e.preventDefault();
      stopPlayback();
      goTo(stepYear(getTarget(), e.key === 'ArrowRight' ? 1 : -1, e.shiftKey ? 10 : 1));
    } else if (e.key === ' ' && !(e.target instanceof HTMLButtonElement)) {
      e.preventDefault();
      togglePlayback();
    }
  });

  // Playback: advance the continuous year each frame.
  let raf = 0;
  let last = 0;
  function frame(t: number) {
    const dt = Math.min(0.1, (t - last) / 1000);
    last = t;
    const y = getDisplayYear();
    const next = y + SPEEDS[Number(speedSel.value)].steps * stepFor(Math.floor(y)) * dt;
    if (next >= MAX_YEAR) {
      jump(MAX_YEAR);
      stopPlayback();
      return;
    }
    jump(next);
    raf = requestAnimationFrame(frame);
  }
  function startPlayback() {
    if (getDisplayYear() >= MAX_YEAR) jump(MIN_YEAR);
    last = performance.now();
    playBtn.textContent = '❚❚';
    playBtn.setAttribute('aria-label', 'Pause');
    raf = requestAnimationFrame(frame);
  }
  function stopPlayback() {
    if (!raf) return;
    cancelAnimationFrame(raf);
    raf = 0;
    playBtn.textContent = '▶';
    playBtn.setAttribute('aria-label', 'Play');
  }
  function togglePlayback() {
    if (raf) stopPlayback();
    else startPlayback();
  }
  playBtn.addEventListener('click', togglePlayback);
  slider.addEventListener('pointerdown', stopPlayback);
}
