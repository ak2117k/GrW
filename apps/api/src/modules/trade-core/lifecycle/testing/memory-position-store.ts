import { ActivePositionExistsError, type CorePositionRepository } from '../repositories/core-position.repository';
import { isActiveStatus, type CorePosition, type NewPositionRow, type PositionPatch } from '../lifecycle.types';

const copy = (p: CorePosition): CorePosition => structuredClone(p);
const oldestFirst = (a: CorePosition, b: CorePosition) => a.createdAt.getTime() - b.createdAt.getTime() || a.id.localeCompare(b.id);

/** CorePositionRepository in memory, with the same contract (memory-position-store.spec.ts; the opt-in DB test checks the real one). */
export class MemoryPositionStore {
  rows: CorePosition[] = [];
  private seq = 0;

  constructor(private readonly clock: () => Date = () => new Date()) {}

  readonly repo = {
    createIfNoActive: async (row: NewPositionRow): Promise<CorePosition> => {
      const exchange = row.instrument.exchange.toUpperCase();
      const active = this.rows.find(
        (p) => p.userId === row.userId && p.instrument.exchange === exchange && p.instrument.token === row.instrument.token && isActiveStatus(p.status),
      );
      if (active) throw new ActivePositionExistsError(active.id);
      if (this.rows.some((p) => p.intentId === row.intentId)) throw new Error('unique violation: core_positions.intentId');
      this.seq += 1;
      const now = this.clock();
      const p: CorePosition = {
        id: `pos_${this.seq}`,
        userId: row.userId,
        intentId: row.intentId,
        strategyId: row.strategyId,
        strategyVersionId: row.strategyVersionId,
        vehicle: row.vehicle,
        instrument: { ...row.instrument, exchange, underlying: row.vehicle === 'OPTIONS_BUY' ? row.underlying : null },
        underlying: row.underlying,
        side: row.side,
        direction: row.direction,
        status: 'PENDING_ENTRY',
        requestedQty: row.requestedQty,
        entryFilledQty: 0,
        exitFilledQty: 0,
        openQty: 0,
        entryAvgPrice: null,
        plan: structuredClone(row.plan),
        initialStopPrice: null,
        stopPrice: null,
        targetPrice: null,
        partialPrice: null,
        partialQty: 0,
        trailActive: false,
        partialDone: false,
        highWater: null,
        lowWater: null,
        exitSeq: 0,
        exitReason: null,
        blindSince: null,
        openedAt: null,
        closedAt: null,
        createdAt: now,
        updatedAt: now,
        version: 0,
      };
      this.rows.push(p);
      return copy(p);
    },
    findByIntent: async (intentId: string) => {
      const p = this.rows.find((x) => x.intentId === intentId);
      return p ? copy(p) : null;
    },
    findForUser: async (userId: string, id: string) => {
      const p = this.rows.find((x) => x.id === id && x.userId === userId);
      return p ? copy(p) : null;
    },
    /** No tenant scoping in memory: the bypass just runs fn. */
    withoutTenant: <T>(fn: () => T): T => fn(),
    listActive: async () => this.rows.filter((p) => isActiveStatus(p.status)).sort(oldestFirst).map(copy),
    listActiveUserIds: async () => [...new Set(this.rows.filter((p) => isActiveStatus(p.status)).map((p) => p.userId))].sort(),
    listForUser: async (userId: string, since: Date | null) =>
      this.rows
        .filter((p) => p.userId === userId && (since === null || isActiveStatus(p.status) || (p.closedAt !== null && p.closedAt.getTime() >= since.getTime())))
        .sort(oldestFirst)
        .map(copy),
    lastOpenedAt: async (userId: string, strategyId: string, token: string) => {
      const opened = this.rows
        .filter((p) => p.userId === userId && p.strategyId === strategyId && p.instrument.token === token && p.openedAt !== null)
        .map((p) => (p.openedAt as Date).getTime());
      return opened.length ? new Date(Math.max(...opened)) : null;
    },
    listClosedSince: async (userId: string, strategyId: string, token: string, since: Date) =>
      this.rows
        .filter((p) => p.userId === userId && p.strategyId === strategyId && p.instrument.token === token && p.status === 'CLOSED' && p.closedAt !== null && p.closedAt.getTime() >= since.getTime())
        .sort((a, b) => (b.closedAt as Date).getTime() - (a.closedAt as Date).getTime())
        .map(copy),
    listUserIdsSince: async (since: Date) =>
      [
        ...new Set(
          this.rows
            .filter((p) => isActiveStatus(p.status) || p.createdAt.getTime() >= since.getTime() || (p.closedAt !== null && p.closedAt.getTime() >= since.getTime()))
            .map((p) => p.userId),
        ),
      ].sort(),
    update: async (userId: string, id: string, expectVersion: number, patch: PositionPatch) => {
      const p = this.rows.find((x) => x.id === id && x.userId === userId && x.version === expectVersion);
      if (!p) return null;
      for (const [k, v] of Object.entries(patch)) if (v !== undefined) (p as unknown as Record<string, unknown>)[k] = v;
      p.openQty = p.entryFilledQty - p.exitFilledQty;
      p.version += 1;
      p.updatedAt = this.clock();
      return copy(p);
    },
  } as unknown as CorePositionRepository;
}
