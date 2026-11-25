import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { parseMessageReaderConfig } from '../message-reader.config';
import type { ReaderCounts, SessionNote } from '../repositories/message-reader.repository';
import { MessageReaderController } from './message-reader.controller';

const NOW = new Date('2026-11-25T05:00:00Z'); // 10:30 IST
const OWNER = { userId: 'owner-1', role: 'ADMIN', email: 'o@x' };

const note = (id: string, postedAt: string, o: Partial<SessionNote> = {}): SessionNote => ({
  messageId: id,
  channelId: 'ch1',
  channelTitle: 'Stock Gainers',
  postedAt: new Date(postedAt),
  readAt: new Date(postedAt),
  status: 'READ',
  kind: 'INFO',
  scope: 'MARKET',
  claims: [],
  summary: 's',
  latencyMs: 1200,
  error: null,
  ...o,
});

function make(o: { ownerUserId?: string | null; mode?: 'off' | 'shadow' | 'on' } = {}) {
  const counts: ReaderCounts = { posts: 12, byStatus: { READ: 10, FAILED: 1, CACHED: 1 }, p50Ms: 4100, p95Ms: 9800, lastReadAt: new Date('2026-11-25T04:58:00Z') };
  const repo = {
    countsSince: jest.fn(async () => counts),
    notesForSession: jest.fn(async () => [note('m2', '2026-11-25T04:30:00Z'), note('m1', '2026-11-25T04:00:00Z', { status: 'FAILED', error: 'timed out' })]),
  };
  const ctrl = new MessageReaderController(
    repo,
    parseMessageReaderConfig({ MESSAGE_READER: o.mode ?? 'shadow' }),
    { ownerUserId: o.ownerUserId === undefined ? 'owner-1' : o.ownerUserId },
    () => NOW,
    () => true,
  );
  return { ctrl, repo };
}

describe('MessageReaderController', () => {
  it('health returns p95', async () => {
    const m = make();
    const h = await m.ctrl.health(OWNER);
    expect(m.repo.countsSince).toHaveBeenCalledWith(new Date(NOW.getTime() - 60 * 60_000));
    expect(h).toEqual({
      mode: 'shadow',
      agentsOn: true,
      lastReadAt: new Date('2026-11-25T04:58:00Z'),
      lastHour: { posts: 12, byStatus: { READ: 10, FAILED: 1, CACHED: 1 }, p50Ms: 4100, p95Ms: 9800 },
    });
  });

  it("notes returns the day's readings newest first", async () => {
    const m = make();
    const out = await m.ctrl.notes(OWNER, '2026-11-25');
    expect(m.repo.notesForSession).toHaveBeenCalledWith('2026-11-25');
    expect(out.date).toBe('2026-11-25');
    expect(out.notes.map((n) => n.messageId)).toEqual(['m2', 'm1']);
    expect(out.notes[1]).toMatchObject({ channelTitle: 'Stock Gainers', status: 'FAILED', kind: 'INFO', scope: 'MARKET', latencyMs: 1200, error: 'timed out' });
  });

  it("notes defaults to today's IST session and rejects a malformed date", async () => {
    const m = make();
    await m.ctrl.notes(OWNER, undefined);
    expect(m.repo.notesForSession).toHaveBeenCalledWith('2026-11-25');
    await expect(m.ctrl.notes(OWNER, '25-11-2026')).rejects.toBeInstanceOf(BadRequestException);
  });

  it('owner only: another admin or a non-admin is refused', async () => {
    const m = make();
    await expect(m.ctrl.health({ ...OWNER, userId: 'someone' })).rejects.toBeInstanceOf(ForbiddenException);
    await expect(m.ctrl.notes({ ...OWNER, role: 'USER' }, '2026-11-25')).rejects.toBeInstanceOf(ForbiddenException);
    expect(m.repo.countsSince).not.toHaveBeenCalled();
    expect(m.repo.notesForSession).not.toHaveBeenCalled();
  });
});
