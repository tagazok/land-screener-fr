// Strategy presets, column dictionary and all explanatory texts (French).
// Presets are data: filters decide pass/fail, weights only order the survivors.

import type { FilterDef, Row, SignalDef } from './engine';

export type StrategyId = 'long' | 'medium' | 'short' | 'live' | 'land';
export type PropertyType = 'house' | 'apt';

export interface ColumnInfo {
  label: string;
  unit: 'eur' | 'eur_m2' | 'eur_m2_month' | 'pct' | 'pct_raw' | 'count' | 'days' | 'bool' | 'text' | 'num' | 'density' | 'km';
  /** What the value means. */
  def?: string;
  /** How it is calculated, and from which source. */
  calc?: string;
}

/** Tooltip text for a column: meaning, then "Calcul : ..." when there is one. */
export function columnHelp(column: string): string {
  const c = COLUMNS[column];
  if (!c) return '';
  return [c.def, c.calc ? `Calcul : ${c.calc}` : ''].filter(Boolean).join('\n\n');
}

export const COLUMNS: Record<string, ColumnInfo> = {
  nom: { label: 'Commune', unit: 'text' },
  pop: {
    label: 'Population', unit: 'count',
    def: 'Nombre d’habitants en 2022 (recensement INSEE).',
  },
  price_m2: {
    label: 'Prix €/m²', unit: 'eur_m2',
    def: 'Prix de vente médian au m² habitable, pour le type de bien choisi (maison ou appartement), sur les 24 derniers mois (2024–2025). La médiane est le prix du milieu : la moitié des ventes est au-dessus, l’autre moitié en dessous.',
    calc: 'source DVF (actes de vente enregistrés par les impôts). On garde les ventes classiques d’un seul logement, avec ou sans dépendance (garage, cave), sans local commercial, d’au moins 9 m². Prix ÷ surface habitable, puis médiane. Les prix sous 300 €/m² ou au-dessus de 20 000 €/m² sont écartés (erreurs probables). Vide s’il y a moins de 5 ventes.',
  },
  n_sales: {
    label: 'Ventes', unit: 'count',
    def: 'Nombre de ventes utilisées pour calculer le prix médian, sur 24 mois. Moins il y en a, moins le prix est fiable : en dessous de 10, prenez-le comme un ordre de grandeur.',
  },
  rent_m2: {
    label: 'Loyer €/m²/mois', unit: 'eur_m2_month',
    def: 'Loyer mensuel estimé au m², charges comprises, pour un logement loué vide (non meublé), mis en location au 3e trimestre 2025.',
    calc: 'estimation de l’ANIL (« Carte des loyers ») à partir des annonces SeLoger et leboncoin. C’est un modèle statistique, pas une moyenne de loyers réels. Logement de référence : appartement de 52 m², maison de 92 m² (au-delà, le loyer au m² baisse en général). Dans la plupart des petites communes, le loyer est estimé pour un groupe de communes voisines comparables.',
  },
  rent_confidence: {
    label: 'Fiabilité loyer', unit: 'text',
    def: 'Fiabilité de l’estimation de loyer, selon les critères de l’ANIL.',
    calc: 'Élevée : qualité du modèle (R²) au moins 0,5, au moins 30 annonces dans la commune et intervalle de prédiction étroit (moins de 60 % du loyer). Moyenne : R² au moins 0,5, mais peu d’annonces ou intervalle large. Faible : R² sous 0,5, à prendre avec beaucoup de prudence.',
  },
  gross_yield: {
    label: 'Rendement brut', unit: 'pct',
    def: 'Loyer annuel rapporté au prix d’achat, avant toute dépense.',
    calc: 'loyer €/m²/mois × 12 ÷ prix €/m². Exemple : 10 €/m²/mois et 2 000 €/m² → 120 ÷ 2 000 = 6 %. Ne déduit ni la taxe foncière, ni les charges, ni la vacance, ni les travaux, ni les frais de notaire. Le loyer étant charges comprises, ce rendement est un peu surestimé.',
  },
  price_trend_3y: {
    label: 'Prix sur 3 ans', unit: 'pct',
    def: 'Évolution du prix médian au m² en 3 ans, maisons et appartements confondus.',
    calc: 'médiane des ventes de 2025 comparée à la médiane des ventes de 2022. Vide s’il y a moins de 10 ventes dans l’une des deux années.',
  },
  land_price_m2: {
    label: 'Terrain €/m²', unit: 'eur_m2',
    def: 'Prix médian au m² des terrains à bâtir vendus sur les 36 derniers mois (2023–2025).',
    calc: 'source DVF. Ventes de terrains à bâtir sans construction, d’au moins 100 m². Prix ÷ surface du terrain, puis médiane. Les prix sous 2 €/m² ou au-dessus de 2 000 €/m² sont écartés. Vide s’il y a moins de 3 ventes.',
  },
  n_land_sales: {
    label: 'Ventes de terrains', unit: 'count',
    def: 'Nombre de ventes de terrains à bâtir utilisées, sur 36 mois.',
  },
  pop_cagr_11y: {
    label: 'Croissance pop./an', unit: 'pct',
    def: 'Croissance moyenne de la population par an entre 2011 et 2022. Une commune qui gagne des habitants a plus de demande de logements.',
    calc: '(population 2022 ÷ population 2011) puissance 1/11, moins 1. Exemple : +1 % par an ≈ +12 % en 11 ans.',
  },
  density: {
    label: 'Densité', unit: 'density',
    def: 'Habitants par km² en 2022. Indique s’il s’agit d’une ville, d’un bourg ou d’une zone rurale.',
    calc: 'population 2022 ÷ superficie de la commune.',
  },
  median_income: {
    label: 'Revenu médian', unit: 'eur',
    def: 'Niveau de vie médian en 2021 : revenu disponible par an, après impôts et prestations sociales, par « unité de consommation » (INSEE Filosofi, dernière année disponible).',
    calc: 'le revenu du ménage est divisé par son nombre d’unités de consommation : 1 pour le premier adulte, 0,5 par autre personne de 14 ans ou plus, 0,3 par enfant de moins de 14 ans. Vide pour les petites communes (secret statistique).',
  },
  vacancy_rate: {
    label: 'Vacance', unit: 'pct',
    def: 'Part des logements vides en 2022 (ni occupés, ni résidence secondaire). Une vacance basse signale un marché locatif tendu, où l’on trouve facilement un locataire.',
    calc: 'logements vacants ÷ total des logements (recensement INSEE 2022).',
  },
  second_home_share: {
    label: 'Résidences secondaires', unit: 'pct',
    def: 'Part des résidences secondaires en 2022. Élevée dans les communes touristiques ; signe aussi d’une forte concurrence et, souvent, de règles plus strictes sur la location courte durée.',
    calc: 'résidences secondaires et logements occasionnels ÷ total des logements (INSEE 2022).',
  },
  tourist_beds_per_1000: {
    label: 'Lits touristiques /1000 hab.', unit: 'num',
    def: 'Capacité d’hébergement touristique professionnel rapportée à la population : mesure l’attractivité touristique. N’inclut pas les meublés de particuliers (Airbnb…).',
    calc: '(chambres d’hôtel × 2 + emplacements de camping × 3 + lits des résidences et villages de vacances) ÷ population × 1 000. Source INSEE 2025. Les coefficients 2 et 3 sont une convention courante pour convertir en lits.',
  },
  tfpb_rate: {
    label: 'Taux taxe foncière', unit: 'pct_raw',
    def: 'Taux total de la taxe foncière sur les propriétés bâties en 2025 : commune + intercommunalité + syndicats + taxe spéciale d’équipement + GEMAPI. Hors taxe d’ordures ménagères.',
    calc: 'le taux ne s’applique pas au prix du bien mais à sa « base » : la moitié de la valeur locative cadastrale fixée par les impôts. Exemple : base de 2 000 € × 40 % = 800 € de taxe par an. Le montant dépend donc du bien, pas seulement du taux. Source DGFiP, fichier REI 2025.',
  },
  second_home_surcharge: {
    label: 'Surtaxe résid. secondaires', unit: 'pct_raw',
    def: 'Majoration de la taxe d’habitation sur les résidences secondaires votée par la commune, de 0 à 60 %. Elle touche les logements meublés qui ne sont la résidence principale de personne, donc en général les meublés de tourisme. Elle ne touche pas un logement loué à l’année comme résidence principale du locataire.',
    calc: 'source DGFiP, fichier REI 2025.',
  },
  zone_tendue: {
    label: 'Zone tendue', unit: 'bool',
    def: 'Commune où l’offre de logements ne suit pas la demande (décret du 22/12/2025), y compris les zones « touristiques et tendues ».',
    calc: 'pour un propriétaire, cela implique notamment : préavis d’un mois pour le locataire, hausse de loyer encadrée à la relocation, taxe sur les logements vacants, et la commune peut surtaxer les résidences secondaires. C’est aussi un indice que la location courte durée y est, ou sera, encadrée : il n’existe pas de donnée nationale sur ces règles, vérifiez en mairie.',
  },
  zone_abc: {
    label: 'Zone ABC', unit: 'text',
    def: 'Classement national de la tension du marché du logement, de A bis (le plus tendu) à C (le moins tendu). Il sert aux aides et dispositifs comme le prêt à taux zéro.',
    calc: 'arrêté en vigueur au 26 juin 2026.',
  },
  risk_count: {
    label: 'Risques signalés', unit: 'count',
    def: 'Nombre de signaux de risque, sur 9, pour comparer rapidement les communes. Indique qu’un risque est reconnu, pas sa gravité, ni si un bien précis est exposé.',
    calc: '+1 pour chacun : plan de prévention inondation ; risque de submersion marine ; risque de feu de forêt ; plan de prévention des risques technologiques ; au moins 5 arrêtés de catastrophe naturelle « inondation » depuis 1996 ; potentiel radon de catégorie 3 ; plus de 60 jours par an de restriction d’eau renforcée ; plus de la moitié de la commune en exposition forte aux argiles ; commune listée pour le recul du trait de côte.',
  },
  catnat_flood: {
    label: 'Arrêtés inondation', unit: 'count',
    def: 'Nombre d’arrêtés de catastrophe naturelle pris pour la commune depuis 1996 pour inondation, coulée de boue ou remontée de nappe. Chaque arrêté correspond à un événement reconnu par l’État.',
    calc: 'source Géorisques, base GASPAR.',
  },
  ppr_flood: {
    label: 'Plan inondation', unit: 'bool',
    def: 'La commune a un plan de prévention des risques d’inondation, approuvé ou en cours d’élaboration. Certaines zones peuvent y être inconstructibles ou soumises à des règles de construction.',
    calc: 'source Géorisques, base GASPAR (plans opposables ou prescrits).',
  },
  risk_marine_flood: {
    label: 'Submersion marine', unit: 'bool',
    def: 'Risque d’inondation par la mer recensé pour la commune par la préfecture.',
    calc: 'source Géorisques, base GASPAR (dossier départemental des risques majeurs).',
  },
  risk_forest_fire: {
    label: 'Feu de forêt', unit: 'bool',
    def: 'Risque de feu de forêt recensé pour la commune. Peut imposer au propriétaire des obligations de débroussaillement.',
    calc: 'source Géorisques, base GASPAR (dossier départemental des risques majeurs).',
  },
  ppr_industrial: {
    label: 'Plan technologique', unit: 'bool',
    def: 'Plan de prévention des risques technologiques : un site industriel dangereux (Seveso) est proche d’une partie de la commune.',
    calc: 'source Géorisques, base GASPAR (plans approuvés ou prescrits).',
  },
  radon_class: {
    label: 'Radon', unit: 'num',
    def: 'Potentiel radon de la commune, de 1 (faible) à 3 (significatif). Le radon est un gaz radioactif naturel qui peut s’accumuler dans les bâtiments ; en catégorie 3, il doit être signalé aux acheteurs et locataires.',
    calc: 'source ASNR (ex-IRSN), arrêté du 27 juin 2018.',
  },
  drought_days_avg: {
    label: 'Jours de sécheresse/an', unit: 'days',
    def: 'Nombre moyen de jours par an où la commune était en restriction d’eau « alerte renforcée » ou « crise » (arrosage, piscines, lavage, agriculture limités ou interdits).',
    calc: 'moyenne 2021–2025, toutes ressources confondues (eau potable, eaux souterraines, eaux de surface). Source VigiEau.',
  },
  crisis_days_avg: {
    label: 'Jours de crise eau/an', unit: 'days',
    def: 'Nombre moyen de jours par an au niveau « crise », le plus sévère : seuls les usages prioritaires (santé, sécurité, eau potable, salubrité) sont autorisés.',
    calc: 'moyenne 2021–2025, toutes ressources confondues. Source VigiEau.',
  },
  drinking_water_days_avg: {
    label: 'Restriction eau potable/an', unit: 'days',
    def: 'Nombre moyen de jours par an où la ressource qui sert à l’eau potable était elle-même en restriction (niveau « alerte » ou plus). C’est le signal le plus direct d’un approvisionnement en eau fragile.',
    calc: 'moyenne 2021–2025, zones d’alerte « eau potable » de VigiEau. Dans beaucoup de départements, aucune restriction sur l’eau potable n’est enregistrée sur cette période : la valeur y est alors 0 partout.',
  },
  water_limit_breach_share: {
    label: 'Eau du robinet non conforme', unit: 'pct',
    def: 'Part des analyses d’eau du robinet de 2025 qui dépassaient une limite de qualité sanitaire (bactéries, nitrates, pesticides…), sur les réseaux qui alimentent la commune. 0 % est la norme ; quelques pour cent signalent un problème récurrent.',
    calc: 'contrôle sanitaire des Agences régionales de santé (Ministère de la Santé). Analyses dépassant une limite ÷ nombre d’analyses, tous réseaux de la commune confondus. Un dépassement ponctuel n’interdit pas toujours de boire l’eau ; l’ARS informe alors la mairie et les habitants.',
  },
  clay_high_share: {
    label: 'Argile : exposition forte', unit: 'pct',
    def: 'Part de la surface de la commune en exposition forte au retrait-gonflement des argiles. Ces sols se rétractent quand ils sèchent et gonflent quand ils se réhumidifient : les maisons individuelles sur fondations peu profondes se fissurent. C’est la deuxième cause d’indemnisation des catastrophes naturelles, après les inondations, et elle augmente avec les sécheresses.',
    calc: 'intersection des contours de la commune avec la carte d’exposition officielle (arrêté du 9 janvier 2026, Géorisques / BRGM). Dans les zones d’exposition moyenne et forte, une étude de sol est obligatoire pour vendre un terrain constructible et pour construire une maison. La carte au 1/50 000 ne remplace pas une étude de sol sur la parcelle.',
  },
  clay_med_high_share: {
    label: 'Argile : moyenne ou forte', unit: 'pct',
    def: 'Part de la surface de la commune en exposition moyenne ou forte au retrait-gonflement des argiles (carte 2026).',
    calc: 'même méthode que l’exposition forte, en ajoutant les zones d’exposition moyenne.',
  },
  catnat_drought: {
    label: 'Arrêtés sécheresse', unit: 'count',
    def: 'Nombre d’arrêtés de catastrophe naturelle « sécheresse » pris pour la commune depuis 1996 : des maisons y ont été fissurées par le mouvement des sols argileux, et l’État l’a reconnu.',
    calc: 'source Géorisques, base GASPAR. Chaque arrêté compte une fois.',
  },
  coast_retreat_decree: {
    label: 'Recul du trait de côte', unit: 'bool',
    def: 'La commune figure sur la liste nationale des communes dont l’urbanisme doit s’adapter à l’érosion du littoral (décret du 13 février 2026). Elle doit cartographier les zones menacées à 30 ans et à 100 ans ; dans la zone à 30 ans, les constructions nouvelles sont en principe interdites.',
    calc: 'liste publiée par le Ministère de la Transition écologique (loi Climat et résilience, 2021).',
  },
  risk_coast_erosion: {
    label: 'Érosion côtière', unit: 'bool',
    def: 'Risque de recul du trait de côte, de falaises ou d’avancée dunaire recensé pour la commune par la préfecture.',
    calc: 'source Géorisques, base GASPAR (dossier départemental des risques majeurs).',
  },
  apl_gp: {
    label: 'Accès aux médecins', unit: 'num',
    def: 'Nombre de consultations de médecin généraliste accessibles par habitant et par an. Sous 2,5, la commune est considérée comme sous-dotée (« désert médical »). Repère : la moyenne nationale est d’environ 3,5.',
    calc: 'indicateur APL de la DREES, 2024. Il compte les médecins de la commune et des communes voisines jusqu’à 20 minutes de route, pondérés par la distance et par leur activité réelle, et tient compte de l’âge des habitants.',
  },
  apl_gp_65: {
    label: 'Accès médecins ≤ 65 ans', unit: 'num',
    def: 'Même indicateur en ne comptant que les médecins de 65 ans ou moins. Un écart important avec l’indicateur complet signale des départs en retraite prochains.',
    calc: 'indicateur APL de la DREES, 2024.',
  },
  gp_count: {
    label: 'Médecins dans la commune', unit: 'count',
    def: 'Nombre de médecins généralistes installés dans la commune.',
    calc: 'base permanente des équipements 2025 (INSEE).',
  },
  services_km: {
    label: 'Distance aux services', unit: 'km',
    def: 'Distance moyenne jusqu’aux services du quotidien : médecin généraliste, pharmacie, supermarché, boulangerie, école, collège et poste. Moins de 3 km : tout est sur place ou presque ; plus de 8 km : la voiture est indispensable pour tout.',
    calc: 'moyenne des 7 distances ci-dessous. Chaque distance est mesurée à vol d’oiseau jusqu’à la commune la plus proche qui a ce service (0 = dans la commune), entre centres de communes : c’est approximatif de quelques km. Source INSEE, base permanente des équipements 2025 ; les communes des départements voisins sont prises en compte.',
  },
  ...Object.fromEntries(
    ([
      ['gp', 'Médecin généraliste'], ['pharmacy', 'Pharmacie'], ['supermarket', 'Supermarché'],
      ['bakery', 'Boulangerie'], ['primary_school', 'École'], ['college', 'Collège'], ['lycee', 'Lycée'],
      ['emergency', 'Urgences'], ['train', 'Gare'], ['post', 'Poste'],
    ] as const).map(([k, l]) => [`dist_${k}_km`, {
      label: l, unit: 'km' as const,
      def: `Distance à vol d’oiseau jusqu’à la commune la plus proche qui a ce service. 0 km = dans la commune.`,
      calc: 'entre centres de communes, donc approximatif de quelques km ; la distance par la route est plus longue. Source INSEE, base permanente des équipements 2025.',
    }]),
  ),
  fibre_share: {
    label: 'Fibre', unit: 'pct',
    def: 'Part des logements et locaux de la commune éligibles à un débit d’au moins 1 Gbit/s (fibre optique), au 30 juin 2026. Important pour le télétravail.',
    calc: 'source ARCEP, « Ma connexion internet ».',
  },
  aav_category: {
    label: 'Position / ville', unit: 'text',
    def: 'Place de la commune dans l’aire d’attraction d’une ville (INSEE) : commune-centre, pôle, couronne (au moins 15 % des actifs travaillent dans le pôle) ou hors attraction des villes. Indique le lien avec un bassin d’emploi.',
    calc: 'zonage INSEE des aires d’attraction des villes 2020, géographie 2024.',
  },
  aav_name: { label: 'Aire d’attraction', unit: 'text', def: 'Ville dont la commune dépend pour l’emploi.' },
  aav_size: { label: 'Taille de l’aire', unit: 'text', def: 'Population de l’aire d’attraction (2017).' },
  // ---------------------------------------------------------------- rental investment simulation
  purchase_price: {
    label: 'Coût d’achat', unit: 'eur',
    def: 'Coût total estimé pour acheter le bien simulé : prix + frais de notaire.',
    calc: 'prix médian au m² (DVF) × surface simulée, + frais de notaire. Surface par défaut : 92 m² pour une maison, 52 m² pour un appartement (les surfaces de référence des loyers de l’ANIL) ; modifiable dans « Filtres et poids ».',
  },
  net_yield: {
    label: 'Rendement net', unit: 'pct',
    def: 'Ce que le bien rapporte chaque année, une fois payées les charges, la taxe foncière et les mois sans locataire, rapporté au coût total d’achat (frais de notaire compris). Avant impôt sur le revenu et avant crédit.',
    calc: '(loyer annuel − vacance − charges non récupérables, entretien et assurance − taxe foncière moyenne de la commune) ÷ (prix + frais de notaire). Hypothèses modifiables dans « Filtres et poids » → « Hypothèses d’achat ». Le loyer ANIL étant charges comprises, le rendement est un peu surestimé.',
  },
  cashflow_month: {
    label: 'Cash-flow/mois', unit: 'eur',
    def: 'Ce qui reste (ou ce qu’il faut ajouter) chaque mois une fois la mensualité du crédit payée. Positif : le loyer paie tout. Négatif : effort d’épargne mensuel.',
    calc: 'revenu net annuel ÷ 12 − mensualité du crédit. Crédit = coût total × (1 − apport), à taux fixe, assurance emprunteur et impôts non compris.',
  },
  tfpb_total_avg_eur: {
    label: 'Taxe foncière moyenne', unit: 'eur',
    def: 'Montant moyen de taxe foncière payé par compte de propriétaire dans la commune, toutes collectivités confondues. Un compte peut regrouper plusieurs biens : c’est un ordre de grandeur.',
    calc: 'montant de la part communale ÷ nombre de comptes (fichier REI 2025), multiplié par le rapport taux total ÷ taux communal.',
  },
  // ---------------------------------------------------------------- rental demand
  tenant_share: {
    label: 'Locataires', unit: 'pct',
    def: 'Part des résidences principales occupées par des locataires (parc privé, social et meublé). Plus elle est élevée, plus le marché locatif est profond : plus de candidats, et revente à un investisseur plus facile.',
    calc: 'locataires ÷ résidences principales, recensement INSEE 2023.',
  },
  private_rent_share: {
    label: 'Locataires parc privé', unit: 'pct',
    def: 'Part des résidences principales louées vides par un propriétaire privé : c’est le marché direct d’un investisseur en location longue durée.',
    calc: 'locataires d’un logement vide du parc privé ÷ résidences principales, INSEE 2023.',
  },
  furnished_share: {
    label: 'Locataires en meublé', unit: 'pct',
    def: 'Part des résidences principales louées meublées : indicateur de demande pour la location meublée (étudiants, mobilité).',
    calc: 'locataires d’un logement meublé ÷ résidences principales, INSEE 2023.',
  },
  social_share: {
    label: 'Logement social', unit: 'pct',
    def: 'Part des résidences principales en logement social (HLM). Un parc social abondant concurrence la location privée bon marché.',
    calc: 'locataires du parc social vide ÷ résidences principales, INSEE 2023.',
  },
  unemployment_rate: {
    label: 'Chômage', unit: 'pct',
    def: 'Part des actifs de 15 à 64 ans qui se déclarent au chômage. Un chômage élevé signale un bassin d’emploi faible : locataires moins solvables, demande plus fragile.',
    calc: 'chômeurs ÷ actifs de 15 à 64 ans, recensement INSEE 2023. Au sens du recensement (déclaratif), ce taux est plus élevé que le taux de chômage officiel du BIT.',
  },
  jobs: {
    label: 'Emplois', unit: 'count',
    def: 'Nombre d’emplois situés dans la commune (lieu de travail), en 2023.',
    calc: 'recensement INSEE 2023.',
  },
  jobs_per_active: {
    label: 'Emplois par actif', unit: 'num',
    def: 'Emplois situés dans la commune pour un actif qui y habite. Au-dessus de 1 : pôle d’emploi qui attire des salariés de l’extérieur (demande locative). En dessous de 0,5 : commune surtout résidentielle, on travaille ailleurs.',
    calc: 'emplois au lieu de travail ÷ actifs de 15 à 64 ans résidents, INSEE 2023.',
  },
  students: {
    label: 'Étudiants', unit: 'count',
    def: 'Nombre d’étudiants inscrits dans l’enseignement supérieur dans la commune (université, BTS, écoles…).',
    calc: 'atlas régional des effectifs étudiants, ministère de l’Enseignement supérieur, rentrée 2025.',
  },
  students_per_1000: {
    label: 'Étudiants /1000 hab.', unit: 'num',
    def: 'Étudiants inscrits dans la commune pour 1 000 habitants : principal moteur de la location meublée et du bail mobilité.',
    calc: 'étudiants ÷ population × 1 000.',
  },
  dpe_fg_share: {
    label: 'Passoires F-G', unit: 'pct',
    def: 'Part des diagnostics de performance énergétique réalisés dans la commune qui classent le logement F ou G. Depuis 2025, un logement G ne peut plus être mis en location ; ce sera F en 2028 et E en 2034. Une part élevée veut dire un parc ancien : travaux de rénovation à prévoir pour louer, ou biens moins chers à rénover.',
    calc: 'DPE F ou G ÷ tous les DPE de logements existants depuis juillet 2021 (ADEME). Ce sont les logements vendus, loués ou rénovés, pas tout le parc. Vide sous 20 diagnostics.',
  },
  dpe_g_share: {
    label: 'Passoires G', unit: 'pct',
    def: 'Part des DPE classés G, la pire classe : ces logements sont déjà interdits à la location depuis le 1er janvier 2025.',
    calc: 'DPE G ÷ tous les DPE depuis juillet 2021 (ADEME).',
  },
  dpe_count: {
    label: 'Nombre de DPE', unit: 'count',
    def: 'Nombre de diagnostics énergétiques depuis juillet 2021 qui servent au calcul.',
  },
  // ---------------------------------------------------------------- safety
  crime_burglary: {
    label: 'Cambriolages', unit: 'num',
    def: 'Cambriolages de logement enregistrés en 2025 pour 1 000 logements. Repère : environ 3,5 en moyenne nationale.',
    calc: 'statistiques de la police et de la gendarmerie (SSMSI). Pour les communes avec très peu de faits (moins de 5 par an sur 3 ans), le ministère ne publie pas le chiffre exact : la valeur affichée est alors la moyenne des petites communes du département.',
  },
  crime_violence: {
    label: 'Violences physiques', unit: 'num',
    def: 'Victimes de violences physiques hors cadre familial enregistrées en 2025, pour 1 000 habitants.',
    calc: 'SSMSI ; même règle pour les petites communes que pour les cambriolages.',
  },
  crime_damage: {
    label: 'Dégradations', unit: 'num',
    def: 'Destructions et dégradations volontaires enregistrées en 2025, pour 1 000 habitants.',
    calc: 'SSMSI.',
  },
  crime_theft: {
    label: 'Vols sans violence', unit: 'num',
    def: 'Victimes de vols sans violence (pickpockets, vols à l’étalage exclus) enregistrées en 2025, pour 1 000 habitants.',
    calc: 'SSMSI.',
  },
  crime_estimated: {
    label: 'Chiffres estimés', unit: 'bool',
    def: 'Oui : la commune enregistre trop peu de faits pour que le ministère publie ses chiffres ; on affiche la moyenne des petites communes du département. C’est en général bon signe.',
  },
  // ---------------------------------------------------------------- schools
  college_ips: {
    label: 'Collège (IPS)', unit: 'num',
    def: 'Indice de position sociale du collège public : il résume le milieu social des familles des élèves (100 ≈ moyenne nationale). Plus il est élevé, plus le collège accueille des élèves de milieux favorisés, ce qui est très lié à la réussite scolaire. Ce n’est pas une note du collège.',
    calc: 'moyenne des collèges publics de la commune (Éducation nationale, rentrée 2025) ; sans collège, celui de la commune la plus proche qui en a un.',
  },
  college_ips_km: {
    label: 'Distance au collège (IPS)', unit: 'km',
    def: 'Distance jusqu’à la commune dont le collège est utilisé pour l’IPS (0 = dans la commune).',
  },
  lycee_success: {
    label: 'Réussite au bac', unit: 'pct_raw',
    def: 'Taux de réussite au baccalauréat des lycées publics généraux et technologiques.',
    calc: 'moyenne pondérée par le nombre de candidats des lycées publics de la commune, ou de la commune la plus proche qui en a (Éducation nationale, session 2025).',
  },
  lycee_success_km: {
    label: 'Distance au lycée (bac)', unit: 'km',
    def: 'Distance jusqu’à la commune dont le lycée est utilisé (0 = dans la commune).',
  },
  lycee_value_added: {
    label: 'Valeur ajoutée du lycée', unit: 'num',
    def: 'Écart entre le taux de réussite au bac du lycée et celui attendu compte tenu de ses élèves (âge, origine sociale, notes au brevet). Positif : le lycée fait mieux qu’attendu. C’est l’indicateur officiel pour juger l’apport d’un lycée.',
    calc: 'indicateurs de valeur ajoutée des lycées (IVAL), Éducation nationale, session 2025, en points de pourcentage.',
  },
};

