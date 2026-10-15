import { ExitFillSettler } from './exit-fill-settler.service';
import { CLAIM_STALE_MS } from '../domain/claim-timing';

const NOW = new Date('2026-10-14T11:11:00Z'); // 10 min after the row: past CLAIM_STALE_MS
const ROW = { id: 'r1', userId: 'owner', verdictId: 'v1', symbol: 'X', brokerOrderId: 'O1', createdAt: new Date('2026-10-14T11:01:00Z') };
function make(book: unknown, rows: unknown[] = [ROW]) {
  const repo = { placedAwaitingFill: jest.fn(async () => rows), settlePlaced: jest.fn(async () => true) };
  const session = {
    getOrderBookEnvelope: jest.fn(async () => book),
    placeOrderClassified: jest.fn(), cancelOrderClassified: jest.fn(), getPositionsEnvelope: jest.fn(),
  };
  const sessions = {
    withOwnerSession: jest.fn(async (_u: string, fn: any, opts: any) => {
      expect(opts).toEqual({ allowEphemeralLogin: false }); // never a second broker login
      return fn(session, 'user-feed');
    }),
  };
  return { s: new ExitFillSettler(repo as never, sessions as never), repo, sessions, session };
}

describe('ExitFillSettler (E5)', () => {
  it('complete ⇒ FILLED with the fill, only while the row is still PLACED; reads the book and nothing else', async () => {
    const { s, repo, session } = make({ status: true, data: [{ orderid: 'O1', status: 'complete', averageprice: '527.1', filledshares: '100', exchorderupdatetime: '14-Oct-2026 16:31:05' }] });
    await s.runOnce(NOW);
    expect(repo.placedAwaitingFill).toHaveBeenCalledWith(new Date('2026-10-13T18:30:00Z'));
    expect(repo.settlePlaced).toHaveBeenCalledWith('r1', {
      status: 'FILLED', orderStatus: 'complete', fillPrice: 527.1, fillQty: 100, fillAt: new Date('2026-10-14T11:01:05Z'),
    });
    expect(session.placeOrderClassified).not.toHaveBeenCalled();
    expect(session.cancelOrderClassified).not.toHaveBeenCalled();
    expect(session.getPositionsEnvelope).not.toHaveBeenCalled();
  });
  it('complete with no exchange time ⇒ the observation time', async () => {
    const { s, repo } = make({ status: true, data: [{ orderid: 'O1', status: 'complete' }] });
    await s.runOnce(NOW);
    expect(repo.settlePlaced).toHaveBeenCalledWith('r1', expect.objectContaining({ status: 'FILLED', fillPrice: null, fillAt: NOW }));
  });
  it('rejected / cancelled ⇒ REJECTED', async () => {
    const { s, repo } = make({ status: true, data: [{ orderid: 'O1', status: 'rejected', text: 'RMS' }] });
    await s.runOnce(NOW);
    expect(repo.settlePlaced).toHaveBeenCalledWith('r1', { status: 'REJECTED', reason: 'BROKER_REJECTED', orderStatus: 'rejected', brokerMessage: 'RMS' });
    const c = make({ status: true, data: [{ orderid: 'O1', status: 'cancelled', text: '' }] });
    await c.s.runOnce(NOW);
    expect(c.repo.settlePlaced).toHaveBeenCalledWith('r1', { status: 'REJECTED', reason: 'CANCELLED', orderStatus: 'cancelled', brokerMessage: null });
  });
  it('open / unanswered book / unknown order / no session ⇒ untouched', async () => {
    for (const book of [{ status: true, data: [{ orderid: 'O1', status: 'open' }] }, {}, { status: false }, { status: true, data: [{ orderid: 'O9', status: 'complete' }] }]) {
      const { s, repo } = make(book);
      await s.runOnce(NOW);
      expect(repo.settlePlaced).not.toHaveBeenCalled();
    }
    const { s, repo, sessions } = make({});
    sessions.withOwnerSession.mockRejectedValueOnce(new Error('NO_FEED_SESSION'));
    await expect(s.runOnce(NOW)).resolves.toBeUndefined();
    expect(repo.settlePlaced).not.toHaveBeenCalled();
  });
  it('leaves a row the executor may still be working on alone (younger than the claim-stale bound)', async () => {
    const { s, sessions } = make({ status: true, data: [{ orderid: 'O1', status: 'complete' }] }, [{ ...ROW, createdAt: new Date(NOW.getTime() - CLAIM_STALE_MS + 1_000) }]);
    await s.runOnce(NOW);
    expect(sessions.withOwnerSession).not.toHaveBeenCalled();
  });
  it('checks a row at most every 30 s and is single-flight', async () => {
    const { s, sessions } = make({ status: true, data: [{ orderid: 'O1', status: 'open' }] });
    await Promise.all([s.runOnce(NOW), s.runOnce(NOW)]);
    await s.runOnce(new Date(NOW.getTime() + 10_000));
    expect(sessions.withOwnerSession).toHaveBeenCalledTimes(1);
    await s.runOnce(new Date(NOW.getTime() + 31_000));
    expect(sessions.withOwnerSession).toHaveBeenCalledTimes(2);
  });
  it('a failing query never throws out of runOnce', async () => {
    const { s, repo } = make({});
    repo.placedAwaitingFill.mockRejectedValueOnce(new Error('db down'));
    await expect(s.runOnce(NOW)).resolves.toBeUndefined();
  });
});
