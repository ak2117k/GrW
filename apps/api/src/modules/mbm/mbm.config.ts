// apps/api/src/modules/mbm/mbm.config.ts
// MBM M2 flags (docs/superpowers/plans/2026-10-19-mbm-m2-serving.md §4). Parsed in ONE place.

export type MbmMode = 'off' | 'observe' | 'on';

export interface MbmConfig {
  /** off: nothing runs, the client answers `absent`. observe (M2): bars refresh + proxy. on: reserved. */
  mode: MbmMode;
  /** Upper-cased, de-duplicated instrument list (MBM_INSTRUMENTS, default NIFTY). */
  instruments: string[];
  /** MBM service base URL without a trailing slash (MBM_URL, default http://mbm:5100). */
  url: string;
  /** The owner whose OWN Angel session fetches the 1m bars (MBM_FEED_USER_ID, else first AI_AUTO_EXIT_USER_IDS). */
  feedUserId: string | null;
  /**
   * M3 stream A consumers (docs/superpowers/plans/2026-10-19-mbm-m3-consumers.md). EFFECTIVE values:
   * forced to `off` while `mode` is off (the global rule: every consumer inert, every output unchanged).
   * packet (MBM_PACKET): the sentinel packet block `marketBehaviour`. observe logs it, on adds it.
   * exitShadow (MBM_EXIT_SHADOW): the exit-gate shadow. observe and on both only RECORD, never decide.
   */
  packet: MbmMode;
  exitShadow: MbmMode;
  /**
   * M3 trade-core entry gate `market-behaviour` (MBM_ENTRY_GATE, default off). observe: the gate always
   * passes and records what it would have done; on: a regime the strategy version skips fails the gate.
   * Inert whenever `mode` is off: read it through `mbmEntryGateMode`.
   */
  entryGate: MbmMode;
  /**
   * NIFTY option-chain capture into mbm_chain_snapshots (MBM_CHAIN_CAPTURE, off|on, default off).
   * A PRODUCER of training data, not a consumer: independent of MBM_ENABLED (every missed session is
   * lost for good, Angel serves nothing for expired contracts). Needs `feedUserId`.
   */
  chainCapture: 'off' | 'on';
  /**
   * Per-symbol chain capture (MBM_CHAIN_CAPTURE_STOCKS, off|on, default off): the chain watchlist's
   * symbols (owner's open NFO position underlyings + registered news symbols), nearest expiry ATM ±10,
   * every 15 min 09:15–15:15 IST + a 15:30 EOD snapshot. Independent of MBM_ENABLED; needs `feedUserId`.
   */
  chainCaptureStocks: 'off' | 'on';
  /**
   * Indices the 5-min chain capture covers (MBM_CHAIN_CAPTURE_INSTRUMENTS, default NIFTY,BANKNIFTY). Only
   * index underlyings whose 1m bar the refresher stores are accepted (the stored close centres the window).
   */
  chainCaptureInstruments: string[];
  /** Human-readable fallbacks taken while parsing; logged once at boot. */
  problems: string[];
}

export const MBM_CONFIG = Symbol('MBM_CONFIG');

const MODES: readonly MbmMode[] = ['off', 'observe', 'on'];
const DEFAULT_URL = 'http://mbm:5100';
/** Indices the chain capture accepts (and its default): each has an index token AND a stored 1m bar series. */
export const CHAIN_CAPTURE_INDICES = ['NIFTY', 'BANKNIFTY'] as const;

