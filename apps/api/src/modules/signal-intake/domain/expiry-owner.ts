import { instrumentHits } from './prefilter';
import { normalise } from './text';
import type { Vocabulary } from './vocabulary';

/**
 * The underlying the post's expiry was written next to: the last instrument named before the expiry text (the
 * shortest prefix whose normalised form already carries the expiry), else the first of `hits` (the post's
 * instruments, in order), else the post's only `named` underlying. Shared by signal-intake (multi-call LLM / image
 * replies) and message-reader's option legs. Call it only for a post that has an expiry.
 */
export function expiryOwnerIn(
  text: string,
  vocab: Vocabulary,
  hits: ReadonlyArray<{ i: number; name: string }>,
  named: readonly string[],
): string | null {
  let lo = 1;
  let hi = text.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (normalise(text.slice(0, mid), vocab).expiry) hi = mid;
    else lo = mid + 1;
  }
  const prefix = instrumentHits(normalise(text.slice(0, lo), vocab).tokens, vocab);
  return prefix.length ? prefix[prefix.length - 1].name : (hits[0]?.name ?? (named.length === 1 ? named[0] : null));
}

/**
 * signal-intake's reading: the owner of the post's written expiry (null when it has none) and the distinct
 * underlyings the post names. A post naming one underlying (or none) gives that one.
 */
export function expiryOwner(text: string, vocab: Vocabulary): { owner: string | null; named: string[] } {
  const all = normalise(text, vocab);
  const hits = instrumentHits(all.tokens, vocab);
  const named = [...new Set(hits.map((h) => h.name))];
  if (!all.expiry) return { owner: null, named };
  if (named.length <= 1) return { owner: named[0] ?? null, named };
  return { owner: expiryOwnerIn(text, vocab, hits, named), named };
}
