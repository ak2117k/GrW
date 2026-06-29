import { cn } from '@/utils/cn';
import { useSettingsStore } from '@/stores/settings-store';
import { AutoTradeMode } from '@/types';
import api from '@/services/api';
import toast from 'react-hot-toast';
import { Bot, AlertTriangle } from 'lucide-react';
import { useState } from 'react';

const modes = [
  { value: AutoTradeMode.OFF, label: 'OFF', color: 'gray' },
  { value: AutoTradeMode.PAPER_TRADING, label: 'PAPER TRADING', color: 'amber' },
  { value: AutoTradeMode.APPROVAL_REQUIRED, label: 'APPROVAL REQUIRED', color: 'blue' },
  { value: AutoTradeMode.FULLY_AUTOMATIC, label: 'FULLY AUTOMATIC', color: 'emerald' },
] as const;

export default function AutoTradeControls() {
  const settings = useSettingsStore((s) => s.settings);
  const updateSettings = useSettingsStore((s) => s.updateSettings);
  const [showWarning, setShowWarning] = useState(false);
  const [pendingMode, setPendingMode] = useState<AutoTradeMode | null>(null);

  const currentMode = settings.autoTradeMode;
  const isPaper = currentMode === AutoTradeMode.PAPER_TRADING || settings.paperTrading;

  const handleModeChange = async (mode: AutoTradeMode) => {
    if (mode === currentMode) return;

    // If switching to fully automatic, show warning first
    if (mode === AutoTradeMode.FULLY_AUTOMATIC) {
      setPendingMode(mode);
      setShowWarning(true);
      return;
    }

    await applyMode(mode);
  };

  const applyMode = async (mode: AutoTradeMode) => {
    try {
      await api.put('/settings', { autoTradeMode: mode });
      updateSettings({ autoTradeMode: mode });
      toast.success(`Auto-trade mode: ${mode.replace(/_/g, ' ')}`);
    } catch {
      toast.error('Failed to update auto-trade mode');
    }
    setShowWarning(false);
    setPendingMode(null);
  };

  const confirmAutomatic = () => {
    if (pendingMode) applyMode(pendingMode);
  };

  const cancelWarning = () => {
    setShowWarning(false);
    setPendingMode(null);
  };

  const getActiveStyle = (mode: typeof modes[number]) => {
    if (currentMode !== mode.value) return '';
    switch (mode.color) {
      case 'amber':
        return 'bg-amber-500/20 text-amber-400 border-amber-500/50';
      case 'blue':
        return 'bg-blue-500/20 text-blue-400 border-blue-500/50';
      case 'emerald':
        return 'bg-emerald-500/20 text-emerald-400 border-emerald-500/50';
      default:
        return 'bg-gray-600/20 text-gray-300 border-gray-500/50';
    }
  };

  return (
    <div className="relative flex items-center gap-3">
      <Bot size={20} className="text-[var(--color-accent-blue)] shrink-0" />

      <div className="flex rounded-lg border border-[var(--color-border-subtle)] overflow-hidden bg-[var(--color-bg-secondary)]">
        {modes.map((mode) => (
          <button
            key={mode.value}
            onClick={() => handleModeChange(mode.value)}
            className={cn(
              'px-3 py-2 text-xs font-medium transition-all border-r border-[var(--color-border-subtle)] last:border-r-0',
              currentMode === mode.value
                ? getActiveStyle(mode)
                : 'text-[var(--color-text-muted)] hover:text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-tertiary)]',
            )}
          >
            {mode.label}
          </button>
        ))}
      </div>

      {isPaper && (
        <span className="text-[10px] font-bold px-2 py-0.5 rounded bg-amber-500/15 text-amber-400 border border-amber-500/30">
          PAPER
        </span>
      )}

      {currentMode !== AutoTradeMode.OFF && currentMode !== AutoTradeMode.PAPER_TRADING && !isPaper && (
        <span className="text-[10px] font-bold px-2 py-0.5 rounded bg-emerald-500/15 text-emerald-400 border border-emerald-500/30">
          LIVE
        </span>
      )}

      {/* Warning dialog for FULLY_AUTOMATIC */}
      {showWarning && (
        <div className="absolute top-full left-0 mt-2 z-20 w-80 rounded-lg border border-amber-500/40 bg-gray-900 p-4 shadow-xl">
          <div className="flex items-start gap-2 mb-3">
            <AlertTriangle size={18} className="text-amber-400 shrink-0 mt-0.5" />
            <div>
              <p className="text-sm font-medium text-amber-300 mb-1">Enable Fully Automatic?</p>
              <p className="text-xs text-gray-400">
                Trades will execute automatically without your approval. Make sure your risk parameters are properly configured.
              </p>
            </div>
          </div>
          <div className="flex gap-2">
            <button
              onClick={confirmAutomatic}
              className="flex-1 py-1.5 rounded-md text-xs font-bold bg-amber-600 text-white hover:bg-amber-500 transition-colors"
            >
              Enable
            </button>
            <button
              onClick={cancelWarning}
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
