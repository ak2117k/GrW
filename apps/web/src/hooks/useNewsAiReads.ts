import { useEffect, useRef, useState } from 'react';
import { getNewsReads, type AiArticleRead } from '@/services/newsAi';
import { chunk, idsToFetch } from '@/components/news/newsAiFormat';

const BATCH = 50;
/** Articles without a read are asked again after this (the server reads them async). */
const RETRY_MS = 3 * 60_000;
const TICK_MS = 60_000;

/**
 * Per-article AI reads for the visible feed. Fetches only ids it has not got
 * yet, in batches; failures are swallowed (cards just show no AI read).
 */
export function useNewsAiReads(articleIds: string[]): Map<string, AiArticleRead> {
  const [reads, setReads] = useState<Map<string, AiArticleRead>>(() => new Map());
  const readsRef = useRef(reads);
  readsRef.current = reads;
  const requestedAt = useRef(new Map<string, number>());
  const [tick, setTick] = useState(0);
  const key = articleIds.join(',');

  useEffect(() => {
    const t = setInterval(() => setTick((n) => n + 1), TICK_MS);
    return () => clearInterval(t);
  }, []);

  useEffect(() => {
    let cancelled = false;
    const now = Date.now();
    const want = idsToFetch(articleIds, (id) => readsRef.current.has(id), requestedAt.current, now, RETRY_MS);
    if (want.length === 0) return;
    for (const id of want) requestedAt.current.set(id, now);
    for (const batch of chunk(want, BATCH)) {
      getNewsReads(batch)
        .then((rows) => {
          if (cancelled || rows.length === 0) return;
          setReads((prev) => {
            const next = new Map(prev);
            for (const r of rows) next.set(r.articleId, r);
            return next;
          });
        })
        .catch(() => {
          /* best effort — the card simply shows no AI read */
        });
    }
    return () => {
      cancelled = true;
    };
    // `key` captures the id list; `tick` drives the periodic retry.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, tick]);

  return reads;
}
