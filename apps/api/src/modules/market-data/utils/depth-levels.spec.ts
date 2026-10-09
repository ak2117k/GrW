import { depthFromFullQuote, depthFromSnapQuote } from './depth-levels';

describe('depthFromSnapQuote (WebSocketV2 SNAP_QUOTE)', () => {
  it('maps the best-five arrays from paise to rupees, keeping at most five levels and dropping empty ones', () => {
    const tick = {
      best_5_buy_data: [
        { flag: 1, quantity: 75, price: 25005, no_of_orders: 3 },
        { flag: 1, quantity: 150, price: 25000, no_of_orders: 5 },
        { flag: 1, quantity: 0, price: 0, no_of_orders: 0 },
      ],
      best_5_sell_data: [
        { flag: 0, quantity: 50, price: 25010, no_of_orders: 2 },
        ...Array.from({ length: 6 }, (_, i) => ({ flag: 0, quantity: 1, price: 25020 + i, no_of_orders: 1 })),
      ],
    };
    const d = depthFromSnapQuote(tick, 100)!;
    expect(d.bids).toEqual([
      { price: 250.05, qty: 75, orders: 3 },
      { price: 250, qty: 150, orders: 5 },
    ]);
    expect(d.asks).toHaveLength(5);
    expect(d.asks[0]).toEqual({ price: 250.1, qty: 50, orders: 2 });
  });

  it('is undefined when the tick carries no level at all (LTP/QUOTE mode, indices)', () => {
    expect(depthFromSnapQuote({ last_traded_price: 100 }, 100)).toBeUndefined();
    expect(depthFromSnapQuote({ best_5_buy_data: [{ price: 0, quantity: 0 }], best_5_sell_data: [] }, 100)).toBeUndefined();
    expect(depthFromSnapQuote(null, 100)).toBeUndefined();
  });
});

describe('depthFromFullQuote (REST marketData FULL)', () => {
  it('maps depth.buy / depth.sell in rupees', () => {
    const d = depthFromFullQuote({
      depth: {
        buy: [{ price: 1500.5, quantity: 10, orders: 2 }],
        sell: [{ price: 1501, quantity: 7, orders: 1 }],
      },
    })!;
    expect(d).toEqual({ bids: [{ price: 1500.5, qty: 10, orders: 2 }], asks: [{ price: 1501, qty: 7, orders: 1 }] });
  });

  it('falls back through the SDK’s camel-cased shapes, and is undefined with no levels', () => {
    expect(depthFromFullQuote({ bestBids: [{ Price: 99, Quantity: 1, NoOfOrders: 1 }], bestAsks: [] })).toEqual({
      bids: [{ price: 99, qty: 1, orders: 1 }],
      asks: [],
    });
    expect(depthFromFullQuote({ ltp: 5 })).toBeUndefined();
  });
});
