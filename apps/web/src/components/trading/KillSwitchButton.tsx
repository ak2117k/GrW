import { useState } from 'react';
import { cn } from '@/utils/cn';
import { useTradeStore } from '@/stores/trade-store';
import { Shield, Loader2 } from 'lucide-react';

export default function KillSwitchButton() {
  const positions = useTradeStore((s) => s.positions);
  const isKillSwitchActive = useTradeStore((s) => s.isKillSwitchActive);
  const closeAllPositions = useTradeStore((s) => s.closeAllPositions);

  const [confirming, setConfirming] = useState(false);
  const [executing, setExecuting] = useState(false);

  const hasPositions = positions.length > 0;

  const handleClick = () => {
    if (!hasPositions) return;
    if (!confirming) {
      setConfirming(true);
      // Auto-dismiss confirmation after 5s
      setTimeout(() => setConfirming(false), 5000);
      return;
    }
    // Confirmed — execute
    handleConfirm();
  };

  const handleConfirm = async () => {
    setExecuting(true);
    setConfirming(false);
    try {
      await closeAllPositions();
    } finally {
      setExecuting(false);
    }
  };

  const handleCancel = (e: React.MouseEvent) => {
    e.stopPropagation();
    setConfirming(false);
  };

  if (isKillSwitchActive) {
    return (
      <div className="flex items-center gap-2 rounded-lg bg-red-500/20 border border-red-500/40 px-4 py-2 text-red-400 text-sm font-medium">
        <Loader2 size={16} className="animate-spin" />
        Kill switch activated...
      </div>
    );
  }

  return (
    <div className="relative">
      <button
        onClick={handleClick}
        disabled={!hasPositions || executing}
        className={cn(
          'flex items-center gap-2 rounded-lg px-4 py-2 text-sm font-bold transition-all',
          'border-2',
          hasPositions
            ? 'bg-red-600/20 border-red-500/60 text-red-400 hover:bg-red-600/30 hover:border-red-500 cursor-pointer'
            : 'bg-gray-800 border-gray-700 text-gray-500 cursor-not-allowed',
          hasPositions && !confirming && 'animate-pulse',
          confirming && 'bg-red-600/40 border-red-500',
        )}
      >
        {executing ? (
          <Loader2 size={18} className="animate-spin" />
        ) : (
          <Shield size={18} />
        )}
        {confirming
          ? 'CONFIRM KILL ALL?'
          : executing
            ? 'Closing...'
            : 'KILL SWITCH'}
      </button>

      {confirming && (
        <div className="absolute top-full right-0 mt-2 z-20 w-72 rounded-lg border border-red-500/40 bg-gray-900 p-3 shadow-xl">
          <p className="text-xs text-red-300 mb-3">
            Are you sure? This will close <strong>ALL {positions.length}</strong> open positions immediately.
          </p>
          <div className="flex gap-2">
            <button
              onClick={handleConfirm}
              className="flex-1 py-1.5 rounded-md text-xs font-bold bg-red-600 text-white hover:bg-red-500 transition-colors"
            >
              Yes, Close All
            </button>
            <button
              onClick={handleCancel}
              className="flex-1 py-1.5 rounded-md text-xs font-medium bg-gray-700 text-gray-300 hover:bg-gray-600 transition-colors"
            >
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
