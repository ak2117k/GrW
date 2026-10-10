import type { FiiDerivatives, FiiIndexPositions } from '../market-cues.types';
import { nseDateToYmd, venueNumber } from './ist-dates';

/**
 * FII index F&O positioning — NSE's participant-wise open interest archive,
 * `fao_participant_oi_DDMMYYYY.csv` (no. of contracts). Best effort: the
 * archive host was not tested from the VPS.
 *
 * Read: the FII row's index futures long/short and index call/put long/short.
 */
export function parseParticipantOi(csv: string): FiiIndexPositions {
  const lines = csv.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const title = lines[0] ?? '';
  const dm = /as on\s+([A-Za-z]{3}\s+\d{1,2},\s*\d{4})/i.exec(title);
  const date = dm ? nseDateToYmd(dm[1]) : null;
  if (!date) throw new Error('participant OI: no "as on" date in the title row');
  const headerIdx = lines.findIndex((l) => /^client type\s*,/i.test(l));
  if (headerIdx < 0) throw new Error('participant OI: no header row');
  const header = lines[headerIdx].split(',').map((h) => h.trim().toLowerCase());
  const fiiLine = lines.slice(headerIdx + 1).find((l) => /^fii\s*,/i.test(l));
  if (!fiiLine) throw new Error('participant OI: no FII row');
  const cells = fiiLine.split(',').map((c) => c.trim());
  const col = (name: string): number => {
    const i = header.indexOf(name);
    const v = i >= 0 ? venueNumber(cells[i]) : null;
    if (v === null) throw new Error(`participant OI: FII "${name}" missing or unreadable`);
    return v;
  };
  return {
    date,
    indexFutures: { long: col('future index long'), short: col('future index short') },
    indexCalls: { long: col('option index call long'), short: col('option index call short') },
    indexPuts: { long: col('option index put long'), short: col('option index put short') },
  };
}

export function participantOiChange(now: FiiIndexPositions, prev: FiiIndexPositions): NonNullable<FiiDerivatives['change']> {
  const d = (a: { long: number; short: number }, b: { long: number; short: number }) => ({
    long: a.long - b.long,
    short: a.short - b.short,
  });
  return {
    previousDate: prev.date,
    indexFutures: d(now.indexFutures, prev.indexFutures),
    indexCalls: d(now.indexCalls, prev.indexCalls),
    indexPuts: d(now.indexPuts, prev.indexPuts),
  };
}

/** `{DDMMYYYY}` in the template ← the session date 'YYYY-MM-DD'. */
export function participantOiUrl(template: string, ymd: string): string {
  const [y, m, d] = ymd.split('-');
  return template.replace('{DDMMYYYY}', `${d}${m}${y}`);
}
