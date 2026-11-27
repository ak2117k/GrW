/**
 * Task 7 wiring proof: every exit-authority port resolves to the REAL instance in every consumer module, with
 * TRADE_AGENT_AUTHORITY=off and =live — never undefined (an unbound port is the "every alarm silently dropped" bug).
 *
 * Each consumer module is rebuilt as a clone with the SAME provider list and the same ExitAuthorityModule import
 * (asserted against the real module's metadata), all in one app so the cross-module late-bound ports (TRACKER_WAKE,
 * SUPREME_CONFIRM, HARD_LOSS_PROBE, OWNER_EXIT, AI_HEALTH) resolve exactly as in grw-api. Every OTHER dependency is
 * auto-mocked; the port tokens are NEVER mocked, so a missing binding stays missing and fails the identity checks.
 */
import { Global, Module, type Provider, type Type } from '@nestjs/common';
import { MODULE_METADATA } from '@nestjs/common/constants';
import { ConfigModule } from '@nestjs/config';
import { Test, type TestingModule } from '@nestjs/testing';
import { PrismaService } from '../../common/prisma/prisma.service';
import { AI_HEALTH } from '../ai-gateway/audit/failover-transport';
import { DeskManagerModule } from '../desk-manager/desk-manager.module';
import { DeskActionsService } from '../desk-manager/services/desk-actions.service';
import { DeskExitActions } from '../desk-manager/services/desk-exit-actions.service';
import { DeskStateService } from '../desk-manager/services/desk-state.service';
import { ManagerLlmService } from '../desk-manager/services/manager-llm.service';
import { PendingEntryWatchService } from '../desk-manager/services/pending-entry-watch.service';
import { SupremeConfirmService } from '../desk-manager/services/supreme-confirm.service';
import { TargetWatchService } from '../desk-manager/services/target-watch.service';
import { IntradayCarryModule } from '../intraday-carry/intraday-carry.module';
import { IntradayCarryService } from '../intraday-carry/intraday-carry.service';
import { SentinelExecutorModule } from '../sentinel-executor/sentinel-executor.module';
import { ExitAuthorityRouter } from '../sentinel-executor/services/exit-authority-router.service';
import { ManualOwnerExit } from '../sentinel-executor/services/owner-exit.adapter';
import { SentinelExitExecutor } from '../sentinel-executor/services/sentinel-exit-executor.service';
import { TriggerWatchService } from '../sentinel-executor/services/trigger-watch.service';
import { ExecutorAuthorityBootCheck } from '../sentinel-executor/services/authority-boot-check.service';
import { OrderTrackerService } from '../trade-engine/services/order-tracker.service';
import { TradeExecutionService } from '../trade-engine/services/trade-execution.service';
import { TradeEngineModule } from '../trade-engine/trade-engine.module';
import { ALARM_CHART_READER } from '../trade-sentinel/services/alarm-chart';
import { SentinelAgentService } from '../trade-sentinel/services/sentinel-agent.service';
import { SentinelCycleService } from '../trade-sentinel/services/sentinel-cycle.service';
import { SentinelRunnerService } from '../trade-sentinel/services/sentinel-runner.service';
import { TradeSentinelModule } from '../trade-sentinel/trade-sentinel.module';
import { ExitAuthorityModule } from './exit-authority.module';
import {
  AUTHORITY_STATE,
  OWNER_ESCALATION,
  SUPREME_CONFIRM,
  TRACKER_WAKE,
  TRADE_ALARMS,
  TRADE_BRIEFS,
} from './exit-authority.tokens';
import { lateBindingOf } from './late-ports';
import { TradeBriefRepository } from './repositories/trade-brief.repository';
import { AuthorityStateService } from './services/authority-state.service';
import { EscalationRunner, HARD_LOSS_PROBE, OWNER_EXIT } from './services/escalation-runner.service';
import { TradeAlarmsService } from './services/trade-alarms.service';
import { ExitAuthorityWiringCheck } from './services/wiring-check.service';
import { OwnerButtonsService } from './telegram/owner-buttons.service';
import { TelegramBotClient } from './telegram/telegram-bot.client';

const PORT_TOKENS = new Set<unknown>([
  TRADE_ALARMS, AUTHORITY_STATE, TRADE_BRIEFS, OWNER_ESCALATION, SUPREME_CONFIRM,
  TRACKER_WAKE, HARD_LOSS_PROBE, OWNER_EXIT, AI_HEALTH, ALARM_CHART_READER,
]);

