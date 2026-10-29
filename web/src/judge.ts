// "Is this value good or bad news?" — absolute thresholds per column, so the
// colour means the same thing whatever the filters. Thresholds are written
// for someone buying to live or to rent; they are explained in `why`.

import type { Value } from './engine';

export type Verdict = 'good' | 'bad' | 'warn';

interface Rule {
  /** +1: higher is better, -1: lower is better. */
  dir: 1 | -1;
  /** Good when at or beyond this value (in the good direction). */
  good?: number;
  /** Bad when beyond this value (in the bad direction). */
  bad?: number;
  /** Worth a look when beyond this value, but not yet bad. */
  warn?: number;
}

const RULES: Record<string, Rule> = {
  gross_yield: { dir: 1, good: 0.06, warn: 0.045, bad: 0.035 },
  price_trend_3y: { dir: 1, good: 0.05, bad: -0.05 },
  pop_cagr_11y: { dir: 1, good: 0.01, bad: 0 },
  vacancy_rate: { dir: -1, good: 0.06, bad: 0.1 },
  median_income: { dir: 1, good: 25000, bad: 20000 },
  tfpb_rate: { dir: -1, good: 35, bad: 50 },
  risk_count: { dir: -1, good: 0, warn: 2, bad: 3 },
  clay_high_share: { dir: -1, good: 0.1, warn: 0.3, bad: 0.5 },
  clay_med_high_share: { dir: -1, good: 0.2, bad: 0.8 },
  catnat_drought: { dir: -1, good: 0, bad: 3 },
  catnat_flood: { dir: -1, good: 1, warn: 3, bad: 5 },
  crisis_days_avg: { dir: -1, good: 5, warn: 20, bad: 40 },
  drought_days_avg: { dir: -1, good: 20, warn: 45, bad: 75 },
  water_limit_breach_share: { dir: -1, good: 0, bad: 0.02 },
  pesticide_breach_share: { dir: -1, good: 0, bad: 0.05 },
  pfas_max: { dir: -1, good: 0.02, bad: 0.1 },
  pfas_breach_share: { dir: -1, good: 0, bad: 0 },
  sis_count: { dir: -1, good: 0, bad: 1 },
  polluted_site_count: { dir: -1, good: 0, bad: 2 },
  casias_per_km2: { dir: -1, good: 0.2, bad: 3 },
  apl_gp: { dir: 1, good: 4, warn: 3, bad: 2.5 },
  apl_gp_65: { dir: 1, good: 4, warn: 3, bad: 2.5 },
  services_km: { dir: -1, good: 2, warn: 4, bad: 6 },
  dist_gp_km: { dir: -1, good: 0, bad: 8 },
  dist_pharmacy_km: { dir: -1, good: 0, bad: 8 },
  dist_supermarket_km: { dir: -1, good: 3, bad: 10 },
  dist_bakery_km: { dir: -1, good: 0, bad: 6 },
  dist_primary_school_km: { dir: -1, good: 0, bad: 5 },
  dist_college_km: { dir: -1, good: 3, bad: 12 },
  dist_lycee_km: { dir: -1, good: 5, bad: 20 },
  dist_post_km: { dir: -1, good: 0, bad: 8 },
  dist_emergency_km: { dir: -1, good: 10, bad: 30 },
  dist_train_km: { dir: -1, good: 3, bad: 20 },
  fibre_share: { dir: 1, good: 0.95, bad: 0.8 },
  radon_class: { dir: -1, good: 1, warn: 2, bad: 3 },
  n_sales: { dir: 1, good: 30, bad: 10 },
  second_home_surcharge: { dir: -1, good: 0, warn: 20, bad: 50 },
  net_yield: { dir: 1, good: 0.04, warn: 0.025, bad: 0.015 },
  cashflow_month: { dir: 1, good: 0, warn: -150, bad: -400 },
  unemployment_rate: { dir: -1, good: 0.06, warn: 0.11, bad: 0.15 },
  dpe_fg_share: { dir: -1, good: 0.08, warn: 0.25, bad: 0.35 },
  dpe_g_share: { dir: -1, good: 0.03, warn: 0.1, bad: 0.15 },
  crime_burglary: { dir: -1, good: 2.5, warn: 7, bad: 10 },
  crime_violence: { dir: -1, good: 1, warn: 4, bad: 7 },
  crime_damage: { dir: -1, good: 3, warn: 7, bad: 11 },
  crime_theft: { dir: -1, good: 1.5, warn: 6, bad: 15 },
  college_ips: { dir: 1, good: 108, warn: 95, bad: 88 },
  lycee_success: { dir: 1, good: 97, warn: 93, bad: 90 },
  lycee_value_added: { dir: 1, good: 2, bad: -3 },
  tfpb_total_avg_eur: { dir: -1, good: 600, bad: 2000 },
};

/** Booleans where `true` is bad news. `false` is not highlighted (it's the norm). */
const BAD_IF_TRUE = new Set(['ppr_flood', 'risk_marine_flood', 'coast_retreat_decree', 'risk_coast_erosion', 'risk_forest_fire', 'ppr_industrial']);

/** Direction of a column (+1 higher is better, -1 lower is better), if it has a rule. */
export function direction(column: string): 1 | -1 | null {
  return RULES[column]?.dir ?? null;
}

export function judge(column: string, v: Value | undefined): Verdict | null {
  if (v === null || v === undefined) return null;
  if (typeof v === 'boolean') return v && BAD_IF_TRUE.has(column) ? 'bad' : null;
  if (column === 'rent_confidence') return v === 'high' ? 'good' : v === 'low' ? 'bad' : null;
  if (typeof v !== 'number') return null;
  const r = RULES[column];
  if (!r) return null;
  if (r.dir === 1) {
    if (r.bad !== undefined && v < r.bad) return 'bad';
    if (r.good !== undefined && v >= r.good) return 'good';
    if (r.warn !== undefined && v < r.warn) return 'warn';
  } else {
    if (r.bad !== undefined && v >= r.bad) return 'bad';
    if (r.good !== undefined && v <= r.good) return 'good';
    if (r.warn !== undefined && v >= r.warn) return 'warn';
  }
  return null;
}

/** Human sentence for a verdict, used in the side panel's strengths/weaknesses lists. */
export const VERDICT_LABEL: Record<Verdict, string> = { good: 'Point fort', bad: 'Point faible', warn: 'À surveiller' };
