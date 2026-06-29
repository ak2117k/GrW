import { useState, useEffect, useCallback } from 'react';
import { cn } from '@/utils/cn';
import { OrderSide, OrderType, PositionType, ENTRY_TAG_OPTIONS } from '@/types';
import { useTradeStore } from '@/stores/trade-store';
import { useSettingsStore } from '@/stores/settings-store';
import { AutoTradeMode } from '@/types';
import api from '@/services/api';
import { Search, AlertTriangle, Loader2, ShieldAlert } from 'lucide-react';
import ConfirmLiveTradeModal, { type LiveTradeSummary } from './ConfirmLiveTradeModal';
import { useInstrumentQuote } from '@/hooks/useInstrumentQuote';
import {
  estimatedValue as calcOrderValue,
  maxAffordable,
  riskReward,
} from './order-ticket/order-math';
import PriceHeader from './order-ticket/PriceHeader';
import CapitalStrip from './order-ticket/CapitalStrip';
import RiskRewardBar from './order-ticket/RiskRewardBar';
import QuantityField from './order-ticket/QuantityField';

export interface OrderTicketProps {
  /** Called after a successful submit (paper) or confirmed live submit. */
  onSubmitted?: () => void;
  /** Pre-fill the symbol search (e.g. clicking a position to add/exit). Optional. */
  initialSymbol?: string;
  /** Visual density: 'modal' (default) keeps current spacing; 'panel' for the page. */
  variant?: 'modal' | 'panel';
}

interface Instrument {
  symbol: string;
  token: string;
  exchange: string;
  name: string;
}

type TradeMode = 'paper' | 'live';

