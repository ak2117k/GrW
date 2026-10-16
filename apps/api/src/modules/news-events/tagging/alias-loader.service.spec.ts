import { readFileSync } from 'fs';
import { join } from 'path';
import { AliasLoaderService, EQUITY_L_URL } from './alias-loader.service';
import { parseEquityL } from './alias-derivation';
import { parseNewsEventsConfig } from '../config';

const csv = 'SYMBOL,NAME OF COMPANY, SERIES\nTATAMOTORS,Tata Motors Limited,EQ\nINFY,Infosys Limited,EQ\n';

function harness(getText: jest.Mock) {
  const tx = { instrumentNameAlias: { deleteMany: jest.fn(), createMany: jest.fn() } };
  const prisma = {
    $transaction: jest.fn(async (fn: (t: typeof tx) => Promise<unknown>) => fn(tx)),
    instrumentNameAlias: { findMany: jest.fn().mockResolvedValue([{ symbol: 'X', alias: 'Xylo Corp', kind: 'derived' }]) },
  };
  const tagger = { rebuild: jest.fn() };
  const svc = new AliasLoaderService(parseNewsEventsConfig({ NEWS_EVENTS_V2_ENABLED: 'observe' }), { getText } as never, prisma as never, tagger as never);
  return { svc, tx, prisma, tagger };
}

it('refresh: EQUITY_L → aliases replaced in one transaction → matcher rebuilt', async () => {
  const getText = jest.fn().mockResolvedValue(csv);
  const { svc, tx, tagger } = harness(getText);
  await expect(svc.refresh()).resolves.toBeGreaterThan(2);
  expect(getText).toHaveBeenCalledWith('NSE EQUITY_L', EQUITY_L_URL);
  expect(tx.instrumentNameAlias.deleteMany).toHaveBeenCalledWith({ where: { source: { in: ['EQUITY_L', 'curated'] } } });
  expect(tx.instrumentNameAlias.createMany.mock.calls[0][0].data).toEqual(
    expect.arrayContaining([expect.objectContaining({ symbol: 'TATAMOTORS', alias: 'Tata Motors', kind: 'derived', source: 'EQUITY_L' })]),
  );
  expect(tagger.rebuild).toHaveBeenCalled();
});

it('a failed fetch keeps the table and the matcher; it falls back to the DB rows', async () => {
  const { svc, tx, tagger } = harness(jest.fn().mockRejectedValue(new Error('NSE EQUITY_L: HTTP 403')));
  await expect(svc.refresh()).resolves.toBe(0);
  expect(tx.instrumentNameAlias.deleteMany).not.toHaveBeenCalled();
  expect(tagger.rebuild).not.toHaveBeenCalled();
  await expect(svc.loadFromDb()).resolves.toBe(1);
  expect(tagger.rebuild).toHaveBeenCalledWith([{ symbol: 'X', alias: 'Xylo Corp', kind: 'derived' }]);
});

it('an HTML block page (200, not a CSV) is a failed refresh, never an emptied alias table', async () => {
  const { svc, tx } = harness(jest.fn().mockResolvedValue('<html>Access Denied</html>'));
  await expect(svc.refresh()).resolves.toBe(0);
  expect(tx.instrumentNameAlias.deleteMany).not.toHaveBeenCalled();
});

it('the captured fixture parses (when M0 captured it)', () => {
  const p = join(__dirname, '..', '__fixtures__', 'equity-l.csv');
  let text: string | null = null;
  try {
    text = readFileSync(p, 'utf8');
  } catch {
    /* not captured on this machine */
  }
  if (text) expect(parseEquityL(text).length).toBeGreaterThan(0);
});
