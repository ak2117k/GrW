import { useEffect, useRef } from 'react';
import { useThemeStore } from '@/stores/theme-store';

function cssVar(name: string, fallback: string): string {
  if (typeof document === 'undefined') return fallback;
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return v || fallback;
}

interface Candle {
  o: number;
  h: number;
  l: number;
  c: number;
}

/** One random-walk step producing a plausible candle from the previous close. */
function nextCandle(prevClose: number, vol: number): Candle {
  const o = prevClose;
  const c = o + (Math.random() - 0.5) * vol * 2;
  const h = Math.max(o, c) + Math.random() * vol;
  const l = Math.min(o, c) - Math.random() * vol;
  return { o, h, l, c };
}

/**
 * The landing hero's "living market": a streaming candlestick tape rendered in
 * cv. Not a stock video — the most characteristic artifact of a trader's
 * world, drawn live. Palette comes from the theme tokens (re-read on toggle);
 * under prefers-reduced-motion it paints a single static frame.
 */
export function MarketCanvas({ className }: { className?: string }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const theme = useThemeStore((s) => s.theme);

  useEffect(() => {
    const canvasEl = canvasRef.current;
    if (!canvasEl) return;
    const context = canvasEl.getContext('2d');
    if (!context) return;
    // Non-null locals so the nested (hoisted) render functions don't lose narrowing.
    const cv: HTMLCanvasElement = canvasEl;
    const g: CanvasRenderingContext2D = context;

    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    const up = cssVar('--color-accent-green', '#12d9a0');
    const down = cssVar('--color-accent-red', '#ff4d6a');
    const lineColor = cssVar('--color-accent-blue', '#22d3ee');
    const gridColor = cssVar('--grid-line', 'rgba(148,163,208,0.06)');
    const labelColor = cssVar('--color-text-muted', '#6a7699');

    const VISIBLE = 56;
    const VOL = 1.15;
    const COMMIT_MS = 1300;

    const candles: Candle[] = [];
    let price = 100;
    for (let i = 0; i < VISIBLE; i++) {
      const cd = nextCandle(price, VOL);
      candles.push(cd);
      price = cd.c;
    }
    let forming = nextCandle(candles[candles.length - 1].c, VOL);

    let width = 0;
    let height = 0;
    // eased vertical range so the scale doesn't jump as candles enter/leave
    let dispMin = 0;
    let dispMax = 0;

    function resize() {
      const parent = cv.parentElement;
      if (!parent) return;
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      width = parent.clientWidth;
      height = parent.clientHeight;
      cv.width = Math.round(width * dpr);
      cv.height = Math.round(height * dpr);
      cv.style.width = `${width}px`;
      cv.style.height = `${height}px`;
      g.setTransform(dpr, 0, 0, dpr, 0, 0);
    }
    resize();
    const ro = new ResizeObserver(resize);
    if (cv.parentElement) ro.observe(cv.parentElement);

    function draw(t: number) {
      const all = candles.concat([lerpCandle(forming, t)]);
      const pad = 28;
      const tMin = Math.min(...all.map((c) => c.l));
      const tMax = Math.max(...all.map((c) => c.h));
      // ease toward target range (or snap on first frame)
      dispMin = dispMin ? dispMin + (tMin - dispMin) * 0.08 : tMin;
      dispMax = dispMax ? dispMax + (tMax - dispMax) * 0.08 : tMax;
      const range = dispMax - dispMin || 1;
      const y = (v: number) => pad + (1 - (v - dispMin) / range) * (height - pad * 2);
      const cw = width / (VISIBLE + 1);
      const bw = Math.max(2, cw * 0.56);
      const offset = -cw * t; // continuous leftward scroll

      g.clearRect(0, 0, width, height);

      // hairline grid
      g.strokeStyle = gridColor;
      g.lineWidth = 1;
      for (let gi = 0; gi <= 4; gi++) {
        const gy = pad + (gi / 4) * (height - pad * 2);
        g.beginPath();
        g.moveTo(0, gy + 0.5);
        g.lineTo(width, gy + 0.5);
        g.stroke();
      }

      // candles
      all.forEach((cd, i) => {
        const x = i * cw + cw / 2 + offset;
        const bull = cd.c >= cd.o;
        g.strokeStyle = bull ? up : down;
        g.fillStyle = bull ? up : down;
        g.globalAlpha = 0.92;
        g.beginPath();
        g.moveTo(x, y(cd.h));
        g.lineTo(x, y(cd.l));
        g.stroke();
        const yo = y(cd.o);
        const yc = y(cd.c);
        const top = Math.min(yo, yc);
        const bh = Math.max(1.5, Math.abs(yc - yo));
        g.fillRect(x - bw / 2, top, bw, bh);
      });
      g.globalAlpha = 1;

      // last-price line + glowing marker + mono label
      const lastY = y(all[all.length - 1].c);
      g.strokeStyle = lineColor;
      g.globalAlpha = 0.5;
      g.setLineDash([4, 5]);
      g.beginPath();
      g.moveTo(0, lastY);
      g.lineTo(width, lastY);
      g.stroke();
      g.setLineDash([]);
      g.globalAlpha = 1;

      const lastX = VISIBLE * cw + cw / 2 + offset;
      g.fillStyle = lineColor;
      g.shadowColor = lineColor;
      g.shadowBlur = 14;
      g.beginPath();
      g.arc(lastX, lastY, 3.5, 0, Math.PI * 2);
      g.fill();
      g.shadowBlur = 0;

      g.fillStyle = labelColor;
      g.font = '11px ui-monospace, "SF Mono", Menlo, monospace';
      g.textAlign = 'right';
      g.fillText(all[all.length - 1].c.toFixed(2), width - 8, Math.max(12, lastY - 8));
    }

    // Interpolate the forming candle so it "unfolds" from its open over t.
    function lerpCandle(target: Candle, t: number): Candle {
      const e = t * t * (3 - 2 * t); // smoothstep
      return {
        o: target.o,
        c: target.o + (target.c - target.o) * e,
        h: target.o + (target.h - target.o) * e,
        l: target.o + (target.l - target.o) * e,
      };
    }

    if (reduced) {
      draw(1);
      return () => ro.disconnect();
    }

    let raf = 0;
    let lastTs = 0;
    let acc = 0;
    function frame(ts: number) {
      if (!lastTs) lastTs = ts;
      acc += ts - lastTs;
      lastTs = ts;
      if (acc >= COMMIT_MS) {
        candles.push(forming);
        candles.shift();
        forming = nextCandle(candles[candles.length - 1].c, VOL);
        acc = 0;
      }
      draw(Math.min(1, acc / COMMIT_MS));
      raf = requestAnimationFrame(frame);
    }
    raf = requestAnimationFrame(frame);

    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
    };
  }, [theme]);

  return <canvas ref={canvasRef} className={className} aria-hidden="true" />;
}
