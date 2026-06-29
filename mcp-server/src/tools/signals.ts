import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { apiClient } from "../api-client.js";

export function registerSignalTools(server: McpServer): void {
  // ── get_active_signals ──
  server.tool(
    "get_active_signals",
    "Get all currently active trading signals with their confidence scores, entry/exit prices, and strategy source.",
    {},
    async () => {
      try {
        const result = await apiClient.get("/api/signals/active");
        return {
          content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
        };
      } catch (error) {
        return {
          content: [{ type: "text" as const, text: `Error fetching active signals: ${error instanceof Error ? error.message : String(error)}` }],
        };
      }
    }
  );

  // ── get_strategies ──
  server.tool(
    "get_strategies",
    "List all registered trading strategies with their metadata (name, description, enabled status, parameters).",
    {},
    async () => {
      try {
        const result = await apiClient.get("/api/signals/strategies");
        return {
          content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
        };
      } catch (error) {
        return {
          content: [{ type: "text" as const, text: `Error fetching strategies: ${error instanceof Error ? error.message : String(error)}` }],
        };
      }
    }
  );

  // ── trigger_signal_scan ──
  server.tool(
    "trigger_signal_scan",
    "Trigger a manual signal scan across all registered strategies. The scan runs asynchronously via a Bull queue job.",
    {},
    async () => {
      try {
        const result = await apiClient.post("/api/signals/scan");
        return {
          content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
        };
      } catch (error) {
        return {
          content: [{ type: "text" as const, text: `Error triggering signal scan: ${error instanceof Error ? error.message : String(error)}` }],
        };
      }
    }
  );
}
