import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { apiClient } from "../api-client.js";

export function registerTradingTools(server: McpServer): void {
  // ── place_trade ──
  server.tool(
    "place_trade",
    "Place a trade (paper or live). Defaults to PAPER mode for safety. If isPaper is false, this tool will NOT execute the trade directly — it will return a confirmation prompt. Use confirm_live_trade to actually execute a live trade.",
    {
      symbol: z.string().describe("Trading symbol (e.g. 'RELIANCE-EQ', 'NIFTY24APR25000CE')"),
      token: z.string().describe("Instrument token"),
      exchange: z.string().describe("Exchange: NSE, BSE, NFO, MCX"),
      side: z.enum(["BUY", "SELL"]).describe("Trade side: BUY or SELL"),
      orderType: z.enum(["MARKET", "LIMIT", "STOP_MARKET", "STOP_LIMIT"]).describe("Order type"),
      quantity: z.number().int().positive().describe("Number of shares/lots"),
      price: z.number().optional().describe("Limit price (required for LIMIT/STOP_LIMIT orders)"),
      triggerPrice: z.number().optional().describe("Trigger price (required for STOP_MARKET/STOP_LIMIT orders)"),
      positionType: z.enum(["INTRADAY", "DELIVERY", "CARRYFORWARD"]).describe("Position type"),
      stoploss: z.number().optional().describe("Stoploss price"),
      target: z.number().optional().describe("Target price"),
      strategy: z.string().optional().describe("Strategy name that generated this trade"),
      isPaper: z.boolean().optional().describe("Paper trade mode (default: true). Set to false for live trading."),
    },
    async (params) => {
      try {
        const isPaper = params.isPaper !== false; // default true

        if (!isPaper) {
          // Live trade — return confirmation prompt, do NOT execute
          const details = [
            `Side: ${params.side}`,
            `Symbol: ${params.symbol}`,
            `Exchange: ${params.exchange}`,
            `Quantity: ${params.quantity}`,
            `Order Type: ${params.orderType}`,
            params.price ? `Price: ${params.price}` : null,
            params.triggerPrice ? `Trigger: ${params.triggerPrice}` : null,
            `Position: ${params.positionType}`,
            params.stoploss ? `Stoploss: ${params.stoploss}` : null,
            params.target ? `Target: ${params.target}` : null,
          ]
            .filter(Boolean)
            .join("\n  ");

          return {
            content: [
              {
                type: "text" as const,
                text: `WARNING — LIVE TRADE CONFIRMATION REQUIRED\n\nYou are about to place a LIVE trade with real money:\n  ${details}\n\nThis will execute against your broker account. To proceed, call the confirm_live_trade tool with the same parameters.\n\nTo place as a paper trade instead, call place_trade again with isPaper: true.`,
              },
            ],
          };
        }

        // Paper trade — execute directly
        const body = {
          symbol: params.symbol,
          token: params.token,
          exchange: params.exchange,
          side: params.side,
          orderType: params.orderType,
          quantity: params.quantity,
          price: params.price,
          triggerPrice: params.triggerPrice,
          positionType: params.positionType,
          stoploss: params.stoploss,
          target: params.target,
          strategy: params.strategy,
          isPaper: true,
        };

        const result = await apiClient.post("/api/trades/execute", body);
        return {
          content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
        };
      } catch (error) {
        return {
          content: [{ type: "text" as const, text: `Error placing trade: ${error instanceof Error ? error.message : String(error)}` }],
        };
      }
    }
  );

  // ── confirm_live_trade ──
  server.tool(
    "confirm_live_trade",
    "Execute a LIVE trade with real money. Only call this after the user has explicitly confirmed they want to proceed with a live trade. This sends the order to the broker.",
    {
      symbol: z.string().describe("Trading symbol"),
      token: z.string().describe("Instrument token"),
      exchange: z.string().describe("Exchange: NSE, BSE, NFO, MCX"),
      side: z.enum(["BUY", "SELL"]).describe("Trade side"),
      orderType: z.enum(["MARKET", "LIMIT", "STOP_MARKET", "STOP_LIMIT"]).describe("Order type"),
      quantity: z.number().int().positive().describe("Number of shares/lots"),
      price: z.number().optional().describe("Limit price"),
      triggerPrice: z.number().optional().describe("Trigger price"),
      positionType: z.enum(["INTRADAY", "DELIVERY", "CARRYFORWARD"]).describe("Position type"),
      stoploss: z.number().optional().describe("Stoploss price"),
      target: z.number().optional().describe("Target price"),
      strategy: z.string().optional().describe("Strategy name"),
    },
    async (params) => {
      try {
        const body = {
          symbol: params.symbol,
          token: params.token,
          exchange: params.exchange,
          side: params.side,
          orderType: params.orderType,
          quantity: params.quantity,
          price: params.price,
          triggerPrice: params.triggerPrice,
          positionType: params.positionType,
          stoploss: params.stoploss,
          target: params.target,
          strategy: params.strategy,
          isPaper: false,
        };

        const result = await apiClient.post("/api/trades/execute", body);
        return {
          content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
        };
      } catch (error) {
        return {
          content: [{ type: "text" as const, text: `Error executing live trade: ${error instanceof Error ? error.message : String(error)}` }],
        };
      }
    }
  );

  // ── close_trade ──
  server.tool(
    "close_trade",
    "Close a specific open trade by its ID.",
    {
      tradeId: z.string().describe("The trade ID to close"),
      reason: z.string().optional().describe("Reason for closing the trade"),
    },
    async ({ tradeId, reason }) => {
      try {
        const result = await apiClient.post(`/api/trades/${tradeId}/close`, {
          reason: reason || "Closed via MCP",
        });
        return {
          content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
        };
      } catch (error) {
        return {
          content: [{ type: "text" as const, text: `Error closing trade: ${error instanceof Error ? error.message : String(error)}` }],
        };
      }
    }
  );

  // ── close_all_positions (KILL SWITCH) ──
  server.tool(
    "close_all_positions",
    "KILL SWITCH — Close ALL open positions immediately. This is an emergency action that squares off every open position. Use with caution.",
    {
      reason: z.string().describe("Reason for closing all positions (required for audit trail)"),
    },
    async ({ reason }) => {
      try {
        const result = await apiClient.post("/api/trades/close-all", { reason });
        return {
          content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
        };
      } catch (error) {
        return {
          content: [{ type: "text" as const, text: `Error closing all positions: ${error instanceof Error ? error.message : String(error)}` }],
        };
      }
    }
  );

  // ── modify_trade ──
  server.tool(
    "modify_trade",
    "Modify an existing trade's stoploss, target, or quantity.",
    {
      tradeId: z.string().describe("The trade ID to modify"),
      stoploss: z.number().optional().describe("New stoploss price"),
      target: z.number().optional().describe("New target price"),
      quantity: z.number().int().positive().optional().describe("New quantity"),
    },
    async ({ tradeId, stoploss, target, quantity }) => {
      try {
        const body: Record<string, unknown> = {};
        if (stoploss !== undefined) body.stoploss = stoploss;
        if (target !== undefined) body.target = target;
        if (quantity !== undefined) body.quantity = quantity;

        const result = await apiClient.put(`/api/trades/${tradeId}`, body);
        return {
          content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
        };
      } catch (error) {
        return {
          content: [{ type: "text" as const, text: `Error modifying trade: ${error instanceof Error ? error.message : String(error)}` }],
        };
      }
    }
  );
}
