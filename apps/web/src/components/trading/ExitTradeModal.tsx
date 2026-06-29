import { useState, useEffect, useCallback } from 'react';
import { Modal } from '@/components/common';
import { cn } from '@/utils/cn';
import { EXIT_REASON_OPTIONS, type ExitReasonTag } from '@/types';
import api from '@/services/api';
import toast from 'react-hot-toast';
import { Loader2 } from 'lucide-react';

interface ExitTradeModalProps {
  tradeId: string | null;
  isOpen: boolean;
  onClose: () => void;
  onClosed?: () => void;
}

/**
 * M5 — Structured exit-reason picker.
 *
 * Why a separate modal: the most important field for journal analysis is
 * *why* a trade was closed (target hit vs panic vs reversal) — pushing the
 * close action through a dedicated picker forces the trader to record that
 * reason instead of bypassing it via a one-click button.
 */
export default function ExitTradeModal({
  tradeId,
  isOpen,
  onClose,
  onClosed,
}: ExitTradeModalProps) {
  const [exitReasonTag, setExitReasonTag] = useState<ExitReasonTag | ''>('');
  const [exitNotes, setExitNotes] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);

  useEffect(() => {
    if (isOpen) {
      setExitReasonTag('');
      setExitNotes('');
      setIsSubmitting(false);
    }
  }, [isOpen]);

  const handleConfirm = useCallback(async () => {
    if (!tradeId || !exitReasonTag) return;
    setIsSubmitting(true);
    try {
      await api.post(`/trades/${tradeId}/close`, {
        exitReasonTag,
        exitNotes: exitNotes.trim() || undefined,
      });
      toast.success('Trade closed');
      onClosed?.();
      onClose();
    } catch (err) {
      console.error('ExitTradeModal: close failed', err);
      toast.error('Failed to close trade');
    } finally {
      setIsSubmitting(false);
    }
  }, [tradeId, exitReasonTag, exitNotes, onClose, onClosed]);

  // M5: prevent ESC / backdrop from dismissing the modal mid-POST — the
  // success toast would otherwise fire on an unmounted component.
  const handleClose = useCallback(() => {
    if (isSubmitting) return;
    onClose();
  }, [isSubmitting, onClose]);

  return (
    <Modal isOpen={isOpen} onClose={handleClose} title="Close Trade" size="md">
      <div className="space-y-4">
        <p className="text-xs text-gray-400">
          What actually happened? This is the most important field for journal
          analysis.
        </p>

        {/* Reason tag chips */}
        <div>
          <label className="block text-xs font-medium text-gray-400 mb-1.5">
            Exit reason
          </label>
          <div className="grid grid-cols-2 gap-1.5">
            {EXIT_REASON_OPTIONS.map((opt) => {
              const active = exitReasonTag === opt.value;
              return (
                <button
                  key={opt.value}
                  type="button"
                  onClick={() => setExitReasonTag(opt.value)}
                  className={cn(
                    'rounded-md border px-2.5 py-1.5 text-xs text-left transition-colors',
                    active
                      ? 'border-blue-500 bg-blue-500/15 text-blue-300'
                      : 'border-gray-700 bg-gray-800 text-gray-400 hover:border-gray-600',
                  )}
                >
                  {opt.label}
                </button>
              );
            })}
          </div>
        </div>

        {/* Optional notes */}
        <div>
          <label className="block text-xs font-medium text-gray-400 mb-1">
            Exit notes (optional)
          </label>
          <textarea
            value={exitNotes}
            onChange={(e) => setExitNotes(e.target.value)}
            placeholder="Anything you want to remember about how this exit played out?"
            rows={3}
            className="w-full rounded-md border border-gray-700 bg-gray-800 py-2 px-3 text-sm text-gray-100 placeholder-gray-500 outline-none focus:border-blue-500 resize-none"
          />
        </div>

        {/* Confirm button */}
        <button
          onClick={handleConfirm}
          disabled={!exitReasonTag || isSubmitting}
          className={cn(
            'w-full py-2.5 rounded-md text-sm font-semibold transition-colors flex items-center justify-center gap-2',
            'bg-red-600 hover:bg-red-500 text-white',
            (!exitReasonTag || isSubmitting) && 'opacity-50 cursor-not-allowed',
          )}
        >
          {isSubmitting ? <Loader2 size={16} className="animate-spin" /> : null}
          {isSubmitting ? 'Closing...' : 'Confirm Close'}
        </button>
      </div>
    </Modal>
  );
}
