import { create } from 'zustand';

export interface SelectedSymbol {
  symbol: string;
  token: string;
  exchange: string;
  name: string;
}

export interface IndicatorState {
  ema20: boolean;
  ema50: boolean;
  ema200: boolean;
  rsi: boolean;
  bollinger: boolean;
  vwap: boolean;
  oi: boolean;
  volume: boolean;
}

interface ChartState {
  selectedSymbol: SelectedSymbol;
  timeframe: string;
  indicators: IndicatorState;
  isFullscreen: boolean;
  chartType: 'candlestick' | 'line' | 'area';

  setSymbol: (symbol: SelectedSymbol) => void;
  setTimeframe: (timeframe: string) => void;
  toggleIndicator: (key: keyof IndicatorState) => void;
  toggleFullscreen: () => void;
  setChartType: (type: 'candlestick' | 'line' | 'area') => void;
}

export const useChartStore = create<ChartState>((set) => ({
  selectedSymbol: {
    symbol: 'NIFTY',
    token: '99926000',
    exchange: 'NSE',
    name: 'NIFTY 50',
  },
  timeframe: '15m',
  indicators: {
    ema20: false,
    ema50: false,
    ema200: false,
    rsi: false,
    bollinger: false,
    vwap: false,
    oi: false,
    volume: true,
  },
  isFullscreen: false,
  chartType: 'candlestick',

  setSymbol: (symbol) => set({ selectedSymbol: symbol }),

  setTimeframe: (timeframe) => set({ timeframe }),

  toggleIndicator: (key) =>
    set((state) => ({
      indicators: {
        ...state.indicators,
        [key]: !state.indicators[key],
      },
    })),

  toggleFullscreen: () => set((state) => ({ isFullscreen: !state.isFullscreen })),

  setChartType: (chartType) => set({ chartType }),
}));
