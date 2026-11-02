// Risks at one address of the open commune, from the public Géorisques API
// (the same data as the official "état des risques" report). Called from the
// browser: the address search uses the IGN Géoplateforme geocoder, limited to the
// commune. Nothing is stored; the two APIs allow cross-origin calls.

import { LitElement, css, html, nothing } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';

const GEOCODER = 'https://data.geopf.fr/geocodage/search';
const GEORISQUES = 'https://georisques.gouv.fr/api/v1/resultats_rapport_risque';

interface Hit { label: string; lon: number; lat: number }
interface Risk { present: boolean; libelle: string; libelleStatutCommune: string | null; libelleStatutAdresse: string | null }
interface Report { adresse?: { libelle?: string }; url?: string; risquesNaturels?: Record<string, Risk>; risquesTechnologiques?: Record<string, Risk> }

/** good / bad / warn / unknown, from the Géorisques wording ("Risque Existant - important", "Risque non Concerne"…). */
export function riskLevel(status: string | null | undefined): 'bad' | 'warn' | 'good' | 'unknown' {
  const s = (status ?? '').toLowerCase();
  if (!s) return 'unknown';
  if (/non concern|absent/.test(s)) return 'good';
  if (/inconnu|non connu/.test(s)) return 'unknown';
  if (/important|fort|élev|concerne/.test(s)) return 'bad';
  return 'warn';
}

@customElement('address-risk')
export class AddressRisk extends LitElement {
  /** INSEE code of the commune (the address search stays inside it). */
  @property() code = '';
  @property() commune = '';

  @state() private query = '';
  @state() private hits: Hit[] = [];
  @state() private open = false;
  @state() private report: Report | null = null;
  @state() private status: 'idle' | 'loading' | 'error' = 'idle';
  private timer?: number;
  private ctl?: AbortController;

  updated(changed: Map<string, unknown>) {
    // Another commune: forget the previous address.
    if (changed.has('code') && changed.get('code') !== undefined) {
      this.query = ''; this.hits = []; this.report = null; this.status = 'idle';
    }
    // Lets the printed sheet keep this section only when an address was looked up.
    this.toggleAttribute('reported', !!this.report);
  }

  private onInput(v: string) {
    this.query = v;
    clearTimeout(this.timer);
    if (v.trim().length < 3) { this.hits = []; return; }
    this.timer = window.setTimeout(() => this.search(v.trim()), 250);
  }

  private async search(q: string) {
    this.ctl?.abort();
    this.ctl = new AbortController();
    const u = `${GEOCODER}?${new URLSearchParams({ q, citycode: this.code, limit: '6', autocomplete: '1' })}`;
    try {
      const d = await (await fetch(u, { signal: this.ctl.signal })).json();
      this.hits = (d.features ?? []).map((f: { properties: { label: string }; geometry: { coordinates: [number, number] } }) => ({
        label: f.properties.label, lon: f.geometry.coordinates[0], lat: f.geometry.coordinates[1],
      }));
      this.open = true;
    } catch { /* aborted or offline: keep the previous list */ }
  }

  private async pick(h: Hit) {
    this.query = h.label;
    this.open = false;
    this.status = 'loading';
    this.report = null;
    this.dispatchEvent(new CustomEvent('locate', { detail: h, bubbles: true, composed: true }));
    try {
      const r = await fetch(`${GEORISQUES}?latlon=${h.lon},${h.lat}`);
      if (!r.ok) throw new Error(String(r.status));
      this.report = await r.json();
      this.status = 'idle';
    } catch {
      this.status = 'error';
    }
  }

