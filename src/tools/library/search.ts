/* Fuzzy matching for concept lookups — "did you mean" suggestions on a miss. */
import type { Concept } from "./api.js";

function tokenize(s: string): string[] {
  return s.toLowerCase().split(/[^a-z0-9%]+/).filter(Boolean);
}

/**
 * Case-insensitive match with a light rank: exact > prefix > substring >
 * token-level. The token tier matches every query word against some haystack
 * word by prefix in either direction, so near-misses like "stochastics" →
 * "Stochastic Oscillator" still hit.
 */
export function rank(haystack: string, needle: string): number {
  const h = haystack.toLowerCase();
  const n = needle.toLowerCase();
  if (h === n) return 4;
  if (h.startsWith(n)) return 3;
  if (h.includes(n)) return 2;
  const hTokens = tokenize(h);
  const nTokens = tokenize(n);
  if (nTokens.length > 0 && nTokens.every((nt) => hTokens.some((ht) => ht.startsWith(nt) || nt.startsWith(ht)))) {
    return 1;
  }
  return 0;
}

export function nearestConcepts(concepts: Concept[], slug: string, limit = 3): string[] {
  return concepts
    .map((c) => ({ slug: c.slug, score: rank(c.slug, slug) + rank(c.name, slug) }))
    .filter((c) => c.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((c) => c.slug);
}
