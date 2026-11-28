import { prefilter } from './prefilter';
import { hasNewCall, resultPostReason } from './result-post';
import { buildVocabulary } from './vocabulary';

const vocab = buildVocabulary(['RELIANCE-EQ', 'SBIN-EQ']);
const reason = (text: string) => resultPostReason(prefilter(text, vocab).norm);

describe('resultPostReason — a post reporting a completed outcome (audit 2026-11-27)', () => {
  it.each([
    'Silver 40 to 44++ … gains done',
    'SILVER 40 TO 44++ GAINS DONE 🔥',
    'Nifty 24000 CE target hit',
    'BANKNIFTY 52000 PE 🎯 done',
    'Crude 5600 CE 120 to 160 done ✅',
    'Profit booked in RELIANCE',
    'SBIN 800 to 830 booked',
    'All targets done in NIFTY 24000 CE',
    'T2 achieved, 2x done',
  ])('"%s" is a result post', (text) => {
    expect(reason(text)).toMatch(/^result:/);
  });

  it.each([
    'BUY NIFTY 24000 CE ABOVE 120 SL 100 TGT 140/160/200',
    'Silver buy 40-41 sl 37 target 44/48',
    'Book profit near 160',
    'Good morning traders',
    'Nifty 22400 support, below that 22000 done for the week?',
  ])('"%s" is not', (text) => {
    expect(reason(text)).toBeNull();
  });
});

describe('hasNewCall — a call verb AND its SL / TGT price AFTER the first outcome (review 2026-11-28)', () => {
  const newCall = (text: string) => hasNewCall(prefilter(text, vocab).norm);
  it.each([
    'T1 done ✅ BUY NIFTY 24000 CE ABOVE 300 SL 250',
    'Silver 40 to 44++ gains done ✅ Now BUY NIFTY 24000 CE ABOVE 120 SL 100',
    'Crude 120 to 160 done. BUY BANKNIFTY 52000 PE ABOVE 300 TGT 350',
  ])('"%s" gives a new call', (text) => expect(newCall(text)).toBe(true));

  it.each([
    'BUY NIFTY 24000 CE ABOVE 120 SL 100 TGT 140 🎯 done', // a repost of the old call with its outcome
    'target 1 done, now buy NIFTY 24000 CE above 120', // no stop / target after the outcome
    'Silver buy 40 to 44++ gains done',
    'Good morning traders', // no outcome at all
  ])('"%s" does not', (text) => expect(newCall(text)).toBe(false));
});
