import { NotFoundException } from '@nestjs/common';
import { validate } from 'class-validator';
import { plainToInstance } from 'class-transformer';
import type { CorePositionRepository } from '../../lifecycle/repositories/core-position.repository';
import { AckReconDto, JournalDayQueryDto } from '../dto/core-journal.dto';
import type { SiloComparisonReader } from '../silo-comparison.reader';
import { MemoryJournalStore } from '../testing/memory-journal-store';
import { CoreJournalController } from './core-journal.controller';

const AT = new Date('2026-10-13T05:00:00.000Z');

function setup() {
  const store = new MemoryJournalStore();
  const positions = {
    findForUser: jest.fn(async (userId: string, id: string) => (userId === 'user_A' && id === 'pos_1' ? { id: 'pos_1', intentId: 'ci_1', createdAt: AT, status: 'CLOSED' } : null)),
    listForUser: jest.fn().mockResolvedValue([{ status: 'OPEN', blindSince: AT }, { status: 'EXITING', blindSince: null }, { status: 'CLOSED', blindSince: null }]),
  };
  const desk = { ack: jest.fn().mockResolvedValue({ acknowledged: 'jr_9' }), unacked: jest.fn().mockResolvedValue([]) };
  const intake = { status: () => ({ mode: 'journal' as const, users: 1, pending: 0, dropped: 0 }) };
  const journalStatus = { status: () => ({ pending: 0, written: 10, dropped: 0, failures: 0, lastError: null }) };
  const comparison = { forDay: jest.fn().mockResolvedValue([]) };
  const c = new CoreJournalController(store.repo, store.summaryRepo, positions as unknown as CorePositionRepository, comparison as unknown as SiloComparisonReader, desk, intake, journalStatus);
  return { store, positions, desk, comparison, c };
}

describe('CoreJournalController (spec §8.4)', () => {
  it("day: the caller's summary, trades, setup count, skips by reason, the latch and notices", async () => {
    const { store, c } = setup();
    await store.summaryRepo.createIfAbsent(store.sampleSummary({ istDay: '2026-10-13' }));
    await store.repo.append([
      { type: 'ALERT_RECEIVED', userId: 'user_A', at: AT, intentId: 'ci_1', payload: {} },
      { type: 'INTENT_SKIPPED', userId: 'user_A', at: AT, intentId: 'ci_2', payload: { reason: 'GATE' } },
      { type: 'INTENT_SKIPPED', userId: 'user_A', at: AT, intentId: 'ci_3', payload: { reason: 'GATE' } },
      { type: 'DAILY_LOSS_LATCHED', userId: 'user_A', at: AT, payload: {} },
      { type: 'INTENT_SKIPPED', userId: 'user_B', at: AT, intentId: 'ci_b', payload: { reason: 'COOLDOWN' } },
    ]);
    const r = await c.day('user_A', { day: '2026-10-13' });
    expect(r).toMatchObject({ day: '2026-10-13', setups: 1, skips: { GATE: 2 }, latched: true, summary: { trades: 1, netPnl: '1460.00' } });
    expect(r.trades).toHaveLength(1);
  });

  it('a position timeline is its rows plus its intent’s alert and verdict; 404 for another user', async () => {
    const { store, c } = setup();
    await store.repo.append([
      { type: 'ALERT_RECEIVED', userId: 'user_A', at: AT, intentId: 'ci_1', payload: {} },
      { type: 'RISK_VERDICT', userId: 'user_A', at: new Date(AT.getTime() + 1), intentId: 'ci_1', payload: {} },
      { type: 'POSITION_STATE', userId: 'user_A', at: new Date(AT.getTime() + 2), positionId: 'pos_1', payload: { to: 'OPEN' } },
    ]);
    const r = await c.position('user_A', 'pos_1');
    expect(r.events.map((e) => e.type)).toEqual(['ALERT_RECEIVED', 'RISK_VERDICT', 'POSITION_STATE']);
    await expect(c.position('user_B', 'pos_1')).rejects.toBeInstanceOf(NotFoundException);
  });

  it('status: entries, journal health, active / blind / exiting, unacknowledged findings', async () => {
    const { c } = setup();
    expect(await c.status('user_A')).toEqual({
      entries: { mode: 'journal', users: 1, pending: 0, dropped: 0 },
      journal: { pending: 0, written: 10, dropped: 0, failures: 0, lastError: null },
      positions: { active: 2, blind: 1, exiting: 1 },
      mismatches: [],
    });
  });

  it('ack passes the trimmed reason for the caller; the body must say why; a day must be a date', async () => {
    const { desk, c } = setup();
    expect(await c.ack('user_A', 'jr_9', { reason: '  checked  ' })).toEqual({ acknowledged: 'jr_9' });
    expect(desk.ack).toHaveBeenCalledWith('user_A', 'jr_9', 'checked');
    expect(await validate(plainToInstance(AckReconDto, { reason: '   ' }))).toHaveLength(1);
    expect(await validate(plainToInstance(AckReconDto, { reason: 'checked' }))).toHaveLength(0);
    expect(await validate(plainToInstance(JournalDayQueryDto, { day: '13-10-2026' }))).toHaveLength(1);
    expect(await validate(plainToInstance(JournalDayQueryDto, {}))).toHaveLength(0);
  });
});
