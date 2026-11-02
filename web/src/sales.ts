/** Sale point colours by type: house, flat, building land, outbuilding. */
export const SALE_COLORS = { M: '#2563eb', A: '#a21caf', T: '#b45309', D: '#64748b' } as const;
const SALE_LABEL: Record<string, string> = { M: 'Maison', A: 'Appartement', T: 'Terrain à bâtir', D: 'Dépendance (garage, parking, cave)' };
const NATURE: Record<string, string> = { F: 'vente en l’état futur d’achèvement (neuf)', J: 'adjudication (vente aux enchères)', B: 'vente de terrain à bâtir' };
/** DVF "nature de culture" codes. */
const LAND: Record<string, string> = {
  S: 'sol bâti', AG: 'agrément', J: 'jardin', AB: 'à bâtir', T: 'terres', P: 'prés', PA: 'pâtures', PC: 'pacages', VI: 'vignes',
  VE: 'vergers', B: 'bois', BR: 'futaies résineuses', BF: 'futaies feuillues', BM: 'futaies mixtes', BT: 'taillis', BS: 'taillis sous futaie',
  BP: 'peupleraies', BO: 'oseraies', L: 'landes', LB: 'landes boisées', E: 'eaux', CA: 'carrières', CH: 'chemin de fer', TP: 'terres plantées',
};
const eur = (v: number) => v.toLocaleString('fr-FR', { maximumFractionDigits: 0 }) + ' €';
const int = (v: number) => v.toLocaleString('fr-FR', { maximumFractionDigits: 0 });
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

/** Cadastral parcel id "33522000AB0123" -> "section AB n° 123". */
export function parcelLabel(id: string): string {
  const m = /^\w{5}\w{3}([0-9A-Z]{2})(\d{4})$/.exec(id);
  return m ? `section ${m[1].replace(/^0/, '')} n° ${Number(m[2])}` : id;
}

/** One sale (DVF), as HTML for the popup. Text values are escaped: they come from the tiles. */
export function saleHtml(p: Record<string, unknown>, at: [number, number]): string {
  const n = (k: string) => (typeof p[k] === 'number' ? (p[k] as number) : null);
  const str = (k: string) => (typeof p[k] === 'string' && p[k] ? (p[k] as string) : null);
  const price = n('p'), s = n('s'), l = n('l'), r = n('r'), g = n('g'), k = n('k'), nl = n('nl'), np = n('np');
  const t = str('t') ?? '';
  const date = str('d');
  const nature = NATURE[str('n') ?? ''];
  const land = (str('c') ?? '').split(',').map((x) => x.split(':')).filter(([c, m]) => c && Number(m) > 0)
    .map(([c, m]) => `${LAND[c] ?? c} ${int(Number(m))} m²`);
  const q = str('q');
  const cadastre = `https://www.geoportail.gouv.fr/carte?c=${at[0].toFixed(6)},${at[1].toFixed(6)}&z=19&l0=ORTHOIMAGERY.ORTHOPHOTOS::GEOPORTAIL:OGC:WMTS(1)&l1=CADASTRALPARCELS.PARCELLAIRE_EXPRESS::GEOPORTAIL:OGC:WMTS(1)&permalink=yes`;
  const lines = [
    `<b>${SALE_LABEL[t] ?? 'Vente'}</b>${date ? ` · <span>${new Date(date).toLocaleDateString('fr-FR', { day: 'numeric', month: 'long', year: 'numeric' })}</span>` : ''}`,
    price !== null ? `<span class="big">${eur(price)}</span>${price && s && (t === 'M' || t === 'A') ? ` <span class="sub">${eur(price / s)}/m²</span>` : price && l && t === 'T' ? ` <span class="sub">${eur(price / l)}/m²</span>` : ''}` : '',
    str('a') ? `<span class="addr">${esc(str('a')!)}</span>` : '',
    [s ? `${s} m² habitables` : '', r ? `${r} pièce${r > 1 ? 's' : ''}` : '', k ? `Carrez ${k.toLocaleString('fr-FR')} m²` : ''].filter(Boolean).join(' · '),
    [g ? `avec ${g} dépendance${g > 1 ? 's' : ''} (garage, cave…)` : '', nl ? `${nl} lot${nl > 1 ? 's' : ''} de copropriété` : ''].filter(Boolean).join(' · '),
    l ? `Terrain ${int(l)} m²${land.length ? ` : ${land.join(', ')}` : ''}` : '',
    nature ? `<span class="sub">${nature}</span>` : '',
    q ? `<span class="sub">Parcelle ${esc(parcelLabel(q))}${np ? ` (+${np - 1} autre${np > 2 ? 's' : ''})` : ''} · <a href="${cadastre}" target="_blank" rel="noopener noreferrer">voir sur le cadastre ↗</a></span>` : '',
  ];
  return `<div class="sale">${lines.filter(Boolean).join('<br>')}</div>`;
}

/** Several sales at one spot (lots of one building, or resales): newest first. */
export function salesHtml(list: Record<string, unknown>[], at: [number, number]): string {
  const sorted = [...list].sort((a, b) => String(b.d ?? '').localeCompare(String(a.d ?? '')));
  const shown = sorted.slice(0, 6);
  const more = sorted.length - shown.length;
  return (sorted.length > 1 ? `<div class="count">${sorted.length} ventes à cet endroit</div>` : '')
    + shown.map((p) => saleHtml(p, at)).join('<hr>')
    + (more > 0 ? `<div class="sub">… et ${more} autre${more > 1 ? 's' : ''} (zoomez pour les séparer)</div>` : '')
    + '<div class="src">Source : DVF (DGFiP)</div>';
}
