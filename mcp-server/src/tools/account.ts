import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { apiClient } from "../api-client.js";

export function registerAccountTools(server: McpServer): void {
  // ── get_account_info ──
  server.tool(
    "get_account_info",
    "Get broker account information including profile details, RMS (balance/margin), and order book summary.",
    {},
    async () => {
      try {
        const result = await apiClient.get("/api/broker/account");
        return {
          content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
        };
      } catch (error) {
        return {
          content: [{ type: "text" as const, text: `Error fetching account info: ${error instanceof Error ? error.message : String(error)}` }],
        };
      }
    }
  );

  // ── get_broker_status ──
  server.tool(
    "get_broker_status",
    "Get broker connection status — whether the Angel One session is active, client ID, and connection health.",
    {},
    async () => {
      try {
        const result = await apiClient.get("/api/broker/status");
        return {
          content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
        };
      } catch (error) {
        return {
          content: [{ type: "text" as const, text: `Error fetching broker status: ${error instanceof Error ? error.message : String(error)}` }],
        };
      }
    }
  );

  // ── ask_advisor ──
  server.tool(
    "ask_advisor",
    "Fetch the trader's full trading context — recent trades, performance stats, open positions, daily P&L, active strategies, and risk status. Returns raw data for Claude to analyze directly as a trading advisor. Use this when the user asks for trading advice, performance analysis, trade reviews, or strategy suggestions.",
    {
      question: z.string().describe("The user's trading question — included in the response so Claude has full context for analysis"),
    },
    async ({ question }) => {
      // Fetch all relevant trading data in parallel for Claude to analyze
      const results = await Promise.allSettled([
        apiClient.get("/api/advisor/context"),
        apiClient.get("/api/trades/risk-status"),
        apiClient.get("/api/signals/active"),
        apiClient.get("/api/signals/strategies"),
      ]);

      const [contextRes, riskRes, signalsRes, strategiesRes] = results;

      const payload: Record<string, any> = {
        question,
        instruction: "You are an expert Indian market trading advisor. Analyze the data below and provide specific, actionable advice. Reference actual numbers, trades, and strategies. Be honest — if performance is poor, say so constructively. Consider Indian market specifics: NSE/BSE hours (9:15–15:30 IST), Thursday expiries, FII/DII flows, Nifty/BankNifty options dynamics.",
      };

      if (contextRes.status === "fulfilled") {
        payload.trading_context = contextRes.value;
      }
      if (riskRes.status === "fulfilled") {
        payload.risk_status = riskRes.value;
      }
      if (signalsRes.status === "fulfilled") {
        payload.active_signals = signalsRes.value;
      }
      if (strategiesRes.status === "fulfilled") {
        payload.strategies = strategiesRes.value;
      }

      // If all fetches failed, return the error
      const allFailed = results.every((r) => r.status === "rejected");
      if (allFailed) {
        return {
          content: [{
            type: "text" as const,
            text: `Error fetching trading data: ${(results[0] as PromiseRejectedResult).reason?.message ?? "Backend unreachable"}. Is the API server running on localhost:4001?`,
          }],
        };
      }

      return {
        content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }],
      };
    }
  );
}
