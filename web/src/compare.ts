// Side-by-side comparison of communes: which value is best in each row.
// Pure functions, no DOM.

import { num, type SignalDef, type Value } from './engine';
import { direction } from './judge';

/** At most this many communes side by side. */
export const MAX_COMPARE = 4;

/**
 * Which direction is "better" for a column: the active strategy's weighted signal wins
 * (price is low-is-better when buying, for instance), else the fixed good/bad rule of judge.ts.
 * null = no obvious best (population, altitude…): the row is not highlighted.
 */
export function betterDirection(column: string, signals: SignalDef[]): 1 | -1 | null {
  const s = signals.find((x) => x.column === column && x.weight > 0);
  return s ? s.dir : direction(column);
}

/**
 * Index of the best value(s) in a row, ties included. Empty when there is no direction,
 * fewer than two values, or every value is equal (nothing to choose).
 */
export function bestIndexes(values: (Value | undefined)[], dir: 1 | -1 | null): number[] {
  if (!dir) return [];
  const nums = values.map((v) => num(v ?? null));
  const known = nums.filter((v): v is number => v !== null);
  if (known.length < 2) return [];
  const best = dir > 0 ? Math.max(...known) : Math.min(...known);
  const hits = nums.flatMap((v, i) => (v === best ? [i] : []));
  return hits.length === known.length ? [] : hits;
}

/**
 * Whether a row shows a real difference: numbers spread by at least `tolerance`
 * (relative to the largest absolute value), or any differing text / yes-no value.
 * Rows with fewer than two known values are not differences.
 */
export function differs(values: (Value | undefined)[], tolerance = 0.05): boolean {
  const known = values.filter((v): v is Exclude<Value, null> => v !== null && v !== undefined);
  if (known.length < 2) return false;
  if (known.every((v) => typeof v === 'number')) {
    const n = known as number[];
    const max = Math.max(...n), min = Math.min(...n);
    const scale = Math.max(Math.abs(max), Math.abs(min));
    return scale === 0 ? false : (max - min) / scale >= tolerance;
  }
  return new Set(known.map(String)).size > 1;
}

/** Parse "33063,33281" into valid, unique commune codes (at most MAX_COMPARE). */
export function parseCodes(s: string | null | undefined): string[] {
  const out: string[] = [];
  for (const c of (s ?? '').split(',').map((x) => x.trim().toUpperCase())) {
    if (/^(\d{5}|2[AB]\d{3})$/.test(c) && !out.includes(c)) out.push(c);
  }
  return out.slice(0, MAX_COMPARE);
}
