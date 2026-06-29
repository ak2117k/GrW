import { Loader2 } from 'lucide-react';

interface PageLoadingOverlayProps {
  isLoading: boolean;
  message?: string;
}

/**
 * Full-content loading overlay shown while page data is being fetched.
 * Renders a centered spinner over the page content area.
 * Once loading is done, the overlay unmounts and reveals the content.
 */
export function PageLoadingOverlay({ isLoading, message }: PageLoadingOverlayProps) {
  if (!isLoading) return null;

  return (
    <div className="flex h-[60vh] items-center justify-center">
      <div className="flex flex-col items-center gap-3">
        <Loader2
          size={32}
          className="animate-spin text-[var(--color-accent-blue)]"
        />
        <span className="text-sm text-[var(--color-text-muted)]">
          {message ?? 'Loading...'}
        </span>
      </div>
    </div>
  );
}
