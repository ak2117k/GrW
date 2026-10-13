import type { ModuleRef } from '@nestjs/core';
import type { HubExchange, Price } from '../../../market-hub/hub.types';
import type { CoreOrder } from '../../execution/execution.types';
import { CoreOrderEvents } from '../../execution/order-events';
import { PaperExecutionAdapter } from '../../execution/paper-execution.adapter';
import { PaperLedgerService } from '../../execution/paper-ledger.service';
import { PaperMatcherService } from '../../execution/paper-matcher.service';
import { FakeHub, fakeHubSource, fakeModuleRef } from '../../execution/testing/fake-hub';
import { fakeDefaults, MemoryPaperStore } from '../../execution/testing/memory-paper-store';
import { depth, paperSettings } from '../../execution/testing/paper-fixtures';
import type { CoreEntryIntent, LimitInForce } from '../../risk-wall/risk-wall.types';
import type { CoreKillSwitchReader } from '../../risk-wall/services/core-kill-switch.reader';
import type { CoreKillSwitchService } from '../../risk-wall/services/core-kill-switch.service';
import type { CoreRiskLimitService } from '../../risk-wall/services/core-risk-limit.service';
import { intentFixture, limitsFixture } from '../../risk-wall/testing/risk-fixtures';
import type { StrategyBlocks } from '../../strategies/blocks/block-types';
import type { CoreStrategyRepository } from '../../strategies/repositories/core-strategy.repository';
import { adaptiveBlocks, plainBlocks } from '../../strategies/testing/block-fixtures';
import { CoreLifecycleService, type CoreOpenRequest } from '../core-lifecycle.service';
import type { LifecycleEventSink } from '../lifecycle-events';
import type { CorePositionRepository } from '../repositories/core-position.repository';
import type { LifecycleEvent } from '../lifecycle.types';
import { mtfBlocks, optionBlocks } from './lifecycle-fixtures';
import { MemoryPositionStore } from './memory-position-store';

const IST_MS = 5.5 * 3600_000;

export class MemoryEventSink implements LifecycleEventSink {
  readonly events: LifecycleEvent[] = [];

  async record(e: LifecycleEvent): Promise<void> {
    this.events.push(e);
  }

  types(positionId?: string): string[] {
    return this.events.filter((e) => !positionId || e.positionId === positionId).map((e) => e.type);
  }
}

/** The catalogue the harness answers (test data only). */
export const VERSIONS: Record<string, { strategyId: string; status: string; blocks: StrategyBlocks }> = {
  csv_ungated_v1: { strategyId: 'cs_ungated', status: 'PAPER', blocks: plainBlocks() },
  csv_adaptive_v1: { strategyId: 'cs_adaptive', status: 'PAPER', blocks: adaptiveBlocks() },
  csv_mtf_v1: { strategyId: 'cs_mtf', status: 'PAPER', blocks: mtfBlocks() },
  csv_option_v1: { strategyId: 'cs_option', status: 'PAPER', blocks: optionBlocks() },
  csv_draft: { strategyId: 'cs_ungated', status: 'DRAFT', blocks: plainBlocks() },
};

export interface HarnessOptions {
  /** Users the fake hub serves (default A and B). */
  served?: string[];
  /** The live limits CoreRiskLimitService answers (default the fixture limits). */
  liveLimits?: () => LimitInForce[];
  /** core_paper_defaults blindAfterMs (default 30 000; null = row absent). */
  blindAfterMs?: number | null;
  /** Subscribe the service to order updates (default true). */
  subscribe?: boolean;
  /** Wrap the repository the service uses (e.g. to emulate tenant scoping); the store's rows stay shared. */
  repo?: (memory: CorePositionRepository) => CorePositionRepository;
  /** Also hand every lifecycle event to this sink (M5: the journal sink), after the memory sink. */
  teeSink?: LifecycleEventSink;
}

/**
 * The real M3 ledger, matcher and paper adapter over memory stores and one fake hub, plus a
 * CoreLifecycleService. Use with jest.useFakeTimers({ now: NOW }): every time is Date.now().
 */
