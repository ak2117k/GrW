import { Loader2 } from 'lucide-react';

/**
 * Full-page loading fallback shown while lazy-loaded page chunks download.
 * Used as the Suspense fallback in AppLayout.
 */
export default function PageFallback() {
  return (
    <div className="flex h-[calc(100vh-8rem)] items-center justify-center">
      <div className="flex flex-col items-center gap-3">
        <div className="relative">
          <div className="h-10 w-10 rounded-full border-2 border-gray-700" />
          <Loader2
            size={40}
            className="absolute inset-0 animate-spin text-blue-500"
          />
        </div>
        <span className="text-sm text-gray-500">Loading...</span>
      </div>
    </div>
  );
}
