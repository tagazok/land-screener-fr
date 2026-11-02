// Comparison page: up to 4 communes side by side, one column each, every indicator
// of the side panel as a row. The best value of each row is highlighted (see compare.ts).
// The commune names and the indicator labels stay visible while scrolling.

import { LitElement, css, html, nothing } from 'lit';
import { customElement, property, query, state } from 'lit/decorators.js';
import type { Row, Scored, SignalDef } from '../engine';
import { CSV_SEP, csvValue, fmt } from '../format';
import { MAX_COMPARE, betterDirection, bestIndexes, differs } from '../compare';
import { COLUMNS, DETAIL_GROUPS, FILTERS, columnHelp } from '../strategies';
import { TIER_COLORS } from './map-view';
import './info-tip';

const TIER_TEXT: Record<string, string> = { A: '#fff', B: '#14361f', C: '#3b4a1a', D: '#5a4210', E: '#4a1606', fail: '#fff' };
const fold = (s: string) => s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[-'’]/g, ' ');
const tip = (label: string, text: string) => html`<info-tip .label=${label} .text=${text}></info-tip>`;
/** Columns kept out of the "points forts" list of a card (detail or count columns). */
const DETAIL_ONLY = /^(dist_|n_|nhist_|hist_)|_65$|^clay_med_high_share$/;

interface Line { column: string; values: Row[string][]; best: number[]; dir: 1 | -1 | null }

@customElement('compare-view')
export class CompareView extends LitElement {
  /** Every commune, already derived for the active strategy (price_m2, net_yield…). */
  @property({ attribute: false }) rows: Row[] = [];
  /** Scores of the communes in the current zone. */
  @property({ attribute: false }) results: Scored[] = [];
  @property({ attribute: false }) codes: string[] = [];
  @property({ attribute: false }) favorites: string[] = [];
  @property({ attribute: false }) signals: SignalDef[] = [];
  @property({ attribute: false }) depNames: Record<string, string> = {};
  @property() strategyLabel = '';
  /** Columns the active strategy cares about, most important first: they lead each card's "points forts". */
  @property({ attribute: false }) priority: string[] = [];
  @property({ type: Boolean }) copied = false;

  @state() private query = '';
  @state() private acOpen = false;
  @state() private acIndex = 0;
  @state() private onlyDiff = false;
  @query('input.ac') private input?: HTMLInputElement;

  private _byCode?: { rows: Row[]; map: Map<string, Row> };
  private get byCode(): Map<string, Row> {
    if (this._byCode?.rows !== this.rows) this._byCode = { rows: this.rows, map: new Map(this.rows.map((r) => [r.code, r])) };
    return this._byCode.map;
  }

  /** Put the cursor in the search field (called when the page opens from a commune's panel). */
  focusSearch() {
    this.updateComplete.then(() => { this.input?.focus(); this.acOpen = true; });
  }

  private emit(name: string, detail?: unknown) {
    this.dispatchEvent(new CustomEvent(name, { detail, bubbles: true, composed: true }));
  }

  private setCodes(codes: string[]) {
    this.emit('compare-change', codes.slice(0, MAX_COMPARE));
  }

  private add(code: string) {
    this.query = '';
    this.acIndex = 0;
    if (!this.codes.includes(code)) this.setCodes([...this.codes, code]);
    this.acOpen = this.codes.length + 1 < MAX_COMPARE;
    if (!this.acOpen) this.input?.blur();
  }

  /** Suggestions: favourites first, then communes whose name or postal code matches, biggest first. */
  private get suggestions(): { row: Row; fav: boolean }[] {
    const taken = new Set(this.codes);
    const fav = new Set(this.favorites);
    const q = fold(this.query.trim());
    const favs = this.favorites.map((c) => this.byCode.get(c)).filter((r): r is Row => !!r && !taken.has(r.code));
    if (!q) return favs.slice(0, 8).map((row) => ({ row, fav: true }));
    const isCp = /^\d{2,5}$/.test(q);
    const match = (r: Row) => (isCp
      ? typeof r.postcodes === 'string' && r.postcodes.split(' ').some((p) => p.startsWith(q))
      : fold(r.nom).includes(q));
    const rank = (r: Row) => (isCp || fold(r.nom).startsWith(q) ? 0 : 1);
    const pop = (r: Row) => (typeof r.pop === 'number' ? r.pop : 0);
    const favHits = favs.filter(match);
    const others = this.rows.filter((r) => !taken.has(r.code) && !fav.has(r.code) && match(r))
      .sort((a, b) => rank(a) - rank(b) || pop(b) - pop(a)).slice(0, 8 - Math.min(favHits.length, 4));
    return [...favHits.slice(0, 4).map((row) => ({ row, fav: true })), ...others.map((row) => ({ row, fav: false }))];
  }

  private onKey(e: KeyboardEvent) {
    const s = this.suggestions;
    if (e.key === 'ArrowDown') { e.preventDefault(); this.acOpen = true; this.acIndex = Math.min(s.length - 1, this.acIndex + 1); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); this.acIndex = Math.max(0, this.acIndex - 1); }
    else if (e.key === 'Enter' && s[this.acIndex]) { e.preventDefault(); this.add(s[this.acIndex].row.code); }
    else if (e.key === 'Escape') { e.stopPropagation(); this.acOpen = false; }
  }

  private lines(cities: Row[]): { title: string; help?: string; lines: Line[] }[] {
    const seen = new Set<string>();
    return DETAIL_GROUPS.map((g) => ({
      title: g.title, help: g.help,
      lines: g.columns.filter((c) => c in COLUMNS && !seen.has(c) && (seen.add(c), true)).map((column) => {
        const values = cities.map((r) => r[column] ?? null);
        const dir = ['bool', 'text'].includes(COLUMNS[column].unit) ? null : betterDirection(column, this.signals);
        return { column, values, dir, best: bestIndexes(values, dir) };
      }).filter((l) => l.values.some((v) => v !== null) && (!this.onlyDiff || differs(l.values))),
    })).filter((g) => g.lines.length);
  }

  private exportCsv(cities: Row[], groups: { title: string; lines: Line[] }[]) {
    const lines = [['Indicateur', ...cities.map((c) => `${c.nom} (${c.code})`)].map((v) => csvValue(v)).join(CSV_SEP)];
    for (const g of groups) for (const l of g.lines) lines.push([COLUMNS[l.column].label, ...l.values].map((v) => csvValue(v)).join(CSV_SEP));
    lines.push(`# Land Screener FR · comparaison · ${this.strategyLabel} · meilleure valeur = ${groups.flatMap((g) => g.lines).filter((l) => l.best.length).length} lignes`);
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob(['\ufeff' + lines.join('\n')], { type: 'text/csv;charset=utf-8' }));
    a.download = `comparaison-${cities.map((c) => c.code).join('-')}.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
  }

  render() {
    const cities = this.codes.map((c) => this.byCode.get(c)).filter((r): r is Row => !!r);
    const scored = new Map(this.results.map((r) => [r.row.code, r]));
    const groups = this.lines(cities);
    const all = groups.flatMap((g) => g.lines);
    const judged = all.filter((l) => l.dir);
    const rank = (c: string) => { const i = this.priority.indexOf(c); return i < 0 ? 1e3 : i; };
    const wins = cities.map((_, i) => all.filter((l) => l.best.includes(i)).map((l) => l.column)
      .sort((a, b) => rank(a) - rank(b)));
    const canAdd = cities.length < MAX_COMPARE;
    const fav = new Set(this.favorites);
    const span = cities.length + 1 + (canAdd ? 1 : 0);

    return html`
      <div class="bar">
        <button class="link back" @click=${() => this.emit('compare-close')}>← Retour au classement</button>
      </div>
      <div class="title">
        <h2>Comparer des communes</h2>
        <span class="muted">jusqu’à ${MAX_COMPARE} · stratégie « ${this.strategyLabel} »</span>
        ${tip('Comparer', `La meilleure valeur de chaque ligne est surlignée en vert. « Meilleure » suit la stratégie choisie quand elle a un critère sur la ligne (par exemple un prix bas pour acheter), sinon le sens habituel (moins de risques, plus de médecins…). Les lignes sans meilleur évident (population, altitude, textes) ne sont pas surlignées, ni les égalités parfaites.\n\nLe score et le groupe sont ceux de la stratégie choisie, calculés parmi les communes de la zone affichée sur la page principale.\n\nLa liste des communes est enregistrée dans le lien de partage.`)}
        <span class="grow"></span>
        <label class="switchlabel"><input class="switch" type="checkbox" .checked=${this.onlyDiff}
          @change=${(e: Event) => (this.onlyDiff = (e.target as HTMLInputElement).checked)}> Différences seulement</label>
        ${tip('Différences seulement', 'Masque les lignes où les communes ont la même valeur, ou des valeurs à moins de 5 % les unes des autres.')}
        <button class="btn" @click=${() => this.emit('copy-link')}>${this.copied ? 'Lien copié ✓' : 'Copier le lien'}</button>
        <button class="btn" ?disabled=${!cities.length} @click=${() => this.exportCsv(cities, groups)}>Exporter CSV</button>
        <button class="btn" ?disabled=${!cities.length} title="Imprimer la comparaison, ou l’enregistrer en PDF" @click=${() => window.print()}>Imprimer</button>
      </div>

      <p class="printonly">Land Screener FR · comparaison du ${new Date().toLocaleDateString('fr-FR')} · ${location.href}</p>
      <div class="scroller card">
        <table style="--n:${cities.length + (canAdd ? 1 : 0)}">
          <thead>
            <tr class="names">
              <th class="corner"><span class="muted">${cities.length} commune${cities.length > 1 ? 's' : ''}</span></th>
              ${cities.map((c) => {
                const s = scored.get(c.code);
                const t = s?.pass && s.tier ? s.tier : 'fail';
                const dep = this.depNames[c.dep as string] ?? c.dep;
                return html`<th class="name">
                  <div class="head">
                    <button class="star ${fav.has(c.code) ? 'on' : ''}" aria-pressed=${fav.has(c.code) ? 'true' : 'false'}
                      title=${fav.has(c.code) ? 'Retirer des favoris' : 'Ajouter aux favoris'} @click=${() => this.emit('toggle-favorite', c.code)}>${fav.has(c.code) ? '★' : '☆'}</button>
                    <button class="link cname" title="Ouvrir sa fiche sur la page principale" @click=${() => this.emit('open-commune', c.code)}>${c.nom}</button>
                    <button class="x" aria-label="Retirer ${c.nom} de la comparaison" title="Retirer"
                      @click=${() => this.setCodes(this.codes.filter((x) => x !== c.code))}>×</button>
                  </div>
                  <div class="sub">
                    <span class="tier" style="background:${TIER_COLORS[t]};color:${TIER_TEXT[t]}"
                      title=${s ? (s.pass ? `Groupe ${s.tier}` : 'Éliminée par les filtres') : 'Hors des départements affichés'}>${s?.pass ? s.tier : '–'}</span>
                    <span title=${s && !s.pass ? `Ne passe pas : ${s.failed.map((f) => FILTERS[f]?.label ?? (f === 'tiers' ? 'groupes choisis' : f)).join(', ')}` : ''}>${s?.pass ? html`<b>${fmt('score', s.score)}</b>/100` : s ? `éliminée (${s.failed.length} filtre${s.failed.length > 1 ? 's' : ''})` : 'hors zone'}</span>
                    <small>${dep}</small>
                  </div>
                </th>`;
              })}
              ${canAdd ? html`<th class="add">${this.renderAdd(cities.length)}</th>` : nothing}
            </tr>
            <tr class="cards">
              <th class="corner2"></th>
              ${cities.map((c, i) => html`<th class="detail">
                <small class="muted">${fmt('pop', c.pop)} hab.${c.postcodes ? ` · ${String(c.postcodes).split(' ')[0]}` : ''}</small>
                <div class="wins">Meilleure sur ${wins[i].length} / ${judged.length}${tip('Meilleure sur…', 'Nombre de lignes où cette commune a la meilleure valeur, parmi les lignes qui ont un meilleur (égalités comprises). Avec « Différences seulement », seules les lignes affichées comptent.')}</div>
                <ul>${wins[i].filter((c) => !DETAIL_ONLY.test(c)).slice(0, 3).map((col) => html`<li>${COLUMNS[col].label}</li>`)}</ul>
              </th>`)}
              ${canAdd ? html`<th></th>` : nothing}
            </tr>
          </thead>
          <tbody>
            ${cities.length ? groups.map((g) => html`
              <tr class="sec"><td colspan=${span}><span>${g.title}${g.help ? tip(g.title, g.help) : nothing}</span></td></tr>
              ${g.lines.map((l) => html`<tr>
                <td class="label">${COLUMNS[l.column].label}${columnHelp(l.column) ? tip(COLUMNS[l.column].label, columnHelp(l.column)) : nothing}</td>
                ${l.values.map((v, i) => html`<td class=${l.best.includes(i) ? 'best' : ''}>${fmt(l.column, v)}${l.best.includes(i) ? html`<span class="mark" aria-label="meilleure"> ★</span>` : nothing}</td>`)}
                ${canAdd ? html`<td></td>` : nothing}
              </tr>`)}`)
            : html`<tr><td class="label"></td><td class="empty" colspan=${span - 1}>Ajoutez une commune avec le champ à droite : vos favoris sont proposés en premier.</td></tr>`}
          </tbody>
        </table>
      </div>
      <p class="muted small">Valeurs de la fiche de chaque commune, pour le type de bien de la stratégie. Les mêmes avertissements s’appliquent : survolez les « ? » pour le détail des calculs.</p>
    `;
  }

  private renderAdd(n: number) {
    const s = this.suggestions;
    return html`
      <div class="adder">
        <label class="muted small" for="ac">${n ? 'Ajouter une commune' : 'Choisir une commune'}</label>
        <input id="ac" class="ac" type="search" autocomplete="off" placeholder="Nom ou code postal…" .value=${this.query}
          role="combobox" aria-expanded=${this.acOpen && s.length ? 'true' : 'false'} aria-controls="aclist"
          @focus=${() => (this.acOpen = true)} @blur=${() => setTimeout(() => (this.acOpen = false), 150)}
          @input=${(e: Event) => { this.query = (e.target as HTMLInputElement).value; this.acIndex = 0; this.acOpen = true; }}
          @keydown=${(e: KeyboardEvent) => this.onKey(e)}>
        ${this.acOpen && (s.length || this.query) ? html`
          <div class="acmenu" id="aclist" role="listbox">
            ${s.some((x) => x.fav) ? html`<div class="h">★ Favoris</div>` : nothing}
            ${s.map((x, i) => html`
              ${i > 0 && s[i - 1].fav && !x.fav ? html`<div class="h">Autres communes</div>` : nothing}
              ${i === 0 && !x.fav ? html`<div class="h">Communes</div>` : nothing}
              <div class="i ${i === this.acIndex ? 'hl' : ''}" role="option" aria-selected=${i === this.acIndex ? 'true' : 'false'}
                @mousedown=${(e: Event) => { e.preventDefault(); this.add(x.row.code); }} @mouseenter=${() => (this.acIndex = i)}>
                ${x.fav ? html`<span class="favstar">★</span>` : nothing}<span>${x.row.nom}</span>
                <small>${typeof x.row.postcodes === 'string' ? x.row.postcodes.split(' ')[0] : ''} · ${x.row.dep}</small>
              </div>`)}
            ${!s.length ? html`<div class="none">Aucune commune ne correspond.</div>` : nothing}
          </div>` : nothing}
        ${!n && !this.favorites.length ? html`<p class="muted small hint">Astuce : l’étoile ☆ d’une commune l’ajoute à vos favoris, proposés ici en premier.</p>` : nothing}
      </div>`;
  }

  static styles = css`
    :host { display: flex; flex-direction: column; gap: 10px; padding: 14px 22px 26px; }
    .muted { color: var(--muted); } .small { font-size: 12.5px; margin: 0; }
    .bar { display: flex; } .grow { flex: 1; }
    .link { border: 0; background: none; padding: 0; color: var(--brand-2); font: inherit; font-weight: 600; cursor: pointer; }
    .link:hover { text-decoration: underline; }
    .title { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
    .title h2 { margin: 0; font-size: 20px; letter-spacing: -.02em; }
    .btn { display: inline-flex; align-items: center; gap: 8px; border: 1px solid var(--line); background: var(--surface); color: var(--ink); padding: 7px 13px; border-radius: 10px; cursor: pointer; font: inherit; font-weight: 550; white-space: nowrap; }
    .btn:hover { background: var(--hover); } .btn:disabled { opacity: .5; cursor: default; }
    .switchlabel { display: inline-flex; align-items: center; gap: 8px; font-size: 13.5px; color: var(--ink-2); cursor: pointer; }
    .switch { appearance: none; width: 34px; height: 20px; border-radius: 999px; background: var(--switch-off); position: relative; cursor: pointer; margin: 0; transition: background .15s; }
    .switch::after { content: ''; position: absolute; top: 2px; left: 2px; width: 16px; height: 16px; border-radius: 50%; background: #fff; transition: transform .15s; box-shadow: 0 1px 2px rgba(0,0,0,.25); }
    .switch:checked { background: var(--brand-2); } .switch:checked::after { transform: translateX(14px); }
    .card { background: var(--surface); border: 1px solid var(--line); border-radius: var(--radius, 14px); box-shadow: var(--shadow); }

    /* One scroll box: the header rows stick to its top, the label column to its left. */
    .scroller { overflow: auto; max-height: calc(100vh - var(--header-h, 56px) - 150px); position: relative; }
    table { border-collapse: separate; border-spacing: 0; width: 100%; min-width: calc(250px + var(--n) * 190px); table-layout: fixed; }
    th, td { padding: 8px 12px; border-bottom: 1px solid var(--row-line); font-variant-numeric: tabular-nums; }
    td { text-align: right; }
    th { background: var(--surface); text-align: left; font-weight: 500; vertical-align: top; }
    th.corner, td.label { position: sticky; left: 0; width: 250px; background: var(--surface); z-index: 1; border-right: 1px solid var(--line); }
    th.corner { top: 0; z-index: 4; vertical-align: middle; }
    th.corner2 { position: sticky; left: 0; z-index: 1; border-right: 1px solid var(--line); }
    td.label { text-align: left; color: var(--ink-2); }
    tr.names th { position: sticky; top: 0; z-index: 3; border-bottom: 0; padding-bottom: 6px; box-shadow: 0 1px 0 var(--line); }
    tr.names th.corner { z-index: 4; border-bottom: 1px solid var(--line); }
    th.add { position: sticky; top: 0; z-index: 3; width: 230px; }
    tr.cards th { border-bottom: 1px solid var(--line); padding-top: 2px; }
    .head { display: flex; align-items: center; gap: 6px; }
    .cname { color: var(--ink); font-size: 15px; font-weight: 700; text-align: left; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; }
    .star, .x { border: 0; background: none; padding: 0 2px; cursor: pointer; font-size: 16px; line-height: 1; color: var(--faint); }
    .star.on, .favstar { color: #e0a100; } .x { margin-left: auto; font-size: 18px; } .x:hover { color: var(--bad); }
    .sub { display: flex; align-items: center; gap: 6px; margin-top: 4px; font-size: 13px; color: var(--muted); }
    .sub b { color: var(--ink); font-size: 15px; } .sub small { margin-left: auto; font-size: 11.5px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .tier { display: inline-grid; place-items: center; min-width: 20px; height: 20px; border-radius: 6px; font-size: 11px; font-weight: 800; }
    .detail small { font-size: 12px; }
    .wins { color: var(--good); font-weight: 650; font-size: 12.5px; margin-top: 4px; display: flex; align-items: center; }
    .detail ul { margin: 4px 0 0; padding-left: 16px; font-size: 12.5px; color: var(--ink-2); }
    tr.sec td { background: var(--surface-2); text-align: left; padding: 7px 12px; }
    tr.sec td span { position: sticky; left: 12px; display: inline-flex; align-items: center; font-size: 11.5px; font-weight: 700; letter-spacing: .05em; text-transform: uppercase; color: var(--ink-2); }
    td.best { background: var(--good-bg); color: var(--good); font-weight: 700; }
    .mark { font-size: 11px; }
    td.empty { text-align: center; color: var(--muted); padding: 30px; }
    tbody tr:hover td:not(.label) { filter: brightness(.98); }

    .adder { position: relative; display: flex; flex-direction: column; gap: 4px; font-weight: 400; }
    .ac { width: 100%; border: 1.5px solid var(--brand-2); border-radius: 9px; padding: 7px 10px; font: inherit; background: var(--input-bg); color: var(--ink); }
    .ac:focus { outline: 2px solid var(--brand-soft); }
    .acmenu { position: absolute; left: 0; right: 0; top: 100%; margin-top: 4px; background: var(--surface); border: 1px solid var(--line); border-radius: 10px; box-shadow: var(--shadow); z-index: 10; overflow: hidden; max-height: 320px; overflow-y: auto; }
    .acmenu .h { font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: .05em; color: var(--muted); padding: 8px 10px 3px; }
    .acmenu .i { display: flex; align-items: center; gap: 6px; padding: 6px 10px; cursor: pointer; font-size: 13.5px; }
    .acmenu .i small { margin-left: auto; color: var(--faint); white-space: nowrap; }
    .acmenu .i.hl { background: var(--brand-soft); }
    .acmenu .none { padding: 10px; color: var(--muted); font-size: 13px; }
    .hint { margin-top: 6px; }
    .printonly { display: none; }
    @media print {
      :host { padding: 0; }
      .bar, .btn, .switchlabel, info-tip, .x, .star, th.add, td:last-child:empty { display: none !important; }
      .scroller { max-height: none; overflow: visible; box-shadow: none; }
      table { min-width: 0; font-size: 11px; }
      th, td { padding: 4px 6px; }
      tr.names th, th.corner, td.label { position: static; }
      tr { break-inside: avoid; }
      .printonly { display: block; font-size: 11px; color: #555; margin: 0; }
    }
  `;
}
