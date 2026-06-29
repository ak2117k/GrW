import { Modal } from '@/components/common';
import { AlertTriangle } from 'lucide-react';

export interface LiveTradeSummary {
  side: string;
  quantity: number;
  symbol: string;
  orderType: string;
  estimatedValue: number;
  stoploss?: number;
  target?: number;
}

interface ConfirmLiveTradeModalProps {
  isOpen: boolean;
  onClose: () => void;
  onConfirm: () => void;
  summary: LiveTradeSummary;
}

function formatINR(value: number): string {
  return value.toLocaleString('en-IN', { style: 'currency', currency: 'INR' });
}

export default function ConfirmLiveTradeModal({
  isOpen,
  onClose,
  onConfirm,
  summary,
}: ConfirmLiveTradeModalProps) {
  const { side, quantity, symbol, orderType, estimatedValue, stoploss, target } = summary;

  // Plain-language one-liner: "BUY 50 RELIANCE-EQ @ MARKET, est. ₹X, SL ₹.. Target ₹.."
  const summaryLine = [
    `${side} ${quantity} ${symbol} @ ${orderType}`,
    `est. ${formatINR(estimatedValue)}`,
    stoploss != null ? `SL ${formatINR(stoploss)}` : null,
    target != null ? `Target ${formatINR(target)}` : null,
  ]
    .filter(Boolean)
    .join(', ');

  return (
    <Modal isOpen={isOpen} onClose={onClose} title="Confirm Live Order" size="sm">
      <div className="space-y-4">
        {/* Real-money warning */}
        <div className="flex items-start gap-2 rounded-md border border-red-500/30 bg-red-500/10 px-3 py-2.5 text-xs text-red-300">
          <AlertTriangle size={16} className="mt-0.5 shrink-0 text-red-400" />
          <span>
            <span className="font-semibold text-red-400">LIVE order — real money.</span>{' '}
            This places an actual order with your broker and can result in real financial
            loss. Review the details below before confirming.
          </span>
        </div>

        {/* Plain-language summary */}
        <div className="rounded-md border border-gray-700/60 bg-gray-800/80 px-3 py-3">
          <div className="text-sm font-medium text-[var(--color-text-primary)]">
            {summaryLine}
          </div>
        </div>

        {/* Actions */}
        <div className="flex items-center gap-2">
          <button
            onClick={onClose}
            className="flex-1 rounded-md border border-gray-700 py-2.5 text-sm font-medium text-gray-300 transition-colors hover:bg-gray-700"
          >
            Cancel
          </button>
          <button
            onClick={onConfirm}
            className="flex-1 rounded-md bg-red-600 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-red-500"
          >
            Confirm Live Order
          </button>
        </div>
      </div>
    </Modal>
  );
}
