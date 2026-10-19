import { describe, expect, it } from 'vitest';
import { evaluate, passes, percentiles, type FilterDef, type Row, type SignalDef } from './engine';
import { csvValue, fmt } from './format';
import { judge } from './judge';
import { COLUMNS, FILTERS, SIGNALS, STRATEGIES, columnHelp, derive, preset } from './strategies';
import { decode, encode } from './url';

describe('good / bad verdicts', () => {
  it('higher-is-better thresholds', () => {
    expect(judge('gross_yield', 0.07)).toBe('good');
    expect(judge('gross_yield', 0.05)).toBe(null);
    expect(judge('gross_yield', 0.04)).toBe('warn');
    expect(judge('gross_yield', 0.03)).toBe('bad');
    expect(judge('apl_gp', 2.4)).toBe('bad');
    expect(judge('pop_cagr_11y', -0.001)).toBe('bad');
  });
  it('lower-is-better thresholds', () => {
    expect(judge('risk_count', 0)).toBe('good');
    expect(judge('risk_count', 1)).toBe(null);
    expect(judge('risk_count', 2)).toBe('warn');
    expect(judge('risk_count', 3)).toBe('bad');
    expect(judge('dist_gp_km', 0)).toBe('good');
    expect(judge('dist_gp_km', 9)).toBe('bad');
  });
  it('booleans and missing values', () => {
    expect(judge('coast_retreat_decree', true)).toBe('bad');
    expect(judge('coast_retreat_decree', false)).toBe(null);
    expect(judge('zone_tendue', true)).toBe(null);
    expect(judge('apl_gp', null)).toBe(null);
    expect(judge('rent_confidence', 'low')).toBe('bad');
  });
});

describe('french formatting and help coverage', () => {
  it('formats numbers the French way', () => {
    expect(fmt('price_m2', 2510).replace(/\s/g, ' ')).toBe('2 510 €');
    expect(fmt('gross_yield', 0.059).replace(/\s/g, ' ')).toBe('5,9 %');
    expect(fmt('zone_tendue', true)).toBe('oui');
    expect(fmt('rent_confidence', 'high')).toBe('élevée');
  });
  it('writes CSV values for French Excel', () => {
    expect(csvValue(0.0592)).toBe('0,0592');
    expect(csvValue('a;b')).toBe('"a;b"');
  });
  it('every shown column, filter and weight has an explanation', () => {
    for (const st of STRATEGIES) {
      for (const c of st.table) expect(columnHelp(c), c).not.toBe('');
      for (const f of st.filters) expect(FILTERS[f.id]?.help, f.id).toBeTruthy();
      for (const s of st.signals) expect(SIGNALS[s.id]?.help, s.id).toBeTruthy();
      for (const f of st.filters) expect(COLUMNS[f.column], f.column).toBeDefined();
    }
  });
});

const row = (code: string, extra: Record<string, number | boolean | null>): Row => ({ code, nom: code, ...extra });

describe('filters', () => {
  const f: FilterDef = { id: 'y', column: 'y', op: 'min', value: 0.05, enabled: true };
  it('min / max thresholds', () => {
    expect(passes(row('a', { y: 0.06 }), f)).toBe(true);
    expect(passes(row('a', { y: 0.04 }), f)).toBe(false);
    expect(passes(row('a', { y: 0.04 }), { ...f, op: 'max' })).toBe(true);
  });
  it('missing data passes unless requireData', () => {
    expect(passes(row('a', { y: null }), f)).toBe(true);
    expect(passes(row('a', { y: null }), { ...f, requireData: true })).toBe(false);
  });
  it('boolean ops', () => {
    const b: FilterDef = { id: 'b', column: 'b', op: 'isFalse', enabled: true };
    expect(passes(row('a', { b: true }), b)).toBe(false);
    expect(passes(row('a', { b: false }), b)).toBe(true);
  });
});

describe('percentiles', () => {
  it('ranks with ties and nulls', () => {
    expect(percentiles([10, null, 30, 20])).toEqual([0, null, 1, 0.5]);
    expect(percentiles([5, 5, 10])).toEqual([0.25, 0.25, 1]);
  });
});

describe('evaluate', () => {
  const rows = [row('a', { y: 0.08, g: 0 }), row('b', { y: 0.06, g: 1 }), row('c', { y: 0.02, g: 1 })];
  const filters: FilterDef[] = [{ id: 'y', column: 'y', op: 'min', value: 0.05, enabled: true }];
  const signals: SignalDef[] = [
    { id: 'y', column: 'y', dir: 1, weight: 1 },
    { id: 'g', column: 'g', dir: 1, weight: 0 },
  ];
  it('filters exclude, weights only order', () => {
    const r = evaluate(rows, filters, signals);
    expect(r.map((x) => x.pass)).toEqual([true, true, false]);
    expect(r[0].score).toBe(100);
    expect(r[1].score).toBe(0);
    expect(r[2].score).toBeNull();
    // zero-weight signal is still computed for display but does not move the score
    expect(r[1].parts.g).toBe(1);
  });
  it('lower-is-better signals invert', () => {
    const r = evaluate(rows, [], [{ id: 'y', column: 'y', dir: -1, weight: 1 }]);
    expect(r[2].score).toBe(100);
  });
  it('disabled filters do nothing', () => {
    const r = evaluate(rows, [{ ...filters[0], enabled: false }], signals);
    expect(r.every((x) => x.pass)).toBe(true);
  });
  it('tiers are assigned to passing rows only', () => {
    const r = evaluate(rows, filters, signals);
    expect(r[0].tier).toBe('A');
    expect(r[2].tier).toBeNull();
  });
});

describe('derive', () => {
  it('maps type-specific columns and counts risks', () => {
    const [d] = derive([row('a', { price_m2_house: 2000, gross_yield_house: 0.06, ppr_flood: true, radon_class: 3, catnat_flood: 6, drought_days_avg: 10 })], 'house');
    expect(d.price_m2).toBe(2000);
    expect(d.gross_yield).toBe(0.06);
    expect(d.risk_count).toBe(3);
  });
});

describe('url', () => {
  it('round-trips changed filters and weights', () => {
    const p = preset('short');
    p.filters[0].value = 250;
    p.filters[1].enabled = true;
    p.signals[0].weight = 5;
    const h = encode({ strategy: 'short', type: 'apt', filters: p.filters, signals: p.signals, selected: '33529' });
    const back = decode(h);
    expect(back.strategy).toBe('short');
    expect(back.type).toBe('apt');
    expect(back.filters[0].value).toBe(250);
    expect(back.filters[1].enabled).toBe(true);
    expect(back.signals[0].weight).toBe(5);
    expect(back.selected).toBe('33529');
  });
  it('falls back to the preset on unknown input', () => {
    expect(decode('#garbage').strategy).toBe('long');
  });
  it('round-trips several départements and ignores invalid codes', () => {
    const p = preset('live');
    const h = encode({ strategy: 'live', type: 'house', filters: p.filters, signals: p.signals, selected: null, scopes: ['40', '33', '2A'] });
    expect(h).toContain('z=2A,33,40');
    expect(decode(h).scopes).toEqual(['2A', '33', '40']);
    expect(decode('#v=1&s=live&z=33,zz,999,2b').scopes).toEqual(['2B', '33']);
    expect(decode('#v=1&s=live').scopes).toEqual([]);
  });
});
