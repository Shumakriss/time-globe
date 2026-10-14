import { describe, expect, it } from 'vitest';
import { formatYear, MAX_YEAR, MIN_YEAR, posToYear, stepYear, yearToPos } from '../src/timeScale';

describe('timeScale', () => {
  it('maps endpoints and segment boundaries', () => {
    expect(posToYear(0)).toBe(MIN_YEAR);
    expect(posToYear(1)).toBe(MAX_YEAR);
    expect(posToYear(0.1)).toBe(-10000);
    expect(posToYear(0.2)).toBe(-3400);
    expect(yearToPos(-3400)).toBeCloseTo(0.2);
  });

  it('round-trips years', () => {
    for (const y of [MIN_YEAR, -50000, -10000, -5000, -3400, -500, -1, 1, 117, 1250, 1914, MAX_YEAR]) {
      expect(posToYear(yearToPos(y))).toBe(y);
    }
  });

  it('never yields year 0', () => {
    for (let p = 0; p <= 1; p += 0.00001) expect(posToYear(p)).not.toBe(0);
    expect(stepYear(-1, 1)).toBe(1);
    expect(stepYear(1, -1)).toBe(-1);
    expect(stepYear(-5, 10)).toBe(6);
  });

  it('uses era-appropriate wheel steps', () => {
    expect(stepYear(1000, 1)).toBe(1001);
    expect(stepYear(-5000, 1)).toBe(-4990);
    expect(stepYear(-20000, 1)).toBe(-19500);
    expect(stepYear(1000, 1, 10)).toBe(1010);
    expect(stepYear(MAX_YEAR, 5)).toBe(MAX_YEAR);
    expect(stepYear(MIN_YEAR, -5)).toBe(MIN_YEAR);
  });

  it('formats years', () => {
    expect(formatYear(-500)).toBe('500 BCE');
    expect(formatYear(1250)).toBe('1,250 CE');
  });
});
