import { ForbiddenException, NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import type { AuditService } from '../../../../common/audit/audit.service';
import type { CorePaperDefaultsRepository, PaperDefaultRow } from '../repositories/core-paper-defaults.repository';
import { NOW, SEED_ROWS } from '../testing/paper-fixtures';
import { CorePaperDefaultsService } from './core-paper-defaults.service';

const OWNER = { userId: 'usr_owner', role: 'ADMIN' };
const USER = { userId: 'user_A', role: 'USER' };
const T = NOW.getTime();

function setup() {
  const store: { rows: PaperDefaultRow[] } = { rows: SEED_ROWS.map((r) => ({ ...r, note: 'seed', updatedBy: null, updatedAt: NOW })) };
  const repo = {
    list: jest.fn(async () => store.rows),
    upsert: jest.fn(async (key: string, scope: string, numValue: PaperDefaultRow['numValue'], note: string, updatedBy: string, now: Date) => {
      const row = { key, scope, numValue, note, updatedBy, updatedAt: now };
      store.rows = [...store.rows.filter((r) => !(r.key === key && r.scope === scope)), row];
      return row;
    }),
  };
  const audit = { append: jest.fn().mockResolvedValue({ seq: 1n, hash: 'h' }) };
  const svc = new CorePaperDefaultsService(repo as unknown as CorePaperDefaultsRepository, audit as unknown as AuditService);
  return { store, repo, audit, svc };
}

describe('CorePaperDefaultsService', () => {
  it('resolves the settings from the rows and caches them for 5 s', async () => {
    const { repo, svc } = setup();
    const a = await svc.settings(T);
    expect(a.ok && a.settings.noPriceRejectMs).toBe(30000);
    await svc.settings(T + 4_999);
    expect(repo.list).toHaveBeenCalledTimes(1);
    await svc.settings(T + 5_000);
    expect(repo.list).toHaveBeenCalledTimes(2);
  });

  it('an incomplete table fails closed with the missing pairs', async () => {
    const { store, svc } = setup();
    store.rows = store.rows.filter((r) => r.key !== 'startingCapital');
    expect(await svc.settings(T)).toEqual({ ok: false, missing: ['startingCapital@ALL'] });
  });

  it('an unreadable table throws and is not cached', async () => {
    const { repo, svc } = setup();
    repo.list.mockRejectedValueOnce(new Error('db down'));
    await expect(svc.settings(T)).rejects.toThrow('db down');
    expect((await svc.settings(T + 1)).ok).toBe(true);
  });

  it('lists every row in key order with its note', async () => {
    const { svc } = setup();
    const views = await svc.list();
    expect(views).toHaveLength(14);
    expect(views[0]).toEqual({ key: 'startingCapital', scope: 'ALL', value: 1000000, note: 'seed', updatedBy: null, updatedAt: NOW.toISOString() });
    expect(views.map((v) => v.key).slice(-5)).toEqual(Array(5).fill('maxLotsPerOrder'));
  });

  it('the owner changes a default at once; the reason becomes its note; it is audited; the cache is dropped', async () => {
    const { audit, svc } = setup();
    await svc.settings(T);
    const v = await svc.change(OWNER, { key: 'slippageBps', scope: 'OPTIONS_BUY', value: 30, reason: '  tighter fills  ' }, NOW);
    expect(v).toEqual({ key: 'slippageBps', scope: 'OPTIONS_BUY', value: 30, note: 'tighter fills', updatedBy: 'usr_owner', updatedAt: NOW.toISOString() });
    expect(audit.append).toHaveBeenCalledWith({
      action: 'CORE_PAPER_DEFAULT_CHANGED',
      userId: 'usr_owner',
      target: 'core_paper_default:slippageBps@OPTIONS_BUY',
      meta: { key: 'slippageBps', scope: 'OPTIONS_BUY', from: '50.00', to: '30.00', reason: 'tighter fills' },
    });
    const after = await svc.settings(T + 1);
    expect(after.ok && after.settings.slippageBps.OPTIONS_BUY.toFixed(2)).toBe('30.00');
  });

  it('a change stamps updatedAt and updatedBy explicitly (the column has no @updatedAt)', async () => {
    const { repo, svc } = setup();
    const LATER = new Date(T + 60_000);
    const v = await svc.change(OWNER, { key: 'startingCapital', scope: 'ALL', value: 500000, reason: 'smaller book' }, LATER);
    expect(repo.upsert).toHaveBeenCalledWith('startingCapital', 'ALL', expect.anything(), 'smaller book', 'usr_owner', LATER);
    expect(v.updatedAt).toBe(LATER.toISOString());
    expect(v.updatedAt).not.toBe(NOW.toISOString());
    expect(v.updatedBy).toBe('usr_owner');
    const listed = (await svc.list()).find((r) => r.key === 'startingCapital');
    expect(listed).toMatchObject({ value: 500000, updatedBy: 'usr_owner', updatedAt: LATER.toISOString() });
  });

  it('the owner can add a cap for another underlying', async () => {
    const { audit, svc } = setup();
    await svc.change(OWNER, { key: 'maxLotsPerOrder', scope: 'RELIANCE', value: 4, reason: 'stock options' }, NOW);
    expect(audit.append.mock.calls[0][0].meta).toEqual({ key: 'maxLotsPerOrder', scope: 'RELIANCE', from: null, to: '4.00', reason: 'stock options' });
    const s = await svc.settings(T);
    expect(s.ok && s.settings.maxLotsPerOrder.RELIANCE).toBe(4);
  });

  it('only the owner may change a default, even if the route guard were bypassed; nothing is written', async () => {
    const { repo, audit, svc } = setup();
    await expect(svc.change(USER, { key: 'startingCapital', scope: 'ALL', value: 5, reason: 'mine' }, NOW)).rejects.toBeInstanceOf(ForbiddenException);
    expect(repo.upsert).not.toHaveBeenCalled();
    expect(audit.append).not.toHaveBeenCalled();
  });

  it('an unknown key or scope is 404; a bad value is 422', async () => {
    const { svc } = setup();
    await expect(svc.change(OWNER, { key: 'nope', scope: 'ALL', value: 1, reason: 'why not' }, NOW)).rejects.toBeInstanceOf(NotFoundException);
    await expect(svc.change(OWNER, { key: 'startingCapital', scope: 'MTF', value: 1, reason: 'why not' }, NOW)).rejects.toBeInstanceOf(NotFoundException);
    await expect(svc.change(OWNER, { key: 'maxLotsPerOrder', scope: 'nifty', value: 1, reason: 'why not' }, NOW)).rejects.toBeInstanceOf(NotFoundException);
    await expect(svc.change(OWNER, { key: 'mtfFundedShare', scope: 'MTF', value: 1, reason: 'why not' }, NOW)).rejects.toBeInstanceOf(UnprocessableEntityException);
  });
});
