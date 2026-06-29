import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { apiClient } from "../api-client.js";

export function registerInsightTools(server: McpServer): void {
  // ── get_pending_insights ──
  server.tool(
    "get_pending_insights",
    "Claim up to 10 pending AI insight requests. Each returned row is atomically transitioned from 'pending' to 'in_progress'. Stale in_progress rows (>5 min) are reverted to pending before the read. Use this from a /loop to process insights as they come in. Returns an array of rows with id, sectionKey, contextKey, and contextData (the snapshot you should analyze).",
    {},
    async () => {
      try {
        const result = await apiClient.post<{ insights: unknown[] }>(
          "/api/insights/mcp/claim-pending",
        );
        return {
          content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
        };
      } catch (error) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Error claiming pending insights: ${error instanceof Error ? error.message : String(error)}`,
            },
          ],
        };
      }
    },
  );

  // ── complete_insight ──
  server.tool(
    "complete_insight",
    "Mark an insight request completed with your analysis. The insight should be markdown-formatted (bullet points, short sentences). Confidence is 1-100 indicating how confident you are in the analysis (consider data freshness, signal strength, conflicting indicators).",
    {
      id: z.string().describe("The insight row id from get_pending_insights"),
      content: z.string().describe("Your analysis as markdown"),
      confidence: z.number().int().min(1).max(100).describe("Confidence 1-100"),
    },
    async ({ id, content, confidence }) => {
      try {
        const result = await apiClient.post(`/api/insights/mcp/${id}/complete`, {
          content,
          confidence,
        });
        return {
          content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
        };
      } catch (error) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Error completing insight ${id}: ${error instanceof Error ? error.message : String(error)}`,
            },
          ],
        };
      }
    },
  );

  // ── fail_insight ──
  server.tool(
    "fail_insight",
    "Mark an insight request failed with an error message. Use this when the contextData is malformed, missing required fields, or analysis is impossible.",
    {
      id: z.string().describe("The insight row id"),
      errorMessage: z.string().describe("Why this insight failed"),
    },
    async ({ id, errorMessage }) => {
      try {
        const result = await apiClient.post(`/api/insights/mcp/${id}/fail`, { errorMessage });
        return {
          content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
        };
      } catch (error) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Error failing insight ${id}: ${error instanceof Error ? error.message : String(error)}`,
            },
          ],
        };
      }
    },
  );
}
