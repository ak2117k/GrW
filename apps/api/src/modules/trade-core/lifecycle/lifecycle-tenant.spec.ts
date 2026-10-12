import { NotFoundException } from '@nestjs/common';
import { CoreRiskStateProvider } from './core-risk-state.provider';
import { NOW } from './testing/lifecycle-fixtures';
import { lifecycleHarness, openRequest } from './testing/lifecycle-harness';

beforeEach(() => jest.useFakeTimers({ now: NOW, doNotFake: ['nextTick', 'setImmediate', 'queueMicrotask'] }));
afterEach(() => jest.useRealTimers());

describe("tenant isolation (spec §10: user A's alerts, limits, kill switch and positions never affect user B)", () => {
  it("A's stop, A's exit-all and A's kill switch never touch B's position on the same instrument", async () => {
    const h = lifecycleHarness();
    const a = await h.lifecycle.openPosition(openRequest());
    const b = await h.lifecycle.openPosition(openRequest({}, { intentId: 'int_b', userId: 'user_B', stopPrice: 480 }));
    await h.price(500);
    await h.lifecycle.exitAll('user_A', 'KILL_SWITCH', 'A only');
    h.killOn.add('user_A');
    await h.sweep();
    await h.price(499);
    expect(h.positions.rows.find((x) => x.id === a.id)).toMatchObject({ status: 'CLOSED' });
    expect(h.positions.rows.find((x) => x.id === b.id)).toMatchObject({ status: 'OPEN', exitReason: null });
    expect(h.ordersOf(b.id).map((o) => o.purpose)).toEqual(['ENTRY']);
    const provider = new CoreRiskStateProvider(h.ledger, h.positions.repo, h.lifecycle);
    expect((await provider.liveState('user_B', new Date())).openPositions.map((x) => x.positionId)).toEqual([b.id]);
    expect((await h.lifecycle.positionsFor('user_B', null)).map((x) => x.id)).toEqual([b.id]);
    await expect(h.lifecycle.requestExit('user_B', a.id, 'MANUAL', 'not mine')).rejects.toBeInstanceOf(NotFoundException);
    await expect(h.lifecycle.proposeStop('user_A', b.id, 499, 'x')).rejects.toBeInstanceOf(NotFoundException);
  });

  it('a user the hub does not serve: the entry never fills and the position is CANCELLED; the served user fills (drift D7)', async () => {
    const h = lifecycleHarness({ served: ['user_A'] });
    const a = await h.lifecycle.openPosition(openRequest());
    const b = await h.lifecycle.openPosition(openRequest({}, { intentId: 'int_b', userId: 'user_B' }));
    await h.price(500);
    h.advance(30_001);
    await h.sweep();
    expect(h.positions.rows.find((x) => x.id === a.id)?.status).toBe('OPEN');
    expect(h.positions.rows.find((x) => x.id === b.id)?.status).toBe('CANCELLED');
  });
});
