import { describe, expect, it } from 'vitest';
import { buildMesh, clipRing, KIND_GAINED, KIND_SOLID, mercatorX, mercatorY, parseColor, VERTEX_FLOATS } from '../src/fills/mesh';

const square = (x0: number, y0: number, x1: number, y1: number) => [
  [x0, y0], [x1, y0], [x1, y1], [x0, y1], [x0, y0],
];

function triangleArea(v: Float32Array, i: Uint32Array): number {
  let a = 0;
  for (let t = 0; t < i.length; t += 3) {
    const [p, q, r] = [i[t], i[t + 1], i[t + 2]].map((k) => [v[k * VERTEX_FLOATS], v[k * VERTEX_FLOATS + 1]]);
    a += Math.abs((q[0] - p[0]) * (r[1] - p[1]) - (r[0] - p[0]) * (q[1] - p[1])) / 2;
  }
  return a;
}

describe('mesh', () => {
  it('clips a ring to a rectangle', () => {
    const r = clipRing(square(0, 0, 10, 10).slice(0, -1), 5, 5, 20, 20);
    const xs = r.map((p) => p[0]);
    const ys = r.map((p) => p[1]);
    expect(Math.min(...xs)).toBe(5);
    expect(Math.max(...xs)).toBe(10);
    expect(Math.min(...ys)).toBe(5);
  });

  it('subdivides large polygons without losing area', () => {
    const item = { key: 'a', polygons: [[square(0, 0, 10, 10)]], kind: KIND_SOLID, rid: 1, from: 0, end: 10, rs: 10, re: 10, color: [1, 0, 0] as [number, number, number], pal: 0 };
    const whole = buildMesh([{ ...item, polygons: [[square(0, 0, 1, 1)]] }]);
    const big = buildMesh([item]);
    // 10x10 degrees with 6-degree cells: split into 4 cells, same total (mercator) area as one big quad.
    expect(big.indices.length).toBeGreaterThanOrEqual(whole.indices.length * 4);
    const expected = (10 / 360) * (0.5 - 0.47224); // mercator area of the 10° box at the equator
    expect(triangleArea(big.vertices, big.indices)).toBeCloseTo(expected, 3);
  });

  it('normalizes front distance from the reference border to 0..1', () => {
    const gained = {
      polygons: [[square(10, 0, 20, 10)]],
      key: 'g',
      reference: { key: 1, polygons: [[square(0, 0, 10, 10)]] },
      kind: KIND_GAINED, rid: 1, from: 0, end: 10, rs: 0, re: 10, color: [0, 1, 0] as [number, number, number], pal: 0,
    };
    const { vertices } = buildMesh([gained]);
    const ds: number[] = [];
    for (let v = 0; v < vertices.length / VERTEX_FLOATS; v++) ds.push(vertices[v * VERTEX_FLOATS + 2]);
    expect(Math.min(...ds)).toBeCloseTo(0, 5); // touching the old border
    expect(Math.max(...ds)).toBeCloseTo(1, 5);
  });

  it('measures births from a point, so the front is a circle around it', () => {
    const birth = {
      polygons: [[square(0, 0, 10, 10)]],
      key: 'b',
      reference: { key: -1, polygons: [[[[5, 5]]]] },
      kind: KIND_GAINED, rid: 1, from: 0, end: 10, rs: 0, re: 10, color: [0, 1, 0] as [number, number, number], pal: 0,
    };
    const { vertices } = buildMesh([birth]);
    const at = (x: number, y: number) => {
      for (let v = 0; v < vertices.length / VERTEX_FLOATS; v++) {
        const o = v * VERTEX_FLOATS;
        if (Math.abs(vertices[o] - mercatorX(x)) < 1e-6 && Math.abs(vertices[o + 1] - mercatorY(y)) < 1e-6) return vertices[o + 2];
      }
      throw new Error(`no vertex at ${x},${y}`);
    };
    expect(at(5, 5)).toBeCloseTo(0, 5); // the heartland
    expect(at(5, 5)).toBeLessThan(at(7, 5));
    expect(at(7, 5)).toBeLessThan(at(9, 5));
    expect(Math.max(at(0, 0), at(10, 0), at(0, 10), at(10, 10))).toBeCloseTo(1, 5); // a corner is farthest
  });

  it('parses hsl colors', () => {
    expect(parseColor('hsl(0, 100%, 50%)').map((c) => +c.toFixed(3))).toEqual([1, 0, 0]);
  });
});
