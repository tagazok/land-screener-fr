// Rental investment simulation per commune: purchase cost, net yield and
// monthly cash flow under the user's financing assumptions.
//
// Everything is an estimate built from commune medians; the side panel shows
// each step so the user can check the arithmetic.

import type { Row } from './engine';

export interface Finance {
  /** Living area simulated, m². */
  surface: number;
  /** Down payment as a share of the total cost (0..1). */
  deposit: number;
  /** Loan interest rate per year (0.035 = 3.5 %). */
  rate: number;
  /** Loan duration in years. */
  years: number;
  /** Notary fees as a share of the price (older property ≈ 7.5 %). */
  notary: number;
  /** Non-recoverable charges, maintenance, insurance, as a share of the rent. */
  charges: number;
  /** Months per year without a tenant. */
  vacancy: number;
  /** Rent of one parking space or garage, €/month; 0 = not set (no public data on parking rents). */
  parkingRent: number;
  /** Property tax of one parking space, €/year (unknown per commune: entered by the user). */
  parkingTax: number;
}

export const DEFAULT_FINANCE: Finance = {
  surface: 0, // 0 = the ANIL reference size of the property type (92 m² house, 52 m² flat)
  deposit: 0.2,
  rate: 0.035,
  years: 20,
  notary: 0.075,
  charges: 0.15,
  vacancy: 1,
  parkingRent: 0,
  parkingTax: 0,
};

export interface ParkingSimulation {
  price: number;
  notaryFees: number;
  totalCost: number;
  rentYear: number;
  vacancyLoss: number;
  charges: number;
  propertyTax: number;
  netIncome: number;
  grossYield: number;
  netYield: number;
  loan: number;
  monthlyPayment: number;
  cashflowMonth: number;
}

/** One parking space at the commune's median DVF price, with the rent the user entered. */
export function simulateParking(row: Row, f: Finance): ParkingSimulation | null {
  const price = row.parking_price;
  if (typeof price !== 'number' || f.parkingRent <= 0) return null;
  const notaryFees = price * f.notary;
  const totalCost = price + notaryFees;
  const rentYear = f.parkingRent * 12;
  const vacancyLoss = rentYear * (f.vacancy / 12);
  const charges = rentYear * f.charges;
  const netIncome = rentYear - vacancyLoss - charges - f.parkingTax;
  const loan = totalCost * (1 - f.deposit);
  const mp = monthlyPayment(loan, f.rate, f.years);
  return {
    price, notaryFees, totalCost, rentYear, vacancyLoss, charges, propertyTax: f.parkingTax, netIncome,
    grossYield: rentYear / price, netYield: netIncome / totalCost, loan, monthlyPayment: mp, cashflowMonth: netIncome / 12 - mp,
  };
}

/** ANIL rent references: the rent per m² is predicted for these sizes. */
export const REFERENCE_SURFACE = { house: 92, apt: 52 } as const;

export interface Simulation {
  surface: number;
  price: number;
  notaryFees: number;
  totalCost: number;
  rentYear: number;
  vacancyLoss: number;
  charges: number;
  propertyTax: number;
  netIncome: number;
  netYield: number;
  loan: number;
  monthlyPayment: number;
  cashflowMonth: number;
}

/** Monthly payment of a fixed-rate loan (French "mensualité", insurance excluded). */
export function monthlyPayment(principal: number, rate: number, years: number): number {
  const n = years * 12;
  const r = rate / 12;
  if (principal <= 0) return 0;
  if (r === 0) return principal / n;
  return (principal * r) / (1 - (1 + r) ** -n);
}

export function simulate(row: Row, type: 'house' | 'apt', f: Finance): Simulation | null {
  const pm2 = row[`price_m2_${type}`];
  const rm2 = row[`rent_m2_${type}`];
  if (typeof pm2 !== 'number' || typeof rm2 !== 'number') return null;
  const surface = f.surface > 0 ? f.surface : REFERENCE_SURFACE[type];
  const price = pm2 * surface;
  const notaryFees = price * f.notary;
  const totalCost = price + notaryFees;
  const rentYear = rm2 * surface * 12;
  const vacancyLoss = rentYear * (f.vacancy / 12);
  const charges = rentYear * f.charges;
  const tax = row.tfpb_total_avg_eur;
  const propertyTax = typeof tax === 'number' ? tax : 0;
  const netIncome = rentYear - vacancyLoss - charges - propertyTax;
  const loan = totalCost * (1 - f.deposit);
  const mp = monthlyPayment(loan, f.rate, f.years);
  return {
    surface, price, notaryFees, totalCost, rentYear, vacancyLoss, charges, propertyTax, netIncome,
    netYield: netIncome / totalCost,
    loan, monthlyPayment: mp,
    cashflowMonth: netIncome / 12 - mp,
  };
}

/** Adds purchase_price, net_yield and cashflow_month columns for the given property type. */
export function withFinance(rows: Row[], type: 'house' | 'apt', f: Finance): Row[] {
  return rows.map((r) => {
    const s = simulate(r, type, f);
    const p = simulateParking(r, f);
    return {
      ...r,
      purchase_price: s ? Math.round(s.totalCost) : null,
      net_yield: s ? s.netYield : null,
      cashflow_month: s ? Math.round(s.cashflowMonth) : null,
      parking_gross_yield: p ? p.grossYield : null,
      parking_net_yield: p ? p.netYield : null,
      parking_cashflow_month: p ? Math.round(p.cashflowMonth) : null,
    };
  });
}

/** Finance assumptions in the share link: only values that differ from the defaults. */
export function encodeFinance(f: Finance): string {
  const keys = Object.keys(DEFAULT_FINANCE) as (keyof Finance)[];
  return keys.filter((k) => f[k] !== DEFAULT_FINANCE[k]).map((k) => `${k}:${f[k]}`).join(',');
}

export function decodeFinance(s: string | null): Finance {
  const f = { ...DEFAULT_FINANCE };
  if (!s) return f;
  for (const part of s.split(',')) {
    const [k, v] = part.split(':');
    if (k in f && Number.isFinite(Number(v))) (f as Record<string, number>)[k] = Number(v);
  }
  return f;
}
