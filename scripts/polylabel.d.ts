declare module '@mapbox/polylabel' {
  export default function polylabel(polygon: number[][][], precision?: number): [number, number] & { distance: number };
}
