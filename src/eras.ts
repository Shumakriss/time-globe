// Broad eras for the band under the slider. These are global generalizations:
// e.g. the Bronze Age began ~3300 BCE in the Near East but much later elsewhere.
export interface Era {
  name: string;
  start: number;
  end: number;
  color: string;
}

export const ERAS: Era[] = [
  { name: 'Paleolithic', start: -123000, end: -10000, color: '#6b5a48' },
  { name: 'Mesolithic', start: -10000, end: -8000, color: '#7d6a4f' },
  { name: 'Neolithic', start: -8000, end: -3300, color: '#8a7a52' },
  { name: 'Bronze Age', start: -3300, end: -1200, color: '#b07a3a' },
  { name: 'Iron Age', start: -1200, end: -500, color: '#7c7f86' },
  { name: 'Classical', start: -500, end: 500, color: '#a8584a' },
  { name: 'Post-classical', start: 500, end: 1500, color: '#5e6f9a' },
  { name: 'Early Modern', start: 1500, end: 1800, color: '#4f8a7a' },
  { name: 'Modern', start: 1800, end: 2024, color: '#8a6aa0' },
];

export function eraAt(year: number): Era | undefined {
  return ERAS.find((e) => year >= e.start && year < e.end) ?? (year >= 2024 ? ERAS[ERAS.length - 1] : undefined);
}
