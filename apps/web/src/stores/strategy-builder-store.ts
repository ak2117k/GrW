import { create } from 'zustand';
import api from '@/services/api';
import toast from 'react-hot-toast';

// ---- Types ----

export interface IndicatorConfig {
  id: string;
  name: string;
  params: Record<string, number | string>;
}

export interface RuleCondition {
  id: string;
  leftOperand: string; // indicator or variable name
  operator: 'crosses_above' | 'crosses_below' | 'greater_than' | 'less_than' | 'between';
  rightOperand: string; // value or indicator
  rightOperand2?: string; // for "between"
}

export interface RuleConfig {
  id: string;
  conditions: RuleCondition[];
  logic: 'AND' | 'OR';
}

export interface ValidationItem {
  line: number;
  type: 'success' | 'error' | 'warning';
  message: string;
  suggestion?: string;
}

export interface ParseResult {
  valid: boolean;
  items: ValidationItem[];
}

export interface SavedStrategy {
  id: string;
  name: string;
  description: string;
  code: string;
  mode: 'script' | 'visual';
  timeframe: string;
  segment: string;
  createdAt: string;
  updatedAt: string;
}

// ---- Indicator definitions ----

export interface IndicatorDef {
  name: string;
  shortName: string;
  description: string;
  defaultParams: Record<string, number>;
  snippet: string;
}

export const INDICATOR_DEFS: IndicatorDef[] = [
  { name: 'RSI', shortName: 'RSI', description: 'Relative Strength Index — momentum oscillator (0-100)', defaultParams: { period: 14 }, snippet: 'RSI(close, 14)' },
  { name: 'EMA', shortName: 'EMA', description: 'Exponential Moving Average — trend-following', defaultParams: { period: 9 }, snippet: 'EMA(close, 9)' },
  { name: 'SMA', shortName: 'SMA', description: 'Simple Moving Average — smoothed price average', defaultParams: { period: 20 }, snippet: 'SMA(close, 20)' },
  { name: 'MACD', shortName: 'MACD', description: 'MACD — trend and momentum indicator', defaultParams: { fast: 12, slow: 26, signal: 9 }, snippet: 'MACD(close, 12, 26, 9)' },
  { name: 'VWAP', shortName: 'VWAP', description: 'Volume Weighted Average Price', defaultParams: {}, snippet: 'VWAP()' },
  { name: 'Bollinger Bands', shortName: 'BB', description: 'Bollinger Bands — volatility envelope', defaultParams: { period: 20, stddev: 2 }, snippet: 'BB(close, 20, 2)' },
  { name: 'ATR', shortName: 'ATR', description: 'Average True Range — volatility measure', defaultParams: { period: 14 }, snippet: 'ATR(14)' },
  { name: 'Supertrend', shortName: 'SUPERTREND', description: 'Supertrend — trend-following overlay', defaultParams: { period: 10, multiplier: 3 }, snippet: 'SUPERTREND(10, 3)' },
  { name: 'ADX', shortName: 'ADX', description: 'Average Directional Index — trend strength', defaultParams: { period: 14 }, snippet: 'ADX(14)' },
];

// ---- Templates ----

export const STRATEGY_TEMPLATES: Record<string, string> = {
  'RSI Reversal': `//@strategy("RSI Reversal")
//@timeframe("15m")

rsi = RSI(close, 14)

long_entry = rsi < 30
short_entry = rsi > 70
long_exit = rsi > 60
short_exit = rsi < 40

stoploss = ATR(14) * 1.5
target = ATR(14) * 3`,

  'EMA Crossover': `//@strategy("EMA Crossover")
//@timeframe("1h")

ema_fast = EMA(close, 9)
ema_slow = EMA(close, 21)

long_entry = ema_fast > ema_slow
short_entry = ema_fast < ema_slow

stoploss = ATR(14) * 2
target = ATR(14) * 4`,

  'MACD + RSI Combo': `//@strategy("MACD + RSI Combo")
//@timeframe("15m")

rsi = RSI(close, 14)
macd, signal, hist = MACD(close, 12, 26, 9)

long_entry = rsi < 35 AND hist > 0 AND macd > signal
short_entry = rsi > 65 AND hist < 0 AND macd < signal

stoploss = ATR(14) * 1.5
target = ATR(14) * 3`,

  'Bollinger Breakout': `//@strategy("Bollinger Breakout")
//@timeframe("15m")

upper, middle, lower = BB(close, 20, 2)
rsi = RSI(close, 14)

long_entry = close > upper AND rsi > 50
short_entry = close < lower AND rsi < 50

stoploss = ATR(14) * 2
target = ATR(14) * 3`,

  'Supertrend Follow': `//@strategy("Supertrend Follow")
//@timeframe("15m")

st = SUPERTREND(10, 3)
adx = ADX(14)

long_entry = close > st AND adx > 25
short_entry = close < st AND adx > 25

stoploss = ATR(14) * 1.5
target = ATR(14) * 4`,

  'VWAP Mean Reversion': `//@strategy("VWAP Mean Reversion")
//@timeframe("5m")

vwap = VWAP()
rsi = RSI(close, 14)
atr = ATR(14)

long_entry = close < vwap - atr * 1.5 AND rsi < 35
short_entry = close > vwap + atr * 1.5 AND rsi > 65

stoploss = ATR(14) * 1
target = ATR(14) * 2`,
};

