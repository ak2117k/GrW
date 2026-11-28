import { prefilter } from './prefilter';
import { resultPostReason } from './result-post';
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
