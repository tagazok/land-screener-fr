// Shareable URL state: strategy, property type and any filter/weight that
// differs from the strategy preset. Version prefix lets old links degrade.

import type { FilterDef, SignalDef } from './engine';
import { preset, type PropertyType, type StrategyId, type Strategy } from './strategies';

export interface UrlState {
  strategy: StrategyId;
  type: PropertyType;
  filters: FilterDef[];
  signals: SignalDef[];
  selected: string | null;
  /** Département codes to show; empty = all of France. */
  scopes?: string[];
  /** Financing assumptions that differ from the defaults, encoded by finance.ts. */
  finance?: string;
}

export function encode(st: UrlState): string {
  const base = preset(st.strategy);
  const p = new URLSearchParams();
  p.set('v', '1');
  p.set('s', st.strategy);
  if (st.type !== base.type) p.set('t', st.type);
  for (const f of st.filters) {
    const b = base.filters.find((x) => x.id === f.id);
    if (!b || b.enabled !== f.enabled || b.value !== f.value) {
      p.set(`f.${f.id}`, `${f.enabled ? 1 : 0}${f.value !== undefined ? `:${f.value}` : ''}`);
    }
  }
  for (const s of st.signals) {
    const b = base.signals.find((x) => x.id === s.id);
    if (!b || b.weight !== s.weight) p.set(`w.${s.id}`, String(s.weight));
  }
  if (st.selected) p.set('c', st.selected);
  // Commas stay readable in the hash: #…&z=33,40,64
  if (st.scopes?.length) p.set('z', [...st.scopes].sort().join(','));
  if (st.finance) p.set('fi', st.finance);
  return p.toString().replace(/%2C/g, ',').replace(/%3A/g, ':');
}

export function decode(hash: string): UrlState {
  const p = new URLSearchParams(hash.replace(/^#/, ''));
  const sid = (p.get('s') as StrategyId) || 'long';
  const st: Strategy = preset(sid);
  const state: UrlState = {
    strategy: st.id,
    type: p.get('t') === 'apt' || p.get('t') === 'house' ? (p.get('t') as PropertyType) : st.type,
    filters: st.filters,
    signals: st.signals,
    selected: p.get('c'),
    scopes: [...new Set((p.get('z') ?? '').split(',').map((s) => s.trim().toUpperCase()).filter((s) => /^(\d{2}|2[AB])$/.test(s)))].sort(),
    finance: p.get('fi') ?? undefined,
  };
  if (p.get('v') !== '1') return state;
  for (const f of state.filters) {
    const raw = p.get(`f.${f.id}`);
    if (!raw) continue;
    const [en, val] = raw.split(':');
    f.enabled = en === '1';
    if (val !== undefined && Number.isFinite(Number(val))) f.value = Number(val);
  }
  for (const s of state.signals) {
    const raw = p.get(`w.${s.id}`);
    if (raw !== null && Number.isFinite(Number(raw))) s.weight = Math.max(0, Math.min(5, Number(raw)));
  }
  return state;
}
