import type { Value } from './engine';
import { COLUMNS } from './strategies';

const eur0 = new Intl.NumberFormat('fr-FR', { style: 'currency', currency: 'EUR', maximumFractionDigits: 0 });
const eur1 = new Intl.NumberFormat('fr-FR', { style: 'currency', currency: 'EUR', minimumFractionDigits: 1, maximumFractionDigits: 1 });
const int = new Intl.NumberFormat('fr-FR', { maximumFractionDigits: 0 });
const one = new Intl.NumberFormat('fr-FR', { maximumFractionDigits: 1 });
const pct = new Intl.NumberFormat('fr-FR', { style: 'percent', maximumFractionDigits: 1 });
// Small rates (population growth, price change) need more digits, or -0.04 % reads as "-0 %".
const pctSmall = new Intl.NumberFormat('fr-FR', { style: 'percent', maximumFractionDigits: 2 });

const TEXT_VALUES: Record<string, string> = { high: 'élevée', medium: 'moyenne', low: 'faible' };

export function fmt(column: string, v: Value | undefined): string {
  if (v === null || v === undefined) return '—';
  const unit = COLUMNS[column]?.unit ?? 'num';
  if (typeof v === 'boolean') return v ? 'oui' : 'non';
  if (typeof v === 'string') return TEXT_VALUES[v] ?? v;
  switch (unit) {
    case 'eur':
    case 'eur_m2':
      return eur0.format(v);
    case 'eur_m2_month':
      return eur1.format(v);
    case 'pct':
      return v !== 0 && Math.abs(v) < 0.01 ? pctSmall.format(v) : pct.format(v);
    case 'pct_raw':
      return `${one.format(v)} %`;
    case 'km':
      return v === 0 ? 'sur place' : `${one.format(v)} km`;
    case 'days':
    case 'density':
    case 'count':
      return int.format(v);
    default:
      return one.format(v);
  }
}

/**
 * CSV value for French Excel: ';' field separator (see CSV_SEP), ',' decimal,
 * booleans as oui/non, rent confidence translated. Numbers keep full precision.
 */
export const CSV_SEP = ';';

export function csvValue(v: Value | undefined): string {
  if (v === null || v === undefined) return '';
  if (typeof v === 'boolean') return v ? 'oui' : 'non';
  const s = typeof v === 'number' ? String(v).replace('.', ',') : (TEXT_VALUES[v] ?? v);
  return /[";\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
