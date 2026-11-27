import { BRIEF_MAX_CHARS, BRIEF_MIN_CHARS, type DeskPacket, type InstrumentView, type ManagerDecision, type PositionView } from './desk.types';

/** Reward ≥ 1.2 × risk on the underlying (Global Constraints; cfg.minRewardRisk is the same literal). */
export const MIN_REWARD_RISK = 1.2;
export const PAUSE_MIN_MINUTES = 1;
export const PAUSE_MAX_MINUTES = 390;

type Open = Extract<ManagerDecision, { action: 'OPEN' }>;

const positionsOf = (p: DeskPacket): PositionView[] => (p.positions?.status === 'present' && Array.isArray(p.positions.value) ? p.positions.value : []);
const instrumentsOf = (p: DeskPacket): Record<string, InstrumentView> =>
  p.instruments?.status === 'present' && p.instruments.value ? p.instruments.value : {};

/** The entry price the stop/target checks measure from: NOW → ltp, ZONE → mid, BREAKOUT → the trigger on the trade's side. */
function entryRef(d: Open, view: InstrumentView): number | null {
  const e = d.entry;
  if (e.type === 'NOW') return view.ltp ?? null;
  if (e.type === 'ZONE') return e.low !== undefined && e.high !== undefined ? (e.low + e.high) / 2 : null;
  const t = d.side === 'BUY_PE' ? e.triggerBelow : e.triggerAbove;
  return t ?? null;
}

/**
 * +1 when the position gains as the underlying rises (bought CE / future), −1 when it gains as it falls
 * (bought PE). A short (qty < 0) flips it. Read from the trading symbol's CE/PE suffix.
 */
function underlyingDir(p: PositionView): 1 | -1 {
  const put = /PE$/i.test(p.symbol.trim());
  const short = p.qty < 0;
  return put !== short ? -1 : 1;
}

/**
 * Code checks on one manager decision against the packet it was made from. Returns the problems; empty = valid.
 * Shape is parseManagerReply's job; these are the trading rules the AI cannot talk its way past.
 */
export function validateDecision(d: ManagerDecision, packet: DeskPacket): string[] {
  const problems: string[] = [];
  // A BRIEF is the supreme's plan text, not a trading call: no evidence needed.
  if (d.action !== 'BRIEF' && (!Array.isArray(d.evidence) || d.evidence.filter((e) => typeof e === 'string' && e.trim()).length === 0)) problems.push('no evidence: every decision must cite numbers from the packet');

  switch (d.action) {
    case 'BRIEF': {
      // Only an OPEN position in this packet (unknown or closed trackers are not listed there).
      if (!positionsOf(packet).some((x) => x.trackerId === d.trackerId)) problems.push(`tracker ${d.trackerId} not in packet.positions (unknown or closed)`);
      const n = typeof d.text === 'string' ? d.text.trim().length : 0;
      if (n < BRIEF_MIN_CHARS || n > BRIEF_MAX_CHARS) problems.push(`BRIEF text ${n} chars outside ${BRIEF_MIN_CHARS}–${BRIEF_MAX_CHARS}`);
      break;
    }
    case 'OPEN': {
      const view = instrumentsOf(packet)[d.underlying];
      if (!view) {
        problems.push(`underlying ${d.underlying} not in packet.instruments`);
        break;
      }
      if (!(d.entry.validMin > 0)) problems.push(`entry validMin ${d.entry.validMin} must be > 0`);
      const ref = entryRef(d, view);
      if (ref === null || !Number.isFinite(ref)) {
        problems.push(`no entry reference price for ${d.entry.type} (${d.entry.type === 'NOW' ? 'ltp missing' : d.entry.type === 'ZONE' ? 'low/high missing' : d.side === 'BUY_PE' ? 'triggerBelow missing' : 'triggerAbove missing'})`);
        break;
      }
      const dir = d.side === 'BUY_PE' ? -1 : 1;
      const stop = d.stop.underlying;
      const t1 = d.targets.underlying[0];
      const risk = (ref - stop) * dir;
      const reward = (t1 - ref) * dir;
      if (!(risk > 0)) problems.push(`stop ${stop} on the wrong side of entry ${ref} for ${d.side}`);
      if (!(reward > 0)) problems.push(`first target ${t1} on the wrong side of entry ${ref} for ${d.side}`);
      if (risk > 0 && reward > 0 && reward < MIN_REWARD_RISK * risk) {
        problems.push(`reward ${round(reward)} < ${MIN_REWARD_RISK} × risk ${round(risk)} (entry ${ref}, stop ${stop}, target ${t1})`);
      }
      break;
    }
    case 'EXIT':
    case 'BOOK':
    case 'TIGHTEN': {
      const p = positionsOf(packet).find((x) => x.trackerId === d.trackerId);
      if (!p) {
        problems.push(`tracker ${d.trackerId} not in packet.positions`);
        break;
      }
      if (p.held) problems.push(`tracker ${d.trackerId} is on the owner's HOLD list (held)`);
      if (d.action === 'TIGHTEN' && p.managerStop !== null && Number.isFinite(p.managerStop)) {
        const dir = underlyingDir(p);
        const tighter = dir === 1 ? d.underlyingStop > p.managerStop : d.underlyingStop < p.managerStop;
        if (!tighter) problems.push(`TIGHTEN to ${d.underlyingStop} would loosen or keep the stop ${p.managerStop} (${dir === 1 ? 'must be higher' : 'must be lower'})`);
      }
      break;
    }
    case 'PAUSE_ENTRIES':
      if (!Number.isInteger(d.minutes) || d.minutes < PAUSE_MIN_MINUTES || d.minutes > PAUSE_MAX_MINUTES) problems.push(`PAUSE minutes ${d.minutes} outside ${PAUSE_MIN_MINUTES}–${PAUSE_MAX_MINUTES}`);
      break;
    default:
      break;
  }
  return problems;
}

const round = (n: number) => Math.round(n * 100) / 100;
