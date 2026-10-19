// Continuous colour scale for "Colorer par <indicateur>" on the map.

import { direction } from './judge';

// Red → yellow → green (bad → good) and a neutral sequential scale for
// indicators that are neither good nor bad (population, density, price…).
const GOOD_BAD = ['#c2362b', '#e8743b', '#f4b860', '#f2e48a', '#b7dc7b', '#5fb36a', '#1a8a4a'];
const NEUTRAL = ['#f0f4c3', '#c5e1a5', '#80cbc4', '#4db6ac', '#26a69a', '#2b7a9b', '#2c4f8a'];

export interface Scale {
  min: number;
  max: number;
  stops: string[];
  /** true when low values are good (the gradient is reversed). */
  lowIsGood: boolean;
  neutral: boolean;
  color: (v: number) => string;
}

function hex(c: string): [number, number, number] {
  const n = parseInt(c.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function mix(a: string, b: string, t: number): string {
  const [r1, g1, b1] = hex(a);
  const [r2, g2, b2] = hex(b);
  const f = (x: number, y: number) => Math.round(x + (y - x) * t).toString(16).padStart(2, '0');
  return `#${f(r1, r2)}${f(g1, g2)}${f(b1, b2)}`;
}

function quantile(sorted: number[], q: number): number {
  const i = (sorted.length - 1) * q;
  const lo = Math.floor(i);
  const hi = Math.ceil(i);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (i - lo);
}

/** Build a scale over `values`, clamped to the 5th–95th percentile so a few outliers don't wash out the map. */
export function makeScale(column: string, values: number[]): Scale | null {
  const v = values.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  if (!v.length) return null;
  let min = quantile(v, 0.05);
  let max = quantile(v, 0.95);
  if (min === max) {
    min = v[0];
    max = v[v.length - 1];
  }
  const dir = direction(column);
  const neutral = dir === null;
  const lowIsGood = dir === -1;
  const base = neutral ? NEUTRAL : GOOD_BAD;
  const stops = lowIsGood ? [...base].reverse() : base;
  const color = (x: number) => {
    if (max === min) return stops[Math.floor(stops.length / 2)];
    const t = Math.max(0, Math.min(1, (x - min) / (max - min))) * (stops.length - 1);
    const i = Math.min(stops.length - 2, Math.floor(t));
    return mix(stops[i], stops[i + 1], t - i);
  };
  return { min, max, stops, lowIsGood, neutral, color };
}
