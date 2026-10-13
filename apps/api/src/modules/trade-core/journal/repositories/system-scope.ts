import type { ClsService } from 'nestjs-cls';

/**
 * Run a journal write in a FRESH CLS context that carries no tenant (review fix 1). The rows
 * carry their own explicit userId; the Prisma tenant extension would otherwise stamp the
 * caller's tenant over it (createMany overwrites userId), so a USER request that drains the
 * shared buffer could write another user's rows as its own. A nested `cls.run` with
 * `ifNested: 'override'` is used, not `runWithoutTenant`, because that mutates the request's
 * shared store. `fn` is awaited INSIDE the scope: Prisma promises are lazy and read the tenant
 * when awaited.
 */
export function inSystemScope<T>(cls: ClsService, fn: () => Promise<T>): Promise<T> {
  return cls.run({ ifNested: 'override' }, async () => await fn());
}