/** Everyday services averaged into one distance (km). */
export const DAILY_SERVICES = ['gp', 'pharmacy', 'supermarket', 'bakery', 'primary_school', 'college', 'post'];

/** Adds type-specific aliases (price_m2, gross_yield, ...), the risk count and the services distance. */
export function derive(raw: Row[], type: PropertyType): Row[] {
  return raw.map((r) => {
    const n = (k: string) => (typeof r[k] === 'number' ? (r[k] as number) : null);
    const risks = [
      r.ppr_flood === true,
      r.risk_marine_flood === true,
      r.risk_forest_fire === true,
      r.ppr_industrial === true,
      (n('catnat_flood') ?? 0) >= 5,
      n('radon_class') === 3,
      (n('drought_days_avg') ?? 0) > 60,
      (n('clay_high_share') ?? 0) > 0.5,
      r.coast_retreat_decree === true,
    ].filter(Boolean).length;
    const dists = DAILY_SERVICES.map((k) => n(`dist_${k}_km`)).filter((v): v is number => v !== null);
    return {
      ...r,
      price_m2: r[`price_m2_${type}`] ?? null,
      n_sales: r[`n_sales_${type}`] ?? 0,
      rent_m2: r[`rent_m2_${type}`] ?? null,
      rent_confidence: r[`rent_confidence_${type}`] ?? null,
      gross_yield: r[`gross_yield_${type}`] ?? null,
      risk_count: risks,
      services_km: dists.length === DAILY_SERVICES.length ? dists.reduce((a, b) => a + b, 0) / dists.length : null,
    };
  });
}

