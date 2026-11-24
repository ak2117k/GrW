import { Prisma } from '@prisma/client';

/**
 * Test-only: rebuild the Prisma.Sql a `$queryRaw` tagged-template mock was called with, and apply the session
 * predicate it carries (market-hub/candles/session-sql) to in-memory rows — the bounds come from the captured
 * query itself, so a reader that forgets the filter keeps every row. The SQL text is checked on prod separately.
 */
export interface CapturedSql {
  text: string;
  values: unknown[];
}

export function capturedSql(calls: readonly unknown[][], call = 0): CapturedSql {
  const c = calls[call];
  if (!c) throw new Error(`no $queryRaw call #${call}`);
  const [strings, ...values] = c as [TemplateStringsArray | readonly string[], ...unknown[]];
  const q = Prisma.sql(strings as readonly string[], ...(values as Prisma.Sql[]));
  return { text: q.text, values: q.values };
}

const SESSION_RE = /AT TIME ZONE 'Asia\/Kolkata'\)::time >= \$(\d+)::time AND \(\w+ AT TIME ZONE 'Asia\/Kolkata'\)::time < \$(\d+)::time/;

/** The [from, to) IST "HH:MM" bounds of the captured query's session filter; null when it has none. */
export function sessionBounds(q: CapturedSql): { from: string; to: string } | null {
  const m = SESSION_RE.exec(q.text);
  if (!m) return null;
  return { from: String(q.values[Number(m[1]) - 1]), to: String(q.values[Number(m[2]) - 1]) };
}

const IST_MS = 330 * 60_000;
const hhmmOf = (ts: number) => new Date(ts + IST_MS).toISOString().slice(11, 16);

/** The rows the captured query would return: all of them without a session filter, else those whose IST minute is inside it. */
export function rowsPassing<R extends { ts: number }>(q: CapturedSql, rows: readonly R[]): R[] {
  const b = sessionBounds(q);
  if (!b) return [...rows];
  return rows.filter((r) => hhmmOf(r.ts) >= b.from && hhmmOf(r.ts) < b.to);
}
