import type { ModuleRef } from '@nestjs/core';
import type { AuditService } from '../../../../common/audit/audit.service';
import type { JobRunnerService } from '../../../../common/job-registry';
import { HUB_PRICE_SOURCE } from '../../../market-hub/hub-prices';
import type { SessionClock } from '../../../market-hub/session-clock';
import { PaperOrderSquareOff } from '../../execution/paper-order-square-off';
import { fakeHubSource } from '../../execution/testing/fake-hub';
import { CoreEntryIntake } from '../../intake/core-entry-intake.service';
import { DEFAULT_MAX_ALERT_AGE_MS, type EntryMode } from '../../intake/entry-config';
import { EntryMarket } from '../../intake/entry-market';
import { adaptiveSeedBlocks, hit } from '../../intake/testing/intake-fixtures';
import type { CoreLifecycleService, CoreOpenRequest } from '../../lifecycle/core-lifecycle.service';
import { CoreRiskStateProvider } from '../../lifecycle/core-risk-state.provider';
import { CoreSquareOff } from '../../lifecycle/core-square-off';
import { DailyLossMonitor } from '../../lifecycle/daily-loss.monitor';
import { CORE_POSITION_EXITS } from '../../lifecycle/lifecycle-ports';
import { lifecycleHarness, VERSIONS } from '../../lifecycle/testing/lifecycle-harness';
import { CoreCandles } from '../../market/core-candles';
import type { LimitInForce } from '../../risk-wall/risk-wall.types';
import type { CoreKillSwitchService } from '../../risk-wall/services/core-kill-switch.service';
import type { CoreRiskLimitService } from '../../risk-wall/services/core-risk-limit.service';
import { RiskWallService } from '../../risk-wall/services/risk-wall.service';
import { limitsFixture } from '../../risk-wall/testing/risk-fixtures';
import { plainBlocks } from '../../strategies/testing/block-fixtures';
import type { CoreStrategySelectionRepository, LiveSelection } from '../../strategies/repositories/core-strategy-selection.repository';
import { CoreJournalService } from '../core-journal.service';
import { CoreReconciler } from '../core-reconciler.service';
import { CoreTradeSummaryService } from '../core-trade-summary.service';
import { JournalRiskReads } from '../journal-risk-reads';
import { JournalLifecycleSink, JournalRiskVerdictSink } from '../journal-sinks';
import type { CoreJournalRepository } from '../repositories/core-journal.repository';
import type { CoreTradeSummaryRepository } from '../repositories/core-trade-summary.repository';
import { OrderJournaler } from '../order-journaler';
import { MemoryJournalStore } from './memory-journal-store';

// The seeded Adaptive-Stop v1, approved into PAPER (test catalogue only).
VERSIONS.csv_adaptive_stop_v1 = { strategyId: 'cs_adaptive_stop', status: 'PAPER', blocks: adaptiveSeedBlocks() };

export const SEL_UNGATED = (userId = 'user_A'): LiveSelection => ({ userId, strategyId: 'cs_ungated', strategyKey: 'ungated', strategyVersionId: 'csv_ungated_v1', blocks: plainBlocks(), capitalAllocation: '200000.00' });
export const SEL_ADAPTIVE = (userId = 'user_A'): LiveSelection => ({ userId, strategyId: 'cs_adaptive_stop', strategyKey: 'adaptive-stop', strategyVersionId: 'csv_adaptive_stop_v1', blocks: adaptiveSeedBlocks(), capitalAllocation: '200000.00' });

export interface M5Options {
  mode?: EntryMode;
  users?: string[];
  selections?: LiveSelection[];
  /** Users the hub prices (default only user_A, like production). */
  served?: string[];
  limits?: () => LimitInForce[];
}

/**
 * The whole SP2 core in memory: M3 ledger/matcher/adapter + M4 lifecycle (lifecycleHarness) + the real
 * M2 RiskWallService and CoreRiskStateProvider + the real M4 CoreSquareOff + every M5 part over a
 * MemoryJournalStore. The hub candle store is absent (candles unavailable: the gate fails open as
 * seeded, ATR floors at minPct). The corpus is a jest mock (CoreCorpusWriter has its own spec).
 */
