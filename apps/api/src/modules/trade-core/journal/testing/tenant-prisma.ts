import type { TenantContextService } from '../../../../common/tenant/tenant-context.service';

type Row = Record<string, unknown> & { userId: string };

/**
 * A Prisma double that behaves like the tenant extension for createMany / findFirst on a
 * tenant model: the scope is read when the (lazy) promise is awaited, a non-admin tenant
 * overwrites every row's userId and filters reads by it.
 */
export function tenantStampingPrisma(tenant: TenantContextService, modelNames: readonly string[]) {
  const rows: Record<string, Row[]> = {};
  let failNext = 0;
  const scopeUser = (): string | undefined => {
    const ctx = tenant.get();
    return ctx && ctx.role !== 'ADMIN' ? ctx.userId : undefined;
  };
  const lazy = <T>(run: () => T): PromiseLike<T> => ({
    then: (ok, ko) => {
      try {
        return Promise.resolve(run()).then(ok, ko);
      } catch (err) {
        return Promise.reject(err).then(ok, ko);
      }
    },
  });
  const model = (name: string) => {
    rows[name] = [];
    return {
      createMany: jest.fn((args: { data: Row[] }) =>
        lazy(() => {
          if (failNext > 0) {
            failNext -= 1;
            throw new Error('db down');
          }
          const user = scopeUser();
          const data = args.data.map((r) => (user ? { ...r, userId: user } : { ...r }));
          rows[name].push(...data);
          return { count: data.length };
        }),
      ),
      findFirst: jest.fn((args: { where: Record<string, unknown> }) =>
        lazy(() => {
          const user = scopeUser();
          const where = user ? { ...args.where, userId: user } : args.where;
          return rows[name].find((r) => Object.entries(where).every(([k, v]) => r[k] === v)) ?? null;
        }),
      ),
    };
  };
  const prisma: Record<string, unknown> = {};
  for (const n of modelNames) prisma[n] = model(n);
  return { prisma, rows, failOnce: () => void (failNext += 1) };
}