  render() {
    const rows = (group?: Record<string, Risk>) => Object.values(group ?? {}).filter((r) => r.present);
    const nat = rows(this.report?.risquesNaturels);
    const tech = rows(this.report?.risquesTechnologiques);
    const url = this.report?.url && this.report.url.startsWith('https://www.georisques.gouv.fr/') ? this.report.url : null;
    const line = (r: Risk) => {
      const lvl = riskLevel(r.libelleStatutAdresse);
      return html`<tr>
        <td>${r.libelle}</td>
        <td><span class="lvl ${lvl}">${(r.libelleStatutAdresse ?? 'non précisé').replace(/^Risque /, '')}</span></td>
        <td class="muted">${(r.libelleStatutCommune ?? '').replace(/^Risque /, '')}</td>
      </tr>`;
    };
    return html`
      <div class="box">
        <input type="search" placeholder="Adresse à ${this.commune}…" autocomplete="off" .value=${this.query}
          aria-label="Adresse à ${this.commune}" @input=${(e: Event) => this.onInput((e.target as HTMLInputElement).value)}
          @focus=${() => (this.open = this.hits.length > 0)} @blur=${() => setTimeout(() => (this.open = false), 150)}
          @keydown=${(e: KeyboardEvent) => { if (e.key === 'Enter' && this.hits[0]) this.pick(this.hits[0]); }}>
        ${this.open && this.hits.length ? html`<div class="menu" role="listbox">
          ${this.hits.map((h) => html`<div class="i" role="option" @mousedown=${(e: Event) => { e.preventDefault(); this.pick(h); }}>${h.label}</div>`)}
        </div>` : nothing}
      </div>
      ${this.status === 'loading' ? html`<p class="muted">Interrogation de Géorisques…</p>` : nothing}
      ${this.status === 'error' ? html`<p class="err">Géorisques ne répond pas pour le moment. Réessayez plus tard.</p>` : nothing}
      ${this.report ? html`
        <p class="addr">${this.report.adresse?.libelle ?? this.query}</p>
        <table>
          <thead><tr><th>Risque</th><th>À l’adresse</th><th>Commune</th></tr></thead>
          <tbody>
            ${nat.length ? html`<tr class="sec"><td colspan="3">Naturels</td></tr>${nat.map(line)}` : nothing}
            ${tech.length ? html`<tr class="sec"><td colspan="3">Technologiques</td></tr>${tech.map(line)}` : nothing}
            ${!nat.length && !tech.length ? html`<tr><td colspan="3">Aucun risque recensé.</td></tr>` : nothing}
          </tbody>
        </table>
        <p class="muted small">« Inconnu » ou « non connu » : Géorisques n’a pas de carte précise de ce risque à cet endroit, seulement à l’échelle de la commune. Ce n’est pas l’état des risques officiel d’une vente.
          ${url ? html`<a href=${url} target="_blank" rel="noopener noreferrer">Rapport complet sur Géorisques ↗</a>` : nothing}</p>` : nothing}
    `;
  }

  static styles = css`
    :host { display: block; font-size: 13px; }
    @media print { :host { font-size: 8.5pt; } .box { display: none; } .addr { margin-top: 2px; } }
    .box { position: relative; }
    input { width: 100%; box-sizing: border-box; border: 1px solid var(--input-line); background: var(--input-bg); color: var(--ink); border-radius: 9px; padding: 7px 10px; font: inherit; }
    input:focus { outline: 2px solid var(--brand-soft); border-color: var(--brand-2); }
    .menu { position: absolute; left: 0; right: 0; top: 100%; margin-top: 3px; background: var(--surface); border: 1px solid var(--line); border-radius: 9px; box-shadow: var(--shadow); z-index: 5; overflow: hidden; }
    .i { padding: 6px 10px; cursor: pointer; } .i:hover { background: var(--brand-soft); }
    .muted { color: var(--muted); } .small { font-size: 12px; } .err { color: var(--bad); }
    .addr { font-weight: 650; margin: 10px 0 4px; }
    table { width: 100%; border-collapse: collapse; }
    th { text-align: left; font-size: 11px; text-transform: uppercase; letter-spacing: .04em; color: var(--muted); font-weight: 650; padding: 4px 4px; }
    td { padding: 4px; border-top: 1px solid var(--row-line); vertical-align: top; }
    tr.sec td { font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: .04em; color: var(--ink-2); background: var(--surface-2); }
    .lvl { border-radius: 6px; padding: 1px 6px; white-space: nowrap; font-weight: 600; font-size: 12px; }
    .lvl.bad { background: var(--bad-bg); color: var(--bad); } .lvl.warn { background: var(--warn-bg); color: var(--warn); }
    .lvl.good { background: var(--good-bg); color: var(--good); } .lvl.unknown { color: var(--muted); }
    a { color: var(--brand-2); font-weight: 600; }
  `;
}
