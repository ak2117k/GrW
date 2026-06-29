import type { MarketDepthLevel } from '@td/shared';
import { useMarketDepth } from '@/hooks/useMarketDepth';
import { Card } from './_shared';

interface Props {
  token: string;
  exchange: string;
}

/**
 * Card 3: Market depth ladder. Two columns — bids on the left, asks on the
 * right — each up to 5 levels with price / qty / orders. Footer shows the
 * cumulative qty per side.
 *
 * Empty / null states:
 *   - First fetch in flight → "Loading depth..."
 *   - Endpoint returned `{ depth: null }` (market closed, token not
 *     subscribable, SmartAPI call failed, etc.) → "Depth unavailable"
 */
export default function MarketDepthCard({ token, exchange }: Props) {
  const { depth, loading } = useMarketDepth(token, exchange);

  return (
    <Card title="Market Depth">
      {!depth && loading && <p className="text-sm text-zinc-500">Loading depth...</p>}
      {!depth && !loading && <p className="text-sm text-zinc-500">Depth unavailable.</p>}
      {depth && (
        <div className="grid grid-cols-2 gap-4">
          <DepthLadder side="BID" levels={depth.bids} total={depth.totalBidQty} />
          <DepthLadder side="ASK" levels={depth.asks} total={depth.totalAskQty} />
        </div>
      )}
    </Card>
  );
}

function DepthLadder({
  side,
  levels,
  total,
}: {
  side: 'BID' | 'ASK';
  levels: MarketDepthLevel[];
  total: number;
}) {
  const tone = side === 'BID' ? 'text-emerald-400' : 'text-red-400';
  return (
    <div>
      <div className={`text-xs font-semibold mb-2 ${tone}`}>{side}</div>
      <table className="w-full text-xs">
        <thead className="text-zinc-500">
          <tr>
            <th className="text-left font-normal pb-1">Price</th>
            <th className="text-right font-normal pb-1">Qty</th>
            <th className="text-right font-normal pb-1">Orders</th>
          </tr>
        </thead>
        <tbody>
          {levels.length === 0 && (
            <tr>
              <td colSpan={3} className="py-1 text-zinc-600 italic">No {side.toLowerCase()}s</td>
            </tr>
          )}
          {levels.map((l, i) => (
            <tr key={i}>
              <td className={`tabular-nums ${tone}`}>{l.price.toFixed(2)}</td>
              <td className="text-right tabular-nums text-zinc-300">{l.qty.toLocaleString('en-IN')}</td>
              <td className="text-right tabular-nums text-zinc-500">{l.orders}</td>
            </tr>
          ))}
        </tbody>
        <tfoot className="text-zinc-400 border-t border-zinc-700/60">
          <tr>
            <td className="pt-1 text-[10px] uppercase tracking-wider text-zinc-500">Total</td>
            <td className="pt-1 text-right tabular-nums" colSpan={2}>
              {total.toLocaleString('en-IN')}
            </td>
          </tr>
        </tfoot>
      </table>
    </div>
  );
}
