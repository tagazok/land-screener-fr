// Pure filter / scoring engine. No DOM. Same input => same output.
//
// Filters decide pass/fail. Weights only order the survivors.
// Missing data never silently fails a filter unless the filter says so.

export type Value = number | string | boolean | null;
export type Row = Record<string, Value> & { code: string; nom: string };

export type FilterOp = 'min' | 'max' | 'isFalse' | 'isTrue';

export interface FilterDef {
  id: string;
  column: string;
  op: FilterOp;
  /** Threshold for min/max, ignored for boolean ops. */
  value?: number;
  enabled: boolean;
  /** When true a missing value fails the filter; default: missing passes. */
  requireData?: boolean;
}

export interface SignalDef {
  id: string;
  column: string;
  /** +1: higher is better, -1: lower is better. */
  dir: 1 | -1;
  weight: number;
}

export interface Scored {
  row: Row;
  pass: boolean;
  /** Ids of the filters this row failed. */
  failed: string[];
  /** 0..100 among passing rows, null for failing rows. */
  score: number | null;
  tier: Tier | null;
  /** Signal id -> percentile 0..1 among passing rows (null if value missing). */
  parts: Record<string, number | null>;
}

export type Tier = 'A' | 'B' | 'C' | 'D' | 'E';
export const TIERS: Tier[] = ['A', 'B', 'C', 'D', 'E'];

export function num(v: Value | undefined): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

export function passes(row: Row, f: FilterDef): boolean {
  const v = row[f.column];
  if (v === null || v === undefined) return !f.requireData;
  switch (f.op) {
    case 'min':
      return num(v) === null ? !f.requireData : (num(v) as number) >= (f.value ?? -Infinity);
    case 'max':
      return num(v) === null ? !f.requireData : (num(v) as number) <= (f.value ?? Infinity);
    case 'isFalse':
      return v !== true;
    case 'isTrue':
      return v === true;
  }
}

/** Percentile rank (0..1) of each value; ties share the mean rank. Missing -> null. */
export function percentiles(values: (number | null)[]): (number | null)[] {
  const idx = values
    .map((v, i) => [v, i] as const)
    .filter((p): p is readonly [number, number] => p[0] !== null)
    .sort((a, b) => a[0] - b[0]);
  const out: (number | null)[] = values.map(() => null);
  const n = idx.length;
  if (n === 0) return out;
  if (n === 1) {
    out[idx[0][1]] = 0.5;
    return out;
  }
  let i = 0;
  while (i < n) {
    let j = i;
    while (j + 1 < n && idx[j + 1][0] === idx[i][0]) j++;
    const rank = (i + j) / 2 / (n - 1);
    for (let k = i; k <= j; k++) out[idx[k][1]] = rank;
    i = j + 1;
  }
  return out;
}

export function evaluate(rows: Row[], filters: FilterDef[], signals: SignalDef[]): Scored[] {
  const active = filters.filter((f) => f.enabled);
  const results: Scored[] = rows.map((row) => {
    const failed = active.filter((f) => !passes(row, f)).map((f) => f.id);
    return { row, pass: failed.length === 0, failed, score: null, tier: null, parts: {} };
  });

  const survivors = results.filter((r) => r.pass);
  const weighted = signals.filter((s) => s.weight > 0);
  for (const s of signals) {
    const ranks = percentiles(survivors.map((r) => num(r.row[s.column])));
    survivors.forEach((r, i) => {
      const p = ranks[i];
      r.parts[s.id] = p === null ? null : s.dir === 1 ? p : 1 - p;
    });
  }
  for (const r of survivors) {
    // Weighted mean over the signals that have data; missing signals don't count
    // for or against the row.
    let sw = 0;
    let acc = 0;
    for (const s of weighted) {
      const p = r.parts[s.id];
      if (p === null || p === undefined) continue;
      sw += s.weight;
      acc += s.weight * p;
    }
    r.score = sw > 0 ? Math.round((acc / sw) * 1000) / 10 : 50;
  }

  // Tiers by rank among survivors: top 20% = A ... bottom 20% = E.
  const ranked = [...survivors].sort(compareScore);
  ranked.forEach((r, i) => {
    r.tier = TIERS[Math.min(4, Math.floor((i / ranked.length) * 5))];
  });
  return results;
}

/** Score descending, then name — a stable, deterministic order. */
export function compareScore(a: Scored, b: Scored): number {
  const d = (b.score ?? -1) - (a.score ?? -1);
  return d !== 0 ? d : a.row.nom.localeCompare(b.row.nom, 'fr');
}
