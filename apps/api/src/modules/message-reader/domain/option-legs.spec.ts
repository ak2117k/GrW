import { buildVocabulary } from '../../signal-intake/domain/vocabulary';
import { chainSliceStrikes, optionLegsOf, resolveOptionLeg } from './option-legs';

const VOCAB = buildVocabulary(['RELIANCE', 'SUNPHARMA']);
// 2026-11-27 10:00 IST
const NOW = new Date('2026-11-27T04:30:00Z');

const opt = (name: string, seg: string, expiry: string, strike: number, type: 'CE' | 'PE', token: string) => ({
  exch_seg: seg,
  name,
  instrumenttype: seg === 'MCX' ? 'OPTFUT' : name === 'RELIANCE' ? 'OPTSTK' : 'OPTIDX',
  symbol: `${name}${expiry.replace(/^(\d+)([A-Z]+)20(\d\d)$/, '$1$2$3')}${strike}${type}`,
  token,
  expiry,
  strike: String(strike * 100),
});

function niftyMaster() {
  const rows: unknown[] = [];
  let t = 1000;
  for (const exp of ['02DEC2026', '09DEC2026']) {
    for (let k = 25300; k <= 26100; k += 50) {
      rows.push(opt('NIFTY', 'NFO', exp, k, 'CE', String(t++)));
      rows.push(opt('NIFTY', 'NFO', exp, k, 'PE', String(t++)));
    }
  }
  return rows;
}

describe('optionLegsOf', () => {
  it('reads "<UNDERLYING> <strike> CE|PE" legs with the vocabulary (aliases, fused tokens, expiry)', () => {
    expect(optionLegsOf('NIFTY 25700 PE above 330 sl 300', VOCAB, ['NIFTY'])).toEqual([{ underlying: 'NIFTY', strike: 25700, kind: 'PE', expiryHint: null }]);
    expect(optionLegsOf('Bank Nifty 59000CE buy 300-310', VOCAB, ['BANKNIFTY'])).toEqual([{ underlying: 'BANKNIFTY', strike: 59000, kind: 'CE', expiryHint: null }]);
    expect(optionLegsOf('SENSEX 4 DEC 84000 CE 260 to 300', VOCAB, ['SENSEX'])).toEqual([
      { underlying: 'SENSEX', strike: 84000, kind: 'CE', expiryHint: { day: 4, month: 12, year: null } },
    ]);
  });

  it('takes each leg\'s nearest preceding underlying, dedupes, and caps at 3', () => {
    const legs = optionLegsOf('NIFTY 25700 PE and 25900 CE; reliance 1500 ce; NIFTY 25700 PE again; SUNPHARMA 1800 PE', VOCAB, ['NIFTY', 'RELIANCE', 'SUNPHARMA']);
    expect(legs.map((l) => `${l.underlying} ${l.strike} ${l.kind}`)).toEqual(['NIFTY 25700 PE', 'NIFTY 25900 CE', 'RELIANCE 1500 CE']);
  });

  it('a bare strike with one named underlying belongs to it; with none it is dropped', () => {
    expect(optionLegsOf('buy 25700 PE above 330', VOCAB, ['NIFTY'])).toEqual([{ underlying: 'NIFTY', strike: 25700, kind: 'PE', expiryHint: null }]);
    expect(optionLegsOf('buy 25700 PE above 330', VOCAB, [])).toEqual([]);
    expect(optionLegsOf('nifty looks weak', VOCAB, ['NIFTY'])).toEqual([]);
  });

  it('without a vocabulary falls back to a local regex over the named underlyings', () => {
    expect(optionLegsOf('nifty 25700pe above 330', null, ['NIFTY'])).toEqual([{ underlying: 'NIFTY', strike: 25700, kind: 'PE', expiryHint: null }]);
    expect(optionLegsOf('CRUDEOIL 5300 CE 120', null, ['CRUDEOIL', 'NIFTY'])).toEqual([{ underlying: 'CRUDEOIL', strike: 5300, kind: 'CE', expiryHint: null }]);
  });
});

describe('resolveOptionLeg', () => {
  it('nearest listed expiry when none is given, with the contract and that expiry\'s strikes', () => {
    const r = resolveOptionLeg(niftyMaster(), { underlying: 'NIFTY', strike: 25700, kind: 'PE', expiryHint: null }, 'NFO', NOW);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.contract).toMatchObject({ exchange: 'NFO', token: expect.any(String), tradingsymbol: 'NIFTY02DEC2625700PE', expiry: '2026-12-02', expirySource: 'master' });
    expect(r.strikes.get(25700)?.pe?.token).toBe(r.contract.token);
    expect(r.strikes.size).toBe(17);
  });

  it('a stated expiry picks that series', () => {
    const r = resolveOptionLeg(niftyMaster(), { underlying: 'NIFTY', strike: 25700, kind: 'CE', expiryHint: { day: 9, month: 12, year: null } }, 'NFO', NOW);
    expect(r.ok && r.contract.tradingsymbol).toBe('NIFTY09DEC2625700CE');
  });

  it('an unlisted strike says so with the listed range', () => {
    const r = resolveOptionLeg(niftyMaster(), { underlying: 'NIFTY', strike: 25710, kind: 'PE', expiryHint: null }, 'NFO', NOW);
    expect(r).toEqual({ ok: false, reason: expect.stringMatching(/NIFTY 25710 PE is not listed for expiry 2026-12-02 \(listed strikes 25300 to 26100\)/) });
    expect(resolveOptionLeg([], { underlying: 'NIFTY', strike: 25700, kind: 'PE', expiryHint: null }, 'NFO', NOW)).toEqual({ ok: false, reason: expect.stringMatching(/no NIFTY PE options in the instrument master/) });
  });
});

describe('chainSliceStrikes', () => {
  it('ATM +-3 listed strikes around the centre', () => {
    const strikes = [25300, 25350, 25400, 25450, 25500, 25550, 25600, 25650, 25700];
    expect(chainSliceStrikes(strikes, 25540)).toEqual([25400, 25450, 25500, 25550, 25600, 25650, 25700]);
    expect(chainSliceStrikes(strikes, 25310)).toEqual([25300, 25350, 25400, 25450]);
  });
});
