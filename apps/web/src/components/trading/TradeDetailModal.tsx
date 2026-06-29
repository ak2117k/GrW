import { useState, useCallback } from 'react';
import { Clock, Target, Shield, FileText, X } from 'lucide-react';
import { Modal, Badge, PnLDisplay } from '@/components/common';
import { cn } from '@/utils/cn';
import { formatINR } from '@td/shared';
import type { Trade } from '@/types';
import api from '@/services/api';
import toast from 'react-hot-toast';

interface TradeDetailModalProps {
  trade: Trade | null;
  isOpen: boolean;
  onClose: () => void;
  onTradeUpdated?: () => void;
  // M5: parent (JournalPage) handles the structured exit-reason picker.
  // Nesting ExitTradeModal inside this Modal caused both Modal effects
  // to fight over the body-scroll lock + ESC handler, so the picker
  // is rendered as a sibling at the JournalPage level instead.
  onRequestExit?: () => void;
}

function formatDateTime(d: Date | string | undefined): string {
  if (!d) return '--';
  const date = typeof d === 'string' ? new Date(d) : d;
  return date.toLocaleString('en-IN', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function computeDuration(
  start: Date | string | undefined,
  end: Date | string | undefined,
): string {
  if (!start) return '--';
  const s = typeof start === 'string' ? new Date(start) : start;
  const e = end ? (typeof end === 'string' ? new Date(end) : end) : new Date();
  const diff = e.getTime() - s.getTime();
  if (diff < 0) return '--';
  const mins = Math.floor(diff / 60000);
  if (mins < 60) return `${mins}m`;
  const hrs = Math.floor(mins / 60);
  const remMin = mins % 60;
  if (hrs < 24) return `${hrs}h ${remMin}m`;
  const days = Math.floor(hrs / 24);
  return `${days}d ${hrs % 24}h`;
}

function statusVariant(
  status: string,
): 'success' | 'danger' | 'warning' | 'info' | 'neutral' {
  switch (status) {
    case 'OPEN':
    case 'PARTIALLY_FILLED':
      return 'info';
    case 'FILLED':
    case 'CLOSED':
      return 'success';
    case 'CANCELLED':
      return 'warning';
    case 'REJECTED':
      return 'danger';
    default:
      return 'neutral';
  }
}

function sideVariant(side: string): 'success' | 'danger' {
  return side === 'BUY' ? 'success' : 'danger';
}

function InfoRow({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex justify-between items-center py-1.5 border-b border-gray-700/40 last:border-0">
      <span className="text-xs text-gray-400">{label}</span>
      <span className="text-xs font-medium text-gray-200">{value}</span>
    </div>
  );
}

export default function TradeDetailModal({
  trade,
  isOpen,
  onClose,
  onTradeUpdated: _onTradeUpdated,
  onRequestExit,
}: TradeDetailModalProps) {
  const [notes, setNotes] = useState('');
  const [isSavingNotes, setIsSavingNotes] = useState(false);

  const handleSaveNotes = useCallback(async () => {
    if (!trade) return;
    setIsSavingNotes(true);
    try {
      await api.put(`/trades/${trade.id}`, { notes });
      toast.success('Notes saved');
    } catch {
      toast.error('Failed to save notes');
    } finally {
      setIsSavingNotes(false);
    }
  }, [trade, notes]);

  if (!trade) return null;

  const isOpen_ =
    trade.status === 'OPEN' || trade.status === 'PARTIALLY_FILLED';
  const fees = Math.abs(trade.pnl) * 0.01; // Estimated fees placeholder
  const netPnl = trade.pnl - fees;
  const rrActual =
    trade.stoploss && trade.exitPrice
      ? Math.abs(trade.exitPrice - trade.entryPrice) /
        Math.abs(trade.entryPrice - trade.stoploss)
      : null;

  return (
    <Modal isOpen={isOpen} onClose={onClose} size="lg">
      <div className="space-y-5">
        {/* Header */}
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div>
              <div className="flex items-center gap-2">
                <h2 className="text-lg font-semibold text-gray-100">
                  {trade.symbol}
                </h2>
                <span className="text-xs text-gray-500">{trade.exchange}</span>
              </div>
              <div className="flex items-center gap-2 mt-1">
                <Badge label={trade.side} variant={sideVariant(trade.side)} size="sm" />
                <Badge
                  label={trade.status}
                  variant={statusVariant(trade.status)}
                  size="sm"
                />
                {trade.isPaper && (
                  <Badge label="PAPER" variant="warning" size="sm" />
                )}
              </div>
            </div>
          </div>
          <button
            onClick={onClose}
            className="text-gray-500 hover:text-gray-300 transition-colors"
          >
            <X size={18} />
          </button>
        </div>

        {/* Trade Info Grid */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div className="rounded-lg border border-gray-700/60 bg-gray-800/40 p-3">
            <h3 className="text-xs font-medium text-gray-400 uppercase tracking-wide mb-2">
              Trade Info
            </h3>
            <InfoRow label="Entry Price" value={formatINR(trade.entryPrice)} />
            <InfoRow
              label="Exit Price"
              value={trade.exitPrice ? formatINR(trade.exitPrice) : '--'}
            />
            <InfoRow label="Quantity" value={trade.quantity.toString()} />
            <InfoRow label="Order Type" value={trade.orderType} />
            <InfoRow label="Position Type" value={trade.positionType} />
          </div>

          {/* P&L Section */}
          <div className="rounded-lg border border-gray-700/60 bg-gray-800/40 p-3">
            <h3 className="text-xs font-medium text-gray-400 uppercase tracking-wide mb-2">
              Profit & Loss
            </h3>
            <div className="flex items-center justify-between py-1.5 border-b border-gray-700/40">
              <span className="text-xs text-gray-400">P&L</span>
              <PnLDisplay value={trade.pnl} percent={trade.pnlPercent} size="sm" />
            </div>
            <InfoRow label="Est. Fees" value={formatINR(fees)} />
            <div className="flex items-center justify-between py-1.5">
              <span className="text-xs text-gray-400">Net P&L</span>
              <span
                className={cn(
                  'text-xs font-semibold',
                  netPnl >= 0 ? 'text-emerald-400' : 'text-red-400',
                )}
              >
                {formatINR(netPnl)}
              </span>
            </div>
          </div>
        </div>

        {/* Timing */}
        <div className="rounded-lg border border-gray-700/60 bg-gray-800/40 p-3">
          <div className="flex items-center gap-1.5 mb-2">
            <Clock size={14} className="text-gray-500" />
            <h3 className="text-xs font-medium text-gray-400 uppercase tracking-wide">
              Timing
            </h3>
          </div>
          <div className="grid grid-cols-3 gap-3">
            <div>
              <span className="text-[10px] text-gray-500">Entry Time</span>
              <p className="text-xs text-gray-200">
                {formatDateTime(trade.createdAt)}
              </p>
            </div>
            <div>
              <span className="text-[10px] text-gray-500">Exit Time</span>
              <p className="text-xs text-gray-200">
                {formatDateTime(trade.closedAt)}
              </p>
            </div>
            <div>
              <span className="text-[10px] text-gray-500">Duration</span>
              <p className="text-xs text-gray-200">
                {computeDuration(trade.createdAt, trade.closedAt)}
              </p>
            </div>
          </div>
        </div>

        {/* Strategy & Risk */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {/* Strategy */}
          <div className="rounded-lg border border-gray-700/60 bg-gray-800/40 p-3">
            <div className="flex items-center gap-1.5 mb-2">
              <Target size={14} className="text-gray-500" />
              <h3 className="text-xs font-medium text-gray-400 uppercase tracking-wide">
                Strategy
              </h3>
            </div>
            <InfoRow
              label="Strategy"
              value={
                trade.strategy
                  ? trade.strategy
                      .split('-')
                      .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
                      .join(' ')
                  : '--'
              }
            />
          </div>

          {/* Risk */}
          <div className="rounded-lg border border-gray-700/60 bg-gray-800/40 p-3">
            <div className="flex items-center gap-1.5 mb-2">
              <Shield size={14} className="text-gray-500" />
              <h3 className="text-xs font-medium text-gray-400 uppercase tracking-wide">
                Risk
              </h3>
            </div>
            <InfoRow
              label="Stop Loss"
              value={trade.stoploss ? formatINR(trade.stoploss) : '--'}
            />
            <InfoRow
              label="Target"
              value={trade.target ? formatINR(trade.target) : '--'}
            />
            <InfoRow
              label="Actual R:R"
              value={rrActual !== null ? `1:${rrActual.toFixed(2)}` : '--'}
            />
          </div>
        </div>

        {/* M5: Market context at entry. Show the block when ANY context
            field is populated — the trader's reason + tag chips are valuable
            on their own even if VIX / PCR fetches happened to fail at entry. */}
        {(trade.vixAtEntry != null ||
          trade.pcrAtEntry != null ||
          trade.spotAtEntry != null ||
          trade.adRatioAtEntry != null ||
          trade.maxPainAtEntry != null ||
          (trade.entryReason && trade.entryReason.trim().length > 0) ||
          (trade.entryTags && trade.entryTags.length > 0)) && (
          <div className="rounded-lg border border-gray-700/60 bg-gray-800/40 p-3">
            <h3 className="text-xs font-medium text-gray-400 uppercase tracking-wide mb-2">
              Market Context @ Entry
            </h3>
            <div className="grid grid-cols-2 md:grid-cols-3 gap-3 text-xs">
              <div>
                <span className="text-[10px] text-gray-500">Spot</span>
                <p className="text-gray-200">
                  {trade.spotAtEntry != null ? trade.spotAtEntry.toFixed(2) : '--'}
                </p>
              </div>
              <div>
                <span className="text-[10px] text-gray-500">VIX</span>
                <p className="text-gray-200">
                  {trade.vixAtEntry != null ? trade.vixAtEntry.toFixed(2) : '--'}{' '}
                  <span className="text-[10px] text-gray-500">
                    ({trade.vixRegimeAtEntry ?? 'UNKNOWN'})
                  </span>
                </p>
              </div>
              <div>
                <span className="text-[10px] text-gray-500">PCR</span>
                <p className="text-gray-200">
                  {trade.pcrAtEntry != null ? trade.pcrAtEntry.toFixed(2) : '--'}
                </p>
              </div>
              <div>
                <span className="text-[10px] text-gray-500">Max Pain</span>
                <p className="text-gray-200">
                  {trade.maxPainAtEntry != null ? trade.maxPainAtEntry.toFixed(2) : '--'}
                </p>
              </div>
              <div>
                <span className="text-[10px] text-gray-500">A/D</span>
                <p className="text-gray-200">
                  {trade.adRatioAtEntry != null ? trade.adRatioAtEntry.toFixed(2) : '--'}
                </p>
              </div>
            </div>
            {trade.entryReason && (
              <div className="mt-3 pt-3 border-t border-gray-700/40">
                <span className="text-[10px] text-gray-500 uppercase tracking-wide">
                  Why this trade
                </span>
                <p className="text-xs text-gray-200 mt-1">{trade.entryReason}</p>
              </div>
            )}
            {trade.entryTags && trade.entryTags.length > 0 && (
              <div className="mt-2 flex flex-wrap gap-1">
                {trade.entryTags.map((t) => (
                  <span
                    key={t}
                    className="rounded-full border border-blue-500/30 bg-blue-500/10 px-2 py-0.5 text-[10px] text-blue-300"
                  >
                    {t}
                  </span>
                ))}
              </div>
            )}
          </div>
        )}

        {/* M5: Exit reason (closed trades only) */}
        {trade.exitReasonTag && (
          <div className="rounded-lg border border-gray-700/60 bg-gray-800/40 p-3">
            <h3 className="text-xs font-medium text-gray-400 uppercase tracking-wide mb-2">
              Exit Reason
            </h3>
            <p className="text-xs text-gray-200">
              {trade.exitReasonTag.replace(/_/g, ' ')}
            </p>
            {trade.exitNotes && (
              <p className="text-xs text-gray-400 mt-1">{trade.exitNotes}</p>
            )}
          </div>
        )}

        {/* Notes */}
        <div className="rounded-lg border border-gray-700/60 bg-gray-800/40 p-3">
          <div className="flex items-center gap-1.5 mb-2">
            <FileText size={14} className="text-gray-500" />
            <h3 className="text-xs font-medium text-gray-400 uppercase tracking-wide">
              Notes
            </h3>
          </div>
          <textarea
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            placeholder="Add your trade notes here..."
            rows={3}
            className="w-full rounded-md border border-gray-700 bg-gray-900/50 px-3 py-2 text-xs text-gray-200 placeholder-gray-600 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500/40 resize-none"
          />
          <button
            onClick={handleSaveNotes}
            disabled={isSavingNotes}
            className="mt-2 rounded-md bg-blue-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-blue-500 transition-colors disabled:opacity-50"
          >
            {isSavingNotes ? 'Saving...' : 'Save Notes'}
          </button>
        </div>

        {/* Actions */}
        {isOpen_ && (
          <div className="flex justify-end pt-2 border-t border-gray-700/60">
            <button
              onClick={() => onRequestExit?.()}
              disabled={!onRequestExit}
              className="rounded-md bg-red-600 px-4 py-2 text-xs font-medium text-white hover:bg-red-500 transition-colors disabled:opacity-50"
            >
              Close Trade
            </button>
          </div>
        )}
      </div>
    </Modal>
  );
}
