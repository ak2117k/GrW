import { describe, it, expect } from 'vitest';
import { hitTestDrawing, type DrawingScreen } from './hitTest';

const TOLERANCE = 4;

describe('hitTest', () => {
  describe('hline', () => {
    const drawing: DrawingScreen = { kind: 'hline', id: 'a', y: 100 };

    it('hits within tolerance', () => {
      expect(hitTestDrawing(drawing, { x: 50, y: 102 }, TOLERANCE)).toBe(true);
      expect(hitTestDrawing(drawing, { x: 50, y: 100 }, TOLERANCE)).toBe(true);
    });

    it('misses outside tolerance', () => {
      expect(hitTestDrawing(drawing, { x: 50, y: 105 }, TOLERANCE)).toBe(false);
    });
  });

  describe('hzone', () => {
    const drawing: DrawingScreen = { kind: 'hzone', id: 'a', yUpper: 100, yLower: 200 };

    it('hits inside the band', () => {
      expect(hitTestDrawing(drawing, { x: 50, y: 150 }, TOLERANCE)).toBe(true);
    });

    it('hits on the edges within tolerance', () => {
      expect(hitTestDrawing(drawing, { x: 50, y: 98 }, TOLERANCE)).toBe(true);
      expect(hitTestDrawing(drawing, { x: 50, y: 202 }, TOLERANCE)).toBe(true);
    });

    it('misses outside the band beyond tolerance', () => {
      expect(hitTestDrawing(drawing, { x: 50, y: 95 }, TOLERANCE)).toBe(false);
      expect(hitTestDrawing(drawing, { x: 50, y: 205 }, TOLERANCE)).toBe(false);
    });
  });

  describe('trend', () => {
    const drawing: DrawingScreen = {
      kind: 'trend', id: 'a',
      p1: { x: 0, y: 0 },
      p2: { x: 100, y: 100 },
    };

    it('hits on the line', () => {
      expect(hitTestDrawing(drawing, { x: 50, y: 50 }, TOLERANCE)).toBe(true);
    });

    it('misses perpendicular distance beyond tolerance', () => {
      expect(hitTestDrawing(drawing, { x: 50, y: 56 }, TOLERANCE)).toBe(false);
    });

    it('hits perpendicular distance within tolerance', () => {
      expect(hitTestDrawing(drawing, { x: 50, y: 53 }, TOLERANCE)).toBe(true);
    });

    it('does not hit beyond the segment endpoints', () => {
      expect(hitTestDrawing(drawing, { x: -10, y: -10 }, TOLERANCE)).toBe(false);
      expect(hitTestDrawing(drawing, { x: 110, y: 110 }, TOLERANCE)).toBe(false);
    });

    it('handles zero-length segment as a point', () => {
      const zero: DrawingScreen = {
        kind: 'trend', id: 'b',
        p1: { x: 50, y: 50 }, p2: { x: 50, y: 50 },
      };
      expect(hitTestDrawing(zero, { x: 52, y: 51 }, TOLERANCE)).toBe(true);
      expect(hitTestDrawing(zero, { x: 60, y: 60 }, TOLERANCE)).toBe(false);
    });
  });

  describe('vline', () => {
    const drawing: DrawingScreen = { kind: 'vline', id: 'a', x: 100 };

    it('hits within tolerance', () => {
      expect(hitTestDrawing(drawing, { x: 102, y: 50 }, TOLERANCE)).toBe(true);
    });

    it('misses outside tolerance', () => {
      expect(hitTestDrawing(drawing, { x: 105, y: 50 }, TOLERANCE)).toBe(false);
    });
  });

  describe('rect', () => {
    const drawing: DrawingScreen = {
      kind: 'rect', id: 'a',
      p1: { x: 10, y: 10 }, p2: { x: 100, y: 200 },
    };

    it('hits inside', () => {
      expect(hitTestDrawing(drawing, { x: 50, y: 100 }, TOLERANCE)).toBe(true);
    });

    it('hits on edges within tolerance', () => {
      expect(hitTestDrawing(drawing, { x: 8, y: 100 }, TOLERANCE)).toBe(true);
    });

    it('misses outside beyond tolerance', () => {
      expect(hitTestDrawing(drawing, { x: 5, y: 100 }, TOLERANCE)).toBe(false);
      expect(hitTestDrawing(drawing, { x: 200, y: 100 }, TOLERANCE)).toBe(false);
    });

    it('handles rectangle drawn right-to-left (negative width)', () => {
      const reversed: DrawingScreen = {
        kind: 'rect', id: 'b',
        p1: { x: 100, y: 10 }, p2: { x: 10, y: 200 },
      };
      expect(hitTestDrawing(reversed, { x: 50, y: 100 }, TOLERANCE)).toBe(true);
    });
  });

  describe('fib', () => {
    const drawing: DrawingScreen = {
      kind: 'fib', id: 'a',
      levelYs: [100, 120, 140, 160, 180, 195, 200],
    };

    it('hits on any level line within tolerance', () => {
      expect(hitTestDrawing(drawing, { x: 50, y: 102 }, TOLERANCE)).toBe(true);
      expect(hitTestDrawing(drawing, { x: 50, y: 161 }, TOLERANCE)).toBe(true);
    });

    it('misses between levels', () => {
      expect(hitTestDrawing(drawing, { x: 50, y: 110 }, TOLERANCE)).toBe(false);
    });
  });

  describe('text', () => {
    const drawing: DrawingScreen = {
      kind: 'text', id: 'a',
      anchor: { x: 50, y: 100 },
      width: 80, height: 16,
    };

    it('hits inside the text box', () => {
      expect(hitTestDrawing(drawing, { x: 80, y: 108 }, TOLERANCE)).toBe(true);
    });

    it('misses outside the text box', () => {
      expect(hitTestDrawing(drawing, { x: 200, y: 100 }, TOLERANCE)).toBe(false);
    });
  });

  describe('arrow', () => {
    const drawing: DrawingScreen = {
      kind: 'arrow', id: 'a',
      p1: { x: 0, y: 0 }, p2: { x: 100, y: 0 },
    };

    it('hits on the shaft', () => {
      expect(hitTestDrawing(drawing, { x: 50, y: 2 }, TOLERANCE)).toBe(true);
    });

    it('misses off the shaft', () => {
      expect(hitTestDrawing(drawing, { x: 50, y: 10 }, TOLERANCE)).toBe(false);
    });
  });
});