export interface Strategy {
  id: StrategyId;
  label: string;
  blurb: string;
  type: PropertyType;
  filters: FilterDef[];
  signals: SignalDef[];
  /** Columns shown in the table, after the commune name. */
  table: string[];
}

const f = (id: string, column: string, op: FilterDef['op'], value?: number, enabled = true, requireData = false): FilterDef => ({
  id, column, op, value, enabled, requireData,
});
const s = (id: string, column: string, dir: 1 | -1, weight: number): SignalDef => ({ id, column, dir, weight });

export const STRATEGIES: Strategy[] = [
  {
    id: 'long',
    label: 'Location longue durée',
    blurb: 'Location vide à l’année à des résidents. Privilégie le rendement, une population qui augmente et un marché tendu (peu de logements vides).',
    type: 'house',
    filters: [
      f('yield', 'gross_yield', 'min', 0.05, true, true),
      f('sales', 'n_sales', 'min', 10),
      f('risks', 'risk_count', 'max', 2),
      f('flood', 'ppr_flood', 'isFalse', undefined, false),
      f('growth', 'pop_cagr_11y', 'min', 0),
      f('drought', 'drought_days_avg', 'max', 90, false),
      f('netyield', 'net_yield', 'min', 0.03, false, true),
      f('cashflow', 'cashflow_month', 'min', -100, false, true),
      f('dpe', 'dpe_fg_share', 'max', 0.3, false),
      f('unemp', 'unemployment_rate', 'max', 0.15, false),
    ],
    signals: [
      s('net', 'net_yield', 1, 3),
      s('yield', 'gross_yield', 1, 1),
      s('growth', 'pop_cagr_11y', 1, 2),
      s('vacancy', 'vacancy_rate', -1, 2),
      s('tenants', 'tenant_share', 1, 1),
      s('unemp', 'unemployment_rate', -1, 1),
      s('income', 'median_income', 1, 1),
      s('dpe', 'dpe_fg_share', -1, 1),
      s('risk', 'risk_count', -1, 1),
      s('price', 'price_m2', -1, 0),
    ],
    table: ['price_m2', 'rent_m2', 'gross_yield', 'net_yield', 'cashflow_month', 'pop_cagr_11y', 'vacancy_rate', 'tenant_share', 'unemployment_rate', 'dpe_fg_share', 'risk_count', 'n_sales'],
  },
  {
    id: 'medium',
    label: 'Moyenne durée (meublé / bail mobilité)',
    blurb: 'Meublé ou bail mobilité pour étudiants, stagiaires ou salariés en mission. Il faut une vraie ville : la taille et la densité comptent.',
    type: 'apt',
    filters: [
      f('pop', 'pop', 'min', 8000),
      f('yield', 'gross_yield', 'min', 0.04, true, true),
      f('sales', 'n_sales', 'min', 10),
      f('risks', 'risk_count', 'max', 3),
      f('netyield', 'net_yield', 'min', 0.03, false, true),
      f('cashflow', 'cashflow_month', 'min', -100, false, true),
      f('students', 'students_per_1000', 'min', 20, false),
      f('dpe', 'dpe_fg_share', 'max', 0.3, false),
    ],
    signals: [
      s('net', 'net_yield', 1, 3),
      s('yield', 'gross_yield', 1, 1),
      s('students', 'students_per_1000', 1, 2),
      s('density', 'density', 1, 1),
      s('jobs', 'jobs_per_active', 1, 1),
      s('tense', 'vacancy_rate', -1, 1),
      s('dpe', 'dpe_fg_share', -1, 1),
    ],
    table: ['price_m2', 'rent_m2', 'gross_yield', 'net_yield', 'cashflow_month', 'pop', 'students', 'furnished_share', 'jobs_per_active', 'vacancy_rate', 'dpe_fg_share', 'zone_tendue', 'n_sales'],
  },
  {
    id: 'short',
    label: 'Courte durée (saisonnier)',
    blurb: 'Location touristique à la nuit ou à la semaine. Privilégie l’attractivité touristique ; signale les zones tendues, où le maire peut limiter ou soumettre à autorisation les meublés de tourisme.',
    type: 'house',
    filters: [
      f('tourism', 'tourist_beds_per_1000', 'min', 100),
      f('tense', 'zone_tendue', 'isFalse', undefined, false),
      f('surcharge', 'second_home_surcharge', 'max', 30, false),
      f('marine', 'risk_marine_flood', 'isFalse', undefined, false),
      f('sales', 'n_sales', 'min', 5),
    ],
    signals: [
      s('tourism', 'tourist_beds_per_1000', 1, 3),
      s('second', 'second_home_share', 1, 2),
      s('price', 'price_m2', -1, 2),
      s('yield', 'gross_yield', 1, 1),
      s('risk', 'risk_count', -1, 1),
      s('surcharge', 'second_home_surcharge', -1, 1),
      s('dpe', 'dpe_fg_share', -1, 1),
    ],
    table: ['price_m2', 'tourist_beds_per_1000', 'second_home_share', 'zone_tendue', 'second_home_surcharge', 'price_trend_3y', 'risk_count', 'n_sales'],
  },
  {
    id: 'live',
    label: 'Habiter (long terme)',
    blurb: 'Acheter pour y vivre 15 à 30 ans. Privilégie la sécurité face aux risques naturels, une eau sûre, l’accès aux médecins et aux services, et une commune qui gagne des habitants.',
    type: 'house',
    filters: [
      f('risks', 'risk_count', 'max', 2),
      f('crisis', 'crisis_days_avg', 'max', 60),
      f('apl', 'apl_gp', 'min', 2.5),
      f('services', 'services_km', 'max', 8),
      f('coast', 'coast_retreat_decree', 'isFalse'),
      f('growth', 'pop_cagr_11y', 'min', 0),
      f('clay', 'clay_high_share', 'max', 0.5, false),
      f('flood', 'ppr_flood', 'isFalse', undefined, false),
      f('fibre', 'fibre_share', 'min', 0.8, false),
      f('burglary', 'crime_burglary', 'max', 8, false),
      f('violence', 'crime_violence', 'max', 5, false),
      f('ips', 'college_ips', 'min', 95, false),
    ],
    signals: [
      s('risk', 'risk_count', -1, 2),
      s('clay', 'clay_high_share', -1, 2),
      s('crisis', 'crisis_days_avg', -1, 2),
      s('waterq', 'water_limit_breach_share', -1, 1),
      s('apl', 'apl_gp', 1, 2),
      s('services', 'services_km', -1, 2),
      s('growth', 'pop_cagr_11y', 1, 2),
      s('trend', 'price_trend_3y', 1, 1),
      s('price', 'price_m2', -1, 1),
      s('fibre', 'fibre_share', 1, 1),
      s('burglary', 'crime_burglary', -1, 1),
      s('violence', 'crime_violence', -1, 1),
      s('ips', 'college_ips', 1, 1),
    ],
    table: ['price_m2', 'risk_count', 'clay_high_share', 'crisis_days_avg', 'apl_gp', 'services_km', 'crime_burglary', 'crime_violence', 'college_ips', 'pop_cagr_11y', 'fibre_share'],
  },
  {
    id: 'land',
    label: 'Terrain',
    blurb: 'Terrains à bâtir. Privilégie les terrains bon marché dans des communes qui gagnent des habitants et peu exposées aux risques.',
    type: 'house',
    filters: [
      f('landdata', 'land_price_m2', 'min', 0, true, true),
      f('flood', 'ppr_flood', 'isFalse'),
      f('drought', 'drought_days_avg', 'max', 90),
      f('growth', 'pop_cagr_11y', 'min', 0),
      f('coast', 'coast_retreat_decree', 'isFalse'),
      f('clay', 'clay_high_share', 'max', 0.5, false),
    ],
    signals: [
      s('land', 'land_price_m2', -1, 3),
      s('growth', 'pop_cagr_11y', 1, 2),
      s('clay', 'clay_high_share', -1, 1),
      s('drought', 'drought_days_avg', -1, 1),
      s('risk', 'risk_count', -1, 1),
      s('services', 'services_km', -1, 1),
      s('income', 'median_income', 1, 1),
    ],
    table: ['land_price_m2', 'n_land_sales', 'pop_cagr_11y', 'clay_high_share', 'drought_days_avg', 'risk_count', 'services_km'],
  },
];