export default function OrderTicket({
  onSubmitted,
  initialSymbol,
  variant = 'modal',
}: OrderTicketProps) {
  const executeTrade = useTradeStore((s) => s.executeTrade);
  const riskStatus = useTradeStore((s) => s.riskStatus);
  const settings = useSettingsStore((s) => s.settings);
  const defaultsToPaper =
    settings.autoTradeMode === AutoTradeMode.PAPER_TRADING || settings.paperTrading;

  const [symbol, setSymbol] = useState('');
  const [selectedInstrument, setSelectedInstrument] = useState<Instrument | null>(null);
  const [suggestions, setSuggestions] = useState<Instrument[]>([]);
  const [showSuggestions, setShowSuggestions] = useState(false);
  const [side, setSide] = useState<OrderSide>(OrderSide.BUY);
  const [orderType, setOrderType] = useState<OrderType>(OrderType.MARKET);
  const [quantity, setQuantity] = useState<number>(1);
  const [price, setPrice] = useState<number>(0);
  const [triggerPrice, setTriggerPrice] = useState<number>(0);
  const [positionType, setPositionType] = useState<PositionType>(PositionType.INTRADAY);
  const [stoploss, setStoploss] = useState<string>('');
  const [target, setTarget] = useState<string>('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [searchTimer, setSearchTimer] = useState<ReturnType<typeof setTimeout> | null>(null);
  // M5: capture trader rationale + tag chips at entry so the journal
  // can correlate outcomes back to the *intent* behind each trade.
  const [entryReason, setEntryReason] = useState('');
  const [entryTags, setEntryTags] = useState<string[]>([]);
  // Paper | Live segmented control — rendered explicitly so the trader always
  // sees the mode. Defaults to the global paper setting (paper-safe default).
  const [mode, setMode] = useState<TradeMode>(defaultsToPaper ? 'paper' : 'live');
  const [showLiveConfirm, setShowLiveConfirm] = useState(false);

  const needsPrice = orderType === OrderType.LIMIT || orderType === OrderType.STOPLOSS;
  const needsTrigger = orderType === OrderType.STOPLOSS || orderType === OrderType.STOPLOSS_MARKET;

  // Live quote for the selected instrument (polls every 3s; unwraps the
  // /instruments/:token/quote envelope). Replaces the old dead /ltp/:sym call.
  const quote = useInstrumentQuote(
    selectedInstrument?.token ?? null,
    selectedInstrument?.exchange ?? null,
  );
  const ltp = quote.ltp;

  // MARKET orders fill at LTP; LIMIT/SL use the entered price.
  const entryPrice = needsPrice ? price : ltp;
  const estimatedValue = calcOrderValue(quantity, entryPrice);
  const remainingCapital = Math.max(0, riskStatus.capitalLimit - riskStatus.capitalDeployed);
  const affordableQty = maxAffordable(remainingCapital, entryPrice);
  const rr = riskReward({
    entry: entryPrice,
    sl: stoploss ? Number(stoploss) : undefined,
    target: target ? Number(target) : undefined,
    qty: quantity,
    side,
  });
  const showRiskReward = Boolean(stoploss || target);

  // Search instruments
  const searchInstruments = useCallback(async (query: string) => {
    if (query.length < 2) {
      setSuggestions([]);
      return;
    }
    try {
      // The endpoint returns a wrapper `{ instruments, count, source }`, not a
      // bare array — unwrap it. (Reading it as Instrument[] silently set
      // suggestions to the object, whose `.length` is undefined, so the
      // dropdown never rendered.)
      const { data } = await api.get<{ instruments: Instrument[] }>('/market-data/instruments', {
        params: { search: query },
      });
      setSuggestions(data.instruments ?? []);
      setShowSuggestions(true);
    } catch {
      setSuggestions([]);
    }
  }, []);

  const handleSymbolChange = (value: string) => {
    setSymbol(value);
    setSelectedInstrument(null);
    if (searchTimer) clearTimeout(searchTimer);
    const timer = setTimeout(() => searchInstruments(value), 300);
    setSearchTimer(timer);
  };

  const selectInstrument = (instrument: Instrument) => {
    setSymbol(instrument.symbol);
    setSelectedInstrument(instrument);
    setShowSuggestions(false);
    setSuggestions([]);
    // LTP now flows from useInstrumentQuote once selectedInstrument.token is set.
  };

  // Pre-fill the symbol search from initialSymbol and trigger instrument search
  // on mount so the page caller can deep-link a symbol.
  useEffect(() => {
    if (initialSymbol && initialSymbol.length >= 2) {
      setSymbol(initialSymbol);
      searchInstruments(initialSymbol);
    }
    // Only run on mount / when the prop changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialSymbol]);

  // Keep mode in sync if the global default flips while mounted (e.g. settings
  // load completes after first render).
  useEffect(() => {
    setMode(defaultsToPaper ? 'paper' : 'live');
  }, [defaultsToPaper]);

  const resetForm = () => {
    setSymbol('');
    setSelectedInstrument(null);
    setSuggestions([]);
    setShowSuggestions(false);
    setSide(OrderSide.BUY);
    setOrderType(OrderType.MARKET);
    setQuantity(1);
    setPrice(0);
    setTriggerPrice(0);
    setPositionType(PositionType.INTRADAY);
    setStoploss('');
    setTarget('');
    setEntryReason('');
    setEntryTags([]);
  };

  const submitOrder = async (isPaper: boolean) => {
    if (!selectedInstrument || quantity <= 0) return;
    setIsSubmitting(true);
    try {
      await executeTrade({
        symbol: selectedInstrument.symbol,
        token: selectedInstrument.token,
        exchange: selectedInstrument.exchange,
        side,
        orderType,
        quantity,
        price: needsPrice ? price : undefined,
        triggerPrice: needsTrigger ? triggerPrice : undefined,
        positionType,
        stoploss: stoploss ? Number(stoploss) : undefined,
        target: target ? Number(target) : undefined,
        entryReason: entryReason.trim() || undefined,
        entryTags: entryTags.length > 0 ? entryTags : undefined,
        isPaper,
      });
      resetForm();
      onSubmitted?.();
    } catch {
      // error handled in store
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleSubmit = () => {
    if (!selectedInstrument || quantity <= 0 || isSubmitting) return;
    if (mode === 'live') {
      // Live orders require an explicit confirmation step before they touch
      // real money.
      setShowLiveConfirm(true);
      return;
    }
    void submitOrder(true);
  };

  const handleConfirmLive = () => {
    setShowLiveConfirm(false);
    void submitOrder(false);
  };

  const isBuy = side === OrderSide.BUY;
  const isLive = mode === 'live';
  const spacing = variant === 'panel' ? 'space-y-3' : 'space-y-4';

  const liveSummary: LiveTradeSummary = {
    side,
    quantity,
    symbol: selectedInstrument?.symbol ?? symbol,
    orderType,
    estimatedValue,
    stoploss: stoploss ? Number(stoploss) : undefined,
    target: target ? Number(target) : undefined,
  };

  return (
    <div className={spacing}>
      {/* Paper | Live segmented toggle */}
      <div>
        <label className="block text-xs font-medium text-gray-400 mb-1">Mode</label>
        <div className="flex rounded-md overflow-hidden border border-gray-700">
          {(['paper', 'live'] as TradeMode[]).map((m) => {
            const active = mode === m;
            const isLiveOpt = m === 'live';
            return (
              <button
                key={m}
                type="button"
                onClick={() => setMode(m)}
                className={cn(
                  'flex-1 py-2 text-sm font-medium transition-colors flex items-center justify-center gap-1.5',
                  active
                    ? isLiveOpt
                      ? 'bg-red-500/20 text-red-400'
                      : 'bg-amber-500/15 text-amber-300'
                    : 'text-gray-400 hover:bg-gray-700',
                )}
              >
                {isLiveOpt && <ShieldAlert size={13} />}
                {isLiveOpt ? 'Live' : 'Paper'}
              </button>
            );
          })}
        </div>
      </div>

      {/* Mode indicator */}
      {isLive ? (
        <div className="flex items-center gap-2 rounded-md border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-300">
          <ShieldAlert size={14} className="text-red-400" />
          <span className="font-semibold text-red-400">LIVE mode</span> — this order places
          REAL money and requires confirmation.
        </div>
      ) : (
        <div className="flex items-center gap-2 rounded-md bg-amber-500/10 border border-amber-500/20 px-3 py-2 text-xs text-amber-400">
          <AlertTriangle size={14} />
          Paper Trading Mode — this trade will be simulated
        </div>
      )}

      {/* Symbol search */}
      <div className="relative">
        <label className="block text-xs font-medium text-gray-400 mb-1">Symbol</label>
        <div className="relative">
          <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-500" />
          <input
            type="text"
            value={symbol}
            onChange={(e) => handleSymbolChange(e.target.value)}
            onFocus={() => suggestions.length > 0 && setShowSuggestions(true)}
            placeholder="Search symbol..."
            className="w-full rounded-md border border-gray-700 bg-gray-800 py-2 pl-9 pr-3 text-sm text-gray-100 placeholder-gray-500 outline-none focus:border-blue-500"
          />
        </div>
        {showSuggestions && suggestions.length > 0 && (
          <div className="absolute z-10 mt-1 w-full max-h-48 overflow-y-auto rounded-md border border-gray-700 bg-gray-800 shadow-lg">
            {suggestions.map((inst) => (
              <button
                key={`${inst.exchange}-${inst.token}`}
                onClick={() => selectInstrument(inst)}
                className="w-full text-left px-3 py-2 text-sm text-gray-200 hover:bg-gray-700 flex items-center justify-between"
              >
                <span className="font-medium">{inst.symbol}</span>
                <span className="text-xs text-gray-500">{inst.exchange}</span>
              </button>
            ))}
          </div>
        )}
      </div>

      {/* Live price header */}
      {selectedInstrument && (
        <PriceHeader
          ltp={ltp}
          change={quote.change}
          changePct={quote.changePct}
          high={quote.high}
          low={quote.low}
          open={quote.open}
          loading={quote.loading}
        />
      )}

      {/* Side toggle */}
      <div>
        <label className="block text-xs font-medium text-gray-400 mb-1">Side</label>
        <div className="flex rounded-md overflow-hidden border border-gray-700">
          {[OrderSide.BUY, OrderSide.SELL].map((s) => (
            <button
              key={s}
              onClick={() => setSide(s)}
              className={cn(
                'flex-1 py-2 text-sm font-medium transition-colors',
                side === s
                  ? s === OrderSide.BUY
                    ? 'bg-emerald-500/20 text-emerald-400'
                    : 'bg-red-500/20 text-red-400'
                  : 'text-gray-400 hover:bg-gray-700',
              )}
            >
              {s}
            </button>
          ))}
        </div>
      </div>

      {/* Order type */}
      <div>
        <label className="block text-xs font-medium text-gray-400 mb-1">Order Type</label>
        <select
          value={orderType}
          onChange={(e) => setOrderType(e.target.value as OrderType)}
          className="w-full rounded-md border border-gray-700 bg-gray-800 py-2 px-3 text-sm text-gray-100 outline-none focus:border-blue-500"
        >
          <option value={OrderType.MARKET}>MARKET</option>
          <option value={OrderType.LIMIT}>LIMIT</option>
          <option value={OrderType.STOPLOSS}>SL</option>
          <option value={OrderType.STOPLOSS_MARKET}>SL-M</option>
        </select>
      </div>

      {/* Quantity */}
      <div>
        <label className="block text-xs font-medium text-gray-400 mb-1">Quantity</label>
        <QuantityField value={quantity} onChange={setQuantity} />
      </div>

      {/* Price + Trigger row */}
      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className="block text-xs font-medium text-gray-400 mb-1">
            Price {!needsPrice && <span className="text-gray-600">(N/A)</span>}
          </label>
          <input
            type="number"
            min={0}
            step={0.05}
            value={price}
            onChange={(e) => setPrice(parseFloat(e.target.value) || 0)}
            disabled={!needsPrice}
            className={cn(
              'w-full rounded-md border border-gray-700 bg-gray-800 py-2 px-3 text-sm text-gray-100 outline-none focus:border-blue-500',
              !needsPrice && 'opacity-40 cursor-not-allowed',
            )}
          />
        </div>
        <div>
          <label className="block text-xs font-medium text-gray-400 mb-1">
            Trigger {!needsTrigger && <span className="text-gray-600">(N/A)</span>}
          </label>
          <input
            type="number"
            min={0}
            step={0.05}
            value={triggerPrice}
            onChange={(e) => setTriggerPrice(parseFloat(e.target.value) || 0)}
            disabled={!needsTrigger}
            className={cn(
              'w-full rounded-md border border-gray-700 bg-gray-800 py-2 px-3 text-sm text-gray-100 outline-none focus:border-blue-500',
              !needsTrigger && 'opacity-40 cursor-not-allowed',
            )}
          />
        </div>
      </div>

      {/* Position type toggle */}
      <div>
        <label className="block text-xs font-medium text-gray-400 mb-1">Position Type</label>
        <div className="flex rounded-md overflow-hidden border border-gray-700">
          {[PositionType.INTRADAY, PositionType.DELIVERY].map((pt) => (
            <button
              key={pt}
              onClick={() => setPositionType(pt)}
              className={cn(
                'flex-1 py-2 text-sm font-medium transition-colors',
                positionType === pt
                  ? 'bg-blue-500/20 text-blue-400'
                  : 'text-gray-400 hover:bg-gray-700',
              )}
            >
              {pt}
            </button>
          ))}
        </div>
      </div>

      {/* SL / Target */}
      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className="block text-xs font-medium text-gray-400 mb-1">Stoploss (optional)</label>
          <input
            type="number"
            min={0}
            step={0.05}
            value={stoploss}
            onChange={(e) => setStoploss(e.target.value)}
            placeholder="--"
            className="w-full rounded-md border border-gray-700 bg-gray-800 py-2 px-3 text-sm text-gray-100 placeholder-gray-600 outline-none focus:border-blue-500"
          />
        </div>
        <div>
          <label className="block text-xs font-medium text-gray-400 mb-1">Target (optional)</label>
          <input
            type="number"
            min={0}
            step={0.05}
            value={target}
            onChange={(e) => setTarget(e.target.value)}
            placeholder="--"
            className="w-full rounded-md border border-gray-700 bg-gray-800 py-2 px-3 text-sm text-gray-100 placeholder-gray-600 outline-none focus:border-blue-500"
          />
        </div>
      </div>

      {/* M5: Why this trade — free-text rationale + tag chips */}
      <div>
        <label className="block text-xs font-medium text-gray-400 mb-1">
          Why this trade?
        </label>
        <textarea
          value={entryReason}
          onChange={(e) => setEntryReason(e.target.value)}
          placeholder="What's your edge here? (free text)"
          rows={2}
          className="w-full rounded-md border border-gray-700 bg-gray-800 py-2 px-3 text-sm text-gray-100 placeholder-gray-500 outline-none focus:border-blue-500 resize-none"
        />
        <div className="mt-2 flex flex-wrap gap-1.5">
          {ENTRY_TAG_OPTIONS.map((tag) => {
            const active = entryTags.includes(tag.value);
            return (
              <button
                key={tag.value}
                type="button"
                onClick={() =>
                  setEntryTags((prev) =>
                    prev.includes(tag.value)
                      ? prev.filter((t) => t !== tag.value)
                      : [...prev, tag.value],
                  )
                }
                className={cn(
                  'rounded-full border px-2.5 py-0.5 text-[11px] transition-colors',
                  active
                    ? 'border-blue-500 bg-blue-500/15 text-blue-300'
                    : 'border-gray-700 bg-gray-800 text-gray-400 hover:border-gray-600',
                )}
              >
                {tag.label}
              </button>
            );
          })}
        </div>
      </div>

      {/* Capital usage + affordability */}
      <CapitalStrip
        orderValue={estimatedValue}
        capitalLimit={riskStatus.capitalLimit}
        capitalDeployed={riskStatus.capitalDeployed}
        maxAffordable={affordableQty}
      />

      {/* Risk / reward (only when SL or target is set) */}
      {showRiskReward && (
        <RiskRewardBar
          riskAmt={rr.riskAmt}
          rewardAmt={rr.rewardAmt}
          rr={rr.rr}
          slPct={rr.slPct}
          tgtPct={rr.tgtPct}
        />
      )}

      {/* Submit */}
      <button
        onClick={handleSubmit}
        disabled={!selectedInstrument || quantity <= 0 || isSubmitting}
        className={cn(
          'w-full py-2.5 rounded-md text-sm font-semibold transition-colors flex items-center justify-center gap-2',
          isLive
            ? 'bg-red-600 hover:bg-red-500 text-white ring-1 ring-red-400/60'
            : isBuy
              ? 'bg-emerald-600 hover:bg-emerald-500 text-white'
              : 'bg-red-600 hover:bg-red-500 text-white',
          (!selectedInstrument || isSubmitting) && 'opacity-50 cursor-not-allowed',
        )}
      >
        {isSubmitting ? <Loader2 size={16} className="animate-spin" /> : null}
        {isLive && !isSubmitting && (
          <span className="rounded bg-white/20 px-1.5 py-0.5 text-[10px] font-bold tracking-wide">
            LIVE
          </span>
        )}
        {isSubmitting
          ? 'Executing...'
          : `${side} ${selectedInstrument?.symbol || symbol || 'Select Symbol'}`}
      </button>

      {/* Live confirmation */}
      <ConfirmLiveTradeModal
        isOpen={showLiveConfirm}
        onClose={() => setShowLiveConfirm(false)}
        onConfirm={handleConfirmLive}
        summary={liveSummary}
      />
    </div>
  );
}
