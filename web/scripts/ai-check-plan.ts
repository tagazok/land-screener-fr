// How many communes a plan keeps, with the strategy preset filters on top.
//   npx vite-node scripts/ai-check-plan.ts
import { readFileSync } from 'node:fs';
import { evaluate, type Row } from '../src/engine';
import { planFilters, parsePlan } from '../src/ai/plan';
import { derive, preset } from '../src/strategies';

const d = JSON.parse(readFileSync('public/data/communes.json', 'utf8'));
const names = Object.keys(d.cols);
const raw: Row[] = Array.from({ length: d.n }, (_, i) => Object.fromEntries(names.map((c) => [c, d.cols[c][i]])) as Row);
const plan = parsePlan(JSON.stringify({
  mode: 'answer', strategy: 'live', departements: null, reset_filters: true, color_by: null, forest_layer: true, relief_layer: null, summary: '',
  filters: [
    { column: 'pesticide_breach_share', op: 'max', value: 0 }, { column: 'pfas_max', op: 'max', value: 0.1 },
    { column: 'sis_count', op: 'max', value: 0 }, { column: 'polluted_site_count', op: 'max', value: 0 },
    { column: 'casias_per_km2', op: 'max', value: 1 }, { column: 'risk_forest_fire', op: 'is_false', value: null },
    { column: 'water_limit_breach_share', op: 'max', value: 0 }, { column: 'crisis_days_avg', op: 'max', value: 10 },
    { column: 'drought_days_avg', op: 'max', value: 30 }, { column: 'pop', op: 'max', value: 2000 },
    { column: 'town3000_km', op: 'max', value: 10 }, { column: 'forest_around_share', op: 'min', value: 30 },
    { column: 'relief_m', op: 'min', value: 100 }, { column: 'catnat_flood', op: 'max', value: 0 },
    { column: 'tourist_beds_per_1000', op: 'min', value: 100 }, { column: 'second_homes_change', op: 'min', value: 10 },
  ],
}));
const { filters } = planFilters(plan);
const rows = derive(raw, 'house');
for (const withPreset of [true, false]) {
  const p = preset('live');
  const res = evaluate(rows, [...(withPreset ? p.filters : []), ...filters], p.signals);
  const pass = res.filter((r) => r.pass).sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
  console.log(withPreset ? 'with live preset' : 'plan filters only', pass.length, pass.slice(0, 8).map((r) => `${r.row.nom} (${r.row.dep})`).join(', '));
}
// Which plan filter eliminates the most on its own.
for (const f of filters) {
  const n = evaluate(rows, [f], []).filter((r) => r.pass).length;
  console.log(`  ${f.column} ${f.op} ${f.value ?? ''}: ${n} pass alone`);
}
