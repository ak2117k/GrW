import { Injectable, OnModuleInit, Logger } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { TenantContextService } from '../tenant/tenant-context.service';
import { TENANT_MODELS } from '../tenant/tenant.constants';

/**
 * How many times boot will try to reach the database before giving up.
 *
 * SERVERLESS POSTGRES SUSPENDS WHEN IDLE. Neon parks its compute after a quiet
 * period, and the first connection after that has to wake it — which takes
 * longer than the driver's connect timeout, so attempt one fails and attempt
 * two succeeds. Nothing is wrong; the database was asleep.
 *
 * Without a retry that is a coin toss on every cold boot, and it does not fail
 * as "the database was asleep". It surfaces as whichever service happened to
 * query first — a scanner worker, a paper-account service, Prisma itself — so
 * one cause presented as three unrelated bugs across three runs, each with its
 * own plausible-looking stack trace.
 *
 * Five attempts with a 3s gap covers a normal wake with room to spare. A
 * genuinely unreachable database still fails, ~15s later, and says so once.
 */
const CONNECT_ATTEMPTS = 5;
const CONNECT_BACKOFF_MS = 3000;

/**
 * `$connect`, retried while the failure still looks like a sleeping database.
 *
 * Exported for its own test: this runs once at boot, so a regression here is
 * invisible until the next cold start in production.
 */
export async function connectWithRetry(
  connect: () => Promise<void>,
  logger: { log: (m: string) => void; warn: (m: string) => void },
  attempts: number = CONNECT_ATTEMPTS,
  backoffMs: number = CONNECT_BACKOFF_MS,
): Promise<void> {
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      await connect();
      if (attempt > 1) logger.log(`Database reached on attempt ${attempt}`);
      return;
    } catch (err) {
      // The LAST failure is rethrown untouched, so a genuinely misconfigured
      // connection string still surfaces as exactly the error Prisma raised.
      if (attempt === attempts) throw err;
      const message = err instanceof Error ? err.message : String(err);
      logger.warn(
        `Database unreachable on attempt ${attempt}/${attempts} — retrying in ` +
          `${backoffMs}ms. This is normal for a suspended serverless database. ` +
          `(${message.split('\n')[0]})`,
      );
      await new Promise((resolve) => setTimeout(resolve, backoffMs));
    }
  }
}

/** Operations whose `where` is a unique input (extendedWhereUnique applies). */
const UNIQUE_WHERE_OPS = new Set([
  'findUnique',
  'findUniqueOrThrow',
  'update',
  'delete',
]);

/** Operations whose `where` is a regular filter input (AND-merge applies). */
const FILTER_WHERE_OPS = new Set([
  'findFirst',
  'findFirstOrThrow',
  'findMany',
  'count',
  'aggregate',
  'groupBy',
  'updateMany',
  'updateManyAndReturn',
  'deleteMany',
]);

/**
 * Shared Prisma client (TDA-003 Task 2).
 *
 * Applies a `$extends` query component that makes tenant isolation
 * **structural**: for every tenant-owned model (see {@link TENANT_MODELS}),
 * whenever a non-admin tenant context is active, the query is auto-scoped to
 * `userId`. An unscoped query on user data therefore cannot be written by
 * accident.
 *
 * Bypass rule (spec §4/§5): scoping applies ONLY when a tenant context is active
 * AND `role !== 'ADMIN'`. No context (cron / Bull workers / the engine) or an
 * ADMIN context passes through unchanged — that is what keeps background and
 * admin cross-tenant work functioning.
 *
 * **Implementation note:** the installed Prisma 6 client (query-compiler build)
 * no longer ships the `$use` middleware the spec assumed, so scoping is done via
 * a `$extends` `query` component. A `query` component cannot swap one operation
 * for another (no `findUnique`→`findFirst` rewrite), so unique-where operations
 * are scoped with Prisma's `extendedWhereUnique` (GA since Prisma 5): the
 * `userId` filter is added to the unique `where`, so another tenant's row
 * returns `null` (findUnique) or throws `P2025` (update/delete) — never the row.
 * The constructor returns the extended client so the injected `PrismaService`
 * scopes transparently for existing callers.
 *
 * The extension **fails safe**: a tenant-model operation it cannot confidently
 * scope throws rather than running unscoped.
 */
