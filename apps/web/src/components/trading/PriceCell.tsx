import { useEffect, useRef, useState } from 'react';

interface PriceCellProps {
  price: number;
  previousPrice?: number;
  format?: 'currency' | 'number' | 'percent';
}

export default function PriceCell({ price, previousPrice, format = 'number' }: PriceCellProps) {
  const [flash, setFlash] = useState<'up' | 'down' | null>(null);
  const prevRef = useRef(previousPrice ?? price);

  useEffect(() => {
    if (price > prevRef.current) {
      setFlash('up');
    } else if (price < prevRef.current) {
      setFlash('down');
    }
    prevRef.current = price;

    const timer = setTimeout(() => setFlash(null), 600);
    return () => clearTimeout(timer);
  }, [price]);

  const formatted = (() => {
    if (format === 'currency') {
      return price.toLocaleString('en-IN', {
        style: 'currency',
        currency: 'INR',
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
      });
    }
    if (format === 'percent') {
      return `${price >= 0 ? '+' : ''}${price.toFixed(2)}%`;
    }
    return price.toLocaleString('en-IN', {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    });
  })();

  return (
    <span
      className={`inline-block rounded px-1 transition-colors duration-500 ${
        flash === 'up'
          ? 'bg-[var(--color-accent-green)]/20 text-[var(--color-accent-green)]'
          : flash === 'down'
            ? 'bg-[var(--color-accent-red)]/20 text-[var(--color-accent-red)]'
            : ''
      }`}
    >
      {formatted}
    </span>
  );
}