/** Optional test-override tokens (AUTHORITY_ENV, TELEGRAM_DEPS, …): left absent so the services read process.env. */
function isEnvOverride(token: unknown): boolean {
  const name = typeof token === 'symbol' ? token.description ?? '' : typeof token === 'string' ? token : '';
  return /(^|_)(ENV|DEPS)$/.test(name);
}

/** A do-nothing stand-in for any non-port dependency: every method is a jest.fn returning undefined. */
function autoMock(): unknown {
  const fns: Record<string | symbol, unknown> = {};
  return new Proxy(fns, {
    get(target, prop) {
      if (prop === 'then' || typeof prop === 'symbol') return undefined;
      return (target[prop] ??= jest.fn());
    },
  });
}

const CONSUMERS: Array<[string, Type<unknown>]> = [
  ['TradeSentinelModule', TradeSentinelModule],
  ['SentinelExecutorModule', SentinelExecutorModule],
  ['DeskManagerModule', DeskManagerModule],
  ['IntradayCarryModule', IntradayCarryModule],
  ['TradeEngineModule', TradeEngineModule],
];

const clones = new Map<string, Type<unknown>>();
function cloneOf(name: string, real: Type<unknown>): Type<unknown> {
  const existing = clones.get(name);
  if (existing) return existing;
  const providers = (Reflect.getMetadata(MODULE_METADATA.PROVIDERS, real) ?? []) as Provider[];
  // A distinct module class per consumer: the clone keeps the real module's own-provider scope (a local
  // SUPREME_CONFIRM in DeskManagerModule wins over the imported forwarder, exactly as in the app).
  const clone = ({ [`${name}Clone`]: class {} } as Record<string, Type<unknown>>)[`${name}Clone`];
  Module({ imports: [ExitAuthorityModule], providers })(clone);
  clones.set(name, clone);
  return clone;
}

@Global()
@Module({ providers: [{ provide: PrismaService, useFactory: autoMock }], exports: [PrismaService] })
class FakePrismaModule {}

async function build(mode: 'off' | 'live'): Promise<TestingModule> {
  process.env.TRADE_AGENT_AUTHORITY = mode;
  process.env.TELEGRAM_ALERT_BOT_TOKEN = mode === 'live' ? 'test-token' : '';
  process.env.TELEGRAM_ALERT_CHAT_ID = mode === 'live' ? '42' : '';
  const mod = await Test.createTestingModule({
    imports: [
      ConfigModule.forRoot({ isGlobal: true, ignoreEnvFile: true }),
      FakePrismaModule,
      ExitAuthorityModule,
      ...CONSUMERS.map(([n, m]) => cloneOf(n, m)),
    ],
  })
    .overrideProvider(PrismaService)
    .useFactory({ factory: autoMock })
    .overrideProvider(TelegramBotClient)
    .useValue({ sendMessage: jest.fn().mockResolvedValue(1), editMessage: jest.fn(), deleteMessage: jest.fn(), answerCallback: jest.fn(), getUpdates: jest.fn().mockResolvedValue([]), ownerUserId: () => null })
    .useMocker((token) => (PORT_TOKENS.has(token) || isEnvOverride(token) ? undefined : autoMock()))
    .compile();
  await mod.get(AuthorityStateService).bootCheck();
  return mod;
}

const field = (o: unknown, k: string): unknown => (o as Record<string, unknown>)[k];
/** The real instance behind a port as injected: a late-bound forwarder's resolved target, else the value itself. */
const realOf = (port: unknown): unknown => {
  const b = lateBindingOf(port);
  return b ? b.resolve() : port;
};
const inClone = (mod: TestingModule, name: string) => mod.select(clones.get(name)!);
/**
 * Each [label, injected, expected] must be the SAME non-null instance. Failures print only the labels (a diff of
 * these object graphs would print the whole injector and exhaust the heap).
 */
function expectSame(pairs: Array<[string, unknown, unknown]>): void {
  const wrong = pairs
    .filter(([, got, want]) => got == null || got !== want)
    .map(([label, got]) => `${label}: ${got == null ? 'UNBOUND' : 'another instance'}`);
  expect(wrong).toEqual([]);
}