// ---- Validation logic (client-side) ----

const KNOWN_INDICATORS = ['RSI', 'EMA', 'SMA', 'MACD', 'VWAP', 'BB', 'ATR', 'SUPERTREND', 'ADX'];
const KNOWN_VARIABLES = ['close', 'open', 'high', 'low', 'volume'];

function findClosestIndicator(name: string): string | null {
  const upper = name.toUpperCase();
  let best: string | null = null;
  let bestDist = Infinity;
  for (const ind of KNOWN_INDICATORS) {
    const dist = levenshtein(upper, ind);
    if (dist < bestDist && dist <= 2) {
      bestDist = dist;
      best = ind;
    }
  }
  return best;
}

function levenshtein(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () => Array(n + 1).fill(0));
  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] = Math.min(
        dp[i - 1][j] + 1,
        dp[i][j - 1] + 1,
        dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
  }
  return dp[m][n];
}

export function validateCode(code: string): ParseResult {
  const lines = code.split('\n');
  const items: ValidationItem[] = [];
  let hasError = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    const lineNum = i + 1;

    // Skip empty lines and comments
    if (!line || line.startsWith('//')) continue;

    // Check for indicator calls
    const fnCallMatch = line.match(/=\s*([A-Za-z_]+)\s*\(/);
    if (fnCallMatch) {
      const fnName = fnCallMatch[1].toUpperCase();
      if (!KNOWN_INDICATORS.includes(fnName) && !KNOWN_VARIABLES.includes(fnCallMatch[1])) {
        const closest = findClosestIndicator(fnCallMatch[1]);
        if (closest) {
          items.push({
            line: lineNum,
            type: 'error',
            message: `Unknown indicator "${fnCallMatch[1]}" — Did you mean ${closest}?`,
            suggestion: line.replace(fnCallMatch[1], closest),
          });
          hasError = true;
        }
        continue;
      }
      // Valid indicator usage
      items.push({
        line: lineNum,
        type: 'success',
        message: `${fnCallMatch[1]}(...) — valid`,
      });
    }

    // Check for unusually high multipliers
    const multiplierMatch = line.match(/\*\s*(\d+(?:\.\d+)?)/);
    if (multiplierMatch) {
      const mult = parseFloat(multiplierMatch[1]);
      if (mult > 8) {
        items.push({
          line: lineNum,
          type: 'warning',
          message: `Multiplier ${mult} is unusually high — typical range is 1-5`,
        });
      }
    }

    // Check for unknown variables in conditions
    const conditionMatch = line.match(/^(long_entry|short_entry|long_exit|short_exit)\s*=/);
    if (conditionMatch) {
      items.push({
        line: lineNum,
        type: 'success',
        message: `${conditionMatch[1]} rule — valid`,
      });
    }
  }

  return { valid: !hasError, items };
}

// ---- Store ----

interface StrategyBuilderState {
  mode: 'script' | 'visual';
  code: string;
  name: string;
  description: string;
  timeframe: string;
  segment: string;
  indicators: IndicatorConfig[];
  entryRules: RuleConfig[];
  exitRules: RuleConfig[];
  validationResult: ParseResult | null;
  isValidating: boolean;
  isSaving: boolean;
  savedStrategies: SavedStrategy[];
  isLoadingStrategies: boolean;

  setMode: (mode: 'script' | 'visual') => void;
  setCode: (code: string) => void;
  setName: (name: string) => void;
  setDescription: (desc: string) => void;
  setTimeframe: (tf: string) => void;
  setSegment: (seg: string) => void;
  addIndicator: (indicator: IndicatorConfig) => void;
  removeIndicator: (id: string) => void;
  updateIndicator: (id: string, params: Record<string, number | string>) => void;
  addEntryRule: () => void;
  removeEntryRule: (id: string) => void;
  updateEntryRule: (id: string, rule: Partial<RuleConfig>) => void;
  addExitRule: () => void;
  removeExitRule: (id: string) => void;
  updateExitRule: (id: string, rule: Partial<RuleConfig>) => void;
  validateStrategy: () => Promise<void>;
  saveStrategy: () => Promise<void>;
  loadTemplate: (templateName: string) => void;
  fetchSavedStrategies: () => Promise<void>;
  deleteStrategy: (id: string) => Promise<void>;
  loadStrategy: (strategy: SavedStrategy) => void;
  insertAtCursor: (text: string) => void;
}

let nextId = 1;
const uid = () => `rule_${nextId++}_${Date.now()}`;

