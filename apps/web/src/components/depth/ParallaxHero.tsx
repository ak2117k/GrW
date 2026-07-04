import { useRef, type ReactNode } from 'react';

interface ParallaxHeroProps {
  children: ReactNode;
  className?: string;
}

/** Pointer-parallax hero. Children set `data-depth="0.2"` etc.; this maps
 *  pointer position to per-layer translate via inline transform on move.
 *  No-op under prefers-reduced-motion. */
export function ParallaxHero({ children, className }: ParallaxHeroProps) {
  const ref = useRef<HTMLDivElement>(null);

  const onMove = (e: React.MouseEvent) => {
    const el = ref.current;
    if (!el) return;
    if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return;
    const r = el.getBoundingClientRect();
    const dx = (e.clientX - r.left) / r.width - 0.5;
    const dy = (e.clientY - r.top) / r.height - 0.5;
    el.querySelectorAll<HTMLElement>('[data-depth]').forEach((layer) => {
      const depth = Number(layer.dataset.depth ?? 0);
      layer.style.transform = `translate3d(${-dx * depth * 40}px, ${-dy * depth * 40}px, 0)`;
    });
  };
  const reset = () => {
    ref.current?.querySelectorAll<HTMLElement>('[data-depth]').forEach((l) => {
      l.style.transform = 'translate3d(0,0,0)';
    });
  };

  return (
    <div ref={ref} onMouseMove={onMove} onMouseLeave={reset} className={className}>
      {children}
    </div>
  );
}
