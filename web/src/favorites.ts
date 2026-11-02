// Favourite communes, kept in this browser only (localStorage), in the order they were added.

const KEY = 'lsfr-favorites';

export function loadFavorites(): string[] {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? '[]');
    return Array.isArray(v) ? v.filter((c): c is string => typeof c === 'string' && /^(\d{5}|2[AB]\d{3})$/.test(c)) : [];
  } catch {
    return [];
  }
}

export function saveFavorites(codes: string[]): void {
  try {
    localStorage.setItem(KEY, JSON.stringify([...new Set(codes)]));
  } catch {
    /* private mode or full storage: favourites last for this visit only */
  }
}

/** Add or remove one commune; returns the new list. */
export function toggleFavorite(codes: string[], code: string): string[] {
  const next = codes.includes(code) ? codes.filter((c) => c !== code) : [...codes, code];
  saveFavorites(next);
  return next;
}
