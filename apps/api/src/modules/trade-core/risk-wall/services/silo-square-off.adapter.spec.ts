// The silo modules are replaced by bare token classes: this spec never loads silo code.
jest.mock('../../../auto-execution/services/auto-exec-settings.service', () => ({
  AutoExecSettingsService: class AutoExecSettingsService {},
  AUTO_EXEC_SEGMENTS: ['INTRADAY', 'SWING'],
}));
jest.mock('../../../watch-monitor/services/watch.service', () => ({ WatchService: class WatchService {} }));
jest.mock('../../../adaptive-stop-track/services/adaptive-stop-tick-poller.service', () => ({ AdaptiveStopTickPoller: class AdaptiveStopTickPoller {} }));
jest.mock('../../../ungated-track/services/ungated-tick-poller.service', () => ({ UngatedTickPoller: class UngatedTickPoller {} }));
jest.mock('../../../ungated-track/repositories/ungated-watch.repository', () => ({ UngatedWatchRepository: class UngatedWatchRepository {} }));
jest.mock('../../../sell-futures-track/services/sell-futures.service', () => ({ SellFuturesService: class SellFuturesService {} }));
jest.mock('../../../trade-engine/services/trade-execution.service', () => ({ TradeExecutionService: class TradeExecutionService {} }));
jest.mock('../../../trade-engine/repositories/trade.repository', () => ({ TradeRepository: class TradeRepository {} }));
jest.mock('../../../anand-dual-track/services/anand-price-monitor.service', () => ({ AnandPriceMonitorService: class AnandPriceMonitorService {} }));
jest.mock('../../../breakout-swing-track/services/breakout-swing-poller.service', () => ({ BreakoutSwingPollerService: class BreakoutSwingPollerService {} }));

import type { ModuleRef } from '@nestjs/core';
import { AdaptiveStopTickPoller } from '../../../adaptive-stop-track/services/adaptive-stop-tick-poller.service';
import { AnandPriceMonitorService } from '../../../anand-dual-track/services/anand-price-monitor.service';
import { BreakoutSwingPollerService } from '../../../breakout-swing-track/services/breakout-swing-poller.service';
import { AutoExecSettingsService } from '../../../auto-execution/services/auto-exec-settings.service';
import { SellFuturesService } from '../../../sell-futures-track/services/sell-futures.service';
import { TradeRepository } from '../../../trade-engine/repositories/trade.repository';
import { TradeExecutionService } from '../../../trade-engine/services/trade-execution.service';
import { UngatedWatchRepository } from '../../../ungated-track/repositories/ungated-watch.repository';
import { UngatedTickPoller } from '../../../ungated-track/services/ungated-tick-poller.service';
import { WatchService } from '../../../watch-monitor/services/watch.service';
import { SILO_TARGETS, SiloSquareOffAdapter } from './silo-square-off.adapter';

const OWNER = { userId: 'usr_owner', role: 'ADMIN' };
const USER = { userId: 'user_A', role: 'USER' };

function setup() {
  const calls: string[] = [];
  let ungatedTraded = 2;
  const watch = { squareOffAll: jest.fn(async (_reason: string) => { calls.push('watch'); return { watchingClosed: 2, tradedClosed: 3, errors: 0 }; }) };
  const adaptive = { eodSquareOff: jest.fn(async () => { calls.push('adaptive'); return { attempted: 1, closed: 1, skipped: 0, errors: 0 }; }) };
  const ungatedPoller = { eodSquareOff: jest.fn(async () => { calls.push('ungated'); ungatedTraded = 0; }) };
  const ungatedRepo = {
    findAllActive: jest.fn(async () => [...Array.from({ length: ungatedTraded }, () => ({ status: 'TRADED' })), { status: 'WATCHING' }]),
  };
  const sellFutures = { squareOffOpenPositions: jest.fn(async () => { calls.push('sell-futures'); return { closed: 1, errors: 0 }; }) };
  const anand = { squareOffAll: jest.fn(async (reason: string) => { calls.push(`anand:${reason}`); return { attempted: 3, closed: 3, skipped: 0, errors: 0 }; }) };
  const breakout = { squareOffOpenPositions: jest.fn(async (reason: string) => { calls.push(`breakout:${reason}`); return { attempted: 2, closed: 2, skipped: 0, errors: 0 }; }) };
  const tradeEngine = { closeAllPositions: jest.fn(async (reason: string) => { calls.push(`trade-engine:${reason}`); return { closed: 4 }; }) };
  const tradeRepo = { getOpenTrades: jest.fn(async (): Promise<unknown[]> => []) };
  const autoExec = { update: jest.fn(async (userId: string, segment: string) => { calls.push(`auto-exec:${userId}:${segment}`); return {}; }) };
  const services = new Map<unknown, unknown>([
    [AutoExecSettingsService, autoExec],
    [WatchService, watch],
    [AdaptiveStopTickPoller, adaptive],
    [UngatedTickPoller, ungatedPoller],
    [UngatedWatchRepository, ungatedRepo],
    [SellFuturesService, sellFutures],
    [TradeExecutionService, tradeEngine],
    [TradeRepository, tradeRepo],
    [AnandPriceMonitorService, anand],
    [BreakoutSwingPollerService, breakout],
  ]);
  const moduleRef = {
    get: jest.fn((token: { name: string }) => {
      if (!services.has(token)) throw new Error(`Nest could not find ${token.name} element`);
      return services.get(token);
    }),
  };
  const adapter = new SiloSquareOffAdapter(moduleRef as unknown as ModuleRef);
  return { calls, services, moduleRef, adapter, watch, adaptive, ungatedPoller, sellFutures, tradeEngine, tradeRepo, autoExec, anand, breakout };
}

