# Using AI Insights with Claude Code Loop

The `/market` and `/options` pages have an "AI Analysis" card that lets you click "Ask Claude" and get a markdown interpretation of the underlying data. This is powered by the **MCP insights tools** plus a Claude Code `/loop`.

## Setup (once per Claude Code session)

In your Claude Code session, run:

```
/loop 30s Process pending AI insights:
1. Call get_pending_insights
2. For each row returned:
   - If sectionKey is "market-breadth": analyze advances/declines, sector rotation, A/D ratio implications. Output 3-6 markdown bullets.
   - If sectionKey is "options-chain": analyze the chain. Recommend 2-3 best strikes considering gamma, theta, IV skew, OI buildup, ATM/OTM positioning. Note risk caveats.
   - Call complete_insight(id, markdown, confidence) where confidence is 1-100.
3. If empty, exit quickly.
```

While this loop runs, every "Ask Claude" click in the browser is processed within ~30 seconds with zero external API calls. All Claude work happens inside your existing Claude Code session.

## Stopping

Run `/cancel-loop` or close Claude Code.

## Troubleshooting

- **Card stuck on "analyzing..."** — check that the loop is running. The card will time out after 3 minutes and show a retry prompt.
- **Insight is wrong / generic** — re-click "Ask Claude" to request a fresh analysis. The contextData snapshot is captured at click time.
- **DB has stale in_progress rows** — the loop reverts anything older than 5 minutes back to pending automatically on its next tick.