describe.each(['off', 'live'] as const)('exit-authority wiring, TRADE_AGENT_AUTHORITY=%s', (mode) => {
  let mod: TestingModule;
  let state: AuthorityStateService;
  let alarms: TradeAlarmsService;
  let briefs: TradeBriefRepository;
  let buttons: OwnerButtonsService;

  beforeAll(async () => {
    mod = await build(mode);
    state = mod.get(AuthorityStateService);
    alarms = mod.get(TradeAlarmsService);
    briefs = mod.get(TradeBriefRepository);
    buttons = mod.get(OwnerButtonsService);
  }, 120_000);

  afterAll(async () => {
    delete process.env.TRADE_AGENT_AUTHORITY;
    delete process.env.TELEGRAM_ALERT_BOT_TOKEN;
    delete process.env.TELEGRAM_ALERT_CHAT_ID;
    await mod?.close();
  });

  it(`the effective mode is ${mode} after the boot check`, () => {
    expect(state.isLive()).toBe(mode === 'live');
  });

  it.each(CONSUMERS)('%s really imports ExitAuthorityModule (the clone mirrors it)', (_n, real) => {
    expect((Reflect.getMetadata(MODULE_METADATA.IMPORTS, real) as unknown[]).includes(ExitAuthorityModule)).toBe(true);
  });

  it('ExitAuthorityModule: TradeAlarmsService, the runner and the buttons get every port, late ones resolved to the real implementers', () => {
    const sentinel = inClone(mod, 'TradeSentinelModule');
    const executor = inClone(mod, 'SentinelExecutorModule');
    const desk = inClone(mod, 'DeskManagerModule');
    const runner = mod.get(EscalationRunner);
    expectSame([
      ['TradeAlarmsService.state', field(alarms, 'state'), state],
      ['TradeAlarmsService.wake → SentinelRunnerService', realOf(field(alarms, 'wake')), sentinel.get(SentinelRunnerService)],
      ['EscalationRunner.alarms', field(runner, 'alarms'), alarms],
      ['EscalationRunner.briefs', field(runner, 'briefs'), briefs],
      ['EscalationRunner.supreme → SupremeConfirmService', realOf(field(runner, 'supreme')), desk.get(SupremeConfirmService)],
      ['EscalationRunner.ownerExit → OWNER_EXIT', realOf(field(runner, 'ownerExit')), executor.get(OWNER_EXIT)],
      ['EscalationRunner.probe → HARD_LOSS_PROBE', realOf(field(runner, 'probe')), sentinel.get(HARD_LOSS_PROBE)],
      ['EscalationRunner.aiHealth → AI_HEALTH', realOf(field(runner, 'aiHealth')), sentinel.get(AI_HEALTH)],
      ['OwnerButtonsService.ownerExit → OWNER_EXIT', realOf(field(buttons, 'ownerExit')), executor.get(OWNER_EXIT)],
    ]);
    expect(executor.get(OWNER_EXIT) instanceof ManualOwnerExit).toBe(true);
    expect(mod.get(ExitAuthorityWiringCheck).check()).toEqual({
      TRACKER_WAKE: true, SUPREME_CONFIRM: true, HARD_LOSS_PROBE: true, OWNER_EXIT: true, AI_HEALTH: true,
    });
  });

  it('the late-bound forwarders call through to the implementers', async () => {
    const sentinel = inClone(mod, 'TradeSentinelModule');
    const runner = mod.get(EscalationRunner);
    expect((field(runner, 'aiHealth') as { allDownSince(): number | null }).allDownSince()).toBeNull();
    // HARD_LOSS_PROBE → SentinelCycleService.hardLossStillPast: an unknown tracker is a refusal to guess, not "no".
    await expect((field(runner, 'probe') as { stillPastLimit(id: string): Promise<boolean> }).stillPastLimit('trk-none'))
      .rejects.toThrow(/not on the sentinel roster/);
    // OWNER_EXIT → ManualOwnerExit: a backstop for a user outside AI_AUTO_EXIT_USER_IDS is refused before any order.
    await expect((field(runner, 'ownerExit') as { exitAsOwner(u: string, t: string, r: string): Promise<string> })
      .exitAsOwner('u-not-listed', 'trk', 'BACKSTOP DEADLINE: X')).rejects.toThrow(/AI_AUTO_EXIT_USER_IDS/);
    // TRACKER_WAKE → SentinelRunnerService.wakeTracker (the sentinel is disabled here: a no-op, never a throw).
    const wake = sentinel.get(SentinelRunnerService);
    const spy = jest.spyOn(wake, 'wakeTracker');
    (field(alarms, 'wake') as { wakeTracker(u: string, t: string, w: string): void }).wakeTracker('u', 'trk', 'test');
    expect(spy.mock.calls).toEqual([['u', 'trk', 'test']]);
  });

  it('TradeSentinelModule: cycle, agent, TRACKER_WAKE, HARD_LOSS_PROBE, ALARM_CHART_READER', () => {
    const sentinel = inClone(mod, 'TradeSentinelModule');
    const cycle = sentinel.get(SentinelCycleService);
    expectSame([
      ['SentinelCycleService.alarms', field(cycle, 'alarms'), alarms],
      ['SentinelCycleService.authority', field(cycle, 'authority'), state],
      ['SentinelCycleService.briefs', field(cycle, 'briefs'), briefs],
      ['SentinelCycleService.alarmChart', field(cycle, 'alarmChart'), sentinel.get(ALARM_CHART_READER)],
      ['SentinelAgentService.authority', field(sentinel.get(SentinelAgentService), 'authority'), state],
      ['TRACKER_WAKE', sentinel.get(TRACKER_WAKE), sentinel.get(SentinelRunnerService)],
    ]);
    expect(typeof (sentinel.get(ALARM_CHART_READER) as { read?: unknown }).read).toBe('function');
  });

  it('SentinelExecutorModule: router, executor, trigger-watch, boot check', () => {
    const executor = inClone(mod, 'SentinelExecutorModule');
    const desk = inClone(mod, 'DeskManagerModule');
    const router = executor.get(ExitAuthorityRouter);
    const exec = executor.get(SentinelExitExecutor);
    const triggers = executor.get(TriggerWatchService);
    expectSame([
      ['ExitAuthorityRouter.state', field(router, 'state'), state],
      ['ExitAuthorityRouter.alarms', field(router, 'alarms'), alarms],
      ['ExitAuthorityRouter.briefs', field(router, 'briefs'), briefs],
      ['ExitAuthorityRouter.escalation', field(router, 'escalation'), buttons],
      ['ExitAuthorityRouter.supreme → SupremeConfirmService', realOf(field(router, 'supreme')), desk.get(SupremeConfirmService)],
      ['SentinelExitExecutor.authority', field(exec, 'authority'), state],
      ['SentinelExitExecutor.escalation', field(exec, 'escalation'), buttons],
      ['TriggerWatchService.alarms', field(triggers, 'alarms'), alarms],
      ['TriggerWatchService.authority', field(triggers, 'authority'), state],
      ['TriggerWatchService.escalation', field(triggers, 'escalation'), buttons],
    ]);
    expect(executor.get(ExecutorAuthorityBootCheck).problems()).toEqual([]);
  });

  it('DeskManagerModule: exit actions, target watch, actions, pending-entry watch, state, manager LLM, own SUPREME_CONFIRM', () => {
    const desk = inClone(mod, 'DeskManagerModule');
    expectSame([
      ['DeskExitActions.alarms', field(desk.get(DeskExitActions), 'alarms'), alarms],
      ['DeskExitActions.authority', field(desk.get(DeskExitActions), 'authority'), state],
      ['TargetWatchService.alarms', field(desk.get(TargetWatchService), 'alarms'), alarms],
      ['TargetWatchService.authority', field(desk.get(TargetWatchService), 'authority'), state],
      ['DeskActionsService.briefs', field(desk.get(DeskActionsService), 'briefs'), briefs],
      ['DeskActionsService.authority', field(desk.get(DeskActionsService), 'authority'), state],
      ['PendingEntryWatchService.briefs', field(desk.get(PendingEntryWatchService), 'briefs'), briefs],
      ['PendingEntryWatchService.authority', field(desk.get(PendingEntryWatchService), 'authority'), state],
      ['DeskStateService.briefs', field(desk.get(DeskStateService), 'briefs'), briefs],
      ['DeskStateService.authority', field(desk.get(DeskStateService), 'authority'), state],
      ['ManagerLlmService.authority', field(desk.get(ManagerLlmService), 'authority'), state],
      ['SUPREME_CONFIRM (local)', desk.get(SUPREME_CONFIRM), desk.get(SupremeConfirmService)],
    ]);
  });

  it('IntradayCarryModule: the carry service gets TRADE_ALARMS and AUTHORITY_STATE', () => {
    const carry = inClone(mod, 'IntradayCarryModule').get(IntradayCarryService);
    expectSame([
      ['IntradayCarryService.alarms', field(carry, 'alarms'), alarms],
      ['IntradayCarryService.authority', field(carry, 'authority'), state],
    ]);
  });

  it('TradeEngineModule: closeTrade and the order tracker see AUTHORITY_STATE', () => {
    const engine = inClone(mod, 'TradeEngineModule');
    expectSame([
      ['TradeExecutionService.authority', field(engine.get(TradeExecutionService), 'authority'), state],
      ['OrderTrackerService.authority', field(engine.get(OrderTrackerService), 'authority'), state],
    ]);
  });
});
