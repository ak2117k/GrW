import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import api from '@/services/api';
import type { NewsItem } from '@/types';
import { Card } from './_shared';

interface Props {
  symbol: string;
}

/**
 * Strip Angel One series suffixes (`-EQ`, `-AF`, `-BE`, etc.) from the
 * symbol before sending to the news endpoint — news is keyed on the bare
 * ticker, otherwise lookups for `DIXON-AF` miss all `DIXON` headlines.
 */
function bareSymbol(s: string): string {
  return s.toUpperCase().trim().replace(/-[A-Z]{1,3}$/, '');
}

/**
 * Card 6: Last 10 headlines tagged with the current symbol.
 *
 * Fetches /api/news/symbol/:symbol directly (the existing useNews hook is
 * wired to the global news feed with filters; passing it a symbol would
 * mutate that shared state). Backend returns an array of NewsArticle
 * sorted by publishedAt desc, capped at 20 — we render the first 10.
 */
export default function SymbolNewsCard({ symbol }: Props) {
  const cleanSymbol = bareSymbol(symbol);
  const [news, setNews] = useState<NewsItem[] | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!cleanSymbol) return;
    let cancelled = false;
    setLoading(true);
    setNews(null);
    api
      .get<NewsItem[]>(`/news/symbol/${cleanSymbol}`)
      .then((r) => {
        if (cancelled) return;
        setNews(Array.isArray(r.data) ? r.data : []);
      })
      .catch(() => {
        if (cancelled) return;
        setNews([]);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [cleanSymbol]);

  if (loading && !news) {
    return (
      <Card title="News">
        <p className="text-sm text-zinc-500">Loading news...</p>
      </Card>
    );
  }
  if (!news || news.length === 0) {
    return (
      <Card title="News">
        <p className="text-sm text-zinc-500">No recent news for {cleanSymbol}.</p>
      </Card>
    );
  }

  return (
    <Card
      title="News"
      action={
        <Link to={`/news?symbol=${cleanSymbol}`} className="text-xs text-blue-400 hover:text-blue-300">
          View all →
        </Link>
      }
    >
      <ul className="space-y-2.5">
        {news.slice(0, 10).map((n) => (
          <li key={n.id} className="text-sm">
            <a
              href={n.url}
              target="_blank"
              rel="noreferrer"
              className="text-zinc-200 hover:text-blue-400 line-clamp-2"
            >
              {n.title}
            </a>
            <div className="text-xs text-zinc-500 mt-0.5">
              {n.source} · {timeAgo(n.publishedAt)}
              {n.sentiment && n.sentiment !== 'neutral' && (
                <span
                  className={
                    n.sentiment === 'bullish'
                      ? ' ml-2 text-emerald-400'
                      : ' ml-2 text-red-400'
                  }
                >
                  · {n.sentiment}
                </span>
              )}
            </div>
          </li>
        ))}
      </ul>
    </Card>
  );
}

/**
 * Format a Date / ISO string as a coarse relative timestamp ("3m ago",
 * "2h ago", "5d ago"). Anything older than 7 days falls back to a date.
 */
function timeAgo(input: Date | string): string {
  const ts = typeof input === 'string' ? new Date(input).getTime() : input.getTime();
  if (!Number.isFinite(ts)) return '';
  const diff = Date.now() - ts;
  if (diff < 0) return 'just now';
  const m = Math.floor(diff / 60_000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 7) return `${d}d ago`;
  return new Date(ts).toLocaleDateString('en-IN', { day: '2-digit', month: 'short' });
}
