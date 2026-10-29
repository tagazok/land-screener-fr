import { LitElement, css, html, nothing, svg } from 'lit';
import { customElement, query, state } from 'lit/decorators.js';
import { compareScore, evaluate, num, type FilterDef, type Row, type Scored, type SignalDef } from '../engine';
import { CSV_SEP, csvValue, fmt } from '../format';
import { VERDICT_LABEL, judge, type Verdict } from '../judge';
import { DEFAULT_FINANCE, REFERENCE_SURFACE, decodeFinance, encodeFinance, simulate, withFinance, type Finance } from '../finance';
import { makeScale, type Scale } from '../scale';
import {
  COLUMNS, DETAIL_GROUPS, FILTERS, HELP, SIGNALS, STRATEGIES, columnHelp, derive, missingDataNote, preset,
  type PropertyType, type StrategyId,
} from '../strategies';
import { customFilter, decode, encode } from '../url';
import { TIER_COLORS, type Bounds, type MapView, type Paint } from './map-view';
import './map-view';
import './info-tip';
import './ai-chat';
import type { ChatHost } from './ai-chat';
import { planFilters, type Plan } from '../ai/plan';

interface Meta {
  built: string;
  dvf_window_end: string;
  sources: { key: string; producer: string; licence: string; vintage: string; url: string; credit: string | null }[];
}

type SortKey = { column: string; dir: 1 | -1 } | null;

const tip = (label: string, text: string) => html`<info-tip .label=${label} .text=${text}></info-tip>`;
const colTip = (c: string) => (columnHelp(c) ? tip(COLUMNS[c]?.label ?? c, columnHelp(c)) : nothing);

/** A value, coloured when it is good or bad news (see judge.ts). */
const val = (c: string, v: Row[string] | undefined) => {
  const j = judge(c, v);
  return j ? html`<span class="v ${j}" title=${VERDICT_LABEL[j]}>${fmt(c, v)}</span>` : html`${fmt(c, v)}`;
};

/** Every column the table can show, in side-panel order. */
const ALL_TABLE_COLUMNS = [...new Set(DETAIL_GROUPS.flatMap((g) => g.columns))].filter((c) => c in COLUMNS);

/** Extra columns shown by default after the strategy's own columns. */
const COMMON_COLUMNS = ['pop', 'pop_cagr_11y', 'median_income', 'price_trend_3y', 'apl_gp', 'services_km', 'risk_count',
  'clay_high_share', 'crisis_days_avg', 'fibre_share', 'tfpb_rate'];

function defaultColumns(id: StrategyId): string[] {
  const st = STRATEGIES.find((s) => s.id === id) ?? STRATEGIES[0];
  return [...new Set([...st.table, ...COMMON_COLUMNS])].filter((c) => c in COLUMNS);
}

/** "Colorer par" choices: the numeric indicators, grouped like the side panel. */
const COLOR_GROUPS = DETAIL_GROUPS.map((g) => ({
  title: g.title,
  columns: g.columns.filter((c) => COLUMNS[c] && !['bool', 'text'].includes(COLUMNS[c].unit)),
})).filter((g) => g.columns.length);

const TIER_TEXT: Record<string, string> = { A: '#fff', B: '#14361f', C: '#3b4a1a', D: '#5a4210', E: '#4a1606', fail: '#fff' };

/** Table rows rendered at a time; "Afficher plus" adds another page. */
const PAGE = 200;

/** communes.json is columnar ({n, cols: {name: values[]}}): turn it into row objects once. */
function fromColumns(d: { n: number; cols: Record<string, Row[string][]> }): Row[] {
  const names = Object.keys(d.cols);
  const rows: Row[] = new Array(d.n);
  for (let i = 0; i < d.n; i++) {
    const r: Record<string, Row[string]> = {};
    for (const c of names) r[c] = d.cols[c][i];
    rows[i] = r as Row;
  }
  return rows;
}

/** Bounding box of one GeoJSON feature. */
function featureBounds(f: GeoJSON.Feature): Bounds {
  let w = 180, s = 90, e = -180, n = -90;
  const visit = (c: unknown): void => {
    if (Array.isArray(c) && typeof c[0] === 'number') {
      const [x, y] = c as number[];
      w = Math.min(w, x); e = Math.max(e, x); s = Math.min(s, y); n = Math.max(n, y);
    } else if (Array.isArray(c)) c.forEach(visit);
  };
  if (f.geometry && 'coordinates' in f.geometry) visit(f.geometry.coordinates);
  return [[w, s], [e, n]];
}

