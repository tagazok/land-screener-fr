import { describe, expect, it } from 'vitest';
import { riskLevel } from './components/address-risk';

describe('Géorisques status wording', () => {
  it('maps the API phrases to a colour', () => {
    expect(riskLevel('Risque Existant - important')).toBe('bad');
    expect(riskLevel('Risque Concerne')).toBe('bad');
    expect(riskLevel('Risque Existant - modéré')).toBe('warn');
    expect(riskLevel('Risque Existant - faible')).toBe('warn');
    expect(riskLevel('Risque non Concerne')).toBe('good');
    expect(riskLevel('Risque non Connu')).toBe('unknown');
    expect(riskLevel('Risque Inconnu')).toBe('unknown');
    expect(riskLevel(null)).toBe('unknown');
  });
});
