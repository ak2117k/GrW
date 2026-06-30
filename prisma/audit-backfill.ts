/**
 * TDA-008 — audit_logs hash-chain backfill (idempotent, forward-only).
 *
 * Turns the pre-existing `audit_logs` rows (which were written with empty
 * `hash`/`prevHash` and no `seq`/`chainKey`) into a single valid hash chain so
 * the `tda008_audit_chain_seal` migration can tighten `seq`/`prevHash` to
 * NOT NULL and add the UNIQUE(chainKey, seq) backstop.
 *
 * Run order (see prisma/migrations/*_tda008_audit_chain*):
 *   1. apply migration `tda008_audit_chain`  (adds nullable seq + chainKey)
 *   2. run THIS script                       (populates seq/prevHash/hash)
 *   3. apply migration `tda008_audit_chain_seal` (seals NOT NULL + UNIQUE)
 *
 * Hashing is delegated to the SINGLE source of truth in
 * apps/api/src/common/audit/canonicalize.ts — never re-implemented here. The
 * payload field-set, the `?? null` coercion and `sha256(prevHash + payload)`
 * MUST stay byte-for-byte identical to AuditService.append / verifyChain
 * (Task 3); any divergence makes chain verification fail.
 *
 * Idempotent: re-running after a successful backfill is a no-op (exits 0).
 *
 * Usage (td_saas ONLY — never td_saas_test):
 *   DATABASE_URL='postgresql://postgres:postgres@127.0.0.1:5432/td_saas' \
 *     npx tsx prisma/audit-backfill.ts
 */
import { PrismaClient } from '@prisma/client';
import { canonicalize, sha256 } from '../apps/api/src/common/audit/canonicalize';

const prisma = new PrismaClient();

/** Genesis predecessor hash for seq=1: 64 hex zeros. MUST match AuditService. */
const GENESIS_PREV_HASH = '0'.repeat(64);

/** Single global chain for now (partition-ready via chainKey). */
const CHAIN_KEY = 'global';

/** Shape of the columns we read to (re)compute the chain. */
interface AuditRow {
  id: string;
  action: string;
  userId: string | null;
  target: string | null;
  meta: unknown;
  createdAt: Date;
}

async function main(): Promise<void> {
  // Reads use raw SQL on purpose. During backfill the DB is in the phase-1
  // state (nullable `seq`), but the generated client is typed against the
  // SEALED schema (non-nullable `seq`); the typed client therefore rejects both
  // a `{ seq: null }` filter and hydrating a NULL `seq` back into JS (P2032).
  // Raw SQL is agnostic to that mismatch. Writes still go through the typed
  // client below — those set `seq` to a non-null BigInt, so they hydrate fine.

  // Idempotent guard: a row still needs work iff seq IS NULL or hash = ''.
  const guard = await prisma.$queryRaw<{ total: bigint; pending: bigint }[]>`
    SELECT count(*) AS total,
           count(*) FILTER (WHERE "seq" IS NULL OR "hash" = '') AS pending
    FROM "audit_logs"
  `;
  const total = Number(guard[0].total);
  const pending = Number(guard[0].pending);

  if (total === 0) {
    console.log('[audit-backfill] no audit_logs rows; nothing to backfill.');
    return;
  }
  if (pending === 0) {
    console.log(
      `[audit-backfill] already backfilled: all ${total} rows have seq + hash. Exiting.`,
    );
    return;
  }

  // Deterministic chain order: oldest first, id as the stable tie-breaker.
  // Only the hash-input columns are read; seq/prevHash/hash/chainKey are
  // (re)computed below.
  const rows = await prisma.$queryRaw<AuditRow[]>`
    SELECT "id", "action", "userId", "target", "meta", "createdAt"
    FROM "audit_logs"
    ORDER BY "createdAt" ASC, "id" ASC
  `;

  let prevHash = GENESIS_PREV_HASH;
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const seq = BigInt(i + 1);

    // CROSS-TASK INVARIANT — copy this exactly in AuditService.append/verifyChain.
    // Absent fields are coerced to null (never undefined) so canonicalization is
    // stable; seq is the BigInt, createdAt is the row's stored Date.
    const payload = canonicalize({
      chainKey: CHAIN_KEY,
      seq,
      action: row.action,
      userId: row.userId ?? null,
      target: row.target ?? null,
      meta: row.meta ?? null,
      createdAt: row.createdAt,
    });
    const hash = sha256(prevHash + payload);

    // Only chain columns are touched — action/target/meta/createdAt/userId are
    // part of the hash and must remain byte-for-byte unchanged.
    await prisma.auditLog.update({
      where: { id: row.id },
      data: { chainKey: CHAIN_KEY, seq, prevHash, hash },
    });

    prevHash = hash;
  }

  console.log(
    `[audit-backfill] backfilled ${rows.length} row(s) into chain '${CHAIN_KEY}' (seq 1..${rows.length}).`,
  );
}

main()
  .then(async () => {
    await prisma.$disconnect();
    process.exit(0);
  })
  .catch(async (err) => {
    console.error('[audit-backfill] FAILED:', err);
    await prisma.$disconnect();
    process.exit(1);
  });