export const FILTERS: Record<string, { label: string; help: string }> = {
  yield: {
    label: 'Rendement brut minimum',
    help: 'Élimine les communes où le loyer rapporte moins que ce pourcentage du prix d’achat chaque année. Au-dessous d’environ 4 % brut, il reste souvent peu de chose après la taxe foncière, les charges et les travaux.',
  },
  sales: {
    label: 'Ventes minimum (24 mois)',
    help: 'Élimine les communes avec trop peu de ventes : avec 3 ou 4 ventes, le prix médian peut être faussé par une seule vente atypique. Un seuil haut aide aussi à revendre : le marché y est actif.',
  },
  risks: {
    label: 'Risques signalés maximum',
    help: 'Élimine les communes cumulant plus de signaux de risque que ce nombre (inondation, submersion, feu, site industriel, radon, sécheresse…).',
  },
  flood: {
    label: 'Exclure les communes avec plan inondation',
    help: 'Élimine les communes ayant un plan de prévention des risques d’inondation. Attention : ce plan ne couvre souvent qu’une partie de la commune ; vérifiez l’adresse précise sur georisques.gouv.fr.',
  },
  growth: {
    label: 'Croissance pop./an minimum',
    help: 'Élimine les communes qui perdent des habitants (avec 0 %) ou qui croissent moins vite que ce seuil. Une population en baisse signifie en général moins de locataires et des prix qui stagnent.',
  },
  drought: {
    label: 'Jours de sécheresse/an maximum',
    help: 'Élimine les communes restées plus longtemps que ce nombre de jours par an en restriction d’eau renforcée ou en crise (moyenne 2021–2025). Important pour un jardin, un potager, une piscine ou un projet agricole.',
  },
  pop: {
    label: 'Population minimum',
    help: 'Élimine les communes trop petites pour avoir une demande régulière en moyenne durée (étudiants, salariés en mission).',
  },
  tourism: {
    label: 'Lits touristiques min. /1000 hab.',
    help: 'Élimine les communes peu touristiques. Repère : sous 100 lits pour 1 000 habitants, la demande saisonnière est faible.',
  },
  tense: {
    label: 'Exclure les zones tendues',
    help: 'Élimine les zones tendues, où la location courte durée est le plus souvent limitée (autorisation, numéro d’enregistrement, plafond de nuits, quotas). Désactivé par défaut car beaucoup de communes touristiques y sont : vérifiez plutôt les règles en mairie.',
  },
  surcharge: {
    label: 'Surtaxe résid. secondaires max. (%)',
    help: 'Élimine les communes qui majorent la taxe d’habitation des résidences secondaires au-delà de ce pourcentage. Concerne un meublé de tourisme qui n’est la résidence principale de personne.',
  },
  marine: {
    label: 'Exclure la submersion marine',
    help: 'Élimine les communes où un risque d’inondation par la mer est recensé.',
  },
  landdata: {
    label: 'Avec des ventes de terrains',
    help: 'Garde seulement les communes où au moins 3 terrains à bâtir se sont vendus en 3 ans, pour avoir un prix fiable.',
  },
  drinkwater: {
    label: 'Restriction eau potable max. (jours/an)',
    help: 'Élimine les communes dont la ressource en eau potable a été en restriction plus longtemps que ce nombre de jours par an (moyenne 2021–2025). C’est le signal le plus direct d’un approvisionnement en eau fragile.',
  },
  crisis: {
    label: 'Jours de crise eau max. (jours/an)',
    help: 'Élimine les communes restées plus longtemps que ce nombre de jours par an au niveau « crise » de restriction d’eau (moyenne 2021–2025) : seuls les usages prioritaires y sont autorisés. Un indicateur de tension durable sur la ressource en eau.',
  },
  apl: {
    label: 'Accès aux médecins minimum',
    help: 'Élimine les communes sous ce niveau d’accès aux médecins généralistes. 2,5 consultations par habitant et par an est le seuil officiel du « désert médical ».',
  },
  services: {
    label: 'Distance aux services max. (km)',
    help: 'Élimine les communes où les services du quotidien (médecin, pharmacie, supermarché, boulangerie, école, collège, poste) sont en moyenne plus loin que cette distance à vol d’oiseau.',
  },
  coast: {
    label: 'Exclure le recul du trait de côte',
    help: 'Élimine les communes listées par décret comme exposées au recul du trait de côte. Une maison dans la future zone menacée peut perdre l’essentiel de sa valeur ; ailleurs dans la commune, le risque est moindre. Vérifiez la carte locale d’exposition de la commune.',
  },
  clay: {
    label: 'Argile forte max. (% de la commune)',
    help: 'Élimine les communes dont une trop grande part de la surface est en exposition forte au retrait-gonflement des argiles. Désactivé par défaut : dans beaucoup de régions une grande partie des communes est concernée, et le risque se maîtrise par une étude de sol et des fondations adaptées.',
  },
  netyield: {
    label: 'Rendement net minimum',
    help: 'Élimine les communes où le rendement net estimé (après charges, vacance et taxe foncière, frais de notaire compris) est sous ce seuil. Dépend des hypothèses d’achat ci-dessous.',
  },
  cashflow: {
    label: 'Cash-flow mensuel minimum (€)',
    help: 'Élimine les communes où, avec vos hypothèses de crédit, l’effort d’épargne mensuel dépasse ce montant (−100 € : on accepte de remettre jusqu’à 100 € par mois ; 0 : le loyer doit tout payer).',
  },
  dpe: {
    label: 'Passoires F-G maximum (% des DPE)',
    help: 'Élimine les communes où trop de logements diagnostiqués sont classés F ou G : interdits à la location d’ici 2028, ils demandent des travaux de rénovation énergétique.',
  },
  unemp: {
    label: 'Chômage maximum (%)',
    help: 'Élimine les communes où le taux de chômage (au sens du recensement, plus élevé que le taux officiel) dépasse ce seuil.',
  },
  students: {
    label: 'Étudiants min. /1000 hab.',
    help: 'Garde les communes avec une population étudiante significative, cœur de la demande en meublé et bail mobilité.',
  },
  burglary: {
    label: 'Cambriolages max. /1000 logements',
    help: 'Élimine les communes où les cambriolages de logement enregistrés dépassent ce taux. Repère : environ 3,5 en moyenne nationale, 5 à 9 dans les grandes villes.',
  },
  violence: {
    label: 'Violences physiques max. /1000 hab.',
    help: 'Élimine les communes où les violences physiques hors cadre familial enregistrées dépassent ce taux.',
  },
  ips: {
    label: 'IPS du collège minimum',
    help: 'Élimine les communes dont le collège public (ou le plus proche) a un indice de position sociale sous ce seuil. 100 ≈ moyenne nationale.',
  },
  fibre: {
    label: 'Fibre minimum (% des logements)',
    help: 'Élimine les communes où moins de ce pourcentage de logements a accès à la fibre. Utile pour le télétravail.',
  },
};