@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit {
  private readonly logger = new Logger(PrismaService.name);

  /**
   * Lifecycle hook Nest invokes on boot. The constructor returns the **extended**
   * client (a different object with its own prototype that does NOT inherit this
   * class), so this is declared (not defined as a prototype method) and the real
   * implementation is re-attached as an own property of `extended` in the
   * constructor below. A prototype method here would be dead code — unreachable
   * on the returned instance — so it is intentionally absent (TDA-003 M-2).
   */
  declare onModuleInit: () => Promise<void>;

  static readonly CONNECT_ATTEMPTS = CONNECT_ATTEMPTS;

  constructor(private readonly tenantContext: TenantContextService) {
    super();

    const logger = this.logger;
    const extended = this.$extends(
      this.buildTenantScopingExtension(),
    ) as unknown as PrismaService;

    // The extended client has its own (non-PrismaService) prototype, so it lacks
    // our lifecycle method. Re-attach it so Nest's OnModuleInit still connects.
    extended.onModuleInit = async (): Promise<void> => {
      await connectWithRetry(() => extended.$connect(), logger);
      logger.log('Connected to PostgreSQL via Prisma (tenant scoping active)');
    };

    return extended;
  }

  /**
   * Build the `$extends` `query` component that scopes tenant-owned models. The
   * tenant context is read at query time via the captured service (the
   * extension callback's `this` is not the PrismaService instance).
   *
   * ============================ SCOPING LIMITATIONS ========================
   * This interceptor scopes ONLY **top-level** operations on tenant models
   * (the `model` + `operation` pair Prisma reports to `$allOperations`). Two
   * classes of access are therefore NOT auto-scoped and MUST be scoped by hand
   * wherever they touch tenant tables (TDA-003 I-3):
   *
   *   1. **Nested writes** — relation writes embedded in another model's
   *      payload, e.g. `prisma.user.create({ data: { trades: { create: … } } })`
   *      or `{ trades: { connect: { id } } }`. Prisma runs these as part of the
   *      PARENT operation, so the extension never sees a `Trade` op and cannot
   *      stamp/scope `userId`. Always write tenant rows via their own top-level
   *      delegate (`prisma.trade.create(…)`) so this interceptor applies.
   *
   *   2. **Raw queries** — `$queryRaw` / `$executeRaw` / `$queryRawUnsafe` /
   *      `$executeRawUnsafe`. These bypass the model layer entirely; any raw SQL
   *      against a tenant table must include its own `WHERE "userId" = …` guard.
   *
   * Raw queries DO exist today (e.g. `JobRunRepository.lastRunPerJob` over
   * `job_runs`, `NewsSymbolIndexService` over `instruments`, health/wake
   * `SELECT 1` pings). None target a tenant model, so none needs a `userId`
   * guard — but that is a per-call-site fact, not a property of the codebase.
   * Check the table a new raw query touches; do not infer from this note that
   * raw SQL here is safe by default.
   *
   * Nested writes on tenant relations had no call sites when this was last
   * checked (grepped for the `User` relation fields backing TENANT_MODELS —
   * `trades`, `settings`, `alerts`, `subscriptions`, … — followed by a nested
   * `create`/`connect`/`upsert`). That is a point-in-time grep over field names
   * read from the schema, not an invariant: adding a relation field invalidates
   * it. New code must honour these limits or it
   * reopens the cross-tenant hole this interceptor closes. The extension still
   * **fails safe** for the operations it does see: a tenant-model op it cannot
   * confidently scope throws rather than run unscoped.
   * =========================================================================
   */
  private buildTenantScopingExtension() {
    const tenantContext = this.tenantContext;
    return {
      query: {
        $allModels: {
          $allOperations({
            model,
            operation,
            args,
            query,
          }: {
            model: string;
            operation: string;
            args: unknown;
            query: (args: unknown) => Promise<unknown>;
          }): Promise<unknown> {
            const ctx = tenantContext.get();

            // System/background (no context) or ADMIN → never scope. Non-tenant
            // (global/IP) models → never scope.
            if (!ctx || ctx.role === 'ADMIN' || !TENANT_MODELS.has(model)) {
              return query(args);
            }

            return query(scopeArgs(model, operation, args, ctx.userId));
          },
        },
      },
    };
  }
}

type AnyRecord = Record<string, unknown>;

/** Auto-scope `args` for a tenant-owned operation, or fail safe by throwing. */
function scopeArgs(
  model: string,
  operation: string,
  args: unknown,
  userId: string,
): unknown {
  const base = (args as AnyRecord | undefined) ?? {};

  // Unique-where ops: add userId directly into the unique where
  // (extendedWhereUnique). A cross-tenant id then matches no row → null/P2025.
  if (UNIQUE_WHERE_OPS.has(operation)) {
    const where = (base.where as AnyRecord | undefined) ?? {};
    return { ...base, where: { ...where, userId } };
  }

  // Filter-where ops: merge AND: [{ userId }, <existing where> ].
  if (FILTER_WHERE_OPS.has(operation)) {
    return { ...base, where: { AND: [{ userId }, base.where ?? {}] } };
  }

  // create: stamp userId, overriding any client-supplied value.
  if (operation === 'create') {
    const data = (base.data as AnyRecord | undefined) ?? {};
    return { ...base, data: { ...data, userId } };
  }

  // createMany / createManyAndReturn: stamp userId on every row.
  if (operation === 'createMany' || operation === 'createManyAndReturn') {
    const data = base.data;
    if (Array.isArray(data)) {
      return { ...base, data: data.map((row) => ({ ...(row as object), userId })) };
    }
    if (data && typeof data === 'object') {
      return { ...base, data: { ...(data as object), userId } };
    }
    throw new Error(
      `TenantScoping: ${operation} without data on tenant model '${model}' — ` +
        'refusing to run unscoped',
    );
  }

  // upsert: scope the unique lookup, stamp create, and freeze userId on update.
  if (operation === 'upsert') {
    const where = (base.where as AnyRecord | undefined) ?? {};
    const create = (base.create as AnyRecord | undefined) ?? {};
    const next: AnyRecord = {
      ...base,
      where: { ...where, userId },
      create: { ...create, userId },
    };
    if (next.update && typeof next.update === 'object') {
      const update = { ...(next.update as AnyRecord) };
      delete update.userId; // never let the update branch reassign ownership
      next.update = update;
    }
    return next;
  }

  // Fail safe: any other operation on a tenant model could read/write unscoped.
  throw new Error(
    `TenantScoping: unhandled operation '${operation}' on tenant model ` +
      `'${model}' — refusing to run unscoped`,
  );
}