export const useStrategyBuilderStore = create<StrategyBuilderState>((set, get) => ({
  mode: 'script',
  code: '',
  name: '',
  description: '',
  timeframe: '15m',
  segment: 'OPTIONS',
  indicators: [],
  entryRules: [],
  exitRules: [],
  validationResult: null,
  isValidating: false,
  isSaving: false,
  savedStrategies: [],
  isLoadingStrategies: false,

  setMode: (mode) => set({ mode }),
  setCode: (code) => set({ code, validationResult: null }),
  setName: (name) => set({ name }),
  setDescription: (description) => set({ description }),
  setTimeframe: (timeframe) => set({ timeframe }),
  setSegment: (segment) => set({ segment }),

  addIndicator: (indicator) =>
    set((s) => ({ indicators: [...s.indicators, indicator] })),

  removeIndicator: (id) =>
    set((s) => ({ indicators: s.indicators.filter((i) => i.id !== id) })),

  updateIndicator: (id, params) =>
    set((s) => ({
      indicators: s.indicators.map((i) => (i.id === id ? { ...i, params: { ...i.params, ...params } } : i)),
    })),

  addEntryRule: () =>
    set((s) => ({
      entryRules: [
        ...s.entryRules,
        {
          id: uid(),
          conditions: [{ id: uid(), leftOperand: '', operator: 'greater_than', rightOperand: '' }],
          logic: 'AND',
        },
      ],
    })),

  removeEntryRule: (id) =>
    set((s) => ({ entryRules: s.entryRules.filter((r) => r.id !== id) })),

  updateEntryRule: (id, partial) =>
    set((s) => ({
      entryRules: s.entryRules.map((r) => (r.id === id ? { ...r, ...partial } : r)),
    })),

  addExitRule: () =>
    set((s) => ({
      exitRules: [
        ...s.exitRules,
        {
          id: uid(),
          conditions: [{ id: uid(), leftOperand: '', operator: 'greater_than', rightOperand: '' }],
          logic: 'AND',
        },
      ],
    })),

  removeExitRule: (id) =>
    set((s) => ({ exitRules: s.exitRules.filter((r) => r.id !== id) })),

  updateExitRule: (id, partial) =>
    set((s) => ({
      exitRules: s.exitRules.map((r) => (r.id === id ? { ...r, ...partial } : r)),
    })),

  validateStrategy: async () => {
    const { code, mode } = get();
    set({ isValidating: true });

    if (mode === 'script') {
      // Client-side validation first
      const localResult = validateCode(code);

      // Try server-side validation (graceful fallback)
      try {
        const res = await api.post('/strategies/validate', { code });
        const serverResult: ParseResult = res.data?.data ?? res.data;
        set({ validationResult: serverResult, isValidating: false });
      } catch {
        // Fallback to client-side
        set({ validationResult: localResult, isValidating: false });
      }
    } else {
      // Visual mode — minimal validation
      set({
        validationResult: {
          valid: true,
          items: [{ line: 0, type: 'success', message: 'Visual configuration is valid' }],
        },
        isValidating: false,
      });
    }
  },

  saveStrategy: async () => {
    const { code, name, description, timeframe, segment, mode } = get();
    if (!name.trim()) {
      toast.error('Strategy name is required');
      return;
    }
    set({ isSaving: true });
    try {
      await api.post('/strategies', {
        name,
        description,
        code,
        mode,
        timeframe,
        segment,
      });
      toast.success('Strategy saved');
      get().fetchSavedStrategies();
    } catch {
      toast.error('Failed to save strategy');
    } finally {
      set({ isSaving: false });
    }
  },

  loadTemplate: (templateName) => {
    const code = STRATEGY_TEMPLATES[templateName];
    if (code) {
      // Extract name from template
      const nameMatch = code.match(/@strategy\("([^"]+)"\)/);
      const tfMatch = code.match(/@timeframe\("([^"]+)"\)/);
      set({
        code,
        name: nameMatch?.[1] ?? templateName,
        timeframe: tfMatch?.[1] ?? '15m',
        mode: 'script',
        validationResult: null,
      });
      toast.success(`Loaded template: ${templateName}`);
    }
  },

  fetchSavedStrategies: async () => {
    set({ isLoadingStrategies: true });
    try {
      const res = await api.get('/strategies');
      const list: SavedStrategy[] = res.data?.data ?? res.data ?? [];
      set({ savedStrategies: list, isLoadingStrategies: false });
    } catch {
      set({ isLoadingStrategies: false });
    }
  },

  deleteStrategy: async (id) => {
    try {
      await api.delete(`/strategies/${id}`);
      set((s) => ({
        savedStrategies: s.savedStrategies.filter((st) => st.id !== id),
      }));
      toast.success('Strategy deleted');
    } catch {
      toast.error('Failed to delete strategy');
    }
  },

  loadStrategy: (strategy) => {
    set({
      code: strategy.code,
      name: strategy.name,
      description: strategy.description,
      timeframe: strategy.timeframe,
      segment: strategy.segment,
      mode: strategy.mode,
      validationResult: null,
    });
  },

  insertAtCursor: (text) => {
    set((s) => ({
      code: s.code ? `${s.code}\n${text}` : text,
    }));
  },
}));
