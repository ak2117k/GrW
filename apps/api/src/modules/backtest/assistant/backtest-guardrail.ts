/**
 * Deterministic pre-check for "Ask Claude to backtest…" — runs BEFORE any model call.
 *
 * Builds on the AI Trading Advisor's guardrail (injection, hard off-topic such as coding/writing
 * requests) and is stricter about topic: the request must be about backtesting a trading
 * strategy. An "unclear" question that the advisor would still send to the model is refused here.
 */
import { classifyAdvisorQuestion } from '../../ai-assist/advisor-guardrail';

export const BACKTEST_AI_MAX_CHARS = 800;

export const BACKTEST_OFF_TOPIC =
  'I can only set up backtests of trading strategies here — e.g. "backtest a 20/50 EMA crossover on ' +
  'TATAMOTORS 15m for 2 years with a 1.5% stop".';

export const BACKTEST_INJECTION =
  "I can't change how I work. Describe the strategy you want backtested (indicators, entry/exit, stop, symbol, timeframe, period).";

export type BacktestGuardVerdict =
  | { allowed: true }
  | { allowed: false; reason: 'empty' | 'too-long' | 'injection' | 'off-topic'; message: string };

/** Backtest / strategy vocabulary: at least one hit is required. */
const TOPIC = new RegExp(
  '(?<![a-z])(?:' +
    [
      'backtest\\w*', 'back-test\\w*', 'strateg(y|ies)', 'simulat\\w*', 'test(ing)?', 'trad(e|es|ing)',
      'crossover', 'cross(es)? (above|below|over|under)', 'ema', 'sma', 'moving average', 'rsi', 'macd',
      'bollinger', 'bb', 'vwap', 'atr', 'super ?trend', 'adx', 'breakout', 'mean reversion', 'momentum',
      'stop ?loss', 'stop', 'sl', 'target', 'take profit', 'entry', 'entries', 'exit', 'long', 'short',
      'buy', 'sell', 'overbought', 'oversold', 'candles?', 'timeframe', 'intraday', 'swing',
    ].join('|') +
    ')(?![a-z])',
  'i',
);

/** Things never allowed in a backtest request on top of the advisor's injection list. */
const EXTRA_INJECTION = new RegExp(
  ['```', '<\\s*script', '\\{\\{', '\\$\\{', '\\beval\\s*\\(', '\\brequire\\s*\\(', '\\bimport\\s+\\w', '\\bprocess\\.env\\b'].join('|'),
  'i',
);

export function classifyBacktestRequest(raw: string): BacktestGuardVerdict {
  const q = (raw ?? '').trim();
  if (q === '') return { allowed: false, reason: 'empty', message: 'Describe the strategy you want backtested.' };
  if (q.length > BACKTEST_AI_MAX_CHARS) {
    return { allowed: false, reason: 'too-long', message: `Please keep the request under ${BACKTEST_AI_MAX_CHARS} characters.` };
  }
  if (EXTRA_INJECTION.test(q)) return { allowed: false, reason: 'injection', message: BACKTEST_INJECTION };
  const advisor = classifyAdvisorQuestion(q);
  if (!advisor.allowed) {
    if (advisor.reason === 'injection') return { allowed: false, reason: 'injection', message: BACKTEST_INJECTION };
    if (advisor.reason === 'too-long') {
      return { allowed: false, reason: 'too-long', message: `Please keep the request under ${BACKTEST_AI_MAX_CHARS} characters.` };
    }
    return { allowed: false, reason: 'off-topic', message: BACKTEST_OFF_TOPIC };
  }
  if (!TOPIC.test(q)) return { allowed: false, reason: 'off-topic', message: BACKTEST_OFF_TOPIC };
  return { allowed: true };
}

/** Cache key text: case, whitespace and trailing punctuation do not make a new request. */
export function normaliseRequest(raw: string): string {
  return (raw ?? '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/[\s.!?]+$/g, '')
    .trim();
}