/** Lower-case, accent-free text for search ("Saint-Émilion" → "saint emilion"). */
const fold = (s: string) => s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[-'’]/g, ' ');

@customElement('app-root')
export class AppRoot extends LitElement {
  @state() private raw: Row[] = [];
  @state() private departements: GeoJSON.FeatureCollection | null = null;
  @state() private depNames: Record<string, string> = {};
  @state() private meta: Meta | null = null;
  /** '' = toute la France, otherwise a département code. */
  @state() private scopes: string[] = [];
  @state() private depQuery = '';
  @state() private search = '';
  @state() private shown = PAGE;
  @state() private strategy: StrategyId = 'long';
  @state() private type: PropertyType = 'house';
  @state() private filters: FilterDef[] = [];
  /** Free-form filters on any column, kept across strategy changes. */
  @state() private custom: FilterDef[] = [];
  @state() private signals: SignalDef[] = [];
  @state() private selected: string | null = null;
  @state() private sort: SortKey = null;
  @state() private showFailing = false;
  @state() private settingsOpen = false;
  /** Map expanded to fill the window below the header (left of the side panel when open). */
  @state() private mapFull = false;
  @state() private finance: Finance = { ...DEFAULT_FINANCE };
  @state() private colorBy = 'score';
  /** Background map layers (IGN forest mask, shaded relief). */
  @state() private overlays = { forest: false, relief: false };
  @state() private greyFailing = true;
  @state() private columns: string[] = [];
  @state() private theme: 'auto' | 'light' | 'dark' = 'auto';
  @state() private systemDark = false;
  @state() private summaries: Record<string, string> = {};
  @state() private summaryMeta: { model: string; generated: string } | null = null;
  /** AI summaries are fetched one département at a time, when one of its communes is opened. */
  @state() private summaryDeps: Record<string, 'loading' | 'done'> = {};
  /** Megabytes of commune data received so far; null once the data is loaded. */
  @state() private loadingMb: number | null = 0;
  @state() private error: string | null = null;
  @state() private copied = false;
  @query('map-view') private mapView!: MapView;

  connectedCallback() {
    super.connectedCallback();
    const saved = localStorage.getItem('lsfr-theme');
    if (saved === 'light' || saved === 'dark' || saved === 'auto') this.theme = saved;
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    this.systemDark = mq.matches;
    mq.addEventListener('change', (e) => (this.systemDark = e.matches));
    this.applyUrl(location.hash);
    window.addEventListener('hashchange', () => this.applyUrl(location.hash));
    window.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape') return;
      // Close the innermost layer first: drawer, then side panel, then expanded map.
      if (this.settingsOpen) this.settingsOpen = false;
      else if (this.selected) this.select(null);
      else if (this.mapFull) this.setMapFull(false);
    });
    this.load();
    // Close open dropdowns (départements, colonnes) on a click outside them.
    window.addEventListener('click', (e) => {
      const path = e.composedPath();
      this.renderRoot.querySelectorAll('details.deppicker[open], details.colpicker[open]').forEach((d) => {
        if (!path.includes(d)) (d as HTMLDetailsElement).open = false;
      });
    });
  }

  private setMapFull(on: boolean) {
    this.mapFull = on;
    // The page behind the expanded map must not scroll under it.
    document.documentElement.style.overflow = on ? 'hidden' : '';
  }

  private async load() {
    try {
      const [data, dep, meta] = await Promise.all([
        this.fetchWithProgress('./data/communes.json'),
        fetch('./data/departements.geojson').then((r) => r.json()),
        fetch('./data/metadata.json').then((r) => r.json()),
      ]);
      this.raw = fromColumns(data);
      this.departements = dep;
      this.depNames = Object.fromEntries(
        (dep as GeoJSON.FeatureCollection).features.map((f) => [f.properties!.code, f.properties!.nom]),
      );
      this.meta = meta;
      this.loadingMb = null;
    } catch (e) {
      this.error = `Impossible de charger les données : ${(e as Error).message}`;
    }
  }

  /** Fetch JSON while reporting the megabytes received, so a slow connection shows progress. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private async fetchWithProgress(url: string): Promise<any> {
    const r = await fetch(url);
    if (!r.ok) throw new Error(`${url} : HTTP ${r.status}`);
    if (!r.body) return r.json();
    const reader = r.body.getReader();
    const chunks: Uint8Array[] = [];
    let got = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      got += value.length;
      this.loadingMb = got / 1e6;
    }
    const all = new Uint8Array(got);
    let at = 0;
    for (const c of chunks) { all.set(c, at); at += c.length; }
    return JSON.parse(new TextDecoder().decode(all));
  }

  /** Load the AI summaries of a département (optional: the app works without them). */
  private loadSummaries(dep: string) {
    if (this.summaryDeps[dep]) return;
    this.summaryDeps = { ...this.summaryDeps, [dep]: 'loading' };
    fetch(`./data/summaries/${dep}.json`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (d?.summaries) {
          this.summaries = { ...this.summaries, ...d.summaries };
          this.summaryMeta ??= { model: d.model, generated: d.generated };
        }
      })
      .catch(() => undefined)
      .finally(() => (this.summaryDeps = { ...this.summaryDeps, [dep]: 'done' }));
  }

  willUpdate() {
    // Fetch the summaries of the opened commune's département (from a click or a shared link).
    if (!this.selected || !this.raw.length) return;
    const row = this.raw.find((x) => x.code === this.selected);
    if (row) this.loadSummaries(row.dep as string);
  }

  private applyUrl(hash: string) {
    const s = decode(hash);
    this.strategy = s.strategy;
    this.type = s.type;
    this.filters = s.filters;
    this.signals = s.signals;
    this.selected = s.selected;
    this.scopes = s.scopes ?? [];
    this.finance = decodeFinance(s.finance ?? null);
    this.custom = s.custom ?? [];
    this.columns = defaultColumns(s.strategy);
  }

  private pushUrl() {
    const h = encode({
      strategy: this.strategy, type: this.type, filters: this.filters, signals: this.signals, selected: this.selected, scopes: this.scopes, finance: encodeFinance(this.finance), custom: this.custom,
    });
    history.replaceState(null, '', `#${h}`);
  }

  private setStrategy(id: StrategyId) {
    const p = preset(id);
    this.strategy = id;
    this.type = p.type;
    this.filters = p.filters;
    this.signals = p.signals;
    this.sort = null;
    this.columns = defaultColumns(id);
    if (this.colorBy !== 'score' && !(this.colorBy in COLUMNS)) this.colorBy = 'score';
    this.pushUrl();
  }

  private get dark(): boolean {
    return this.theme === 'dark' || (this.theme === 'auto' && this.systemDark);
  }

  private setTheme(t: 'auto' | 'light' | 'dark') {
    this.theme = t;
    localStorage.setItem('lsfr-theme', t);
  }

  private headerObs?: ResizeObserver;

  firstUpdated() {
    // The header wraps onto two lines on narrow windows: expose its real height
    // so the expanded map and the side panel start right below it.
    const h = this.renderRoot.querySelector('header');
    if (h) {
      this.headerObs = new ResizeObserver(() => this.style.setProperty('--header-h', `${h.getBoundingClientRect().height}px`));
      this.headerObs.observe(h);
    }
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    this.headerObs?.disconnect();
    document.documentElement.style.overflow = '';
  }

  updated() {
    const d = this.dark;
    this.dataset.theme = d ? 'dark' : 'light';
    document.documentElement.style.colorScheme = d ? 'dark' : 'light';
    document.documentElement.style.background = d ? '#0f1714' : '#f2f4f1';
  }

  /** Fill colour for every commune, given the "Colorer par" choice. Communes outside the chosen départements are hidden. */
  private mapPaint(results: Scored[]): { paint: Map<string, Paint>; scale: Scale | null } {
    const paint = new Map<string, Paint>();
    const grey = this.dark ? '#5b6862' : TIER_COLORS.fail;
    const hideOthers = this.scopes.length > 0;
    for (const r of this.raw) paint.set(r.code, { color: grey, strong: false, hidden: hideOthers });
    if (this.colorBy === 'score') {
      for (const r of results) {
        const on = r.pass && !!r.tier;
        paint.set(r.row.code, { color: on ? TIER_COLORS[r.tier!] : grey, strong: on });
      }
      return { paint, scale: null };
    }
    const c = this.colorBy;
    const pool = results.filter((r) => !this.greyFailing || r.pass);
    const scale = makeScale(c, pool.map((r) => num(r.row[c])).filter((x): x is number => x !== null));
    for (const r of results) {
      const v = num(r.row[c]);
      const shown = (!this.greyFailing || r.pass) && v !== null && scale;
      paint.set(r.row.code, { color: shown ? scale!.color(v!) : grey, strong: !!shown });
    }
    return { paint, scale };
  }

  private setType(t: PropertyType) {
    this.type = t;
    this.pushUrl();
  }

  private updateFilter(id: string, patch: Partial<FilterDef>) {
    this.filters = this.filters.map((f) => (f.id === id ? { ...f, ...patch } : f));
    this.pushUrl();
  }

  /** Add or replace a free-form filter (one per column and operator). */
  addCustom(column: string, op: FilterDef['op'], value?: number) {
    const f = customFilter(column, op, value);
    this.custom = [...this.custom.filter((x) => x.id !== f.id), f];
    this.shown = PAGE;
    this.pushUrl();
  }

  removeCustom(id: string) {
    this.custom = this.custom.filter((x) => x.id !== id);
    this.pushUrl();
  }

  /** Bridge for the assistant: it only ever goes through these two functions. */
  private chatHost: ChatHost = {
    applyPlan: (plan: Plan) => this.applyPlan(plan),
    facts: () => this.chatFacts(),
  };

  private applyPlan(plan: Plan): { applied: string[]; dropped: string[] } {
    const applied: string[] = [];
    if (plan.strategy && plan.strategy !== this.strategy) {
      this.setStrategy(plan.strategy);
      applied.push(STRATEGIES.find((s) => s.id === plan.strategy)!.label);
    }
    const dropped: string[] = [];
    if (plan.departements) {
      const codes: string[] = [];
      for (const d of plan.departements) {
        const q = fold(d.trim());
        const code = /^(\d{2}|2[ab])$/i.test(q) ? q.toUpperCase()
          : Object.entries(this.depNames).find(([, n]) => fold(n) === q)?.[0];
        if (code && code in this.depNames) codes.push(code); else dropped.push(d);
      }
      if (codes.length || !plan.departements.length) {
        this.setScopes(codes);
        applied.push(codes.length ? this.scopeLabel : 'Toute la France');
      }
    }
    if (plan.reset_filters) this.custom = [];
    const { filters, dropped: badCols } = planFilters(plan);
    dropped.push(...badCols);
    if (filters.length) {
      const ids = new Set(filters.map((f) => f.id));
      this.custom = [...this.custom.filter((x) => !ids.has(x.id)), ...filters];
      applied.push(...filters.map((f) => this.filterChip(f)));
    }
    if (plan.color_by && plan.color_by in COLUMNS && !['bool', 'text'].includes(COLUMNS[plan.color_by].unit)) {
      this.colorBy = plan.color_by;
      applied.push(`Carte : ${COLUMNS[plan.color_by].label}`);
    }
    if (plan.forest_layer !== null || plan.relief_layer !== null) {
      this.overlays = { forest: plan.forest_layer ?? this.overlays.forest, relief: plan.relief_layer ?? this.overlays.relief };
      if (plan.forest_layer !== null) applied.push(plan.forest_layer ? 'Forêts affichées' : 'Forêts masquées');
      if (plan.relief_layer !== null) applied.push(plan.relief_layer ? 'Relief affiché' : 'Relief masqué');
    }
    this.showFailing = false;
    this.sort = null;
    this.shown = PAGE;
    this.pushUrl();
    return { applied, dropped };
  }

  /** The best communes now shown, with the values the user filtered on, as compact text for the model. */
  private chatFacts(): { count: number; text: string } {
    const passing = this.results.filter((r) => r.pass).sort(compareScore);
    const cols = [...new Set([...this.custom.map((f) => f.column), 'pop', 'town3000_name', 'town3000_km', 'price_m2', 'risk_count'])]
      .filter((c) => c in COLUMNS).slice(0, 12);
    const lines = passing.slice(0, 8).map((r) => {
      const dep = this.depNames[r.row.dep as string] ?? r.row.dep;
      const vals = cols.map((c) => `${COLUMNS[c].label} ${fmt(c, r.row[c])}`).join(' ; ');
      return `- ${r.row.nom} (${dep}) : ${vals}`;
    });
    return { count: passing.length, text: `${passing.length} communes au total.\n${lines.join('\n')}` };
  }

  private updateSignal(id: string, weight: number) {
    this.signals = this.signals.map((s) => (s.id === id ? { ...s, weight } : s));
    this.pushUrl();
  }

  private select(code: string | null, fly = false) {
    this.selected = code;
    this.pushUrl();
    if (fly && code) {
      const r = this.raw.find((x) => x.code === code);
      if (r) this.mapView?.flyTo(r.lon as number, r.lat as number);
    }
  }

  // ------------------------------------------------------------ derived
  // 35 000 communes: derive/evaluate are cached and only recomputed when their inputs change.
  private _rows?: { raw: Row[]; type: PropertyType; finance: Finance; out: Row[] };
  private _res?: { rows: Row[]; scope: string; filters: FilterDef[]; custom: FilterDef[]; signals: SignalDef[]; out: Scored[] };

  private get rows(): Row[] {
    const c = this._rows;
    if (c && c.raw === this.raw && c.type === this.type && c.finance === this.finance) return c.out;
    const out = withFinance(derive(this.raw, this.type), this.type, this.finance);
    this._rows = { raw: this.raw, type: this.type, finance: this.finance, out };
    return out;
  }

  /** Scores are computed among the communes of the chosen zone (all of France or one département). */
  private get results(): Scored[] {
    const rows = this.rows;
    const c = this._res;
    const key = this.scopes.join(',');
    if (c && c.rows === rows && c.scope === key && c.filters === this.filters && c.custom === this.custom && c.signals === this.signals) return c.out;
    const set = new Set(this.scopes);
    const inScope = set.size ? rows.filter((r) => set.has(r.dep as string)) : rows;
    const out = evaluate(inScope, [...this.filters, ...this.custom], this.signals);
    this._res = { rows, scope: key, filters: this.filters, custom: this.custom, signals: this.signals, out };
    return out;
  }

  private setScopes(codes: string[]) {
    this.scopes = [...new Set(codes)].sort();
    this.shown = PAGE;
    if (this.selected && this.scopes.length && !this.scopes.some((d) => this.selected!.startsWith(d))) this.selected = null;
    this.pushUrl();
  }

  private _zoom?: { scope: string; dep: unknown; out: Bounds | null };

  /** Bounds of the chosen départements (cached: a new array each render would re-zoom the map). */
  private get zoomTo(): Bounds | null {
    const key = this.scopes.join(',');
    if (this._zoom && this._zoom.scope === key && this._zoom.dep === this.departements) return this._zoom.out;
    const feats = this.departements?.features.filter((x) => this.scopes.includes(x.properties?.code)) ?? [];
    let out: Bounds | null = null;
    for (const f of feats) {
      const b = featureBounds(f);
      out = out ? [[Math.min(out[0][0], b[0][0]), Math.min(out[0][1], b[0][1])], [Math.max(out[1][0], b[1][0]), Math.max(out[1][1], b[1][1])]] : b;
    }
    this._zoom = { scope: key, dep: this.departements, out };
    return out;
  }

  /** "Gironde (33)", "Gironde, Landes" or "4 départements" — for labels and the CSV. */
  private get scopeLabel(): string {
    const s = this.scopes;
    if (!s.length) return 'Toute la France';
    if (s.length === 1) return `${this.depNames[s[0]] ?? s[0]} (${s[0]})`;
    if (s.length <= 3) return s.map((d) => this.depNames[d] ?? d).join(', ');
    return `${s.length} départements`;
  }

  private sorted(results: Scored[]): Scored[] {
    let list = this.showFailing ? [...results] : results.filter((r) => r.pass);
    if (this.search.trim()) {
      const q = fold(this.search.trim());
      list = list.filter((r) => fold(r.row.nom).includes(q) || r.row.code.startsWith(q));
    }
    const s = this.sort;
    if (!s) {
      return list.sort((a, b) => (a.pass === b.pass ? compareScore(a, b) : a.pass ? -1 : 1));
    }
    return list.sort((a, b) => {
      const va = a.row[s.column];
      const vb = b.row[s.column];
      if (va === null || va === undefined) return 1;
      if (vb === null || vb === undefined) return -1;
      if (typeof va === 'number' && typeof vb === 'number') return (va - vb) * s.dir;
      return String(va).localeCompare(String(vb), 'fr') * s.dir;
    });
  }

  private toggleSort(column: string) {
    const s = this.sort;
    this.sort = !s || s.column !== column ? { column, dir: -1 } : s.dir === -1 ? { column, dir: 1 } : null;
  }

  private exportCsv(list: Scored[]) {
    const cols = ['code', 'nom', ...this.tableColumns, 'score', 'tier'];
    const head = cols.map((c) => (c === 'code' ? 'Code INSEE' : c === 'score' ? 'Score' : c === 'tier' ? 'Groupe' : COLUMNS[c]?.label ?? c));
    const lines = [head.map((h) => csvValue(h)).join(CSV_SEP)];
    for (const r of list) {
      lines.push(cols.map((c) => (c === 'score' ? csvValue(r.score) : c === 'tier' ? csvValue(r.tier) : csvValue(r.row[c]))).join(CSV_SEP));
    }
    const st = STRATEGIES.find((s) => s.id === this.strategy)!;
    const zone = this.scopes.length ? this.scopeLabel : 'France métropolitaine';
    lines.push(`# Land Screener FR · ${zone} · ${st.label} · données du ${this.meta?.built ?? ''} · sources : DVF (DGFiP), Estimations ANIL à partir des données du Groupe SeLoger et de leboncoin, INSEE, Géorisques, DGFiP REI, VigiEau`);
    const blob = new Blob(['\ufeff' + lines.join('\n')], { type: 'text/csv;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `land-screener-${this.scopes.join('-') || 'france'}-${this.strategy}.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
  }

  private async share() {
    this.pushUrl();
    try {
      await navigator.clipboard.writeText(location.href);
      this.copied = true;
      setTimeout(() => (this.copied = false), 1500);
    } catch {
      /* clipboard denied: the address bar still holds the link */
    }
  }

  private get tableColumns(): string[] {
    return this.columns.length ? this.columns : defaultColumns(this.strategy);
  }

  private toggleColumn(c: string, on: boolean) {
    const cur = this.tableColumns.filter((x) => x !== c);
    // Keep the order of the side-panel sections so the table stays readable.
    this.columns = on ? ALL_TABLE_COLUMNS.filter((x) => x === c || cur.includes(x)) : cur;
  }

  /** Short human text for an active filter, e.g. "Rendement brut ≥ 5 %". */
  private filterChip(f: FilterDef): string {
    const col = COLUMNS[f.column]?.label ?? f.column;
    if (f.id === 'landdata') return 'Avec ventes de terrains';
    if (f.op === 'isFalse') return `Sans : ${col.toLowerCase()}`;
    if (f.op === 'isTrue') return col;
    const v = fmt(f.column, f.value ?? null);
    return `${col} ${f.op === 'min' ? '≥' : '≤'} ${v === 'sur place' ? '0 km' : v}`;
  }

  // ------------------------------------------------------------ render
  render() {
    if (this.error) return html`<p class="error" role="alert">${this.error}</p>`;
    const results = this.results;
    const passing = results.filter((r) => r.pass);
    const list = this.sorted(results);
    const st = STRATEGIES.find((s) => s.id === this.strategy)!;
    const sel = this.selected ? results.find((r) => r.row.code === this.selected) : undefined;
    const active = this.filters.filter((f) => f.enabled);

    return html`
      <header>
        <div class="brand">
          <svg viewBox="0 0 32 32" aria-hidden="true"><path d="M3 25 L12 12 L17 19 L21 14 L29 25 Z" fill="#9be3b5"/><circle cx="23" cy="8" r="3" fill="#f4d35e"/></svg>
          <span><b>Land Screener</b><small>France métropolitaine · données ouvertes</small></span>
        </div>
        <nav class="tabs" role="tablist" aria-label="Stratégie d’investissement">
          ${STRATEGIES.map((s) => html`
            <button role="tab" aria-selected=${s.id === this.strategy} class=${s.id === this.strategy ? 'on' : ''}
              @click=${() => this.setStrategy(s.id)}>${s.label}</button>`)}
        </nav>
        <span class="grow"></span>
        <div class="themes" role="radiogroup" aria-label="Thème">
          ${([['auto', 'Auto', 'Suivre le réglage du système'], ['light', '☀', 'Thème clair'], ['dark', '☾', 'Thème sombre']] as const).map(([t, l, title]) => html`
            <button role="radio" aria-checked=${this.theme === t} class=${this.theme === t ? 'on' : ''} title=${title} aria-label=${title}
              @click=${() => this.setTheme(t)}>${l}</button>`)}
        </div>
      </header>

      <div class="layout ${sel ? 'has-detail' : ''}">
        <main>
          <section class="summary" aria-label="Réglages actifs">
            <div class="summary-text">
              <p>${st.blurb}</p>
              <div class="chips">
                ${this.scopes.length ? html`<span class="chip strong">${this.scopeLabel}</span>` : nothing}
                ${this.strategy !== 'land' ? html`
                  <div class="seg" role="radiogroup" aria-label="Type de bien">
                    ${(['house', 'apt'] as PropertyType[]).map((t) => html`
                      <button role="radio" aria-checked=${this.type === t} class=${this.type === t ? 'on' : ''} @click=${() => this.setType(t)}>
                        ${t === 'house' ? 'Maison' : 'Appartement'}</button>`)}
                  </div>${tip('Type de bien', HELP.type)}` : nothing}
                ${active.map((f) => html`<span class="chip">${this.filterChip(f)}</span>`)}
                ${this.custom.map((f) => html`<span class="chip custom" title="Filtre ajouté">${this.filterChip(f)}<button aria-label="Retirer le filtre ${this.filterChip(f)}" @click=${() => this.removeCustom(f.id)}>×</button></span>`)}
              </div>
            </div>
            <button class="btn primary" @click=${() => (this.settingsOpen = true)} aria-haspopup="dialog">
              <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M3 5h9M16 5h1M3 10h2M9 10h8M3 15h7M14 15h3" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><circle cx="14" cy="5" r="2" fill="none" stroke="currentColor" stroke-width="2"/><circle cx="7" cy="10" r="2" fill="none" stroke="currentColor" stroke-width="2"/><circle cx="12" cy="15" r="2" fill="none" stroke="currentColor" stroke-width="2"/></svg>
              Filtres et poids
            </button>
          </section>

          ${this.renderStats(passing, results.length)}

          ${this.renderMap(results)}

          <div class="tablebar">
            <h2>Classement</h2>
            <label class="switchlabel"><input class="switch" type="checkbox" .checked=${this.showFailing}
              @change=${(e: Event) => (this.showFailing = (e.target as HTMLInputElement).checked)}> Afficher les communes éliminées</label>
            ${tip('Communes éliminées', HELP.failing)}
            <input class="search" type="search" placeholder="Rechercher une commune…" aria-label="Rechercher une commune"
              .value=${this.search} @input=${(e: Event) => { this.search = (e.target as HTMLInputElement).value; this.shown = PAGE; }}
              @change=${(e: Event) => { this.search = (e.target as HTMLInputElement).value; this.shown = PAGE; }}>
            <span class="grow"></span>
            <button class="btn" @click=${() => this.share()}>${this.copied ? 'Lien copié ✓' : 'Copier le lien'}</button>
            ${this.renderColumnPicker()}
            <button class="btn" @click=${() => this.exportCsv(list)}>Exporter CSV · ${list.length}</button>
          </div>
          ${this.renderTable(list)}
          ${this.renderFooter()}
        </main>
        ${sel ? this.renderDetail(sel) : nothing}
      </div>

      ${this.settingsOpen ? this.renderSettings(results, st.label) : nothing}
      ${this.raw.length ? html`<ai-chat .host=${this.chatHost}></ai-chat>` : nothing}
      ${this.loadingMb !== null ? html`
        <div class="loading" role="status" aria-live="polite">
          <span class="spinner" aria-hidden="true"></span>
          <div>
            <b>Chargement des données des communes…</b>
            <small>${this.loadingMb > 0.05 ? `${this.loadingMb.toLocaleString('fr-FR', { maximumFractionDigits: 0 })} Mo sur environ 30 Mo reçus` : 'Connexion…'}
              · quelques secondes sur une bonne connexion</small>
            <progress max="30" value=${Math.min(30, this.loadingMb)}></progress>
          </div>
        </div>` : nothing}
    `;
  }

  private renderSettings(results: Scored[], label: string) {
    return html`
      <div class="backdrop" @click=${() => (this.settingsOpen = false)}></div>
      <aside class="drawer" role="dialog" aria-modal="true" aria-label="Filtres et poids">
        <div class="drawer-head">
          <div><small>Réglages</small><h2>${label}</h2></div>
          <button class="close" aria-label="Fermer les réglages" @click=${() => (this.settingsOpen = false)}>×</button>
        </div>
        <div class="drawer-body">
          <h3>Filtres <small>retenue / éliminée</small> ${tip('Filtres', HELP.filters)}</h3>
          ${this.filters.map((f) => this.renderFilter(f, results))}
          ${this.renderFinanceInputs()}
          <h3>Poids <small>ordre seulement</small> ${tip('Poids', HELP.weights)}</h3>
          ${this.signals.map((s) => {
            const info = SIGNALS[s.id] ?? { label: s.id, help: '' };
            return html`
              <div class="weight">
                <span>${info.label}${tip(info.label, `${info.help}\n\n${columnHelp(s.column)}`)}</span>
                <input type="range" min="0" max="5" step="1" .value=${String(s.weight)}
                  style="--p:${s.weight * 20}%" aria-label="Poids : ${info.label}"
                  @input=${(e: Event) => this.updateSignal(s.id, Number((e.target as HTMLInputElement).value))}>
                <output>${s.weight}</output>
              </div>`;
          })}
        </div>
        <div class="drawer-foot">
          <button class="btn" @click=${() => this.setStrategy(this.strategy)}>Réglages par défaut</button>
          <button class="btn primary" @click=${() => (this.settingsOpen = false)}>Voir les ${results.filter((r) => r.pass).length} communes</button>
        </div>
      </aside>`;
  }

  private renderFilter(f: FilterDef, results: Scored[]) {
    const failing = results.filter((r) => r.failed.includes(f.id)).length;
    const info = FILTERS[f.id] ?? { label: f.id, help: '' };
    const unit = COLUMNS[f.column]?.unit;
    const isPct = unit === 'pct';
    const shown = f.value === undefined ? undefined : isPct ? Math.round(f.value * 1000) / 10 : f.value;
    const help = [info.help, missingDataNote(f), columnHelp(f.column)].filter(Boolean).join('\n\n');
    return html`
      <div class="filter ${f.enabled ? '' : 'off'}">
        <label class="ftitle">
          <input class="switch" type="checkbox" .checked=${f.enabled} @change=${(e: Event) => this.updateFilter(f.id, { enabled: (e.target as HTMLInputElement).checked })}>
          <span>${info.label}</span>
        </label>
        ${tip(info.label, help)}
        ${(f.op === 'min' || f.op === 'max') && f.id !== 'landdata' ? html`
          <span class="fval">
            <input type="number" step=${isPct ? '0.5' : 'any'} .value=${String(shown ?? '')} ?disabled=${!f.enabled}
              aria-label=${info.label}
              @change=${(e: Event) => {
                const v = Number((e.target as HTMLInputElement).value);
                if (Number.isFinite(v)) this.updateFilter(f.id, { value: isPct ? v / 100 : v });
              }}>${isPct ? html`<i>%</i>` : nothing}
          </span>` : html`<span></span>`}
        <span class="fcount" title="Communes éliminées par ce filtre">${f.enabled && failing ? `−${failing}` : ''}</span>
      </div>`;
  }

  private renderStats(passing: Scored[], total: number) {
    const med = (col: string) => {
      const v = passing.map((r) => num(r.row[col])).filter((x): x is number => x !== null).sort((a, b) => a - b);
      return v.length ? v[Math.floor(v.length / 2)] : null;
    };
    const priceCol = this.strategy === 'land' ? 'land_price_m2' : 'price_m2';
    const card = (value: unknown, label: string, help: string) => html`
      <div class="stat"><span class="label">${label}${tip(label, help)}</span><b>${value}</b></div>`;
    const extra = this.strategy === 'live'
      ? card(val('apl_gp', med('apl_gp')), 'accès médecins médian', `${HELP.median}\n\n${columnHelp('apl_gp')}`)
      : this.strategy !== 'land'
        ? card(val('gross_yield', med('gross_yield')), 'rendement brut médian', `${HELP.median}\n\n${columnHelp('gross_yield')}`)
        : nothing;
    return html`
      <section class="stats" aria-label="Résumé">
        ${card(html`${passing.length}<small> / ${total}</small>`, 'communes retenues', HELP.passing)}
        ${card(fmt(priceCol, med(priceCol)), `${COLUMNS[priceCol].label} médian`, `${HELP.median}\n\n${columnHelp(priceCol)}`)}
        ${extra}
        ${card(val('pop_cagr_11y', med('pop_cagr_11y')), 'croissance pop./an médiane', `${HELP.median}\n\n${columnHelp('pop_cagr_11y')}`)}
      </section>`;
  }

  private renderMap(results: Scored[]) {
    const { paint, scale } = this.mapPaint(results);
    const label = this.colorBy === 'score' ? 'Score global' : COLUMNS[this.colorBy]?.label ?? this.colorBy;
    return html`
      <div class="card mapcard ${this.mapFull ? 'full' : ''}" role=${this.mapFull ? 'region' : nothing} aria-label=${this.mapFull ? 'Carte en grand' : nothing}>
        <div class="maptools">
          ${this.renderDepPicker()}
          <label class="select">
            <span>Colorer par</span>
            <select aria-label="Colorer la carte par" @change=${(e: Event) => (this.colorBy = (e.target as HTMLSelectElement).value)}>
              <option value="score" ?selected=${this.colorBy === 'score'}>Score global (groupes A à E)</option>
              ${COLOR_GROUPS.map((g) => html`<optgroup label=${g.title}>
                ${g.columns.map((c) => html`<option value=${c} ?selected=${this.colorBy === c}>${COLUMNS[c].label}</option>`)}
              </optgroup>`)}
            </select>
          </label>
          ${this.colorBy !== 'score' ? html`${colTip(this.colorBy)}
            <label class="switchlabel"><input class="switch" type="checkbox" .checked=${this.greyFailing}
              @change=${(e: Event) => (this.greyFailing = (e.target as HTMLInputElement).checked)}> Griser les communes éliminées</label>` : nothing}
          <div class="seg" role="group" aria-label="Fonds de carte">
            ${([['forest', 'Forêts', 'Afficher les forêts (IGN, masque forêt 2021–2023). Visible à partir du zoom régional.'],
                ['relief', 'Relief', 'Afficher le relief ombré (IGN, estompage)']] as const).map(([k, l, title]) => html`
              <button aria-pressed=${this.overlays[k] ? 'true' : 'false'} class=${this.overlays[k] ? 'on' : ''} title=${title}
                @click=${() => (this.overlays = { ...this.overlays, [k]: !this.overlays[k] })}>${l}</button>`)}
          </div>${tip('Forêts et relief', HELP.overlays)}
          <span class="grow"></span>
          <span class="hint">Cliquez une commune pour son détail</span>
          <button class="btn icon" @click=${() => this.setMapFull(!this.mapFull)}
            aria-pressed=${this.mapFull ? 'true' : 'false'} title=${this.mapFull ? 'Réduire la carte (Échap)' : 'Agrandir la carte'}>
            ${this.mapFull
              ? html`<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M8 3v5H3M12 3v5h5M8 17v-5H3M12 17v-5h5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg> Réduire`
              : html`<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M3 8V3h5M17 8V3h-5M3 12v5h5M17 12v5h-5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg> Agrandir`}
          </button>
        </div>
        <div class="mapwrap">
          <map-view .tiles=${'./data/communes.pmtiles'} .departements=${this.departements} .zoomTo=${this.zoomTo}
            .paint=${paint} .selected=${this.selected} .dark=${this.dark} .overlays=${this.overlays}
            @select=${(e: CustomEvent<string>) => this.select(e.detail)}></map-view>
          ${this.renderScale(label, scale)}
        </div>
      </div>`;
  }

  /** Multi-select of départements: map, table, scores and medians are restricted to them. */
  private renderDepPicker() {
    const q = fold(this.depQuery.trim());
    const all = Object.entries(this.depNames).sort(([a], [b]) => a.localeCompare(b));
    const shown = q ? all.filter(([c, n]) => c.toLowerCase().startsWith(q) || fold(n).includes(q)) : all;
    const sel = new Set(this.scopes);
    const toggle = (c: string, on: boolean) => this.setScopes(on ? [...this.scopes, c] : this.scopes.filter((x) => x !== c));
    return html`
      <details class="deppicker">
        <summary class="btn ${sel.size ? 'active' : ''}" aria-label="Filtrer par département">
          <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M10 18s6-5.2 6-10A6 6 0 0 0 4 8c0 4.8 6 10 6 10z" fill="none" stroke="currentColor" stroke-width="2"/><circle cx="10" cy="8" r="2" fill="currentColor"/></svg>
          ${this.scopeLabel}
          ${sel.size ? html`<span class="count">${sel.size}</span>` : nothing}
        </summary>
        <div class="depmenu" role="group" aria-label="Départements">
          <div class="depmenu-head">
            <input class="search" type="search" placeholder="Code ou nom…" aria-label="Chercher un département"
              .value=${this.depQuery} @input=${(e: Event) => (this.depQuery = (e.target as HTMLInputElement).value)}>
            <button class="link" ?disabled=${!sel.size} @click=${() => this.setScopes([])}>Toute la France</button>
            ${tip('Départements', HELP.scope)}
          </div>
          ${sel.size ? html`<div class="depchips">${this.scopes.map((c) => html`
            <button class="chip removable" @click=${() => toggle(c, false)} aria-label="Retirer ${this.depNames[c] ?? c}">${c} · ${this.depNames[c] ?? c} ×</button>`)}</div>` : nothing}
          <div class="deplist">
            ${shown.map(([c, n]) => html`
              <label><input type="checkbox" .checked=${sel.has(c)} @change=${(e: Event) => toggle(c, (e.target as HTMLInputElement).checked)}>
                <span class="code">${c}</span> ${n}</label>`)}
            ${shown.length ? nothing : html`<p class="empty">Aucun département ne correspond.</p>`}
          </div>
        </div>
      </details>`;
  }

  /** Colour key on the right of the map. */
  private renderScale(label: string, scale: Scale | null) {
    if (this.colorBy === 'score') {
      return html`
        <div class="key" aria-label="Légende : ${label}">
          <b>${label}${tip('Groupes A à E', HELP.tier)}</b>
          ${(['A', 'B', 'C', 'D', 'E'] as const).map((t, i) => html`
            <div class="tierrow"><span style="background:${TIER_COLORS[t]};color:${TIER_TEXT[t]}">${t}</span>
              <small>${['20 % meilleures', '', 'moyennes', '', '20 % dernières'][i]}</small></div>`)}
          <div class="tierrow"><span class="na"></span><small>éliminée</small></div>
        </div>`;
    }
    if (!scale) return html`<div class="key"><b>${label}</b><small>aucune donnée</small></div>`;
    const c = this.colorBy;
    const mid = (scale.min + scale.max) / 2;
    return html`
      <div class="key" aria-label="Légende : ${label}">
        <b>${label}</b>
        <div class="gradient">
          <div class="bar" style="background:linear-gradient(to top, ${scale.stops.join(', ')})"></div>
          <div class="ticks">
            <span>${fmt(c, scale.max)}${scale.neutral ? '' : scale.lowIsGood ? html` <em class="bad">pire</em>` : html` <em class="good">mieux</em>`}</span>
            <span>${fmt(c, mid)}</span>
            <span>${fmt(c, scale.min)}${scale.neutral ? '' : scale.lowIsGood ? html` <em class="good">mieux</em>` : html` <em class="bad">pire</em>`}</span>
          </div>
        </div>
        <div class="tierrow"><span class="na"></span><small>${this.greyFailing ? 'éliminée ou n.d.' : 'n.d.'}</small></div>
        <small class="keynote">Échelle du 5e au 95e centile${this.greyFailing ? ' des communes retenues' : ''}</small>
      </div>`;
  }

  private renderColumnPicker() {
    const cols = this.tableColumns;
    return html`
      <details class="colpicker">
        <summary class="btn">Colonnes · ${cols.length}</summary>
        <div class="colmenu" role="group" aria-label="Colonnes du tableau">
          <div class="colmenu-head">
            <b>Colonnes affichées</b>
            <button class="link" @click=${() => (this.columns = defaultColumns(this.strategy))}>Par défaut</button>
          </div>
          ${DETAIL_GROUPS.map((g) => html`
            <fieldset><legend>${g.title}</legend>
              ${g.columns.filter((c) => c in COLUMNS).map((c) => html`
                <label><input type="checkbox" .checked=${cols.includes(c)}
                  @change=${(e: Event) => this.toggleColumn(c, (e.target as HTMLInputElement).checked)}> ${COLUMNS[c].label}</label>`)}
            </fieldset>`)}
        </div>
      </details>`;
  }

  private tierBadge(r: Scored) {
    const t = r.pass && r.tier ? r.tier : 'fail';
    return html`<span class="tier" style="background:${TIER_COLORS[t]};color:${TIER_TEXT[t]}">${r.pass ? r.tier : '–'}</span>`;
  }

  private renderTable(list: Scored[]) {
    const cols = this.tableColumns;
    const arrow = (c: string) => (this.sort?.column === c ? (this.sort.dir === -1 ? ' ↓' : ' ↑') : '');
    const header = (c: string, label: string) => html`
      <th scope="col" aria-sort=${this.sort?.column === c ? (this.sort.dir === -1 ? 'descending' : 'ascending') : 'none'}>
        <span class="th"><button @click=${() => this.toggleSort(c)}>${label}${arrow(c)}</button>${colTip(c)}</span>
      </th>`;
    const rank = this.ranks;
    const page = list.slice(0, this.shown);
    return html`
      <div class="card tablewrap">
        <table>
          <thead><tr>
            <th scope="col" class="num"><span class="th">#</span></th>
            ${header('nom', 'Commune')}
            <th scope="col"><span class="th"><button @click=${() => (this.sort = null)}>Score${this.sort ? '' : ' ↓'}</button>${tip('Score', HELP.score)}</span></th>
            ${cols.map((c) => header(c, COLUMNS[c]?.label ?? c))}
          </tr></thead>
          <tbody>
            ${page.map((r) => html`
              <tr class=${`${r.pass ? '' : 'failrow'} ${r.row.code === this.selected ? 'sel' : ''}`}
                @click=${() => this.select(r.row.code, true)}>
                <td class="num">${r.pass ? rank.get(r.row.code) : ''}</td>
                <td class="name">${this.tierBadge(r)}<span>${r.row.nom}${this.scopes.length !== 1 ? html` <small class="dep">${r.row.dep}</small>` : nothing}</span></td>
                <td>${r.pass
                  ? html`<span class="score"><span class="bar"><i style="width:${r.score}%"></i></span><b>${fmt('score', r.score)}</b></span>`
                  : html`<span class="out" title=${`Ne passe pas : ${r.failed.map((f) => FILTERS[f]?.label ?? f).join(', ')}`}>éliminée</span>`}</td>
                ${cols.map((c) => html`<td>${val(c, r.row[c])}</td>`)}
              </tr>`)}
          </tbody>
        </table>
        ${list.length > page.length ? html`
          <div class="more">
            <span>${page.length} sur ${fmt('pop', list.length)} communes affichées</span>
            <button class="btn" @click=${() => (this.shown += PAGE)}>Afficher ${Math.min(PAGE, list.length - page.length)} de plus</button>
            <button class="link" @click=${() => (this.shown = list.length)}>Tout afficher</button>
          </div>` : nothing}
      </div>`;
  }

  private _ranks?: { res: Scored[]; out: Map<string, number> };

  /** Rank (1 = best score) of each passing commune, independent of table sort and search. */
  private get ranks(): Map<string, number> {
    const res = this.results;
    if (this._ranks?.res === res) return this._ranks.out;
    const out = new Map<string, number>();
    res.filter((r) => r.pass).sort(compareScore).forEach((r, i) => out.set(r.row.code, i + 1));
    this._ranks = { res, out };
    return out;
  }

  /** Strongest good and bad signals of a commune, across all panel columns. */
  private highlights(row: Row): { good: string[]; bad: string[] } {
    const good: string[] = [];
    const bad: string[] = [];
    const seen = new Set<string>();
    for (const g of DETAIL_GROUPS) {
      for (const c of g.columns) {
        if (seen.has(c) || !(c in COLUMNS)) continue;
        seen.add(c);
        const j: Verdict | null = judge(c, row[c]);
        // Strengths: keep the summary line, not each nearby service or each variant of an indicator.
        const detailOnly = c.startsWith('dist_') || c === 'apl_gp_65' || c === 'clay_med_high_share' || c === 'n_sales';
        if (j === 'good' && !detailOnly) good.push(c);
        else if (j === 'bad' || j === 'warn') bad.push(c);
      }
    }
    return { good, bad };
  }

  private renderDetail(r: Scored) {
    const row = r.row;
    const hl = this.highlights(row);
    const t = r.pass && r.tier ? r.tier : 'fail';
    return html`
      <aside class="sidenav" aria-label="Détails : ${row.nom}">
        <div class="sn-head">
          <div class="sn-title">
            <span class="tier big" style="background:${TIER_COLORS[t]};color:${TIER_TEXT[t]}">${r.pass ? r.tier : '–'}</span>
            <div>
              <h3>${row.nom}</h3>
              <small>${fmt('pop', row.pop)} habitants · ${row.aav_category ?? ''}</small>
            </div>
          </div>
          <button class="close" aria-label="Fermer le panneau" title="Fermer (Échap)" @click=${() => this.select(null)}>×</button>
        </div>
        <div class="sn-body">
          ${r.pass
            ? html`<div class="sn-score">
                <div><span class="label">Score ${tip('Score', HELP.score)}</span><b>${fmt('score', r.score)}</b><small>/100</small></div>
                <div><span class="label">Groupe ${tip('Groupe', HELP.tier)}</span><b>${r.tier}</b></div>
              </div>`
            : html`<p class="failbox">Éliminée par : ${r.failed.map((f) => FILTERS[f]?.label ?? this.filterChip([...this.custom].find((c) => c.id === f) ?? { id: f, column: f, op: 'min', enabled: true })).join(', ')}</p>`}

          ${this.summaries[row.code] ? html`
            <section class="ai" aria-label="Résumé IA">
              <div class="ai-head"><span class="ai-badge">✦ Résumé IA</span>${tip('Résumé IA', `Paragraphe rédigé automatiquement par un modèle d’IA (${this.summaryMeta?.model.replace(/^us\./, '') ?? ''}, via Amazon Bedrock) à partir des seules données de cette page, le ${this.summaryMeta ? new Date(this.summaryMeta.generated).toLocaleDateString('fr-FR') : ''}.\n\nIl résume la commune en général, puis explique pour quels projets l’outil la retient ou l’écarte avec les réglages par défaut de chaque stratégie (pas avec vos réglages personnalisés). Il peut contenir des erreurs : vérifiez les chiffres dans le détail ci-dessous.`)}</div>
              <p>${this.summaries[row.code]}</p>
            </section>`
          : this.summaryDeps[row.dep as string] === 'loading' ? html`
            <section class="ai" aria-label="Résumé IA" aria-busy="true">
              <div class="ai-head"><span class="ai-badge">✦ Résumé IA</span></div>
              <p class="muted"><span class="spinner small" aria-hidden="true"></span> Chargement du résumé…</p>
            </section>` : nothing}

          ${hl.good.length || hl.bad.length ? html`
            <div class="hl">
              ${hl.good.length ? html`<div class="hl-col good"><h4>Points forts</h4>
                <ul>${hl.good.map((c) => html`<li><span>${COLUMNS[c].label}</span><b>${fmt(c, row[c])}</b></li>`)}</ul></div>` : nothing}
              ${hl.bad.length ? html`<div class="hl-col bad"><h4>Points faibles</h4>
                <ul>${hl.bad.map((c) => html`<li class=${judge(c, row[c]) ?? ''}><span>${COLUMNS[c].label}</span><b>${fmt(c, row[c])}</b></li>`)}</ul></div>` : nothing}
            </div>` : nothing}

          ${r.pass ? html`
            <details open class="grp">
              <summary>Rang par critère ${tip('Rang par critère', HELP.parts)}</summary>
              <div class="parts">${this.signals.filter((s) => s.weight > 0).map((s) => {
                const p = r.parts[s.id];
                const pct = p === null || p === undefined ? null : Math.round(p * 100);
                const cls = pct === null ? '' : pct >= 66 ? 'good' : pct < 34 ? 'bad' : '';
                return html`<div><span>${SIGNALS[s.id]?.label ?? s.id}</span>
                  <span class="bar ${cls}"><i style="width:${pct ?? 0}%"></i></span>
                  <b>${pct === null ? 'n.d.' : pct}</b></div>`;
              })}</div>
            </details>` : nothing}

          ${this.detailWarnings(row)}
          ${this.renderSimulation(row)}
          ${this.renderHistory(row)}
          ${this.renderTourism(row)}

          ${DETAIL_GROUPS.map((g) => html`
            <details open class="grp">
              <summary>${g.title}${g.help ? tip(g.title, g.help) : nothing}</summary>
              <dl>${g.columns.filter((c) => c in COLUMNS).map((c) => html`
                <dt>${COLUMNS[c].label}${colTip(c)}</dt><dd>${val(c, row[c])}</dd>`)}</dl>
            </details>`)}
          <p class="code">Code INSEE ${row.code}</p>
        </div>
      </aside>`;
  }

  private setFinance(patch: Partial<Finance>) {
    this.finance = { ...this.finance, ...patch };
    this.pushUrl();
  }

  /** Purchase assumptions used for net yield and cash flow (drawer section). */
  private renderFinanceInputs() {
    const f = this.finance;
    const ref = REFERENCE_SURFACE[this.type];
    const field = (label: string, value: number, unit: string, step: string, set: (v: number) => void, help: string) => html`
      <label class="fin">
        <span>${label}${tip(label, help)}</span>
        <span class="fval"><input type="number" step=${step} min="0" .value=${String(value)}
          aria-label=${label} @change=${(e: Event) => {
            const v = Number((e.target as HTMLInputElement).value);
            if (Number.isFinite(v) && v >= 0) set(v);
          }}><i>${unit}</i></span>
      </label>`;
    const pct = (v: number) => Math.round(v * 1000) / 10;
    return html`
      <h3>Hypothèses d’achat <small>rendement net et cash-flow</small> ${tip('Hypothèses d’achat', HELP.finance)}</h3>
      <div class="fingrid">
        ${field('Surface', f.surface || ref, 'm²', '1', (v) => this.setFinance({ surface: v === ref ? 0 : v }),
          `Surface du bien simulé. Par défaut ${ref} m² (${this.type === 'house' ? 'maison' : 'appartement'}), la surface de référence des loyers ANIL : au-delà, le loyer au m² réel est en général plus bas.`)}
        ${field('Apport', pct(f.deposit), '%', '1', (v) => this.setFinance({ deposit: v / 100 }), 'Part du coût total (prix + notaire) payée sans emprunter.')}
        ${field('Taux du crédit', pct(f.rate), '%', '0.05', (v) => this.setFinance({ rate: v / 100 }), 'Taux nominal annuel, hors assurance emprunteur.')}
        ${field('Durée', f.years, 'ans', '1', (v) => this.setFinance({ years: Math.max(1, v) }), 'Durée du prêt.')}
        ${field('Frais de notaire', pct(f.notary), '%', '0.5', (v) => this.setFinance({ notary: v / 100 }), 'Environ 7 à 8 % du prix dans l’ancien, 2 à 3 % dans le neuf.')}
        ${field('Charges et entretien', pct(f.charges), '% loyer', '1', (v) => this.setFinance({ charges: v / 100 }),
          'Charges de copropriété non récupérables, entretien, assurance propriétaire non occupant, gestion éventuelle. 10 à 20 % du loyer selon le bien.')}
        ${field('Vacance', f.vacancy, 'mois/an', '0.5', (v) => this.setFinance({ vacancy: Math.min(12, v) }), 'Nombre moyen de mois par an sans locataire.')}
      </div>
      <button class="link" @click=${() => this.setFinance({ ...DEFAULT_FINANCE })}>Hypothèses par défaut</button>`;
  }

  /** Step-by-step purchase simulation for the selected commune. */
  private renderSimulation(row: Row) {
    const sim = simulate(row, this.type, this.finance);
    const kind = this.type === 'house' ? 'maison' : 'appartement';
    if (!sim) {
      return html`<details class="grp"><summary>Simulation d’achat</summary>
        <p class="muted">Pas assez de ventes ou de loyers pour simuler l’achat d’un ${kind} ici.</p></details>`;
    }
    const e = (v: number) => fmt('purchase_price', Math.round(v));
    const f = this.finance;
    return html`
      <details open class="grp sim">
        <summary>Simulation d’achat${tip('Simulation d’achat', HELP.finance)}</summary>
        <p class="muted">${kind[0].toUpperCase() + kind.slice(1)} de ${sim.surface} m² au prix médian de la commune.
          <button class="link" @click=${() => (this.settingsOpen = true)}>Modifier les hypothèses</button></p>
        <dl>
          <dt>Prix (${fmt('price_m2', row[`price_m2_${this.type}`])}/m²)</dt><dd>${e(sim.price)}</dd>
          <dt>+ Frais de notaire (${fmt('net_yield', f.notary)})</dt><dd>${e(sim.notaryFees)}</dd>
          <dt><b>= Coût total</b></dt><dd><b>${e(sim.totalCost)}</b></dd>
          <dt>Loyer annuel (${fmt('rent_m2', row[`rent_m2_${this.type}`])}/m²/mois)</dt><dd>${e(sim.rentYear)}</dd>
          <dt>− Vacance (${f.vacancy} mois)</dt><dd>${e(-sim.vacancyLoss)}</dd>
          <dt>− Charges et entretien (${fmt('net_yield', f.charges)})</dt><dd>${e(-sim.charges)}</dd>
          <dt>− Taxe foncière moyenne${colTip('tfpb_total_avg_eur')}</dt><dd>${e(-sim.propertyTax)}</dd>
          <dt><b>= Revenu net annuel</b></dt><dd><b>${e(sim.netIncome)}</b></dd>
          <dt><b>Rendement net</b>${colTip('net_yield')}</dt><dd>${val('net_yield', sim.netYield)}</dd>
          <dt>Emprunt (apport ${fmt('net_yield', f.deposit)})</dt><dd>${e(sim.loan)}</dd>
          <dt>Mensualité (${fmt('net_yield', f.rate)}, ${f.years} ans)</dt><dd>${e(-sim.monthlyPayment)}</dd>
          <dt><b>Cash-flow mensuel</b>${colTip('cashflow_month')}</dt><dd>${val('cashflow_month', Math.round(sim.cashflowMonth))}</dd>
        </dl>
        <p class="muted small">Avant impôt sur le revenu et assurance emprunteur. Le loyer ANIL est charges comprises : le revenu réel est un peu plus bas.</p>
      </details>`;
  }

  /** Tourist beds per year (INSEE 2015–2026) as bars, and second homes at the last three censuses. */
  private renderTourism(row: Row) {
    const years = Array.from({ length: 12 }, (_, i) => String(2015 + i));
    const beds = years.map((y) => num(row[`tour_beds_${y}`]) ?? 0);
    const homes = [['2011', num(row.second_homes_2011)], ['2016', num(row.second_homes_2016)], ['2022', num(row.second_homes_2022)]] as const;
    if (!beds.some((b) => b > 0) && !homes.some(([, v]) => (v ?? 0) > 0)) return nothing;
    const W = 300, H = 110, padL = 40, padB = 16, padT = 8;
    const max = Math.max(1, ...beds);
    const bw = (W - padL) / years.length;
    const y = (v: number) => padT + (H - padT - padB) * (1 - v / max);
    const int = (v: number) => Math.round(v).toLocaleString('fr-FR');
    return html`
      <details open class="grp">
        <summary>Tourisme : évolution${tip('Tourisme : évolution', HELP.tourism)}</summary>
        ${beds.some((b) => b > 0) ? html`
        <svg class="hist" viewBox="0 0 ${W} ${H}" role="img" aria-label="Lits touristiques par an, 2015 à 2026">
          ${[0, max / 2, max].map((v) => svg`<text x=${padL - 4} y=${y(v) + 3} text-anchor="end" class="ax">${int(v)}</text>
            <line x1=${padL} x2=${W} y1=${y(v)} y2=${y(v)} class="grid"></line>`)}
          ${beds.map((b, i) => svg`<rect x=${padL + i * bw + bw * 0.15} width=${bw * 0.7} y=${y(b)} height=${H - padB - y(b)}
            fill="var(--brand-2)" opacity="0.75"><title>${years[i]} : ${int(b)} lits touristiques</title></rect>`)}
          ${years.map((yy, i) => (i % 2 === 0 || i === years.length - 1)
            ? svg`<text x=${padL + (i + 0.5) * bw} y=${H - 3} text-anchor="middle" class="ax">${yy.slice(2)}</text>` : nothing)}
        </svg>
        <div class="legendrow"><span><i style="background:var(--brand-2)"></i>Lits touristiques (hôtels, campings, résidences, villages vacances), 2015–2026</span></div>`
        : html`<p class="muted small">Aucun hôtel, camping, village vacances ni résidence de tourisme recensé par l’INSEE dans la commune entre 2015 et 2026 (c’est le cas de 7 communes sur 10, surtout des villages). Les gîtes et meublés de particuliers ne sont pas comptés : regardez plutôt l’évolution des résidences secondaires ci-dessous.</p>`}
        <dl class="kv">
          <dt>Résidences secondaires ${homes.map(([yy]) => yy).join(' / ')}${colTip('second_homes_change')}</dt>
          <dd>${homes.map(([, v]) => (v === null ? '—' : int(v))).join(' / ')}</dd>
          <dt>Évolution des lits 2019 → 2026${colTip('tour_beds_change')}</dt><dd>${val('tour_beds_change', row.tour_beds_change)}</dd>
          <dt>Évolution résid. secondaires 2011 → 2022</dt><dd>${val('second_homes_change', row.second_homes_change)}</dd>
        </dl>
      </details>`;
  }

  /** Median €/m² and number of sales per year (DVF 2021–2025), as a small SVG chart. */
  private renderHistory(row: Row) {
    const years = ['2021', '2022', '2023', '2024', '2025'];
    const series = (['house', 'apt'] as const).map((t) => ({
      t,
      label: t === 'house' ? 'Maisons' : 'Appartements',
      price: years.map((y) => num(row[`hist_${t}_${y}`])),
      n: years.map((y) => num(row[`nhist_${t}_${y}`]) ?? 0),
    })).filter((s) => s.price.some((p) => p !== null) || s.n.some((n) => n > 0));
    if (!series.length) return nothing;
    const W = 300, H = 120, padL = 44, padB = 18, padT = 8;
    const prices = series.flatMap((s) => s.price.filter((p): p is number => p !== null));
    const maxN = Math.max(1, ...series.flatMap((s) => s.n));
    const lo = prices.length ? Math.min(...prices) * 0.9 : 0;
    const hi = prices.length ? Math.max(...prices) * 1.05 : 1;
    const x = (i: number) => padL + (i + 0.5) * ((W - padL) / years.length);
    const y = (p: number) => padT + (H - padT - padB) * (1 - (p - lo) / (hi - lo || 1));
    const bw = (W - padL) / years.length / (series.length + 1);
    const color = { house: 'var(--brand-2)', apt: '#5b8def' } as const;
    return html`
      <details open class="grp">
        <summary>Prix et ventes par an${tip('Prix et ventes par an', HELP.history)}</summary>
        <svg class="hist" viewBox="0 0 ${W} ${H}" role="img" aria-label="Prix médian au m² et nombre de ventes par an">
          ${[lo, (lo + hi) / 2, hi].map((v) => svg`<text x=${padL - 4} y=${y(v) + 3} text-anchor="end" class="ax">${Math.round(v / 100) * 100}</text>
            <line x1=${padL} x2=${W} y1=${y(v)} y2=${y(v)} class="grid"></line>`)}
          ${series.map((s, si) => s.n.map((n, i) => svg`<rect x=${x(i) - bw * series.length / 2 + si * bw} width=${bw * 0.9}
            y=${H - padB - (n / maxN) * (H - padT - padB) * 0.45} height=${(n / maxN) * (H - padT - padB) * 0.45}
            fill=${color[s.t]} opacity="0.22"><title>${s.label} ${years[i]} : ${n} ventes</title></rect>`))}
          ${series.map((s) => {
            const pts = s.price.map((p, i) => (p === null ? null : `${x(i)},${y(p)}`)).filter(Boolean).join(' ');
            return svg`<polyline points=${pts} fill="none" stroke=${color[s.t]} stroke-width="2"></polyline>
              ${s.price.map((p, i) => (p === null ? nothing : svg`<circle cx=${x(i)} cy=${y(p)} r="3" fill=${color[s.t]}>
                <title>${s.label} ${years[i]} : ${fmt('price_m2', p)}/m² (${s.n[i]} ventes)</title></circle>`))}`;
          })}
          ${years.map((yy, i) => svg`<text x=${x(i)} y=${H - 4} text-anchor="middle" class="ax">${yy}</text>`)}
        </svg>
        <div class="legendrow">${series.map((s) => html`<span><i style="background:${color[s.t]}"></i>${s.label} (€/m², ligne ; ventes, barres)</span>`)}</div>
        <p class="muted small">Année 2025 : ventes enregistrées au 30 juin 2026, encore incomplètes. Un point manque quand il y a moins de 5 ventes dans l’année.</p>
      </details>`;
  }

  private detailWarnings(row: Row) {
    const w: string[] = [];
    if (row.zone_tendue === true && this.strategy === 'short') w.push('Zone tendue : le maire peut limiter la location courte durée ou la soumettre à autorisation. Vérifiez les règles en mairie avant d’acheter.');
    if (row.rent_confidence === 'low') w.push('L’ANIL juge cette estimation de loyer peu fiable.');
    if (this.strategy === 'live' || this.strategy === 'land') w.push('Avant d’acheter un bien précis : consultez l’état des risques de l’adresse exacte (georisques.gouv.fr) et, pour un terrain, sa zone dans le plan local d’urbanisme (geoportail-urbanisme.gouv.fr). Les données ici sont à l’échelle de la commune.');
    return w.map((t) => html`<p class="note">${t}</p>`);
  }

  private renderFooter() {
    return html`
      <footer class="card">
        <p><b>À lire avant de se fier à un chiffre.</b> Les loyers sont des estimations de l’ANIL à partir d’annonces (charges comprises, logement vide), le plus souvent calculées pour un groupe de communes voisines et non pour la commune seule. Les prix sont des médianes DVF sur 24 mois jusqu’au ${this.meta ? new Date(this.meta.dvf_window_end).toLocaleDateString('fr-FR') : '—'} ; les petites communes ont peu de ventes. Le rendement brut ne tient compte ni des impôts, ni des charges, ni de la vacance, ni des travaux. Un risque signalé veut dire qu’il est reconnu ou réglementé dans la commune, pas qu’il est grave ni qu’il touche un bien précis. Il n’existe pas de donnée ouverte sur les règles de location courte durée commune par commune : la « zone tendue » n’est qu’un indice. Les couleurs vert / orange / rouge suivent des seuils fixes, identiques pour toutes les communes. Survolez les « ? » pour le détail de chaque calcul.</p>
        <details><summary>Sources et licences</summary>
          <ul>${this.meta?.sources.map((s) => html`<li><a href=${s.url} rel="noopener" target="_blank">${s.producer}</a> — ${s.vintage} — ${s.licence}${s.credit ? html` — <i>${s.credit}</i>` : nothing}</li>`)}</ul>
        </details>
        <p class="small">Données construites le ${this.meta ? new Date(this.meta.built).toLocaleDateString('fr-FR') : '—'}. Ceci n’est pas un conseil en investissement.</p>
      </footer>`;
  }

  static styles = css`
    :host {
      --bg: #f2f4f1; --surface: #ffffff; --ink: #14201b; --muted: #5d6b64; --faint: #8b9791; --line: #e3e7e2;
      --brand: #134e33; --brand-2: #1f7a4c; --brand-soft: #e6f3ec;
      --good: #137a3d; --good-bg: #dcf5e5; --bad: #b42318; --bad-bg: #fde4e1; --warn: #a15c07; --warn-bg: #fdf0d5;
      --radius: 14px; --shadow: 0 1px 2px rgba(16, 32, 24, .05), 0 6px 20px rgba(16, 32, 24, .06);
      --surface-2: #f6f8f6; --surface-3: #eceeec; --ink-2: #33423b; --hover: #f4f8f5; --th-bg: #f7f9f7; --row-line: #eef1ee;
      --track: #e1e7e2; --input-bg: #fbfcfb; --input-line: #d6ddd8; --switch-off: #cfd7d2; --seg-bg: #e4e9e5;
      --note-fg: #6b4106; --glass: rgba(255,255,255,.94); --tip-btn: #e3e9e5; --tip-btn-fg: #4f5f57;
      display: block; min-height: 100vh; background: var(--bg); color: var(--ink);
      font: 14px/1.45 ui-sans-serif, system-ui, -apple-system, "Segoe UI", Inter, Roboto, sans-serif;
      -webkit-font-smoothing: antialiased; font-variant-numeric: tabular-nums;
    }
    :host([data-theme='dark']) {
      --bg: #0f1714; --surface: #16211c; --ink: #e4ece7; --muted: #9db0a6; --faint: #74867c; --line: #25342d;
      --brand: #2a8f5a; --brand-2: #3fb877; --brand-soft: #1b3729;
      --good: #6fd597; --good-bg: #163525; --bad: #ff8f80; --bad-bg: #3c1f1b; --warn: #f2b860; --warn-bg: #3a2b14;
      --shadow: 0 1px 2px rgba(0,0,0,.3), 0 8px 24px rgba(0,0,0,.25);
      --surface-2: #1b2822; --surface-3: #23322b; --ink-2: #c9d6cf; --hover: #1c2b24; --th-bg: #19251f; --row-line: #1f2c26;
      --track: #2b3a33; --input-bg: #111b17; --input-line: #33453c; --switch-off: #3a4a42; --seg-bg: #22302a;
      --note-fg: #f5d9a8; --glass: rgba(22,33,28,.94); --tip-btn: #2a3a33; --tip-btn-fg: #c3d1ca;
    }
    button { font: inherit; color: inherit; }
    .card { background: var(--surface); border-radius: var(--radius); box-shadow: var(--shadow); border: 1px solid var(--line); }

    /* ---- header ---- */
    header { position: sticky; top: 0; z-index: 30; display: flex; flex-wrap: wrap; align-items: center; gap: 10px 28px;
      padding: 10px 20px; background: linear-gradient(115deg, #0d3a26, #175c3c 60%, #1f7a4c); color: #fff; box-shadow: 0 2px 12px rgba(0,0,0,.12); }
    .brand { display: flex; align-items: center; gap: 10px; }
    .brand svg { width: 30px; height: 30px; background: rgba(255,255,255,.1); border-radius: 9px; padding: 3px; }
    .brand span { display: flex; flex-direction: column; line-height: 1.15; }
    .brand b { font-size: 16px; letter-spacing: -.01em; } .brand small { font-size: 11.5px; opacity: .7; }
    .tabs { display: flex; gap: 2px; flex-wrap: wrap; background: rgba(0,0,0,.18); padding: 4px; border-radius: 12px; }
    .tabs button { border: 0; background: transparent; color: rgba(255,255,255,.82); padding: 7px 14px; border-radius: 9px; cursor: pointer; font-weight: 500; transition: background .15s, color .15s; }
    .tabs button:hover { background: rgba(255,255,255,.1); color: #fff; }
    .tabs button.on { background: #fff; color: var(--brand); font-weight: 650; box-shadow: 0 1px 3px rgba(0,0,0,.2); }
    .tabs button:focus-visible, .btn:focus-visible, .seg button:focus-visible { outline: 2px solid #9be3b5; outline-offset: 2px; }

    /* ---- layout ---- */
    .layout { display: grid; grid-template-columns: minmax(0, 1fr); }
    .layout.has-detail { grid-template-columns: minmax(0, 1fr) 400px; }
    main { padding: 18px 22px 30px; display: flex; flex-direction: column; gap: 16px; min-width: 0; }

    /* ---- summary of active settings ---- */
    .summary { display: flex; align-items: flex-start; gap: 16px; justify-content: space-between; }
    .summary-text p { margin: 0 0 10px; color: var(--muted); max-width: 820px; font-size: 14.5px; }
    .chips { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; }
    .chip { background: var(--surface); border: 1px solid var(--line); border-radius: 999px; padding: 4px 11px; font-size: 12.5px; color: var(--ink-2); }
    .chip.custom { border-color: var(--brand-2); background: var(--brand-soft); display: inline-flex; align-items: center; gap: 4px; padding-right: 4px; }
    .chip.custom button { border: 0; background: transparent; color: var(--brand-2); font-size: 15px; line-height: 1; cursor: pointer; padding: 0 5px; border-radius: 999px; }
    .chip.custom button:hover { background: var(--surface); }
    .seg { display: inline-flex; background: var(--seg-bg); border-radius: 999px; padding: 3px; margin-right: 2px; }
    .seg button { border: 0; background: transparent; border-radius: 999px; padding: 4px 12px; font-size: 12.5px; cursor: pointer; color: var(--muted); font-weight: 500; }
    .seg button.on { background: var(--surface); color: var(--brand); font-weight: 650; box-shadow: 0 1px 2px rgba(0,0,0,.12); }

    .btn { display: inline-flex; align-items: center; gap: 8px; border: 1px solid var(--line); background: var(--surface); padding: 8px 14px; border-radius: 10px; cursor: pointer; font-weight: 550; white-space: nowrap; transition: background .15s, border-color .15s; }
    .btn:hover { border-color: var(--input-line); background: var(--hover); }
    .btn.primary { background: var(--brand); border-color: var(--brand); color: #fff; }
    .btn.primary:hover { background: var(--brand-2); }
    .btn svg { width: 17px; height: 17px; }

    /* ---- stats ---- */
    .stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(170px, 1fr)); gap: 12px; }
    .stat { background: var(--surface); border: 1px solid var(--line); border-radius: var(--radius); box-shadow: var(--shadow); padding: 12px 16px; display: flex; flex-direction: column; gap: 2px; }
    .stat .label { color: var(--muted); font-size: 12.5px; display: flex; align-items: center; }
    .stat b { font-size: 26px; font-weight: 700; letter-spacing: -.02em; }
    .stat b small { font-size: 14px; color: var(--faint); font-weight: 500; }
    .stat b .v { font-size: inherit; padding: 0 8px; border-radius: 8px; }

    /* ---- map ---- */
    .mapcard { overflow: visible; }
    .maptools { display: flex; align-items: center; flex-wrap: wrap; gap: 8px 14px; padding: 10px 14px; border-bottom: 1px solid var(--line); }
    .select { display: inline-flex; align-items: stretch; border: 1px solid var(--input-line); border-radius: 10px; background: var(--input-bg); overflow: hidden; }
    .select span { padding: 0 10px; color: var(--muted); font-size: 12.5px; border-right: 1px solid var(--line); display: flex; align-items: center; background: var(--surface-2); }
    .select select { font: inherit; border: 0; background: transparent; color: var(--ink); padding: 7px 10px; min-width: 260px; cursor: pointer; }
    .select select:focus-visible { outline: 2px solid var(--brand-2); }
    .select option, .select optgroup { background: var(--surface); color: var(--ink); }
    .hint { color: var(--faint); font-size: 12.5px; }
    .mapwrap { position: relative; height: 56vh; min-height: 380px; border-radius: 0 0 var(--radius) var(--radius); overflow: hidden; }
    /* Expanded map: fixed between the header and the bottom of the window, left of the side panel. */
    .mapcard.full { position: fixed; top: var(--header-h, 56px); left: 0; right: 0; bottom: 0; z-index: 25;
      display: flex; flex-direction: column; border-radius: 0; border: 0; box-shadow: none; }
    .layout.has-detail .mapcard.full { right: 400px; }
    .mapcard.full .mapwrap { flex: 1; height: auto; min-height: 0; border-radius: 0; }
    .btn.icon { padding: 6px 10px; gap: 6px; font-size: 13px; }
    .btn.icon svg { width: 16px; height: 16px; }
    map-view { position: absolute; inset: 0; }
    .key { position: absolute; right: 12px; top: 12px; width: 160px; background: var(--glass); backdrop-filter: blur(6px); border-radius: 12px; box-shadow: var(--shadow); padding: 10px 12px; display: flex; flex-direction: column; gap: 6px; font-size: 12px; }
    .key b { font-size: 12.5px; display: flex; align-items: center; line-height: 1.25; }
    .tierrow { display: flex; align-items: center; gap: 8px; }
    .tierrow span { width: 24px; height: 18px; border-radius: 5px; display: grid; place-items: center; font-weight: 750; font-size: 11px; flex: none; }
    .tierrow span.na { background: repeating-linear-gradient(45deg, var(--surface-3), var(--surface-3) 3px, var(--track) 3px, var(--track) 6px); }
    .tierrow small, .keynote { color: var(--muted); }
    .keynote { font-size: 11px; line-height: 1.3; }
    .gradient { display: flex; gap: 8px; height: 170px; }
    .gradient .bar { width: 14px; height: 100%; border-radius: 7px; }
    .gradient .ticks { display: flex; flex-direction: column; justify-content: space-between; font-weight: 600; }
    .gradient em { font-style: normal; font-weight: 500; font-size: 10.5px; }
    .gradient em.good { color: var(--good); } .gradient em.bad { color: var(--bad); }

    /* ---- header extras ---- */
    header .grow { flex: 1; }
    .themes { display: flex; gap: 2px; background: rgba(0,0,0,.18); padding: 3px; border-radius: 10px; }
    .themes button { border: 0; background: transparent; color: rgba(255,255,255,.8); min-width: 32px; padding: 5px 9px; border-radius: 8px; cursor: pointer; font-size: 12.5px; }
    .themes button.on { background: rgba(255,255,255,.92); color: #134e33; font-weight: 650; }
    .themes button:focus-visible { outline: 2px solid #9be3b5; outline-offset: 1px; }

    /* ---- table extras ---- */
    th:nth-child(2), td.name { position: sticky; left: 0; background: var(--surface); z-index: 1; box-shadow: 1px 0 0 var(--row-line); }
    th:nth-child(2) { z-index: 2; background: var(--th-bg); }
    tbody tr:hover td.name { background: var(--hover); }
    tr.sel td.name { background: var(--brand-soft); }
    .more { display: flex; align-items: center; gap: 14px; justify-content: center; padding: 12px; border-top: 1px solid var(--line); color: var(--muted); font-size: 13px; position: sticky; left: 0; }
    td.name small.dep { color: var(--faint); font-weight: 500; font-size: 11.5px; margin-left: 4px; }
    .search { font: inherit; border: 1px solid var(--input-line); background: var(--input-bg); color: var(--ink); border-radius: 10px; padding: 7px 12px; min-width: 220px; }
    .search:focus-visible { outline: 2px solid var(--brand-2); border-color: transparent; }
    .select.small select { min-width: 210px; padding: 5px 8px; font-size: 13px; }
    .colpicker { position: relative; }
    .deppicker { position: relative; }
    .deppicker summary { list-style: none; max-width: 340px; overflow: hidden; text-overflow: ellipsis; }
    .deppicker summary::-webkit-details-marker { display: none; }
    .deppicker summary svg { width: 16px; height: 16px; flex: none; }
    .deppicker summary.active { border-color: var(--brand-2); color: var(--brand-2); background: var(--brand-soft); }
    .deppicker .count { background: var(--brand-2); color: #fff; border-radius: 99px; font-size: 11px; padding: 0 7px; line-height: 18px; }
    .depmenu { position: absolute; left: 0; top: calc(100% + 6px); z-index: 30; width: min(420px, 90vw); background: var(--surface); border: 1px solid var(--line); border-radius: 12px; box-shadow: var(--shadow); padding: 12px; display: flex; flex-direction: column; gap: 10px; }
    .depmenu-head { display: flex; align-items: center; gap: 10px; }
    .depmenu-head .search { flex: 1; min-width: 0; }
    .depchips { display: flex; flex-wrap: wrap; gap: 6px; }
    .chip.removable { cursor: pointer; font: inherit; font-size: 12.5px; background: var(--brand-soft); border-color: transparent; color: var(--ink); }
    .chip.removable:hover { background: var(--bad-bg); }
    .deplist { max-height: 320px; overflow-y: auto; display: grid; grid-template-columns: 1fr 1fr; gap: 2px 12px; }
    .deplist label { display: flex; align-items: center; gap: 6px; font-size: 13px; padding: 3px 2px; cursor: pointer; border-radius: 6px; }
    .deplist label:hover { background: var(--hover); }
    .deplist input { accent-color: var(--brand-2); }
    .deplist .code { color: var(--muted); font-variant-numeric: tabular-nums; min-width: 22px; }
    .deplist .empty { grid-column: 1 / -1; color: var(--muted); margin: 6px 0; }
    .link:disabled { color: var(--faint); cursor: default; }
    .chip.strong { background: var(--brand-soft); border-color: transparent; font-weight: 600; }
    .colpicker summary { list-style: none; } .colpicker summary::-webkit-details-marker { display: none; }
    .colmenu { position: absolute; right: 0; top: calc(100% + 6px); z-index: 20; width: min(560px, 90vw); max-height: 60vh; overflow-y: auto; background: var(--surface); border: 1px solid var(--line); border-radius: 12px; box-shadow: var(--shadow); padding: 12px 14px; display: grid; grid-template-columns: 1fr 1fr; gap: 10px 18px; }
    .colmenu-head { grid-column: 1 / -1; display: flex; justify-content: space-between; align-items: center; }
    .colmenu fieldset { border: 0; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 3px; }
    .colmenu legend { font-size: 11px; text-transform: uppercase; letter-spacing: .05em; color: var(--muted); font-weight: 650; padding: 0 0 4px; }
    .colmenu label { display: flex; gap: 6px; align-items: center; font-size: 13px; cursor: pointer; }
    .colmenu input { accent-color: var(--brand-2); }
    .link { border: 0; background: none; color: var(--brand-2); cursor: pointer; font-weight: 600; padding: 0; }

    /* ---- AI summary ---- */
    .ai { background: linear-gradient(135deg, var(--brand-soft), var(--surface-2)); border: 1px solid var(--line); border-radius: 12px; padding: 10px 12px; }
    .ai-head { display: flex; align-items: center; }
    .ai-badge { font-size: 11px; font-weight: 700; letter-spacing: .05em; text-transform: uppercase; color: var(--brand-2); }
    .ai p { margin: 6px 0 0; font-size: 13.5px; line-height: 1.55; }
    .ai p.muted { color: var(--muted); display: flex; align-items: center; gap: 8px; }

    /* ---- loading ---- */
    .loading { position: fixed; left: 50%; top: 45%; transform: translate(-50%, -50%); z-index: 60; display: flex; gap: 14px; align-items: center;
      background: var(--surface); color: var(--ink); border: 1px solid var(--line); border-radius: 14px; padding: 16px 20px; box-shadow: 0 12px 40px rgba(0, 0, 0, .18); min-width: 320px; }
    .loading div { display: flex; flex-direction: column; gap: 4px; }
    .loading small { color: var(--muted); font-size: 12.5px; }
    .loading progress { width: 100%; height: 6px; accent-color: var(--brand-2); }
    .spinner { width: 26px; height: 26px; flex: none; border-radius: 50%; border: 3px solid var(--line); border-top-color: var(--brand-2); animation: spin .9s linear infinite; }
    .spinner.small { width: 14px; height: 14px; border-width: 2px; }
    @keyframes spin { to { transform: rotate(360deg); } }
    @media (prefers-reduced-motion: reduce) { .spinner { animation-duration: 3s; } }

    /* ---- table ---- */
    .tablebar { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; margin-top: 4px; }
    .tablebar h2 { margin: 0 8px 0 0; font-size: 18px; letter-spacing: -.01em; }
    .grow { flex: 1; }
    .tablewrap { overflow: auto; max-height: 70vh; }
    table { border-collapse: separate; border-spacing: 0; width: 100%; font-size: 13.5px; }
    th { position: sticky; top: 0; z-index: 1; background: var(--th-bg); text-align: left; vertical-align: bottom; border-bottom: 1px solid var(--line); font-size: 12px; color: var(--muted); }
    .th { display: inline-flex; align-items: center; padding: 9px 10px; }
    th button { border: 0; background: none; padding: 0; cursor: pointer; font-weight: 650; text-align: left; color: inherit; font-size: 12px; line-height: 1.25; max-width: 130px; }
    th button:hover { color: var(--ink); }
    td { padding: 8px 10px; border-bottom: 1px solid var(--row-line); white-space: nowrap; }
    td.num, th.num { color: var(--faint); width: 32px; text-align: right; }
    td.name { display: flex; align-items: center; gap: 10px; font-weight: 600; }
    tbody tr { cursor: pointer; transition: background .1s; }
    tbody tr:hover { background: var(--hover); }
    tr.sel { background: var(--brand-soft) !important; box-shadow: inset 3px 0 0 var(--brand); }
    tr.failrow td { color: var(--faint); } tr.failrow td.name { font-weight: 500; }
    .tier { display: inline-grid; place-items: center; width: 22px; height: 22px; border-radius: 7px; font-size: 11.5px; font-weight: 750; flex: none; }
    .tier.big { width: 40px; height: 40px; border-radius: 12px; font-size: 19px; }
    .score { display: inline-flex; align-items: center; gap: 8px; }
    .bar { display: inline-block; width: 54px; height: 6px; border-radius: 99px; background: var(--track); overflow: hidden; }
    .bar i { display: block; height: 100%; border-radius: inherit; background: linear-gradient(90deg, #6cc48d, var(--brand-2)); }
    .bar.good i { background: var(--good); } .bar.bad i { background: #e2775f; }
    .score b { font-weight: 700; min-width: 30px; }
    .out { font-size: 12px; background: var(--surface-3); color: var(--muted); border-radius: 6px; padding: 2px 7px; }

    /* ---- good / bad values ---- */
    .v { display: inline-block; padding: 1px 7px; border-radius: 6px; font-weight: 600; }
    .v.good { background: var(--good-bg); color: var(--good); }
    .v.bad { background: var(--bad-bg); color: var(--bad); }
    .v.warn { background: var(--warn-bg); color: var(--warn); }
    /* In the table, good values stay quiet (green text) so problems stand out. */
    td .v.good { background: none; padding: 0; font-weight: 650; }

    /* ---- side panel ---- */
    .sidenav { position: sticky; top: var(--header-h, 56px); align-self: start; height: calc(100vh - var(--header-h, 56px)); display: flex; flex-direction: column; background: var(--surface); border-left: 1px solid var(--line); box-shadow: -8px 0 24px rgba(16,32,24,.06); z-index: 26; }
    .sn-head { display: flex; justify-content: space-between; align-items: flex-start; gap: 8px; padding: 16px 18px 14px; border-bottom: 1px solid var(--line); }
    .sn-title { display: flex; align-items: center; gap: 12px; }
    .sn-head h3 { margin: 0; font-size: 20px; letter-spacing: -.02em; } .sn-head small { color: var(--muted); }
    .sn-body { overflow-y: auto; padding: 14px 18px 30px; display: flex; flex-direction: column; gap: 12px; }
    .sn-score { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
    .sn-score > div { background: var(--surface-2); border-radius: 12px; padding: 10px 12px; }
    .sn-score .label { display: flex; align-items: center; font-size: 12px; color: var(--muted); }
    .sn-score b { font-size: 24px; font-weight: 750; letter-spacing: -.02em; } .sn-score small { color: var(--faint); margin-left: 2px; }
    .failbox { margin: 0; background: var(--surface-2); border-radius: 12px; padding: 10px 12px; color: var(--muted); }
    .hl { display: grid; grid-template-columns: 1fr; gap: 10px; }
    .hl-col { border-radius: 12px; padding: 10px 12px; }
    .hl-col.good { background: var(--good-bg); } .hl-col.bad { background: var(--bad-bg); }
    .hl-col h4 { margin: 0 0 6px; font-size: 12px; text-transform: uppercase; letter-spacing: .05em; }
    .hl-col.good h4 { color: var(--good); } .hl-col.bad h4 { color: var(--bad); }
    .hl-col ul { margin: 0; padding: 0; list-style: none; display: grid; gap: 3px; }
    .hl-col li { display: flex; justify-content: space-between; gap: 10px; font-size: 13px; }
    .hl-col li b { white-space: nowrap; }
    .hl-col li.warn { color: var(--warn); }
    .grp { border: 1px solid var(--line); border-radius: 12px; padding: 4px 12px 8px; }
    .grp summary { cursor: pointer; list-style: none; padding: 8px 0 4px; font-weight: 650; font-size: 12.5px; text-transform: uppercase; letter-spacing: .05em; color: var(--ink-2); display: flex; align-items: center; }
    .grp summary::-webkit-details-marker { display: none; }
    .grp summary::before { content: '▸'; margin-right: 6px; color: var(--faint); transition: transform .15s; }
    .grp[open] summary::before { transform: rotate(90deg); }
    .grp dl { display: grid; grid-template-columns: 1fr auto; margin: 4px 0 0; gap: 5px 12px; font-size: 13px; }
    .muted { color: var(--muted); font-size: 12.5px; margin: 4px 0; }
    .muted.small { font-size: 11.5px; }
    .sim dd { font-variant-numeric: tabular-nums; }
    svg.hist { width: 100%; height: auto; margin-top: 6px; }
    svg.hist .ax { font-size: 9px; fill: var(--muted); }
    svg.hist .grid { stroke: var(--line); stroke-width: 1; }
    .legendrow { display: flex; flex-wrap: wrap; gap: 10px; font-size: 11.5px; color: var(--muted); }
    .legendrow i { display: inline-block; width: 10px; height: 10px; border-radius: 2px; margin-right: 4px; vertical-align: -1px; }
    .fingrid { display: grid; grid-template-columns: 1fr 1fr; gap: 8px 14px; }
    .fin { display: flex; flex-direction: column; gap: 3px; font-size: 13px; }
    .fin > span:first-child { display: flex; align-items: center; color: var(--ink-2); }
    .grp dt { color: var(--ink-2); } .grp dd { margin: 0; text-align: right; white-space: nowrap; }
    .parts { display: grid; gap: 6px; padding-top: 4px; }
    .parts div { display: grid; grid-template-columns: 1fr 90px 28px; gap: 8px; align-items: center; font-size: 12.5px; }
    .parts .bar { width: 100%; } .parts b { text-align: right; }
    .note { margin: 0; background: var(--warn-bg); color: var(--note-fg); border-radius: 12px; padding: 9px 12px; font-size: 12.5px; }
    .code { margin: 0; font-size: 12px; color: var(--faint); }
    .close { border: 0; background: var(--surface-3); width: 32px; height: 32px; border-radius: 10px; font-size: 20px; line-height: 1; cursor: pointer; color: var(--ink-2); flex: none; }
    .close:hover { background: var(--track); } .close:focus-visible { outline: 2px solid var(--brand-2); }

    /* ---- settings drawer ---- */
    .backdrop { position: fixed; inset: 0; background: rgba(10, 25, 18, .35); z-index: 40; animation: fade .15s ease-out; }
    .drawer { position: fixed; top: 0; left: 0; bottom: 0; width: min(420px, 100vw); z-index: 41; background: var(--surface); display: flex; flex-direction: column; box-shadow: 12px 0 40px rgba(0,0,0,.2); animation: slide .2s ease-out; }
    @keyframes slide { from { transform: translateX(-24px); opacity: 0; } }
    @keyframes fade { from { opacity: 0; } }
    @media (prefers-reduced-motion: reduce) { .drawer, .backdrop { animation: none; } }
    .drawer-head { display: flex; justify-content: space-between; align-items: flex-start; padding: 18px 20px 12px; border-bottom: 1px solid var(--line); }
    .drawer-head small { color: var(--muted); text-transform: uppercase; letter-spacing: .06em; font-size: 11px; }
    .drawer-head h2 { margin: 2px 0 0; font-size: 19px; }
    .drawer-body { overflow-y: auto; padding: 6px 20px 20px; flex: 1; }
    .drawer-body h3 { font-size: 12px; text-transform: uppercase; letter-spacing: .06em; margin: 18px 0 8px; display: flex; align-items: center; gap: 4px; color: var(--ink-2); }
    .drawer-body h3 small { text-transform: none; letter-spacing: 0; font-weight: 400; color: var(--faint); }
    .drawer-foot { display: flex; justify-content: space-between; gap: 10px; padding: 12px 20px; border-top: 1px solid var(--line); }
    .filter { display: grid; grid-template-columns: 1fr auto auto 38px; align-items: center; gap: 6px 8px; padding: 9px 0; border-bottom: 1px solid var(--row-line); }
    .filter.off .ftitle span { color: var(--faint); }
    .ftitle { display: flex; align-items: center; gap: 10px; cursor: pointer; }
    .fval { display: inline-flex; align-items: center; gap: 4px; }
    .fval i { font-style: normal; color: var(--muted); }
    .fval input { width: 84px; font: inherit; padding: 5px 8px; border: 1px solid var(--input-line); border-radius: 8px; box-sizing: border-box; text-align: right; background: var(--input-bg); color: var(--ink); }
    .fval input:focus { outline: 2px solid var(--brand-2); outline-offset: 0; border-color: transparent; }
    .fval input:disabled { opacity: .45; }
    .fcount { color: var(--bad); font-size: 12px; font-weight: 600; text-align: right; }
    .weight { display: grid; grid-template-columns: 1fr 120px 18px; align-items: center; gap: 10px; padding: 6px 0; }
    .weight span { display: flex; align-items: center; }
    .weight output { text-align: right; font-weight: 650; color: var(--brand); }
    input[type='range'] { -webkit-appearance: none; appearance: none; height: 6px; border-radius: 99px; background: linear-gradient(90deg, var(--brand-2) var(--p), var(--track) var(--p)); cursor: pointer; }
    input[type='range']::-webkit-slider-thumb { -webkit-appearance: none; width: 18px; height: 18px; border-radius: 50%; background: #fff; border: 2px solid var(--brand-2); box-shadow: 0 1px 3px rgba(0,0,0,.2); }
    input[type='range']::-moz-range-thumb { width: 16px; height: 16px; border-radius: 50%; background: #fff; border: 2px solid var(--brand-2); }
    input[type='range']:focus-visible { outline: 2px solid var(--brand-2); outline-offset: 4px; }

    /* toggle switch (still a native checkbox for keyboard and screen readers) */
    .switch { -webkit-appearance: none; appearance: none; flex: none; width: 34px; height: 20px; margin: 0; border-radius: 99px; background: var(--switch-off); position: relative; cursor: pointer; transition: background .15s; }
    .switch::after { content: ''; position: absolute; top: 2px; left: 2px; width: 16px; height: 16px; border-radius: 50%; background: #fff; box-shadow: 0 1px 2px rgba(0,0,0,.25); transition: transform .15s; }
    .switch:checked { background: var(--brand-2); }
    .switch:checked::after { transform: translateX(14px); }
    .switch:focus-visible { outline: 2px solid var(--brand-2); outline-offset: 2px; }
    .switchlabel { display: inline-flex; align-items: center; gap: 8px; cursor: pointer; color: var(--muted); }

    /* ---- footer ---- */
    footer { padding: 14px 18px; color: var(--muted); font-size: 12.5px; }
    footer p { margin: 0 0 8px; } footer .small { color: var(--faint); margin: 8px 0 0; }
    footer summary { cursor: pointer; font-weight: 600; color: var(--ink-2); }
    footer a { color: var(--brand-2); }
    .error { padding: 20px; color: var(--bad); }

    @media (max-width: 1150px) {
      .layout.has-detail .mapcard.full { right: 0; }
      .layout.has-detail { grid-template-columns: minmax(0, 1fr); }
      .sidenav { position: fixed; right: 0; top: 0; height: 100vh; width: min(400px, 100vw); z-index: 35; }
    }
    @media (max-width: 720px) {
      main { padding: 12px; }
      .summary { flex-direction: column; }
      header { padding: 10px 12px; }
    }
  `;
}
