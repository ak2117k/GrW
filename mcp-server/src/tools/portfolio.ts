import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { apiClient } from "../api-client.js";

export function registerPortfolioTools(server: McpServer): void {
  // ── get_positions ──
  server.tool(
    "get_positions",
    "Get all live positions with real-time P&L from the position manager.",
    {},
    async () => {
      try {
        const result = await apiClient.get("/api/trades/positions");
        return {
          content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
        };
      } catch (error) {
        return {
          content: [{ type: "text" as const, text: `Error fetching positions: ${error instanceof Error ? error.message : String(error)}` }],
        };
      }
    }
  );

  // ── get_open_trades ──
  server.tool(
    "get_open_trades",
    "Get all currently open trades with their details (entry price, P&L, strategy, etc.).",
    {},
    async () => {
      try {
        const result = await apiClient.get("/api/trades/open");
        return {
          content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
        };
      } catch (error) {
        return {
          content: [{ type: "text" as const, text: `Error fetching open trades: ${error instanceof Error ? error.message : String(error)}` }],
        };
      }
    }
  );

  // ── get_trade_history ──
  server.tool(
    "get_trade_history",
    "Get paginated trade history with optional filters by status and strategy.",
    {
      page: z.number().int().positive().optional().describe("Page number (default: 1)"),
      limit: z.number().int().positive().optional().describe("Results per page (default: 20)"),
      status: z.string().optional().describe("Filter by status: OPEN, CLOSED, CANCELLED"),
      strategy: z.string().optional().describe("Filter by strategy name"),
    },
    async ({ page, limit, status, strategy }) => {
      try {
        const result = await apiClient.get("/api/trades", {
          page: page?.toString(),
          limit: limit?.toString(),
          status,
          strategy,
        });
        return {
          content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
        };
      } catch (error) {
        return {
          content: [{ type: "text" as const, text: `Error fetching trade history: ${error instanceof Error ? error.message : String(error)}` }],
        };
      }
    }
  );

  // ── get_daily_pnl ──
  server.tool(
    "get_daily_pnl",
    "Get today's P&L summary including realized and unrealized profit/loss.",
    {},
    async () => {
      try {
        const result = await apiClient.get("/api/trades/daily-pnl");
        return {
          content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
        };
      } catch (error) {
        return {
          content: [{ type: "text" as const, text: `Error fetching daily P&L: ${error instanceof Error ? error.message : String(error)}` }],
        };
      }
    }
  );

  // ── get_risk_status ──
  server.tool(
    "get_risk_status",
    "Get current risk status: daily P&L vs limits, open position count, capital deployed, and kill switch status.",
    {},
    async () => {
      try {
        const result = await apiClient.get("/api/trades/risk-status");
        return {
          content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
        };
      } catch (error) {
        return {
          content: [{ type: "text" as const, text: `Error fetching risk status: ${error instanceof Error ? error.message : String(error)}` }],
        };
      }
    }
  );

  // ── get_portfolio_summary ──
  server.tool(
    "get_portfolio_summary",
    "Get overall portfolio summary with total P&L, win rate, and performance metrics.",
    {},
    async () => {
      try {
        const result = await apiClient.get("/api/portfolio/summary");
        return {
          content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
        };
      } catch (error) {
        return {
          content: [{ type: "text" as const, text: `Error fetching portfolio summary: ${error instanceof Error ? error.message : String(error)}` }],
        };
      }
    }
  );
}
