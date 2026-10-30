// Strategy fit for every commune, computed with the app's own engine so the
// AI summaries explain exactly what the screener shows.
//
//   npx vite-node scripts/strategy-fit.ts
//
// For each commune and each strategy (default filters, house or flat as the
// preset says): pass, or the filters that eliminate it, with the commune's
// value and the threshold. Pass/fail does not depend on the zone (thresholds
// are absolute), so the result holds whatever département is selected.

import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { passes, type Row } from '../src/engine';
import { fmt } from '../src/format';
import { COLUMNS, FILTERS, STRATEGIES, derive } from '../src/strategies';

const root = resolve(import.meta.dirname, '..');
const data = JSON.parse(readFileSync(resolve(root, 'public/data/communes.json'), 'utf8')) as {
  n: number;
  cols: Record<string, Row[string][]>;
};
const names = Object.keys(data.cols);
const raw: Row[] = Array.from({ length: data.n }, (_, i) => {
  const r: Record<string, Row[string]> = {};
  for (const c of names) r[c] = data.cols[c][i];
  return r as Row;
});

type Fit = { pass: boolean; why: string[] };
// The AI summaries were written for these five strategies: newer ones (parking) are left out so the
// summary cache stays valid.
const SUMMARY_STRATEGIES = STRATEGIES.filter((s) => ['long', 'medium', 'short', 'live', 'land'].includes(s.id));
const out: Record<string, Record<string, Fit>> = {};
const counts: Record<string, number> = {};

for (const st of SUMMARY_STRATEGIES) {
  const rows = derive(raw, st.type);
  const active = st.filters.filter((f) => f.enabled);
  let n = 0;
  for (const r of rows) {
    const why: string[] = [];
    for (const f of active) {
      if (passes(r, f)) continue;
      const label = FILTERS[f.id]?.label ?? f.id;
      const v = r[f.column];
      if (f.op === 'min' || f.op === 'max') {
        const shown = v === null || v === undefined ? 'donnée absente' : fmt(f.column, v);
        why.push(`${label} : ${shown} (seuil ${f.op === 'min' ? '≥' : '≤'} ${fmt(f.column, f.value ?? null)})`);
      } else {
        why.push(`${label} (${COLUMNS[f.column]?.label ?? f.column} : oui)`);
      }
    }
    (out[r.code] ??= {})[st.id] = { pass: why.length === 0, why };
    if (!why.length) n++;
  }
  counts[st.id] = n;
}

const target = resolve(root, '../raw/ai/strategy-fit.json');
writeFileSync(target, JSON.stringify({ strategies: SUMMARY_STRATEGIES.map((s) => ({ id: s.id, label: s.label, type: s.type })), fit: out }));
console.log(`wrote ${Object.keys(out).length} communes -> ${target}`);
console.log('communes passing each strategy:', counts);
