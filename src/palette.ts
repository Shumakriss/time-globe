// Colour schemes. "Map" colours come from the data (a distinct hue per polity name, written by the
// data build). "Pretty" colours come from one small coordinated palette; the build assigns each
// polity a palette slot so that neighbours rarely share one (scripts/lib/palette.ts).

export type ColorScheme = 'map' | 'pretty';

/** OKLCH -> linear sRGB -> gamma sRGB (0..1), clamped. */
function oklch(l: number, c: number, hDeg: number): [number, number, number] {
  const h = (hDeg * Math.PI) / 180;
  const a = c * Math.cos(h);
  const b = c * Math.sin(h);
  const l_ = (l + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m_ = (l - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s_ = (l - 0.0894841775 * a - 1.291485548 * b) ** 3;
  const lin = [
    4.0767416621 * l_ - 3.3077115913 * m_ + 0.2309699292 * s_,
    -1.2684380046 * l_ + 2.6097574011 * m_ - 0.3413193965 * s_,
    -0.0041960863 * l_ - 0.7034186147 * m_ + 1.707614701 * s_,
  ];
  const gamma = (x: number) => {
    const v = Math.max(0, Math.min(1, x));
    return v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055;
  };
  return [gamma(lin[0]), gamma(lin[1]), gamma(lin[2])];
}

// Even lightness and gentle chroma make the set read as one family; hue and two lightness steps
// keep neighbours apart. Warm hues lead, cool ones accent, like an old atlas at dusk.
const SLOTS: [l: number, c: number, h: number][] = [
  [0.8, 0.1, 80], // wheat
  [0.7, 0.11, 40], // terracotta
  [0.74, 0.08, 150], // sage
  [0.7, 0.08, 220], // slate blue
  [0.76, 0.09, 350], // rose
  [0.66, 0.09, 290], // lavender
  [0.78, 0.09, 115], // olive
  [0.72, 0.08, 190], // teal
  [0.66, 0.1, 60], // ochre
  [0.82, 0.06, 20], // blush
];

export const PALETTE: [number, number, number][] = SLOTS.map(([l, c, h]) => oklch(l, c, h));
export const PALETTE_SIZE = PALETTE.length;

export function paletteCss(slot: number): string {
  const [r, g, b] = PALETTE[slot % PALETTE_SIZE].map((v) => Math.round(v * 255));
  return `rgb(${r}, ${g}, ${b})`;
}
