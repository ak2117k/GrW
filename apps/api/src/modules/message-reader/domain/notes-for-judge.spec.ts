import { ReadingRow, selectVerifiedNotes } from './notes-for-judge';
import { Claim, ClaimVerdict, ReadScope } from './reading.types';

// 2026-11-25 12:00 IST
const NOW = new Date('2026-11-25T06:30:00.000Z');

const claim = (subject: string, verdict: ClaimVerdict = 'CONFIRMED', text = 'stocks weak'): Claim => ({
  text,
  subject,
  bias: 'CAUTION',
  horizon: 'INTRADAY',
  verdict,
  evidence: [{ fact: 'adv/dec', value: '0.4', source: 'breadth' }],
  claimType: 'CAUTION',
});

let seq = 0;
const row = (scope: ReadScope, claims: Claim[], postedAt = new Date('2026-11-25T05:00:00.000Z')): ReadingRow => ({
  messageId: `m${++seq}`,
  channelId: 'c1',
  channelTitle: 'Alpha Calls',
  postedAt,
  scope,
  claims,
  summary: null,
});

const q = (underlying = 'NIFTY', sector: string | null = null) => ({ underlying, sector, now: NOW });

describe('selectVerifiedNotes', () => {
  it('keeps MARKET notes and drops UNCLEAR', () => {
    const notes = selectVerifiedNotes(
      [row('MARKET', [claim('MARKET', 'CONFIRMED'), claim('MARKET', 'UNCLEAR'), claim('MARKET', 'CONTRADICTED')])],
      q(),
    );
    expect(notes.map((n) => n.verdict)).toEqual(['CONFIRMED', 'CONTRADICTED']);
    expect(notes[0]).toEqual({
      channel: 'Alpha Calls',
      at: '10:30',
      scope: 'MARKET',
      subject: 'MARKET',
      claim: 'stocks weak',
      bias: 'CAUTION',
      verdict: 'CONFIRMED',
      evidence: [{ fact: 'adv/dec', value: '0.4', source: 'breadth' }],
    });
  });

  it("keeps INSTRUMENT notes only for the call's underlying", () => {
    const rows = [row('INSTRUMENT', [claim('SENSEX')])];
    expect(selectVerifiedNotes(rows, q('SENSEX'))).toHaveLength(1);
    expect(selectVerifiedNotes(rows, q('NIFTY'))).toHaveLength(0);
  });

  it("keeps SECTOR notes only for the call's sector", () => {
    const rows = [row('SECTOR', [claim('BANK')])];
    expect(selectVerifiedNotes(rows, q('HDFCBANK', 'BANK'))).toHaveLength(1);
    expect(selectVerifiedNotes(rows, q('HDFCBANK', 'IT'))).toHaveLength(0);
    expect(selectVerifiedNotes(rows, q('NIFTY', null))).toHaveLength(0);
  });

  it('relevance follows the claim subject, not the row scope (final review #7)', () => {
    // A MARKET-scope post with an instrument claim on another underlying: not shown for NIFTY.
    const marketRow = row('MARKET', [claim('MARKET'), claim('RELIANCE')]);
    expect(selectVerifiedNotes([marketRow], q('NIFTY')).map((n) => n.subject)).toEqual(['MARKET']);
    expect(selectVerifiedNotes([marketRow], q('RELIANCE')).map((n) => n.subject)).toEqual(['MARKET', 'RELIANCE']);
    // An INSTRUMENT-scope post with a market-wide claim: shown for any call (as the owner alert would treat it).
    const instRow = row('INSTRUMENT', [claim('MARKET'), claim('SBIN')]);
    expect(selectVerifiedNotes([instRow], q('NIFTY')).map((n) => n.subject)).toEqual(['MARKET']);
    // A sector claim inside a MARKET-scope post reaches only that sector's calls.
    const sectorInMarket = row('MARKET', [claim('BANK')]);
    expect(selectVerifiedNotes([sectorInMarket], q('HDFCBANK', 'BANK'))).toHaveLength(1);
    expect(selectVerifiedNotes([sectorInMarket], q('INFY', 'IT'))).toHaveLength(0);
    // A blank subject is never relevant.
    expect(selectVerifiedNotes([row('MARKET', [claim('  ')])], q())).toHaveLength(0);
  });

  it("drops yesterday's notes", () => {
    // 2026-11-24 23:00 IST — same UTC date as NOW, previous IST session
    const late = row('MARKET', [claim('MARKET')], new Date('2026-11-24T17:30:00.000Z'));
    // 2026-11-25 00:10 IST — previous UTC date, today's IST session
    const early = row('MARKET', [claim('MARKET', 'CONFIRMED', 'early')], new Date('2026-11-24T18:40:00.000Z'));
    expect(selectVerifiedNotes([late, early], q()).map((n) => n.claim)).toEqual(['early']);
  });

  it('drops notes posted after now', () => {
    const future = row('MARKET', [claim('MARKET')], new Date(NOW.getTime() + 60_000));
    const atNow = row('MARKET', [claim('MARKET', 'CONFIRMED', 'at now')], NOW);
    expect(selectVerifiedNotes([future, atNow], q()).map((n) => n.claim)).toEqual(['at now']);
  });

  it('caps at 10 newest first', () => {
    const rows = Array.from({ length: 12 }, (_, i) =>
      row('MARKET', [claim('MARKET', 'CONFIRMED', `n${i}`)], new Date(Date.parse('2026-11-25T04:00:00.000Z') + i * 60_000)),
    );
    const notes = selectVerifiedNotes(rows, q());
    expect(notes).toHaveLength(10);
    expect(notes.map((n) => n.claim)).toEqual(['n11', 'n10', 'n9', 'n8', 'n7', 'n6', 'n5', 'n4', 'n3', 'n2']);
    expect(notes[0].at).toBe('09:41');
  });
});