export function lifecycleHarness(opts: HarnessOptions = {}) {
  const paper = new MemoryPaperStore(() => new Date());
  const positions = new MemoryPositionStore(() => new Date());
  const defaults = fakeDefaults(paperSettings({ blindAfterMs: opts.blindAfterMs === undefined ? 30_000 : opts.blindAfterMs }));
  const events = new CoreOrderEvents();
  const ledger = new PaperLedgerService(paper.tx, paper.orderRepo, paper.fillRepo, paper.ledgerRepo, defaults, events);
  const hub = new FakeHub();
  const moduleRef = fakeModuleRef(fakeHubSource(Object.fromEntries((opts.served ?? ['user_A', 'user_B']).map((u) => [u, hub])))) as unknown as ModuleRef;
  const session = { open: true };
  const clock = {
    isOpen: () => session.open,
    isTradingDay: (_exchange: string, at: Date) => {
      const d = new Date(at.getTime() + IST_MS).getUTCDay();
      return d !== 0 && d !== 6;
    },
  };
  const killOn = new Set<string>();
  const matcher = new PaperMatcherService(ledger, defaults, moduleRef, clock);
  const adapter = new PaperExecutionAdapter(ledger, matcher, { isActive: async (u: string) => killOn.has(u) } as unknown as CoreKillSwitchService, clock);
  const strategies = { findVersion: async (id: string) => (VERSIONS[id] ? { id, ...VERSIONS[id] } : null) } as unknown as CoreStrategyRepository;
  const limits = { inForce: async () => (opts.liveLimits ? opts.liveLimits() : limitsFixture()) } as unknown as CoreRiskLimitService;
  const killReader = { isOn: async (u: string) => killOn.has(u) } as unknown as CoreKillSwitchReader;
  const sink = new MemoryEventSink();
  const serviceRepo = opts.repo ? opts.repo(positions.repo) : positions.repo;
  const tee: LifecycleEventSink = opts.teeSink
    ? {
        record: async (e) => {
          await sink.record(e);
          await opts.teeSink?.record(e);
        },
      }
    : sink;
  const make = () => new CoreLifecycleService(serviceRepo, adapter, strategies, defaults, limits, killReader, moduleRef, clock, tee);
  let lifecycle = make();
  if (opts.subscribe !== false) lifecycle.subscribe();

  const advance = (ms: number) => jest.setSystemTime(Date.now() + ms);
  const settle = async () => {
    for (let i = 0; i < 5; i += 1) await lifecycle.idle();
  };

  /** One market price (default RELIANCE-EQ, deep book): the matcher sees it first, then the lifecycle. */
  async function price(ltp: number, o: { exchange?: HubExchange; token?: string; symbol?: string; qty?: number } = {}): Promise<Price> {
    advance(10);
    const book = o.qty ?? 1_000_000;
    const p: Price = {
      ref: { exchange: o.exchange ?? 'NSE', token: o.token ?? '2885', symbol: o.symbol ?? 'RELIANCE-EQ' },
      ltp,
      at: Date.now(),
      source: 'ws',
      depth: depth([[ltp, book]], [[ltp, book]]),
    };
    hub.setFresh(p);
    advance(1);
    await matcher.onPrice(hub, p, Date.now());
    await settle();
    await lifecycle.onPrice(hub, p, Date.now());
    await settle();
    return p;
  }

  async function sweep(): Promise<void> {
    await matcher.sweep(Date.now());
    await settle();
    await lifecycle.sweep(Date.now());
    await settle();
  }

  /** A restart: the old service is torn down and a new one is built over the same stores. */
  function restart(): CoreLifecycleService {
    lifecycle.onModuleDestroy();
    lifecycle = make();
    lifecycle.subscribe();
    return lifecycle;
  }

  const ordersOf = (positionId: string): CoreOrder[] => paper.orders.filter((x) => x.positionId === positionId);

  return {
    paper,
    positions,
    defaults,
    ledger,
    matcher,
    adapter,
    hub,
    session,
    killOn,
    sink,
    get lifecycle() {
      return lifecycle;
    },
    advance,
    settle,
    price,
    sweep,
    restart,
    ordersOf,
  };
}

/** Ungated-shaped cash BUY of 100 RELIANCE-EQ at a 500 reference. */
export function openRequest(over: Partial<CoreOpenRequest> = {}, intent: Partial<CoreEntryIntent> = {}): CoreOpenRequest {
  const i = intentFixture({ intentId: 'int_1', symbol: 'RELIANCE-EQ', underlying: 'RELIANCE', qty: 100, refPrice: 500, stopPrice: 492.5, capitalPerUnit: 100, ...intent });
  return {
    intent: i,
    qty: i.qty,
    instrument: { exchange: 'NSE', token: '2885', symbol: 'RELIANCE-EQ', lotSize: 1, underlying: null },
    atr: null,
    limits: limitsFixture(),
    option: null,
    ...over,
  };
}
