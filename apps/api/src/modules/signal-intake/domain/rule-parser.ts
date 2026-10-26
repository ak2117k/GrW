import { instrumentHits } from './prefilter';
import { isNumber, normalise, type Normalised } from './text';
import type { EntryType, Horizon, InstrumentKind, ParsedSignal, Side } from './types';
import type { Vocabulary } from './vocabulary';

/**
 * Contract §S rule 2 — the rule parser for the common Indian tip formats. It walks the normalised
 * tokens once with a small mode machine (entry → SL → targets → qty) after lifting out the
 * underlying, the strike + CE/PE and the expiry. It returns null — and the caller falls back to the
 * LLM — whenever the message is ambiguous: two contracts in one post, no entry, an SL or a target on
 * the wrong side of the entry. A wrong parse is worse than an LLM call.
 */

const BUY_WORDS = new Set(['BUY', 'LONG', 'ACCUMULATE', 'ADD', 'B']);
const SELL_WORDS = new Set(['SELL', 'SHORT', 'S']);
const ENTRY_WORDS = new Set(['AT', 'NEAR', 'AROUND', 'CMP', 'ZONE', 'RANGE', 'BETWEEN', 'BW', 'ENTRY', 'PRICE', 'ONLY', 'LEVEL']);
const RANGE_WORDS = new Set(['RANGE', 'ZONE', 'BETWEEN', 'BW']);
const QTY_WORDS = new Set(['QTY', 'QUANTITY', 'LOT', 'LOTS', 'LOTSIZE']);
const POSITIONAL_WORDS = new Set(['POSITIONAL', 'SWING', 'HOLD', 'LONGTERM', 'INVESTMENT', 'DELIVERY', 'WEEKS', 'WEEK', 'MONTHS', 'MONTH', 'DAYS']);

type Mode = 'entry' | 'sl' | 'tgt' | 'qty' | 'none';

