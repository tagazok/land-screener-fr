import { describe, expect, it } from 'vitest';
import type { Row } from './engine';
import { DEFAULT_FINANCE, decodeFinance, encodeFinance, monthlyPayment, simulate } from './finance';

describe('finance', () => {
  it('computes a standard French mortgage payment', () => {
    // 200 000 € at 3.5 % over 20 years ≈ 1 159.92 € per month.
    expect(monthlyPayment(200_000, 0.035, 20)).toBeCloseTo(1159.92, 1);
    expect(monthlyPayment(120_000, 0, 10)).toBeCloseTo(1000, 6);
    expect(monthlyPayment(0, 0.04, 20)).toBe(0);
  });

  it('builds net yield and cash flow step by step', () => {
    const row = { code: 'x', nom: 'x', price_m2_apt: 2000, rent_m2_apt: 12, tfpb_total_avg_eur: 600 } as Row;
    const s = simulate(row, 'apt', { ...DEFAULT_FINANCE, surface: 50, deposit: 0.2, rate: 0.035, years: 20 })!;
    expect(s.price).toBe(100_000);
    expect(s.totalCost).toBeCloseTo(107_500);
    expect(s.rentYear).toBe(7200);
    // 7 200 − 600 (1 month) − 1 080 (15 %) − 600 tax = 4 920 € per year
    expect(s.netIncome).toBeCloseTo(4920);
    expect(s.netYield).toBeCloseTo(4920 / 107_500);
    expect(s.loan).toBeCloseTo(86_000);
    expect(s.cashflowMonth).toBeCloseTo(4920 / 12 - monthlyPayment(86_000, 0.035, 20));
  });

  it('uses the ANIL reference surface by default and needs price and rent', () => {
    const row = { code: 'x', nom: 'x', price_m2_house: 1500, rent_m2_house: 9 } as Row;
    expect(simulate(row, 'house', DEFAULT_FINANCE)!.surface).toBe(92);
    expect(simulate(row, 'apt', DEFAULT_FINANCE)).toBeNull();
  });

  it('round-trips assumptions in the share link', () => {
    const f = { ...DEFAULT_FINANCE, rate: 0.032, years: 25 };
    const e = encodeFinance(f);
    expect(e).toBe('rate:0.032,years:25');
    expect(decodeFinance(e)).toEqual(f);
    expect(decodeFinance('rate:abc,bogus:3')).toEqual(DEFAULT_FINANCE);
  });
});
