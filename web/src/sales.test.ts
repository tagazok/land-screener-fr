import { describe, expect, it } from 'vitest';
import { parcelLabel, saleHtml, salesHtml } from './sales';

const at: [number, number] = [-0.58, 44.82];

describe('sale popup', () => {
  it('shows every DVF field it has', () => {
    const h = saleHtml({ t: 'M', p: 350000, s: 100, r: 4, l: 600, d: '2025-03-14', a: '12 Rue de la Paix, 33400', g: 1,
      c: 'S:120,J:480', q: '33522000AB0123', np: 2, n: 'F' }, at);
    expect(h).toContain('Maison');
    expect(h).toContain('14 mars 2025');
    expect(h).toContain('12 Rue de la Paix, 33400');
    expect(h).toContain('4 pièces');
    expect(h).toContain('avec 1 dépendance');
    expect(h).toContain('jardin 480 m²');
    expect(h).toContain('section AB n° 123');
    expect(h).toContain('+1 autre');
    expect(h).toContain('neuf');
    expect(h).toContain('geoportail.gouv.fr');
  });
  it('escapes text from the tiles', () => {
    expect(saleHtml({ t: 'A', p: 1, a: '<img src=x onerror=alert(1)>' }, at)).not.toContain('<img');
  });
  it('lists several sales at one spot, newest first', () => {
    const h = salesHtml([{ t: 'A', p: 1, d: '2024-01-01' }, { t: 'A', p: 2, d: '2025-01-01' }], at);
    expect(h).toContain('2 ventes à cet endroit');
    expect(h.indexOf('2025')).toBeLessThan(h.indexOf('2024'));
  });
  it('reads cadastral parcel ids', () => {
    expect(parcelLabel('33063000KZ0042')).toBe('section KZ n° 42');
    expect(parcelLabel('330630000B0042')).toBe('section B n° 42');
  });
});
