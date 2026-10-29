// Test questions for the assistant, with the filters a correct plan must contain.
// "expect" lists column:op pairs; extra filters are allowed but reported.

export interface EvalQuestion {
  id: string;
  text: string;
  mode: 'answer' | 'action';
  expect: string[];
  /** Expected web_search routing (default false). */
  web?: boolean;
}

export const QUESTIONS: EvalQuestion[] = [
  { id: 'risks', mode: 'action', text: 'Masque les communes avec plus de 3 risques', expect: ['risk_count:max'] },
  { id: 'apt-down', mode: 'action', text: 'Montre-moi toutes les communes où le prix des appartements a baissé ces 3 dernières années', expect: ['price_trend_apt:max'] },
  { id: 'forest-layer', mode: 'action', text: 'Affiche les forêts sur la carte', expect: [] },
  { id: 'color-price', mode: 'action', text: 'Colore la carte par prix au m²', expect: [] },
  { id: 'gironde-yield', mode: 'answer', text: 'Quelles communes de Gironde ont un rendement brut supérieur à 6 % ?', expect: ['gross_yield:min'] },
  { id: 'pfas', mode: 'action', text: 'Exclus les communes où l’eau du robinet dépasse la limite PFAS', expect: ['pfas_max:max|pfas_breach_share:max'] },
  { id: 'small-growing', mode: 'answer', text: 'Je cherche un village de moins de 1500 habitants dont la population augmente', expect: ['pop:max', 'pop_cagr_11y:min'] },
  { id: 'no-flood-hills', mode: 'answer', text: 'Une commune vallonnée sans aucune inondation enregistrée, dans les Vosges', expect: ['relief_m:min', 'catnat_flood:max'] },
  { id: 'tourism-rising', mode: 'answer', text: 'Quelles communes deviennent de plus en plus touristiques ?', expect: ['second_homes_change:min'] },
  {
    id: 'followup', mode: 'answer', expect: ['none'],
    text: 'Échange précédent :\nUtilisateur : Je cherche une ville du Nord avec un bon rendement\nAssistant : Roubaix correspond à votre recherche, avec un rendement brut de 7 %, mais un risque est identifié.\n\nNouvelle demande : quel est ce risque ?',
  },
  { id: 'web-projects', mode: 'answer', expect: ['none'], web: true, text: 'Y a-t-il des projets d’aménagement ou de construction en cours à Gérardmer ?' },
  { id: 'web-life', mode: 'answer', expect: ['none'], web: true, text: 'Comment est la vie associative et culturelle à Remiremont ?' },
  { id: 'data-risk', mode: 'answer', expect: ['none'], web: false, text: 'Quels sont les risques naturels à Gérardmer ?' },
  { id: 'tiers-best', mode: 'action', text: 'Garde seulement les communes des groupes A et B', expect: ['tiers:AB'] },
  { id: 'tiers-below', mode: 'action', text: 'Seulement celles avec un score inférieur à C', expect: ['tiers:DE'] },
  {
    id: 'olivier', mode: 'answer',
    text: 'Je veux vivre dans un endroit sans pollution, sans risque de feu et sans problème d’eau (pollution ou restrictions). Un petit village de 1000 habitants me va très bien tant qu’il y a une ville d’environ 3000 habitants à proximité. Je veux être près d’une forêt, de préférence sur un terrain qui n’est pas plat : j’aime la montagne ou les collines, et marcher dans ces endroits. Aucune inondation enregistrée. Une population en croissance de préférence, mais ce n’est pas un critère essentiel. Un endroit touristique, et qui l’est devenu récemment.',
    expect: ['risk_forest_fire:is_false', 'forest_around_share:min', 'relief_m:min', 'catnat_flood:max', 'town3000_km:max', 'pesticide_breach_share:max', 'water_limit_breach_share:max'],
  },
];