export const SIGNALS: Record<string, { label: string; help: string }> = {
  yield: { label: 'Rendement brut', help: 'Plus le rendement brut est élevé, meilleur est le score.' },
  growth: { label: 'Croissance démographique', help: 'Plus la population augmente vite, meilleur est le score.' },
  vacancy: { label: 'Faible vacance', help: 'Moins il y a de logements vides, meilleur est le score : les locataires se trouvent plus facilement.' },
  income: { label: 'Revenu médian', help: 'Plus le revenu médian est élevé, meilleur est le score : des locataires plus solvables.' },
  risk: { label: 'Peu de risques', help: 'Moins il y a de risques signalés, meilleur est le score.' },
  tax: { label: 'Taxe foncière basse', help: 'Plus le taux de taxe foncière est bas, meilleur est le score.' },
  price: { label: 'Prix bas', help: 'Plus le prix au m² est bas, meilleur est le score : un ticket d’entrée plus faible.' },
  density: { label: 'Densité', help: 'Plus la commune est dense (plus urbaine), meilleur est le score.' },
  pop: { label: 'Population', help: 'Plus la commune est peuplée, meilleur est le score.' },
  tense: { label: 'Faible vacance', help: 'Moins il y a de logements vides, meilleur est le score.' },
  tourism: { label: 'Attractivité touristique', help: 'Plus il y a de lits touristiques par habitant, meilleur est le score.' },
  second: { label: 'Résidences secondaires', help: 'Plus la part de résidences secondaires est forte, meilleur est le score : c’est le signe d’une destination de vacances.' },
  surcharge: { label: 'Faible surtaxe résid. second.', help: 'Plus la surtaxe sur les résidences secondaires est basse, meilleur est le score.' },
  land: { label: 'Terrain bon marché', help: 'Plus le prix du terrain au m² est bas, meilleur est le score.' },
  drought: { label: 'Peu de sécheresse', help: 'Moins il y a de jours de restriction d’eau, meilleur est le score.' },
  clay: { label: 'Peu d’argile', help: 'Moins la commune est exposée au retrait-gonflement des argiles, meilleur est le score.' },
  drinkwater: { label: 'Eau potable sûre', help: 'Moins il y a de jours de restriction sur l’eau potable, meilleur est le score.' },
  crisis: { label: 'Peu de crises d’eau', help: 'Moins il y a de jours au niveau « crise » de restriction d’eau, meilleur est le score.' },
  waterq: { label: 'Eau du robinet conforme', help: 'Moins il y a d’analyses d’eau du robinet hors limites sanitaires, meilleur est le score.' },
  apl: { label: 'Accès aux médecins', help: 'Plus l’accès aux médecins généralistes est bon, meilleur est le score.' },
  services: { label: 'Services proches', help: 'Plus les services du quotidien sont proches, meilleur est le score.' },
  trend: { label: 'Prix en hausse', help: 'Plus les prix ont monté en 3 ans, meilleur est le score : la commune attire. À l’inverse, cela veut dire un achat plus cher.' },
  fibre: { label: 'Fibre', help: 'Plus la part de logements éligibles à la fibre est élevée, meilleur est le score.' },
  net: { label: 'Rendement net', help: 'Plus le rendement net estimé est élevé, meilleur est le score.' },
  tenants: { label: 'Marché locatif profond', help: 'Plus la part de locataires est élevée, meilleur est le score : plus de candidats et une revente plus facile à un investisseur.' },
  unemp: { label: 'Faible chômage', help: 'Moins il y a de chômage, meilleur est le score.' },
  dpe: { label: 'Peu de passoires', help: 'Moins il y a de logements classés F ou G, meilleur est le score.' },
  students: { label: 'Étudiants', help: 'Plus il y a d’étudiants par habitant, meilleur est le score.' },
  jobs: { label: 'Pôle d’emploi', help: 'Plus il y a d’emplois par actif résident, meilleur est le score : des salariés viennent de l’extérieur.' },
  burglary: { label: 'Peu de cambriolages', help: 'Moins il y a de cambriolages par logement, meilleur est le score.' },
  violence: { label: 'Peu de violences', help: 'Moins il y a de violences physiques par habitant, meilleur est le score.' },
  ips: { label: 'Collège favorisé', help: 'Plus l’indice de position sociale du collège est élevé, meilleur est le score.' },
};

