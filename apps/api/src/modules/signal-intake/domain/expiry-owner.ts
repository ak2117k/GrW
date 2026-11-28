import { instrumentHits } from './prefilter';
import { normalise } from './text';
import type { Vocabulary } from './vocabulary';

/**
 * The underlying a post's written expiry belongs to, for a post that names more than one (a multi-call LLM / image
 * reply): the last instrument named before the expiry text (the shortest prefix whose normalised form already
 * carries the expiry), else the first one named after it. Null when the post has no expiry. A post naming one
 * underlying (or none) gives that one. Same reading as message-reader's option-legs `expiryOwner`.
 */
export function expiryOwner(text: string, vocab: Vocabulary): { owner: string | null; named: string[] } {
  const all = normalise(text, vocab);
  const named = [...new Set(instrumentHits(all.tokens, vocab).map((h) => h.name))];
  if (!all.expiry) return { owner: null, named };
  if (named.length <= 1) return { owner: named[0] ?? null, named };
  let lo = 1;
  let hi = text.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (normalise(text.slice(0, mid), vocab).expiry) hi = mid;
    else lo = mid + 1;
  }
  const before = instrumentHits(normalise(text.slice(0, lo), vocab).tokens, vocab);
  if (before.length) return { owner: before[before.length - 1].name, named };
  return { owner: instrumentHits(all.tokens, vocab)[0]?.name ?? null, named };
}