export function parseSignal(raw: string, vocab: Vocabulary, pre?: Normalised): ParsedSignal | null {
  const norm = pre ?? normalise(raw, vocab);
  const t = norm.tokens;
  if (t.length === 0) return null;
  const used = new Array<boolean>(t.length).fill(false);

  // ─── Underlying ────────────────────────────────────────────────────────────
  const hits = instrumentHits(t, vocab);
  const names = [...new Set(hits.map((h) => h.name))];
  if (names.length !== 1) return null;
  const underlying = names[0];
  for (const h of hits) used[h.i] = true;
  const cls = vocab.classOf.get(underlying) ?? 'STOCK';

  // ─── Contract: strike + CE/PE, FUT, cash ───────────────────────────────────
  let kind: InstrumentKind | null = null;
  let strike: number | null = null;
  for (let i = 1; i < t.length; i++) {
    if ((t[i] === 'CE' || t[i] === 'PE') && isNumber(t[i - 1])) {
      if (kind) return null; // two option contracts in one post
      kind = t[i] as 'CE' | 'PE';
      strike = Number(t[i - 1]);
      used[i] = used[i - 1] = true;
    }
  }
  if (t.includes('CE') && !kind) return null;
  if (t.includes('PE') && !kind) return null;
  const futIdx = t.indexOf('FUT');
  if (futIdx >= 0) {
    if (kind) return null;
    kind = 'FUT';
    used[futIdx] = true;
  }
  if (!kind) kind = cls === 'STOCK' ? 'EQ' : 'FUT';

  // ─── Walk ──────────────────────────────────────────────────────────────────
  let side: Side | null = null;
  let entryType: EntryType | null = null;
  const entry: number[] = [];
  let sl: number | null = null;
  let slCost = false;
  let noSl = false;
  const targets: number[] = [];
  let qty: number | null = null;
  let mode: Mode = 'entry';
  let rangeJoin = false;
  let rangeExplicit = false;

  for (let i = 0; i < t.length; i++) {
    if (used[i]) continue;
    const w = t[i];
    if (isNumber(w)) {
      const v = Number(w);
      if (t[i + 1] === 'LOT' || t[i + 1] === 'LOTS') {
        qty = Math.round(v);
        continue;
      }
      if (mode === 'entry') {
        if (entry.length < 2) entry.push(v);
        if (entry.length === 2 && rangeJoin) rangeExplicit = true;
        if (entry.length === 2 && rangeJoin && !entryType) entryType = 'RANGE';
        rangeJoin = false;
      } else if (mode === 'sl') {
        if (sl === null) sl = v;
        mode = 'none';
      } else if (mode === 'tgt') {
        // "TARGET 1 140": a lone single digit right after the keyword is the target's ordinal.
        if (/^[1-5]$/.test(w) && /^TGT\d?$/.test(t[i - 1] ?? '') && isNumber(t[i + 1] ?? '')) continue;
        targets.push(v);
      } else if (mode === 'qty') {
        qty = Math.round(v);
        mode = 'none';
      }
      continue;
    }
    if (w === 'TO' || w === '/') {
      if (mode === 'entry' && entry.length === 1) rangeJoin = true;
      continue;
    }
    if (w === 'SL') {
      mode = 'sl';
      if (['COST', 'CTC', 'ENTRY'].includes(t[i + 1] ?? '')) slCost = true;
      if (t[i + 1] === 'NO' || t[i - 1] === 'NO' || t[i - 1] === 'WITHOUT') noSl = true;
      continue;
    }
    if (/^TGT\d?$/.test(w)) {
      mode = 'tgt';
      continue;
    }
    if (w === 'ABOVE') {
      entryType = 'ABOVE';
      if (entry.length === 0) mode = 'entry';
      continue;
    }
    if (w === 'BELOW') {
      entryType = 'BELOW';
      if (entry.length === 0) mode = 'entry';
      continue;
    }
    if (BUY_WORDS.has(w) && (w !== 'B' || i === 0)) {
      if (side && side !== 'BUY') return null;
      side = 'BUY';
      if (entry.length === 0) mode = 'entry';
      continue;
    }
    if (SELL_WORDS.has(w) && (w !== 'S' || i === 0)) {
      if (side && side !== 'SELL') return null;
      side = 'SELL';
      if (entry.length === 0) mode = 'entry';
      continue;
    }
    if (QTY_WORDS.has(w)) {
      mode = 'qty';
      continue;
    }
    // Stock Gainers style: "CMP 37 SUPPORT 20 FOR 57" / "above 731 support 720 view 740" — once an entry
    // is in, a number after SUPPORT is the stop and one after VIEW / FOR is the target.
    if (entry.length > 0 && isNumber(t[i + 1] ?? '')) {
      if (w === 'SUPPORT' && mode !== 'tgt') {
        mode = 'sl';
        continue;
      }
      if (w === 'VIEW' || w === 'FOR') {
        mode = 'tgt';
        continue;
      }
    }
    if (RANGE_WORDS.has(w) && mode === 'entry') rangeExplicit = true;
    if (ENTRY_WORDS.has(w) && entry.length === 0 && mode !== 'sl' && mode !== 'tgt') {
      mode = 'entry';
      continue;
    }
  }

  if (entry.length === 0) return null;
  // Two loose numbers in the entry ("120 … 100 ka stop") are ambiguous: only an explicit range counts.
  if (entry.length === 2 && !rangeExplicit) return null;
  // An explicit action verb (BUY / SELL / LONG / SHORT, KHARIDO / BECHO folded to them, BTST / STBT).
  const verb = side !== null || t.includes('BTST') || t.includes('STBT');
  if (!side && t.includes('BTST')) side = 'BUY';
  if (!side && t.includes('STBT')) side = 'SELL';
  const entryLow = Math.min(...entry);
  const entryHigh = Math.max(...entry);
  // A "range" more than 30% wide is a move being bragged about ("1420CE 37 TO 77 🔥"), not an entry.
  if (entryHigh > entryLow * 1.3) return null;
  const option = kind === 'CE' || kind === 'PE';
  if (!side) {
    if (entryType === 'ABOVE') side = 'BUY';
    else if (entryType === 'BELOW' && (kind === 'FUT' || kind === 'EQ')) side = 'SELL';
    // An option post with no verb whose stop sits under the entry and targets over it is a buy
    // ("ZYDUSLIFE 1140 ce 15-16 support 9 view 21"); anything else stays ambiguous.
    else if (option && entryType !== 'BELOW' && sl !== null && sl < entryLow && targets.length > 0 && targets.every((x) => x > entryHigh)) side = 'BUY';
    else return null;
  }
  if (!(entryLow > 0)) return null;
  if (!entryType) entryType = entry.length === 2 ? 'RANGE' : 'AT';
  if (entryType === 'RANGE' && entryLow === entryHigh) entryType = 'AT';
  // A strike that slipped into the entry ("NIFTY 24000 CE ABOVE 120" never does; "NIFTY 24000 CE 24000" might).
  if (strike !== null && (entryLow === strike || entryHigh === strike)) return null;

  // ─── Sanity: levels on the right side of the entry ─────────────────────────
  if (slCost || noSl || (sl !== null && sl <= 0)) sl = null;
  if (sl !== null) {
    if (side === 'BUY' ? sl >= entryLow : sl <= entryHigh) return null;
  }
  const tgts = [...new Set(targets)];
  if (tgts.some((x) => (side === 'BUY' ? x <= entryHigh : x >= entryLow))) return null;
  tgts.sort((a, b) => (side === 'BUY' ? a - b : b - a));

  // ─── A trade instruction, not a level (prod 2026-10-23: "a monthly close above 33000-33400 needed") ──
  // An explicit verb needs an SL or a target; a bare "ABOVE / BELOW x" counts as an instruction only in
  // the complete tip line "X 24000 PE ABOVE 60 SL 45 TGT 75" (both an SL and a target). The exception
  // is a named option bought at a premium under its strike ("BANKNIFTY 54400 PE ABOVE 387", "Buy crude
  // 10700 CE 225/230"): a strike + CE/PE + a price to pay is a call even when the SL / target is withheld.
  const hasSl = sl !== null;
  const optionBuy = option && side === 'BUY' && (verb || entryType === 'ABOVE') && strike !== null && entryHigh < strike;
  if (!optionBuy && (verb ? !(hasSl || tgts.length > 0) : !(hasSl && tgts.length > 0))) return null;

  const horizon: Horizon = t.includes('BTST') || t.includes('STBT') ? 'BTST' : t.some((w) => POSITIONAL_WORDS.has(w)) ? 'POSITIONAL' : 'INTRADAY';
  const tags: string[] = [];
  if (t.includes('HEROZERO')) tags.push('HERO_ZERO');
  if (slCost) tags.push('SL_COST');
  if (noSl) tags.push('NO_SL');
  if (t.includes('EXPIRY')) tags.push('EXPIRY');

  let confidence = 0.9;
  if (sl === null) confidence -= 0.15;
  if (tgts.length === 0) confidence -= 0.1;

  return {
    underlying,
    instrumentKind: kind,
    strike,
    expiryHint: kind === 'EQ' ? null : norm.expiry,
    side,
    entryType,
    entryLow,
    entryHigh,
    sl,
    targets: tgts,
    qty: qty !== null && qty > 0 ? qty : null,
    horizon,
    tags,
    confidence: Math.round(confidence * 100) / 100,
  };
}