/** Sections of the side panel. Columns missing from COLUMNS are skipped. */
export const DETAIL_GROUPS: { title: string; help?: string; columns: string[] }[] = [
  { title: 'Marché', columns: ['price_m2', 'n_sales', 'price_trend_3y', 'rent_m2', 'rent_confidence', 'gross_yield', 'net_yield', 'cashflow_month', 'land_price_m2', 'n_land_sales'] },
  { title: 'Demande locative', columns: ['tenant_share', 'private_rent_share', 'furnished_share', 'social_share', 'unemployment_rate', 'jobs', 'jobs_per_active', 'students', 'students_per_1000'] },
  { title: 'Énergie des logements', columns: ['dpe_fg_share', 'dpe_g_share', 'dpe_count'] },
  { title: 'Habitants', columns: ['pop', 'pop_cagr_11y', 'density', 'median_income', 'vacancy_rate', 'second_home_share', 'tourist_beds_per_1000', 'aav_category', 'aav_name', 'aav_size'] },
  { title: 'Santé et services', help: 'Distances à vol d’oiseau jusqu’à la commune la plus proche qui a le service ; 0 km = dans la commune.', columns: ['apl_gp', 'apl_gp_65', 'gp_count', 'services_km', 'dist_gp_km', 'dist_pharmacy_km', 'dist_supermarket_km', 'dist_bakery_km', 'dist_primary_school_km', 'dist_college_km', 'dist_lycee_km', 'dist_post_km', 'dist_emergency_km', 'dist_train_km', 'fibre_share'] },
  { title: 'Sécurité', help: 'Faits enregistrés par la police et la gendarmerie en 2025. Une commune touristique ou un pôle commercial a mécaniquement plus de faits par habitant (visiteurs non comptés dans la population).', columns: ['crime_burglary', 'crime_violence', 'crime_damage', 'crime_theft', 'crime_estimated'] },
  { title: 'Écoles', columns: ['college_ips', 'college_ips_km', 'lycee_success', 'lycee_value_added', 'lycee_success_km'] },
  { title: 'Eau', columns: ['drinking_water_days_avg', 'drought_days_avg', 'crisis_days_avg', 'water_limit_breach_share'] },
  { title: 'Sols, côte et risques', columns: ['risk_count', 'clay_high_share', 'clay_med_high_share', 'catnat_drought', 'ppr_flood', 'catnat_flood', 'risk_marine_flood', 'coast_retreat_decree', 'risk_coast_erosion', 'risk_forest_fire', 'ppr_industrial', 'radon_class'] },
  { title: 'Fiscalité et règles', columns: ['tfpb_rate', 'tfpb_total_avg_eur', 'second_home_surcharge', 'zone_tendue', 'zone_abc'] },
];


