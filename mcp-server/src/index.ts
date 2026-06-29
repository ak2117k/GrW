#!/usr/bin/env node

/**
 * TD Automation MCP Server
 *
 * Exposes the TD trading platform's capabilities as MCP tools
 * so Claude Code can interact with live market data, place trades,
 * manage portfolio, and get AI trading advice.
 *
 * Transport: stdio (for Claude Code integration)
 * Backend: NestJS API at http://localhost:4001
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { registerMarketDataTools } from "./tools/market-data.js";
import { registerTradingTools } from "./tools/trading.js";
import { registerPortfolioTools } from "./tools/portfolio.js";
import { registerSignalTools } from "./tools/signals.js";
import { registerAccountTools } from "./tools/account.js";
import { registerInsightTools } from "./tools/insights.js";

async function main(): Promise<void> {
  // Log to stderr — stdout is reserved for MCP protocol messages
  console.error("[td-mcp-server] Starting TD Automation MCP server...");

  const server = new McpServer({
    name: "td-trading",
    version: "1.0.0",
  });

  // Register all tool groups
  registerMarketDataTools(server);
  registerTradingTools(server);
  registerPortfolioTools(server);
  registerSignalTools(server);
  registerAccountTools(server);
  registerInsightTools(server);

  console.error("[td-mcp-server] Registered tool groups: market-data, trading, portfolio, signals, account, insights");

  // Connect via stdio transport
  const transport = new StdioServerTransport();
  await server.connect(transport);

  console.error("[td-mcp-server] Connected via stdio transport. Ready for requests.");
}

main().catch((error) => {
  console.error("[td-mcp-server] Fatal error:", error);
  process.exit(1);
});
