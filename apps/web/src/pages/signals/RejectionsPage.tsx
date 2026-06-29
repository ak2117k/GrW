import { Ban } from 'lucide-react';
import RejectionsTab from './RejectionsTab';

/**
 * Top-level page wrapper for the Rejections analysis view. RejectionsTab is
 * self-contained (own data hook, date filter, summary + table) — this wrapper
 * only adds the standard page header so it matches the other routed pages.
 */
export default function RejectionsPage() {
  return (
    <div className="space-y-5">
      {/* Header */}
      <div className="flex items-center gap-3">
        <div className="rounded-lg bg-amber-500/10 p-2">
          <Ban size={22} className="text-amber-400" />
        </div>
        <div>
          <h1 className="text-xl font-bold text-gray-100">Rejections</h1>
          <p className="text-xs text-gray-500">
            Why scanned Chartink stocks did not become trades
          </p>
        </div>
      </div>

      <RejectionsTab />
    </div>
  );
}
