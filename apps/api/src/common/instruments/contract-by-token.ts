import { istDateOf } from '../utils/contract-expiry';

/**
 * THE way to turn an (exchange, token) into an instrument-master row.
 *
 * WHY: Angel RE-USES a derivative's token once the contract expires, and the master keeps the expired
 * row (22k NFO tokens had 2+ rows on 2026-11-26). `findFirst({ where: { exchange, token } })` then returns
 * whichever row Postgres reads first: on 2026-11-26 the BHEL 29DEC 420 PE exit read BDL's chain and price
 * because token 90007 was also the expired BDL 25AUG 1500 CE. Earlier point fixes (90d2e1b9, 85b058ed,
 * d050d539) each patched one caller; `contract-by-token.ratchet.spec.ts` now fails the build on any new
 * token-keyed instrument lookup that does not come through here.
 *
 * Pick, among the rows sharing the token, ranked:
 *   1. the row whose symbol equals the caller's symbol hint (when given);
 *   2. a row not past expiry at `at` (IST date; a contract still holds its token on its own expiry day);
 *   3. a row that already existed at `at` (createdAt ≤ at), so a past instant gets the contract of that time;
 *   4. an active row;
 *   5. the nearest expiry (none = equity / index, last); among expired rows, the most recent expiry;
 *   6. the newest updatedAt.
 */
export interface ContractRow {
  id: string;
  symbol: string;
  name: string;
  exchange: string;
  token: string;
  lotSize: number;
  tickSize: number;
  expiry: Date | null;
  strike: number | null;
  optionType: string | null;
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export interface ContractRef {
  exchange: string;
  token: string;
  /** The instant the caller is asking about (the trade / decision / bar time); defaults to now. */
  at?: Date;
  /** The caller's tradingsymbol, when it has one: an exact match beats every other rule. */
  symbol?: string | null;
}

/** Only `instrument.findMany` is needed, so a spec can pass a stub. */
export interface InstrumentReader {
  instrument: { findMany(args: unknown): Promise<unknown[]> };
}

export const CONTRACT_SELECT = {
  id: true,
  symbol: true,
  name: true,
  exchange: true,
  token: true,
  lotSize: true,
  tickSize: true,
  expiry: true,
  strike: true,
  optionType: true,
  isActive: true,
  createdAt: true,
  updatedAt: true,
} as const;

const up = (s: string | null | undefined): string => String(s ?? '').trim().toUpperCase();

/** The row for one token among `rows` (all sharing that exchange + token), by the rules above. */
export function pickContract<T extends ContractRow>(rows: readonly T[], opts: { at: Date; symbol?: string | null }): T | null {
  if (rows.length === 0) return null;
  if (rows.length === 1) return rows[0];
  const day = istDateOf(opts.at);
  const hint = up(opts.symbol);
  const live = (r: T): boolean => r.expiry === null || istDateOf(r.expiry) >= day;
  const existed = (r: T): boolean => r.createdAt.getTime() <= opts.at.getTime();
  const flag = (b: boolean): number => (b ? 0 : 1);
  const expiryKey = (r: T): number => {
    if (r.expiry === null) return Number.MAX_SAFE_INTEGER;
    const t = r.expiry.getTime();
    // Live rows: nearest expiry first. Expired rows: most recent expiry first.
    return live(r) ? t : -t;
  };
  const sorted = [...rows].sort(
    (a, b) =>
      flag(hint !== '' && up(a.symbol) === hint) - flag(hint !== '' && up(b.symbol) === hint) ||
      flag(live(a)) - flag(live(b)) ||
      flag(existed(a)) - flag(existed(b)) ||
      flag(a.isActive) - flag(b.isActive) ||
      expiryKey(a) - expiryKey(b) ||
      b.updatedAt.getTime() - a.updatedAt.getTime(),
  );
  return sorted[0];
}

/** Resolve many refs with ONE query; the result is aligned with `refs` (null = no master row). */
export async function contractsByTokens(prisma: InstrumentReader, refs: readonly ContractRef[]): Promise<Array<ContractRow | null>> {
  const wanted = refs.filter((r) => up(r.exchange) !== '' && String(r.token ?? '').trim() !== '');
  if (wanted.length === 0) return refs.map(() => null);
  const pairs = new Map<string, { exchange: string; token: string }>();
  for (const r of wanted) pairs.set(`${up(r.exchange)}:${String(r.token).trim()}`, { exchange: up(r.exchange), token: String(r.token).trim() });
  const rows = (await prisma.instrument.findMany({ where: { OR: [...pairs.values()] }, select: CONTRACT_SELECT })) as ContractRow[];
  const byKey = new Map<string, ContractRow[]>();
  for (const row of rows) {
    const k = `${up(row.exchange)}:${row.token}`;
    const list = byKey.get(k);
    if (list) list.push(row);
    else byKey.set(k, [row]);
  }
  const now = new Date();
  return refs.map((r) => pickContract(byKey.get(`${up(r.exchange)}:${String(r.token ?? '').trim()}`) ?? [], { at: r.at ?? now, symbol: r.symbol }));
}

/** Resolve one (exchange, token). */
export async function contractByToken(
  prisma: InstrumentReader,
  exchange: string,
  token: string,
  opts: { at?: Date; symbol?: string | null } = {},
): Promise<ContractRow | null> {
  const [row] = await contractsByTokens(prisma, [{ exchange, token, at: opts.at, symbol: opts.symbol }]);
  return row;
}
