import { describe, expect, it } from 'vitest';
import { betterDirection, bestIndexes, differs, parseCodes } from './compare';
import { preset } from './strategies';
import { decode, encode } from './url';

describe('best value of a row', () => {
  it('picks the highest or lowest, ties included', () => {
    expect(bestIndexes([0.04, 0.06, null, 0.06], 1)).toEqual([1, 3]);
    expect(bestIndexes([3, 1, 2], -1)).toEqual([1]);
  });
  it('highlights nothing without a direction, with one value, or when all are equal', () => {
    expect(bestIndexes([1, 2], null)).toEqual([]);
    expect(bestIndexes([5, null, null], 1)).toEqual([]);
    expect(bestIndexes([0, 0, 0], -1)).toEqual([]);
  });
  it('follows the strategy when it weighs the column, else the fixed rule', () => {
    const long = preset('long');
    expect(betterDirection('price_m2', long.signals)).toBeNull(); // weight 0 in this preset, no fixed rule
    expect(betterDirection('price_m2', preset('short').signals)).toBe(-1);
    expect(betterDirection('risk_count', long.signals)).toBe(-1);
    expect(betterDirection('pop', long.signals)).toBeNull();
  });
});

describe('differences only', () => {
  it('ignores spreads under 5 % and identical texts', () => {
    expect(differs([100, 103, 104])).toBe(false);
    expect(differs([100, 110])).toBe(true);
    expect(differs(['oui', 'oui'])).toBe(false);
    expect(differs([true, false])).toBe(true);
    expect(differs([0, 0])).toBe(false);
    expect(differs([5, null])).toBe(false);
  });
});

describe('comparison in the share link', () => {
  it('keeps valid unique codes, at most 4', () => {
    expect(parseCodes('33063, 2a004,33063,xx,33281,33318,33522')).toEqual(['33063', '2A004', '33281', '33318']);
  });
  it('round-trips, and an empty list keeps the page open', () => {
    const p = preset('long');
    const base = { strategy: 'long' as const, type: 'house' as const, filters: p.filters, signals: p.signals, selected: null };
    expect(decode(encode({ ...base, compare: ['33063', '33281'] })).compare).toEqual(['33063', '33281']);
    expect(decode(encode({ ...base, compare: [] })).compare).toEqual([]);
    expect(decode(encode(base)).compare).toBeUndefined();
  });
});