export const HELP = {
  finance: 'Le rendement net et le cash-flow sont calculés pour chaque commune avec ces hypothèses, à partir du prix médian au m² (DVF), du loyer estimé (ANIL) et de la taxe foncière moyenne de la commune.\n\nC’est une estimation pour comparer les communes, pas une simulation bancaire : impôt sur le revenu, assurance emprunteur, travaux et frais de garantie ne sont pas comptés. Les hypothèses sont enregistrées dans le lien de partage.',
  history: 'Prix médian au m² des ventes de maisons et d’appartements, et nombre de ventes, par année de vente (DVF, ventes d’un seul logement). Plus il y a de ventes, plus la médiane est fiable.',
  scope: 'Sans sélection : toute la France, les communes sont comparées à l’échelle nationale.\n\nAvec un ou plusieurs départements : la carte et le tableau ne montrent que leurs communes, et le score, les groupes A à E et les médianes sont recalculés en ne comparant que ces communes entre elles. La sélection est enregistrée dans le lien de partage.',
  filters: 'Un filtre élimine les communes qui ne respectent pas la condition. Décochez-le pour le désactiver.\n\nLe nombre en rouge indique combien de communes ce filtre élimine (une même commune peut être éliminée par plusieurs filtres).',
  weights: 'Les poids ne retirent aucune commune : ils changent seulement l’ordre du classement.\n\n0 = critère ignoré, 5 = très important. Seul le rapport entre les poids compte : tout à 1 ou tout à 5 donne le même classement.',
  score: 'Score de 0 à 100, calculé parmi les communes retenues par les filtres.\n\nCalcul : pour chaque critère ayant un poids, on classe les communes retenues de la pire (0) à la meilleure (100). Le score est la moyenne de ces rangs, pondérée par les poids. Si une donnée manque pour une commune, ce critère est ignoré pour elle.\n\nLe score est relatif : il change quand vous modifiez les filtres.',
  tier: 'Les communes retenues sont réparties en 5 groupes de taille égale selon leur score : A = les 20 % meilleures, puis B, C, D et E. En gris : les communes éliminées par au moins un filtre.',
  parts: 'Rang de la commune pour chaque critère, de 0 (la pire des communes retenues) à 100 (la meilleure). Le score est la moyenne de ces rangs, pondérée par les poids.',
  type: 'Les prix, loyers et rendements affichés sont ceux du type de bien choisi. Les appartements se vendent surtout en ville : hors des villes, le prix des appartements est souvent vide faute de ventes.',
  passing: 'Nombre de communes qui passent tous les filtres actifs.',
  median: 'Valeur médiane parmi les communes retenues : la moitié des communes est au-dessus, l’autre moitié en dessous.',
  failing: 'Affiche aussi, en gris et en bas du tableau, les communes éliminées par les filtres. Survolez « éliminée » pour voir quels filtres elles ne passent pas.',
};

export const missingDataNote = (fd: FilterDef): string =>
  fd.op === 'min' || fd.op === 'max'
    ? fd.requireData
      ? 'Les communes sans donnée sont éliminées.'
      : 'Les communes sans donnée passent ce filtre.'
    : '';

export function preset(id: StrategyId): Strategy {
  const st = STRATEGIES.find((x) => x.id === id) ?? STRATEGIES[0];
  return structuredClone(st);
}
