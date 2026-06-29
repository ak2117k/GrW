import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { apiClient } from "../api-client.js";

export function registerMarketDataTools(server: McpServer): void {
  // ── get_live_quote ──
  server.tool(
    "get_live_quote",
    "Get the latest live quote (LTP, OHLC, volume) for an instrument by its token. The token must be subscribed to the market feed for live data.",
    {
      token: z.string().describe("Instrument token (e.g. '99926000' for Nifty 50)"),
      exchange: z.string().optional().describe("Exchange: NSE, BSE, NFO, MCX. Optional — used for context."),
    },
    async ({ token }) => {
      try {
        const result = await apiClient.get(`/api/market-data/instruments/${token}/quote`);
        return {
          content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
        };
      } catch (error) {
        return {
          content: [{ type: "text" as const, text: `Error fetching quote: ${error instanceof Error ? error.message : String(error)}` }],
        };
      }
    }
  );

  // ── get_candles ──
  server.tool(
    "get_candles",
    "Get historical OHLCV candles for an instrument. Supports timeframes: 1m, 3m, 5m, 15m, 30m, 1h, 4h, 1d, 1w, 1M. Dates in ISO format (YYYY-MM-DD or full ISO string).",
    {
      token: z.string().describe("Instrument token"),
      exchange: z.string().optional().describe("Exchange: NSE, BSE, NFO, MCX"),
      timeframe: z.string().describe("Candle timeframe: 1m, 3m, 5m, 15m, 30m, 1h, 4h, 1d, 1w, 1M"),
      from: z.string().describe("Start date (ISO format, e.g. 2026-01-01)"),
      to: z.string().describe("End date (ISO format, e.g. 2026-04-09)"),
    },
    async ({ token, exchange, timeframe, from, to }) => {
      try {
        const result = await apiClient.get(`/api/market-data/instruments/${token}/candles`, {
          exchange,
          timeframe,
          from,
          to,
        });
        return {
          content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
        };
      } catch (error) {
        return {
          content: [{ type: "text" as const, text: `Error fetching candles: ${error instanceof Error ? error.message : String(error)}` }],
        };
      }
    }
  );

  // ── search_instruments ──
  server.tool(
    "search_instruments",
    "Search for instruments (stocks, indices, F&O, commodities) by name or symbol. Returns matching instruments with token, symbol, exchange, and metadata.",
    {
      query: z.string().describe("Search query (e.g. 'RELIANCE', 'NIFTY', 'CRUDE')"),
      exchange: z.string().optional().describe("Filter by exchange: NSE, BSE, NFO, MCX"),
    },
    async ({ query, exchange }) => {
      try {
        const result = await apiClient.get("/api/market-data/instruments", {
          search: query,
          exchange,
        });
        return {
          content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
        };
      } catch (error) {
        return {
          content: [{ type: "text" as const, text: `Error searching instruments: ${error instanceof Error ? error.message : String(error)}` }],
        };
      }
    }
  );

  // ── get_indices ──
  server.tool(
    "get_indices",
    "Get all major market indices (Nifty 50, BankNifty, FinNifty, etc.) with their live quotes.",
    {},
    async () => {
      try {
        const result = await apiClient.get("/api/market-data/indices");
        return {
          content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
        };
      } catch (error) {
        return {
          content: [{ type: "text" as const, text: `Error fetching indices: ${error instanceof Error ? error.message : String(error)}` }],
        };
      }
    }
  );

  // ── get_market_status ──
  server.tool(
    "get_market_status",
    "Get current market status — whether NSE and MCX are open or closed, and the feed connection status.",
    {},
    async () => {
      try {
        const result = await apiClient.get("/api/market-data/market-status");
        return {
          content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
        };
      } catch (error) {
        return {
          content: [{ type: "text" as const, text: `Error fetching market status: ${error instanceof Error ? error.message : String(error)}` }],
        };
      }
    }
  );
}
