// Links to listing sites, built by the app from the commune's name and postal code
// (never written by the AI model, which tends to invent URL formats).
//
// leboncoin search URLs: /recherche?category=<9 sale | 10 rental>&locations=<Name>_<postcode>
// and real_estate_type=<1 house | 2 flat | 3 land>. Written from known public URLs, not from
// leboncoin documentation: check one link by hand if leboncoin changes its format.

import type { Row } from './engine';

export interface AdLink {
  label: string;
  url: string;
}

export const firstPostcode = (row: Row): string | null =>
  typeof row.postcodes === 'string' && row.postcodes ? row.postcodes.split(' ')[0] : null;

export function adLinks(row: Row): AdLink[] {
  const cp = firstPostcode(row);
  if (!cp) return [];
  const loc = encodeURIComponent(`${row.nom}_${cp}`).replace(/%20/g, '+');
  const base = `https://www.leboncoin.fr/recherche?locations=${loc}`;
  return [
    { label: 'Maisons à vendre', url: `${base}&category=9&real_estate_type=1` },
    { label: 'Appartements à vendre', url: `${base}&category=9&real_estate_type=2` },
    { label: 'Terrains', url: `${base}&category=9&real_estate_type=3` },
    { label: 'Locations', url: `${base}&category=10` },
  ];
}
