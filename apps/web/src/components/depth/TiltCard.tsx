import { useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { computeTilt } from './tilt';

interface TiltCardProps {
  children: ReactNode;
  className?: string;
  style?: CSSProperties;
  maxTiltDeg?: number;
}

const prefersReducedMotion = () =>
  typeof window !== 'undefined' &&
  window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

/** A pointer-tracked 3D-tilt wrapper. Pure CSS transforms; no-op when the user
 *  prefers reduced motion. Wrap depth content (a .depth-card) as children. */
export function TiltCard({ children, className, style, maxTiltDeg = 8 }: TiltCardProps) {
  const ref = useRef<HTMLDivElement>(null);
  const [t, setT] = useState({ rotateX: 0, rotateY: 0 });

  const onMove = (e: React.MouseEvent) => {
    if (prefersReducedMotion() || !ref.current) return;
    const r = ref.current.getBoundingClientRect();
    setT(computeTilt((e.clientX - r.left) / r.width, (e.clientY - r.top) / r.height, maxTiltDeg));
  };
  const reset = () => setT({ rotateX: 0, rotateY: 0 });

  return (
    <div
      ref={ref}
      onMouseMove={onMove}
      onMouseLeave={reset}
      style={{ perspective: 'var(--depth-perspective)', ...style }}
      className={className}
    >
      <div
        style={{
          transform: `rotateX(${t.rotateX}deg) rotateY(${t.rotateY}deg)`,
          transition: 'transform 0.15s ease-out',
          transformStyle: 'preserve-3d',
        }}
      >
        {children}
      </div>
    </div>
  );
}
