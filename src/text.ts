/** Lowercase, strip diacritics and collapse whitespace, for accent/case-insensitive matching. */
export function normalize(s: string): string {
  return s.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase().replace(/\s+/g, " ").trim();
}
