// Prints the facts block the chat would send for a follow-up about Roubaix (risk list included).
//   npx vite-node scripts/ai-followup.ts
import { readFileSync } from 'node:fs';
import type { Row } from '../src/engine';
import { COLUMNS, derive } from '../src/strategies';
import { fmt } from '../src/format';

const d = JSON.parse(readFileSync('public/data/communes.json', 'utf8'));
const names = Object.keys(d.cols);
const raw: Row[] = Array.from({ length: d.n }, (_, i) => Object.fromEntries(names.map((c) => [c, d.cols[c][i]])) as Row);
const r = derive(raw, 'house').find((x) => x.code === '59512')!;
console.log(['risk_count', 'risk_list', 'catnat_flood', 'ppr_flood', 'radon_class'].map((c) => `${COLUMNS[c].label} ${fmt(c, r[c])}`).join(' ; '));