export function m5Harness(o: M5Options = {}) {
  const store = new MemoryJournalStore();
  const journalRepo = store.repo as unknown as CoreJournalRepository;
  const summaryRepo = store.summaryRepo as unknown as CoreTradeSummaryRepository;
  const journal = new CoreJournalService(journalRepo);
  const corpus = { entrySetup: jest.fn().mockResolvedValue(undefined), outcome: jest.fn().mockResolvedValue(undefined) };
  const limits = o.limits ?? (() => limitsFixture());
  let summaries: CoreTradeSummaryService | null = null;
  const closed = { positionClosed: async (u: string, id: string) => void (await summaries?.writeFor(u, id)) };
  const h = lifecycleHarness({ served: o.served ?? ['user_A'], liveLimits: limits, teeSink: new JournalLifecycleSink(journal, closed) });
  summaries = new CoreTradeSummaryService(h.positions.repo, h.ledger, summaryRepo, corpus);
  const reads = new JournalRiskReads(journalRepo);
  const clock = { isOpen: () => h.session.open } as unknown as SessionClock;
  // h.restart() swaps h.lifecycle; every consumer reaches it through these, as a real restart rebuilds them.
  const lifecycle = { openPosition: (r: CoreOpenRequest, n?: Date) => h.lifecycle.openPosition(r, n) } as unknown as CoreLifecycleService;
  const marks = { mark: (id: string) => h.lifecycle.mark(id) };
  const provider = new CoreRiskStateProvider(h.ledger, h.positions.repo, marks, reads);
  const limitService = { inForce: async () => limits() } as unknown as CoreRiskLimitService;
  const killSwitch = { isActive: async (u: string) => h.killOn.has(u) } as unknown as CoreKillSwitchService;
  const wall = new RiskWallService(limitService, killSwitch, provider, new JournalRiskVerdictSink(journal), clock);
  const hubSource = fakeHubSource(Object.fromEntries((o.served ?? ['user_A']).map((u) => [u, h.hub])));
  const moduleRef = {
    get: (token: unknown) => {
      if (token === HUB_PRICE_SOURCE) return hubSource;
      if (token === CORE_POSITION_EXITS) return h.lifecycle;
      throw new Error('no market hub candles in this test');
    },
  } as unknown as ModuleRef;
  const market = new EntryMarket(moduleRef, new CoreCandles(moduleRef));
  Object.assign(market, { sleep: async (ms: number) => { h.advance(ms); } });
  const selections = { listEnabledPaper: async () => o.selections ?? [SEL_UNGATED()] } as unknown as CoreStrategySelectionRepository;
  const intake = new CoreEntryIntake({ mode: o.mode ?? 'paper', userIds: new Set(o.users ?? ['user_A']), maxAlertAgeMs: DEFAULT_MAX_ALERT_AGE_MS }, selections, wall, lifecycle, h.defaults, market, summaries, journal, corpus);
  const orders = new OrderJournaler(h.adapter, h.ledger, journal);
  orders.onModuleInit();
  const jobs = { run: jest.fn((_n: string, _o: unknown, fn: () => Promise<unknown>) => fn()) } as unknown as JobRunnerService;
  const audit = { append: jest.fn().mockResolvedValue({ seq: 1n, hash: 'h' }) } as unknown as AuditService;
  const recon = new CoreReconciler(h.positions.repo, h.ledger, summaryRepo, journalRepo, journal, summaries, h.adapter, h.defaults, clock, jobs, audit);
  // The real kill-switch / daily-loss cascade target: cancel pending entry orders, exit every position.
  const squareOff = new CoreSquareOff(new PaperOrderSquareOff(h.ledger, h.matcher), moduleRef);
  const monitor = new DailyLossMonitor(h.positions.repo, provider, limitService, squareOff, audit, journal);

  /** Let every queued write, order update and sink call finish. */
  async function pump(): Promise<void> {
    for (let i = 0; i < 4; i += 1) {
      await h.settle();
      for (let j = 0; j < 5; j += 1) await new Promise((r) => setImmediate(r));
      await journal.flush();
    }
  }

  /** A Chartink hit now, with a fresh hub price for its instrument first (the intake reads the hub). */
  function hitAt(ltp: number, over: Parameters<typeof hit>[0] = {}) {
    const x = hit({ receivedAt: new Date(), alertAt: new Date(), hitPrice: ltp, ...over });
    h.hub.setFresh({ ref: { exchange: 'NSE', token: x.token, symbol: x.tradingSymbol }, ltp, at: Date.now(), source: 'ws' });
    return x;
  }

  const types = (positionId?: string) => store.rows.filter((r) => !positionId || r.positionId === positionId).map((r) => r.type);

  return { h, store, journal, corpus, summaries, wall, intake, recon, reads, monitor, squareOff, orders, pump, hitAt, types };
}
