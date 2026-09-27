// Text similarity for the duplicate-bug check (HLD §5.4). Trigram similarity, the same measure as
// Postgres pg_trgm, so candidates from Jira and from our own table are ranked on one scale.
// Embedding-based similarity replaces this in M4; until then trigrams catch reworded titles well.

const STOP = new Set([
  'the',
  'a',
  'an',
  'is',
  'on',
  'in',
  'of',
  'to',
  'for',
  'and',
  'with',
  'when',
  'after',
  'at',
  'not',
  'be',
]);

/** Lower-cased words without punctuation or filler words. */
export function words(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((w) => w.length > 1 && !STOP.has(w));
}

function trigrams(text: string): Set<string> {
  const out = new Set<string>();
  for (const w of words(text)) {
    const padded = `  ${w} `;
    for (let i = 0; i + 3 <= padded.length; i++) out.add(padded.slice(i, i + 3));
  }
  return out;
}

/** 0–1: shared trigrams over all trigrams of both texts. */
export function similarity(a: string, b: string): number {
  const x = trigrams(a);
  const y = trigrams(b);
  if (!x.size || !y.size) return 0;
  let shared = 0;
  for (const t of x) if (y.has(t)) shared++;
  return shared / (x.size + y.size - shared);
}

/**
 * Words worth sending to Jira's text search: the most distinctive few, since Jira ANDs nothing and a
 * long query mostly adds noise. Longer words first; they carry more meaning in bug titles.
 */
export function searchTerms(summary: string, max = 6): string[] {
  return [...new Set(words(summary))].sort((a, b) => b.length - a.length).slice(0, max);
}
