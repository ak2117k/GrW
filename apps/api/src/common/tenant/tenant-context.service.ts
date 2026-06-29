import { Injectable } from '@nestjs/common';
import { ClsService } from 'nestjs-cls';

/** The request-scoped tenant principal stored under the `'tenant'` CLS key. */
export interface TenantContext {
  userId: string;
  role: string;
}

/** CLS key under which the tenant context is stored. */
const TENANT_KEY = 'tenant';

/**
 * Thin wrapper over `ClsService` exposing the request-scoped tenant context
 * (TDA-003 §3). The `TenantContextInterceptor` calls {@link set} from `req.user`
 * after the auth guard runs; `PrismaService` (Task 2) reads {@link get} to
 * auto-scope tenant-owned queries.
 *
 * **Key invariant:** "no context" means system/background scope (unscoped), not
 * "deny" — cron/queue/engine code never sets a context and keeps full access.
 */
@Injectable()
export class TenantContextService {
  constructor(private readonly cls: ClsService) {}

  /** The active tenant context, or `undefined` for system/background scope. */
  get(): TenantContext | undefined {
    return this.cls.get<TenantContext | undefined>(TENANT_KEY);
  }

  /** Set the tenant context for the remainder of the current CLS scope. */
  set(ctx: TenantContext): void {
    this.cls.set(TENANT_KEY, ctx);
  }

  /**
   * Run `fn` with the tenant context cleared (§5 explicit bypass), then restore
   * the previous value. Lets an authenticated admin action deliberately touch
   * data unscoped without leaking that bypass to the rest of the request.
   *
   * The bypass works in the **same CLS store** (it mutates the shared value, not
   * a nested `cls.run` scope), so restoration must wait for `fn` to actually
   * finish. When `fn` returns a promise — the common case, since the bypassed
   * work is an async Prisma query whose tenant context is read only once the
   * query runs — restoring synchronously would re-arm scoping before the query
   * executes, silently defeating the bypass. So for thenables we restore after
   * the promise settles; for synchronous `fn` we restore immediately.
   */
  runWithoutTenant<T>(fn: () => T): T {
    const previous = this.cls.get<TenantContext | undefined>(TENANT_KEY);
    this.cls.set(TENANT_KEY, undefined);
    const restore = (): void => {
      this.cls.set(TENANT_KEY, previous);
    };

    let result: T;
    try {
      result = fn();
    } catch (err) {
      restore();
      throw err;
    }

    if (
      result != null &&
      typeof (result as { then?: unknown }).then === 'function'
    ) {
      return (result as unknown as Promise<unknown>).then(
        (value) => {
          restore();
          return value;
        },
        (err) => {
          restore();
          throw err;
        },
      ) as unknown as T;
    }

    restore();
    return result;
  }
}
