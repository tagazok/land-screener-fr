// What the assistant knows about the data: the indicators it may filter on, and
// everyday words mapped to them. Kept compact: Chrome's on-device model has a
// small context window, so only the indicators relevant to a question are sent.

import { COLUMNS, STRATEGIES } from '../strategies';

export interface CatalogEntry {
  id: string;
  label: string;
  /** What the model must write as a value: "%" means a percentage (5 = 5 %). */
  unit: string;
  kind: 'number' | 'bool';
  hint: string;
}

const UNIT: Record<string, string> = {
  pct: '%', pct_raw: '%', eur: '€', eur_m2: '€/m²', eur_m2_month: '€/m²/mois', count: 'nombre', days: 'jours/an',
  km: 'km', density: 'hab./km²', num: '', ugl: 'µg/L', m: 'm',
};

/** Columns the assistant must not touch (identifiers, text, per-year raw series). */
const SKIP = /^(code|nom|dep|lon|lat|epci|hist_|nhist_|tour_beds_20|second_homes_20|aav_name|town3000_name)/;

function firstSentence(s = ''): string {
  const i = s.search(/[.:](\s|$)/);
  return (i > 0 ? s.slice(0, i) : s).slice(0, 140);
}

export const CATALOG: CatalogEntry[] = Object.entries(COLUMNS)
  .filter(([id, c]) => !SKIP.test(id) && c.unit !== 'text')
  .map(([id, c]) => ({
    id,
    label: c.label,
    unit: c.unit === 'bool' ? 'oui/non' : UNIT[c.unit] ?? '',
    kind: c.unit === 'bool' ? 'bool' : 'number',
    hint: firstSentence(c.def),
  }));

export const CATALOG_IDS = CATALOG.map((c) => c.id);
const BY_ID = new Map(CATALOG.map((c) => [c.id, c]));

/** Values the model writes as percentages are stored as ratios (0.05). */
export function toStored(column: string, value: number): number {
  return COLUMNS[column]?.unit === 'pct' ? value / 100 : value;
}

/**
 * Everyday concepts -> indicators, with a suggested rule. Sent to the model as guidance,
 * and used to pick which indicators to show it.
 */
export const CONCEPTS: { words: RegExp; text: string; columns: string[] }[] = [
  { words: /pollu|contamin|pfas|pesticid|sol|potager|poule/i, columns: ['pesticide_breach_share', 'pfas_max', 'sis_count', 'polluted_site_count', 'casias_per_km2'],
    text: 'pas de pollution = pesticide_breach_share max 0, pfas_max max 0.1, sis_count max 0, polluted_site_count max 0, casias_per_km2 max 1' },
  { words: /feu|incendi|fire/i, columns: ['risk_forest_fire', 'ppr_fire'], text: 'pas de risque de feu = risk_forest_fire is_false' },
  { words: /eau|water|sécheresse|secheresse|restriction|robinet/i, columns: ['water_limit_breach_share', 'crisis_days_avg', 'drought_days_avg', 'pesticide_breach_share', 'pfas_max'],
    text: 'pas de problème d’eau = water_limit_breach_share max 0, crisis_days_avg max 10, drought_days_avg max 30, pesticide_breach_share max 0' },
  { words: /inond|flood|crue/i, columns: ['catnat_flood', 'ppr_flood', 'risk_flood', 'risk_marine_flood'], text: 'aucune inondation enregistrée = catnat_flood max 0 ; pas de plan inondation = ppr_flood is_false' },
  { words: /forêt|foret|bois|forest|arbre/i, columns: ['forest_around_share', 'forest_share'], text: 'près d’une forêt = forest_around_share min 30' },
  { words: /montagne|colline|vallon|relief|plat|altitude|mountain|hill/i, columns: ['relief_m', 'alt_mean'], text: 'terrain non plat / collines = relief_m min 100 ; montagne = relief_m min 400' },
  { words: /habitant|village|ville|population|taille/i, columns: ['pop', 'town3000_km'], text: 'village = pop max 2000 ; ville proche de 3 000 hab. = town3000_km max 10' },
  { words: /croiss|grandi|augment|gagne|population/i, columns: ['pop_cagr_11y'], text: 'population en croissance = pop_cagr_11y min 0' },
  { words: /touris|vacance|saison|résidence secondaire/i, columns: ['tourist_beds_per_1000', 'tour_beds_change', 'second_homes_change', 'second_home_share'],
    text: 'touristique = tourist_beds_per_1000 min 100 ou second_home_share min 15 ; le devient = second_homes_change min 10 ou tour_beds_change min 5' },
  { words: /risque|risk/i, columns: ['risk_count'], text: 'risques signalés = risk_count (0 à 9)' },
  { words: /prix|cher|coût|cout|baiss|hausse|appart|maison|price/i, columns: ['price_m2', 'price_trend_house', 'price_trend_apt', 'price_trend_3y'],
    text: 'prix des appartements en baisse sur 3 ans = price_trend_apt max 0 ; maisons = price_trend_house max 0' },
  { words: /parking|garage|box|stationnement|place de|voiture/i, columns: ['parking_price', 'n_parking_sales', 'parking_gross_yield', 'parking_gap_share', 'car_share', 'parking_spot_share', 'zfe_share'],
    text: 'investir dans un parking/garage = strategy "parking" ; demande = parking_gap_share min 10 ; prix d’une place = parking_price ; rendement parking = parking_gross_yield (nécessite un loyer saisi)' },
  { words: /rendement|rentab|loyer|invest|cash/i, columns: ['gross_yield', 'net_yield', 'cashflow_month', 'rent_m2'], text: 'rendement en %' },
  { words: /médecin|medecin|santé|sante|service|école|ecole/i, columns: ['apl_gp', 'services_km', 'college_ips'], text: 'désert médical = apl_gp < 2.5' },
  { words: /crime|cambriol|sécurité|securite|violence/i, columns: ['crime_burglary', 'crime_violence'], text: 'pour 1000 logements / habitants' },
  { words: /air|ozone|particule/i, columns: [], text: 'la qualité de l’air n’est pas encore disponible' },
];

const ALWAYS = ['pop', 'risk_count', 'price_m2', 'pop_cagr_11y'];

/** Indicators relevant to a question (all of them when `all` is set, for large models). */
export function relevant(question: string, all = false): { entries: CatalogEntry[]; hints: string[] } {
  if (all) return { entries: CATALOG, hints: CONCEPTS.map((c) => c.text) };
  const hit = CONCEPTS.filter((c) => c.words.test(question));
  const ids = new Set([...ALWAYS, ...hit.flatMap((c) => c.columns)]);
  // Also any indicator whose label words appear in the question.
  const q = question.toLowerCase();
  for (const c of CATALOG) if (c.label.length > 4 && q.includes(c.label.toLowerCase())) ids.add(c.id);
  return { entries: [...ids].map((i) => BY_ID.get(i)).filter((x): x is CatalogEntry => !!x), hints: hit.map((c) => c.text) };
}

export function describe(entries: CatalogEntry[]): string {
  return entries.map((c) => `- ${c.id} (${c.label}${c.unit ? `, ${c.unit}` : ''}${c.hint ? ` : ${c.hint}` : ''})`).join('\n');
}

export const STRATEGY_IDS = STRATEGIES.map((s) => s.id);
export const STRATEGY_TEXT = STRATEGIES.map((s) => `${s.id} = ${s.label}`).join(' ; ');
