import { describe, expect, it } from 'vitest';
import { nearestSpan } from '../src/search';

describe('nearestSpan', () => {
  const spans = [
    { from: -27, to: 100 },
    { from: 101, to: 394 },
    { from: 600, to: 700 },
  ];
  it('picks the span alive in the year', () => {
    expect(nearestSpan(spans, 200)).toBe(spans[1]);
  });
  it('picks the nearest span in time otherwise', () => {
    expect(nearestSpan(spans, 1500)).toBe(spans[2]);
    expect(nearestSpan(spans, -500)).toBe(spans[0]);
    expect(nearestSpan(spans, 450)).toBe(spans[1]);
  });
});
