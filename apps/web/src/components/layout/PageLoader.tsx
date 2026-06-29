import { useEffect, useState } from 'react';
import { useLocation } from 'react-router-dom';
import { cn } from '@/utils/cn';

/**
 * Global page transition loader.
 * Shows a top progress bar on route changes and a subtle content fade.
 */
export default function PageLoader() {
  const location = useLocation();
  const [loading, setLoading] = useState(false);
  const [progress, setProgress] = useState(0);

  useEffect(() => {
    // Start loading on every route change
    setLoading(true);
    setProgress(20);

    const t1 = setTimeout(() => setProgress(60), 100);
    const t2 = setTimeout(() => setProgress(90), 300);
    const t3 = setTimeout(() => {
      setProgress(100);
      setTimeout(() => setLoading(false), 200);
    }, 500);

    return () => {
      clearTimeout(t1);
      clearTimeout(t2);
      clearTimeout(t3);
    };
  }, [location.pathname]);

  if (!loading && progress === 0) return null;

  return (
    <>
      {/* Top progress bar */}
      <div className="fixed top-0 left-0 right-0 z-50 h-[2px]">
        <div
          className={cn(
            'h-full bg-gradient-to-r from-blue-500 via-blue-400 to-cyan-400 transition-all duration-300 ease-out',
            progress >= 100 && 'opacity-0 transition-opacity duration-300',
          )}
          style={{ width: `${progress}%` }}
        />
        {/* Glow effect */}
        {loading && (
          <div
            className="absolute right-0 top-0 h-[2px] w-24 bg-gradient-to-l from-cyan-400/80 to-transparent animate-pulse"
            style={{ right: `${100 - progress}%` }}
          />
        )}
      </div>
    </>
  );
}