const csv = (raw: string | undefined): string[] =>
  String(raw ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

export function parseMbmConfig(env: NodeJS.ProcessEnv): MbmConfig {
  const problems: string[] = [];

  const rawMode = (env.MBM_ENABLED ?? '').trim().toLowerCase();
  let mode: MbmMode = 'off';
  if ((MODES as readonly string[]).includes(rawMode)) mode = rawMode as MbmMode;
  else if (rawMode !== '') problems.push(`MBM_ENABLED=${rawMode} is not off|observe|on — using off`);

  let instruments = [...new Set(csv(env.MBM_INSTRUMENTS).map((s) => s.toUpperCase()))];
  if (instruments.length === 0) instruments = ['NIFTY'];

  let url = (env.MBM_URL ?? '').trim().replace(/\/+$/, '');
  if (url === '') url = DEFAULT_URL;
  else if (!/^https?:\/\//i.test(url)) {
    problems.push(`MBM_URL=${url} is not an http(s) URL — using ${DEFAULT_URL}`);
    url = DEFAULT_URL;
  }

  const rawGate = (env.MBM_ENTRY_GATE ?? '').trim().toLowerCase();
  let entryGate: MbmMode = 'off';
  if ((MODES as readonly string[]).includes(rawGate)) entryGate = rawGate as MbmMode;
  else if (rawGate !== '') problems.push(`MBM_ENTRY_GATE=${rawGate} is not off|observe|on — using off`);

  const rawCapture = (env.MBM_CHAIN_CAPTURE ?? '').trim().toLowerCase();
  let chainCapture: 'off' | 'on' = 'off';
  if (rawCapture === 'on' || rawCapture === 'off') chainCapture = rawCapture;
  else if (rawCapture !== '') problems.push(`MBM_CHAIN_CAPTURE=${rawCapture} is not off|on — using off`);

  const feedUserId = (env.MBM_FEED_USER_ID ?? '').trim() || csv(env.AI_AUTO_EXIT_USER_IDS)[0] || null;
  if (chainCapture === 'on' && !feedUserId) {
    problems.push('MBM_CHAIN_CAPTURE=on but no MBM_FEED_USER_ID / AI_AUTO_EXIT_USER_IDS — the chain capture will not run');
  }
  const rawStocks = (env.MBM_CHAIN_CAPTURE_STOCKS ?? '').trim().toLowerCase();
  let chainCaptureStocks: 'off' | 'on' = 'off';
  if (rawStocks === 'on' || rawStocks === 'off') chainCaptureStocks = rawStocks;
  else if (rawStocks !== '') problems.push(`MBM_CHAIN_CAPTURE_STOCKS=${rawStocks} is not off|on — using off`);
  if (chainCaptureStocks === 'on' && !feedUserId) {
    problems.push('MBM_CHAIN_CAPTURE_STOCKS=on but no MBM_FEED_USER_ID / AI_AUTO_EXIT_USER_IDS — the per-symbol chain capture will not run');
  }
  const rawCaptureInst = csv(env.MBM_CHAIN_CAPTURE_INSTRUMENTS).map((s) => s.toUpperCase());
  const accepted = CHAIN_CAPTURE_INDICES as readonly string[];
  const chainCaptureInstruments = [...new Set(rawCaptureInst.filter((s) => accepted.includes(s)))];
  for (const s of rawCaptureInst) {
    if (!accepted.includes(s)) problems.push(`MBM_CHAIN_CAPTURE_INSTRUMENTS: ${s} is not one of ${accepted.join('|')} — ignored`);
  }
  if (chainCaptureInstruments.length === 0) chainCaptureInstruments.push(...CHAIN_CAPTURE_INDICES);
  if (mode !== 'off' && !feedUserId) {
    problems.push('no MBM_FEED_USER_ID and AI_AUTO_EXIT_USER_IDS is empty — the bar refresher will not run');
  }

  const consumer = (name: string): MbmMode => {
    const raw = (env[name] ?? '').trim().toLowerCase();
    let m: MbmMode = 'off';
    if ((MODES as readonly string[]).includes(raw)) m = raw as MbmMode;
    else if (raw !== '') problems.push(`${name}=${raw} is not off|observe|on — using off`);
    if (m !== 'off' && mode === 'off') {
      problems.push(`${name}=${m} is ignored while MBM_ENABLED=off`);
      m = 'off';
    }
    return m;
  };
  const packet = consumer('MBM_PACKET');
  const exitShadow = consumer('MBM_EXIT_SHADOW');

  return { mode, instruments, url, feedUserId, packet, exitShadow, entryGate, chainCapture, chainCaptureStocks, chainCaptureInstruments, problems };
}

/** The entry gate's effective mode: MBM_ENABLED=off makes every consumer inert (plan M3, global rule). */
export function mbmEntryGateMode(c: Pick<MbmConfig, 'mode' | 'entryGate'> | null | undefined): MbmMode {
  return !c || c.mode === 'off' ? 'off' : c.entryGate;
}

/** The single boot line: `[mbm] mode=… instruments=… url=… feedUser=… chainCapture=…`. */
export function mbmBootLine(c: MbmConfig): string {
  return (
    `[mbm] mode=${c.mode} instruments=${c.instruments.join(',')} url=${c.url} feedUser=${c.feedUserId ?? 'none'}` +
    ` chainCapture=${c.chainCapture}${c.chainCapture === 'on' ? `(${c.chainCaptureInstruments.join(',')})` : ''}` +
    ` chainCaptureStocks=${c.chainCaptureStocks}`
  );
}