describe('SiloSquareOffAdapter', () => {
  it('for the owner, calls every silo entry point once, in order, auto-execution first and trade-engine last', async () => {
    const { calls, moduleRef, adapter, watch, autoExec } = setup();
    const results = await adapter.squareOffAll(OWNER, 'panic');
    expect(results.map((r) => r.target)).toEqual([...SILO_TARGETS]);
    expect(results.map((r) => r.status)).toEqual(['OK', 'OK', 'OK', 'OK', 'OK', 'OK', 'OK', 'OK']);
    expect(calls).toEqual([
      'auto-exec:usr_owner:INTRADAY', 'auto-exec:usr_owner:SWING',
      'watch', 'adaptive', 'ungated', 'sell-futures',
      'anand:core kill switch: panic', 'breakout:core kill switch: panic',
      'trade-engine:core kill switch: panic',
    ]);
    expect(autoExec.update).toHaveBeenCalledWith('usr_owner', 'INTRADAY', { killSwitch: true });
    expect(watch.squareOffAll).toHaveBeenCalledWith('manual');
    expect(moduleRef.get).toHaveBeenCalledWith(WatchService, { strict: false });
    expect(results.find((r) => r.target === 'ungated-track')?.detail).toBe('closed 2 of 2; 0 still open');
    expect(results.find((r) => r.target === 'trade-engine')?.detail).toContain('closed 4 open trades; 0 still open;');
  });

  it('a non-owner sets only their own auto-execution kill flag and never resolves a platform silo', async () => {
    const { calls, moduleRef, adapter } = setup();
    const results = await adapter.squareOffAll(USER, 'stop');
    expect(results.map((r) => [r.target, r.status])).toEqual([
      ['auto-execution', 'OK'],
      ['watch-monitor', 'SKIPPED'],
      ['adaptive-stop-track', 'SKIPPED'],
      ['ungated-track', 'SKIPPED'],
      ['sell-futures-track', 'SKIPPED'],
      ['anand-dual-track', 'SKIPPED'],
      ['breakout-swing-track', 'SKIPPED'],
      ['trade-engine', 'SKIPPED'],
    ]);
    expect(calls).toEqual(['auto-exec:user_A:INTRADAY', 'auto-exec:user_A:SWING']);
    expect(moduleRef.get.mock.calls.map((c) => c[0])).toEqual([AutoExecSettingsService]);
  });

  it('one failing silo does not stop the rest', async () => {
    const { calls, adapter, watch } = setup();
    watch.squareOffAll.mockRejectedValueOnce(new Error('broker timeout'));
    const results = await adapter.squareOffAll(OWNER, 'panic');
    expect(results.find((r) => r.target === 'watch-monitor')).toEqual({ target: 'watch-monitor', status: 'FAILED', detail: 'broker timeout' });
    expect(calls).toEqual(expect.arrayContaining(['adaptive', 'ungated', 'sell-futures', 'trade-engine:core kill switch: panic']));
  });

  it('partial results are FAILED, not OK', async () => {
    const { adapter, watch, adaptive, ungatedPoller, sellFutures } = setup();
    watch.squareOffAll.mockResolvedValueOnce({ watchingClosed: 0, tradedClosed: 2, errors: 1 });
    adaptive.eodSquareOff.mockResolvedValueOnce({ attempted: 3, closed: 2, skipped: 1, errors: 0 });
    ungatedPoller.eodSquareOff.mockImplementationOnce(async () => undefined); // nothing closes
    sellFutures.squareOffOpenPositions.mockResolvedValueOnce({ closed: 0, errors: 2 });
    const byTarget = Object.fromEntries((await adapter.squareOffAll(OWNER, 'panic')).map((r) => [r.target, r]));
    expect(byTarget['watch-monitor']).toMatchObject({ status: 'FAILED', detail: 'closed 2 traded, dismissed 0 watching, 1 errors' });
    expect(byTarget['adaptive-stop-track']).toMatchObject({ status: 'FAILED', detail: 'closed 2 of 3, 1 skipped (no exit price), 0 errors' });
    expect(byTarget['ungated-track']).toMatchObject({ status: 'FAILED', detail: 'closed 0 of 2; 2 still open' });
    expect(byTarget['sell-futures-track']).toMatchObject({ status: 'FAILED', detail: 'closed 0, 2 errors' });
    expect(byTarget['trade-engine'].status).toBe('OK');
  });

  it('closes the anand dual-track and breakout-swing positions (CLAUDE.md §9: ALL positions), before trade-engine', async () => {
    const { calls, adapter, anand, breakout } = setup();
    const results = await adapter.squareOffAll(OWNER, 'panic');
    expect(anand.squareOffAll).toHaveBeenCalledWith('core kill switch: panic');
    expect(breakout.squareOffOpenPositions).toHaveBeenCalledWith('core kill switch: panic');
    expect(results.find((r) => r.target === 'anand-dual-track')).toEqual({
      target: 'anand-dual-track', status: 'OK', detail: 'closed 3 of 3, 0 skipped (no fresh price), 0 errors',
    });
    expect(results.find((r) => r.target === 'breakout-swing-track')).toEqual({
      target: 'breakout-swing-track', status: 'OK', detail: 'closed 2 of 2, 0 skipped (no fresh price), 0 errors',
    });
    expect(calls.indexOf('breakout:core kill switch: panic')).toBeLessThan(calls.indexOf('trade-engine:core kill switch: panic'));
  });

  it('anand / breakout failures and partial closes surface as FAILED; the rest still run', async () => {
    const { calls, adapter, anand, breakout } = setup();
    anand.squareOffAll.mockRejectedValueOnce(new Error('db down'));
    breakout.squareOffOpenPositions.mockResolvedValueOnce({ attempted: 2, closed: 1, skipped: 1, errors: 0 });
    const byTarget = Object.fromEntries((await adapter.squareOffAll(OWNER, 'panic')).map((r) => [r.target, r]));
    expect(byTarget['anand-dual-track']).toEqual({ target: 'anand-dual-track', status: 'FAILED', detail: 'db down' });
    expect(byTarget['breakout-swing-track']).toMatchObject({ status: 'FAILED', detail: 'closed 1 of 2, 1 skipped (no fresh price), 0 errors' });
    expect(calls).toContain('trade-engine:core kill switch: panic');
  });

  it('trade-engine is FAILED when open trades remain after closeAllPositions', async () => {
    const { adapter, tradeEngine, tradeRepo } = setup();
    tradeEngine.closeAllPositions.mockResolvedValueOnce({ closed: 3 });
    tradeRepo.getOpenTrades.mockResolvedValueOnce([{ id: 't1' }, { id: 't2' }]);
    const results = await adapter.squareOffAll(OWNER, 'panic');
    const te = results.find((r) => r.target === 'trade-engine');
    expect(te?.status).toBe('FAILED');
    expect(te?.detail).toContain('closed 3 open trades; 2 still open;');
    expect(te?.detail).toContain('kill switch is now on');
    expect(tradeRepo.getOpenTrades).toHaveBeenCalledWith();
  });

  it('a silo that is not loaded in this process is UNAVAILABLE and the rest still run', async () => {
    const { calls, services, adapter } = setup();
    services.delete(SellFuturesService);
    const results = await adapter.squareOffAll(OWNER, 'panic');
    expect(results.find((r) => r.target === 'sell-futures-track')).toEqual({
      target: 'sell-futures-track', status: 'UNAVAILABLE', detail: 'SellFuturesService is not loaded in this process',
    });
    expect(calls).toContain('trade-engine:core kill switch: panic');
  });
});
