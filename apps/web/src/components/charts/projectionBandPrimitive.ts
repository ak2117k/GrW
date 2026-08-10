import type { ISeriesApi, ISeriesPrimitive, SeriesAttachedParameter, Time } from 'lightweight-charts';
import type { ProjectionBand } from './projectionBoxView';

/**
 * Paints the projection bands as FILLED rectangles.
 *
 * Why a series primitive and not price lines: `createPriceLine` draws a
 * horizontal line and nothing else, so a band built from lines is two edges
 * with empty chart between them. The projection is the TRAVEL — the filled
 * area from the broken level to where the move is expected to end — and an
 * unfilled pair of lines does not read as one object.
 *
 * The band spans the full plot width rather than a time window. A projection
 * has no natural right edge (it is "from here until it gets there"), and
 * inventing one would assert a horizon the engine never computed.
 */
export class ProjectionBandPrimitive implements ISeriesPrimitive<Time> {
  private bands: ProjectionBand[] = [];
  private series: ISeriesApi<'Candlestick'> | null = null;
  private requestUpdate?: () => void;

  private readonly paneView = {
    renderer: () => ({
      draw: (target: {
        useBitmapCoordinateSpace: (
          cb: (scope: {
            context: CanvasRenderingContext2D;
            bitmapSize: { width: number; height: number };
            horizontalPixelRatio: number;
            verticalPixelRatio: number;
          }) => void,
        ) => void;
      }) => {
        const series = this.series;
        if (!series || this.bands.length === 0) return;

        target.useBitmapCoordinateSpace(({ context: ctx, bitmapSize, verticalPixelRatio }) => {
          for (const band of this.bands) {
            // A disposed series throws rather than returning null, and this
            // runs on every frame — one throw here would break the whole chart
            // render, not just the band.
            let y1: number | null = null;
            let y2: number | null = null;
            try {
              y1 = series.priceToCoordinate(band.from);
              y2 = series.priceToCoordinate(band.to);
            } catch {
              return;
            }
            if (y1 === null || y2 === null) continue;

            const top = Math.min(y1, y2) * verticalPixelRatio;
            const bottom = Math.max(y1, y2) * verticalPixelRatio;
            const height = bottom - top;
            if (!(height > 0)) continue;

            ctx.save();
            ctx.fillStyle = band.fill;
            ctx.fillRect(0, top, bitmapSize.width, height);

            ctx.strokeStyle = band.border;
            ctx.lineWidth = Math.max(1, verticalPixelRatio);
            // Armed projections are dashed, confirmed ones solid — the same
            // distinction the card makes, so the two cannot disagree about
            // whether a break has been accepted.
            ctx.setLineDash(band.dashed ? [6 * verticalPixelRatio, 4 * verticalPixelRatio] : []);
            ctx.beginPath();
            ctx.moveTo(0, top);
            ctx.lineTo(bitmapSize.width, top);
            ctx.moveTo(0, bottom);
            ctx.lineTo(bitmapSize.width, bottom);
            ctx.stroke();

            // The direction arrow: break level on the left, target on the
            // right, arrowhead at the target. Two horizontal edges say
            // "somewhere in here"; the arrow is what makes the band read as a
            // MOVE. Drawn from the band's own endpoints, so it can never point
            // somewhere the box does not claim.
            if (band.arrow) {
              const yStart = y1 * verticalPixelRatio;
              const yEnd = y2 * verticalPixelRatio;
              const xStart = bitmapSize.width * 0.08;
              const xEnd = bitmapSize.width * 0.92;

              ctx.beginPath();
              ctx.moveTo(xStart, yStart);
              ctx.lineTo(xEnd, yEnd);
              ctx.stroke();

              // Arrowhead, rotated along the line so it points at the target
              // regardless of how steep the projection is.
              const angle = Math.atan2(yEnd - yStart, xEnd - xStart);
              const head = 10 * verticalPixelRatio;
              ctx.setLineDash([]);
              ctx.beginPath();
              ctx.moveTo(xEnd, yEnd);
              ctx.lineTo(
                xEnd - head * Math.cos(angle - Math.PI / 7),
                yEnd - head * Math.sin(angle - Math.PI / 7),
              );
              ctx.moveTo(xEnd, yEnd);
              ctx.lineTo(
                xEnd - head * Math.cos(angle + Math.PI / 7),
                yEnd - head * Math.sin(angle + Math.PI / 7),
              );
              ctx.stroke();
            }
            ctx.restore();
          }
        });
      },
    }),
    zOrder: () => 'bottom' as const,
  };

  attached(param: SeriesAttachedParameter<Time>): void {
    this.series = param.series as ISeriesApi<'Candlestick'>;
    this.requestUpdate = param.requestUpdate;
  }

  detached(): void {
    this.series = null;
    this.requestUpdate = undefined;
  }

  paneViews() {
    return [this.paneView];
  }

  /** Replace the drawn bands and ask the chart for a repaint. */
  setBands(bands: ProjectionBand[]): void {
    this.bands = Array.isArray(bands) ? bands : [];
    this.requestUpdate?.();
  }
}
