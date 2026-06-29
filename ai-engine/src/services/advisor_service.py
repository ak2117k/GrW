"""
AI Advisor service — processes trading questions and generates intelligent responses.
Uses rule-based pattern matching on question type with trading context analysis.
"""

import logging
import re
from typing import Any, Dict, List, Optional

logger = logging.getLogger(__name__)


def process_question(question: str, context: Dict[str, Any]) -> Dict[str, Any]:
    """Route question to the appropriate handler based on content analysis.

    Args:
        question: The user's natural language question.
        context: Trading context dict with recent_trades, stats, active_strategies, etc.

    Returns:
        Dict with answer, confidence, relatedInsights, suggestedActions.
    """
    q_lower = question.lower().strip()

    # Classify the question
    if _matches_trade_assessment(q_lower):
        return generate_trade_assessment(context)
    elif _matches_loss_analysis(q_lower):
        return analyze_losses(context.get("recent_trades", []))
    elif _matches_performance_query(q_lower):
        return generate_performance_summary(context.get("stats", {}), context)
    elif _matches_improvement_query(q_lower):
        return generate_improvement_suggestions(
            context.get("recent_trades", []),
            context.get("active_strategies", []),
        )
    else:
        return _generate_contextual_response(question, context)


def _matches_trade_assessment(q: str) -> bool:
    patterns = [
        r"should i (take|enter|buy|sell)",
        r"is this.*(good|bad).*(trade|setup|signal)",
        r"(take|enter) this trade",
        r"trade (worth|good)",
    ]
    return any(re.search(p, q) for p in patterns)


def _matches_loss_analysis(q: str) -> bool:
    patterns = [
        r"why.*(lose|lost|losing|loss)",
        r"what went wrong",
        r"losing trades",
        r"why.*(down|red|negative)",
        r"analyze.*(losses|losing)",
    ]
    return any(re.search(p, q) for p in patterns)


def _matches_performance_query(q: str) -> bool:
    patterns = [
        r"how am i doing",
        r"(my|overall).*(performance|results|stats)",
        r"how.*(performing|going)",
        r"(show|tell).*(performance|summary|stats)",
        r"am i.*(profit|doing well|doing good)",
    ]
    return any(re.search(p, q) for p in patterns)


def _matches_improvement_query(q: str) -> bool:
    patterns = [
        r"what should i (improve|change|fix)",
        r"how.*(improve|better|get better)",
        r"(tips|advice|suggestions)",
        r"what.*(wrong|change|optimize)",
        r"best strategy",
    ]
    return any(re.search(p, q) for p in patterns)


def generate_trade_assessment(context: Dict[str, Any]) -> Dict[str, Any]:
    """Analyze whether the user should take a trade based on current context.

    Examines signal confidence, market regime, recent performance, and risk.
    """
    stats = context.get("stats", {})
    recent_trades = context.get("recent_trades", [])
    open_positions = stats.get("open_positions", 0)

    insights: List[str] = []
    actions: List[str] = []
    confidence = 0.5

    # Check recent performance
    win_rate = stats.get("win_rate", 50)
    if win_rate < 40:
        insights.append(
            f"Your recent win rate is low ({win_rate}%), so be selective with entries."
        )
        confidence -= 0.15
        actions.append("Wait for higher-confidence setups")
    elif win_rate > 60:
        insights.append(
            f"Your win rate is strong at {win_rate}%. Current form supports taking trades."
        )
        confidence += 0.1

    # Check for losing streak
    recent_losses = 0
    for trade in recent_trades[:5]:
        if trade.get("pnl", 0) < 0 and trade.get("status") == "CLOSED":
            recent_losses += 1
        else:
            break

    if recent_losses >= 3:
        insights.append(
            f"You are on a {recent_losses}-trade losing streak. Consider pausing."
        )
        confidence -= 0.2
        actions.append("Take a break and review recent losses before entering")
    elif recent_losses == 0 and len(recent_trades) >= 3:
        insights.append("You are on a winning streak. Stay disciplined with your stops.")
        confidence += 0.05

    # Check open positions
    if open_positions >= 4:
        insights.append(
            f"You have {open_positions} open positions. Adding more increases concentration risk."
        )
        actions.append("Consider closing an existing position first")
        confidence -= 0.1

    # Build answer
    if confidence >= 0.6:
        answer = (
            "Based on your recent performance, conditions look favorable for taking a trade. "
            "Make sure it fits your risk management rules: proper stop-loss, position sizing, "
            "and a minimum 1:2 risk-reward ratio."
        )
    elif confidence >= 0.4:
        answer = (
            "The situation is neutral. While there is no strong reason to avoid trading, "
            "be selective and only enter on high-confidence signals. "
            "Ensure your stop-loss is tight and position size is conservative."
        )
    else:
        answer = (
            "I would recommend caution right now. Your recent trading patterns suggest "
            "it may be better to sit this one out or reduce size. "
            "Focus on reviewing what is not working before adding new positions."
        )

    if not insights:
        insights.append("Limited context available — trade with standard risk parameters.")

    if not actions:
        actions.append("Verify signal confidence is HIGH or VERY_HIGH before entering")
        actions.append("Set stop-loss and target before placing the order")

    return {
        "answer": answer,
        "confidence": round(min(1.0, max(0.0, confidence)), 2),
        "relatedInsights": insights,
        "suggestedActions": actions,
    }


def analyze_losses(trades: List[Dict[str, Any]]) -> Dict[str, Any]:
    """Analyze patterns in recent losing trades."""
    closed_trades = [t for t in trades if t.get("status") == "CLOSED"]
    losing_trades = [t for t in closed_trades if t.get("pnl", 0) < 0]

    if not losing_trades:
        return {
            "answer": "Great news — you have no losing trades in the recent period! Keep up the discipline.",
            "confidence": 0.9,
            "relatedInsights": ["No losses detected in recent trades"],
            "suggestedActions": ["Continue current strategy execution"],
        }

    total_loss = sum(t.get("pnl", 0) for t in losing_trades)
    avg_loss = total_loss / len(losing_trades) if losing_trades else 0

    insights: List[str] = []
    actions: List[str] = []

    # Strategy analysis
    strat_losses: Dict[str, int] = {}
    for t in losing_trades:
        strat = t.get("strategy", "unknown")
        strat_losses[strat] = strat_losses.get(strat, 0) + 1

    worst_strat = max(strat_losses, key=strat_losses.get) if strat_losses else None
    if worst_strat and strat_losses[worst_strat] >= 2:
        insights.append(
            f'Strategy "{worst_strat}" has {strat_losses[worst_strat]} losing trades — '
            "it may need parameter tuning."
        )
        actions.append(f'Review "{worst_strat}" entry and exit criteria')

    # Time analysis
    from datetime import datetime

    hour_losses: Dict[int, int] = {}
    for t in losing_trades:
        entry = t.get("entry_time", "")
        if entry:
            try:
                h = datetime.fromisoformat(entry.replace("Z", "+00:00")).hour
                hour_losses[h] = hour_losses.get(h, 0) + 1
            except (ValueError, AttributeError):
                pass

    if hour_losses:
        worst_hour = max(hour_losses, key=hour_losses.get)
        if hour_losses[worst_hour] >= 2:
            insights.append(
                f"Multiple losses around {worst_hour}:00 — market conditions at "
                "this time may not suit your approach."
            )
            actions.append(f"Consider avoiding trades around {worst_hour}:00")

    # Side analysis
    buy_losses = len([t for t in losing_trades if t.get("side") == "BUY"])
    sell_losses = len([t for t in losing_trades if t.get("side") == "SELL"])
    if buy_losses > sell_losses * 2 and buy_losses >= 3:
        insights.append(
            f"Most losses ({buy_losses}) are on the BUY side. "
            "The market may be in a downtrend — consider more SELL-side setups."
        )
        actions.append("Check if market bias aligns with your trade direction")

    answer_parts = [
        f"You have {len(losing_trades)} losing trades out of {len(closed_trades)} recent closed trades.",
        f"Total loss: {total_loss:.2f} | Average loss per trade: {avg_loss:.2f}.",
    ]

    if insights:
        answer_parts.append("Here is what I found:")
        for i, insight in enumerate(insights, 1):
            answer_parts.append(f"{i}. {insight}")

    if not actions:
        actions.append("Review your stop-loss placement for recent losing trades")
        actions.append("Consider reducing position size until win rate improves")

    return {
        "answer": " ".join(answer_parts),
        "confidence": 0.75,
        "relatedInsights": insights if insights else ["No clear pattern detected in losses"],
        "suggestedActions": actions,
    }


def generate_performance_summary(
    stats: Dict[str, Any], context: Optional[Dict[str, Any]] = None
) -> Dict[str, Any]:
    """Generate a natural language performance summary."""
    total_trades = stats.get("total_trades", 0)
    win_rate = stats.get("win_rate", 0)
    total_pnl = stats.get("total_pnl", 0)
    open_positions = stats.get("open_positions", 0)

    if total_trades == 0:
        return {
            "answer": (
                "You have not closed any trades recently. Start trading to get "
                "personalized performance analysis and insights from the AI advisor."
            ),
            "confidence": 0.9,
            "relatedInsights": ["No recent trading data available"],
            "suggestedActions": ["Begin trading to enable AI analysis"],
        }

    insights: List[str] = []
    actions: List[str] = []

    # Build answer
    pnl_str = f"+{total_pnl:.2f}" if total_pnl >= 0 else f"{total_pnl:.2f}"
    performance_rating = "excellent" if win_rate > 65 else "good" if win_rate > 50 else "needs work"

    answer_parts = [
        f"Here is your recent performance overview:",
        f"",
        f"**Trades:** {total_trades} closed | **Win Rate:** {win_rate}% | **P&L:** {pnl_str}",
        f"**Open Positions:** {open_positions} | **Rating:** {performance_rating.title()}",
    ]

    if win_rate >= 60:
        insights.append(f"Strong win rate of {win_rate}% — you are trading well")
        actions.append("Consider slightly increasing position sizes")
    elif win_rate >= 45:
        insights.append(f"Decent win rate of {win_rate}% — room for improvement")
        actions.append("Focus on filtering out low-confidence signals")
    else:
        insights.append(f"Win rate of {win_rate}% is below target — review your setup criteria")
        actions.append("Reduce position sizes and trade only A+ setups")

    if total_pnl >= 0:
        insights.append(f"Net profitable with {pnl_str}")
    else:
        insights.append(f"Currently in drawdown: {pnl_str}")
        actions.append("Review risk management rules")

    # Daily performance from context
    daily_perf = (context or {}).get("daily_performance", [])
    if daily_perf:
        profit_days = sum(1 for d in daily_perf if d.get("pnl", 0) > 0)
        loss_days = sum(1 for d in daily_perf if d.get("pnl", 0) < 0)
        answer_parts.append(
            f"**Trading Days:** {len(daily_perf)} | **Green Days:** {profit_days} | **Red Days:** {loss_days}"
        )

    return {
        "answer": "\n".join(answer_parts),
        "confidence": 0.85,
        "relatedInsights": insights,
        "suggestedActions": actions,
    }


def generate_improvement_suggestions(
    trades: List[Dict[str, Any]], strategies: List[str]
) -> Dict[str, Any]:
    """Generate actionable improvement suggestions based on patterns."""
    closed_trades = [t for t in trades if t.get("status") == "CLOSED"]

    if len(closed_trades) < 3:
        return {
            "answer": (
                "I need more trade data to provide meaningful improvement suggestions. "
                "Keep logging your trades and I will analyze patterns as they emerge."
            ),
            "confidence": 0.5,
            "relatedInsights": ["Insufficient data for pattern analysis"],
            "suggestedActions": ["Continue trading to build analysis dataset"],
        }

    insights: List[str] = []
    actions: List[str] = []

    # Strategy analysis
    strat_stats: Dict[str, Dict[str, Any]] = {}
    for t in closed_trades:
        strat = t.get("strategy", "unknown")
        if strat not in strat_stats:
            strat_stats[strat] = {"wins": 0, "losses": 0, "pnl": 0.0}
        if t.get("pnl", 0) > 0:
            strat_stats[strat]["wins"] += 1
        else:
            strat_stats[strat]["losses"] += 1
        strat_stats[strat]["pnl"] += t.get("pnl", 0)

    best_strat = None
    best_wr = -1
    worst_strat = None
    worst_wr = 101

    for name, s in strat_stats.items():
        total = s["wins"] + s["losses"]
        if total >= 3:
            wr = (s["wins"] / total) * 100
            if wr > best_wr:
                best_wr = wr
                best_strat = name
            if wr < worst_wr:
                worst_wr = wr
                worst_strat = name

    answer_parts = ["Here are my suggestions to improve your trading:"]

    if best_strat:
        answer_parts.append(
            f"\n**Best Strategy:** {best_strat} ({best_wr:.0f}% win rate) — "
            "consider allocating more capital here."
        )
        insights.append(f'"{best_strat}" is your strongest strategy')
        actions.append(f'Increase allocation to "{best_strat}"')

    if worst_strat and worst_strat != best_strat and worst_wr < 40:
        answer_parts.append(
            f"\n**Weakest Strategy:** {worst_strat} ({worst_wr:.0f}% win rate) — "
            "review parameters or reduce usage."
        )
        insights.append(f'"{worst_strat}" is underperforming')
        actions.append(f'Review or pause "{worst_strat}"')

    # Risk management check
    winning_trades = [t for t in closed_trades if t.get("pnl", 0) > 0]
    losing_trades_list = [t for t in closed_trades if t.get("pnl", 0) < 0]

    if winning_trades and losing_trades_list:
        avg_win = sum(t.get("pnl", 0) for t in winning_trades) / len(winning_trades)
        avg_loss = abs(
            sum(t.get("pnl", 0) for t in losing_trades_list) / len(losing_trades_list)
        )
        rr_ratio = avg_win / avg_loss if avg_loss > 0 else 0

        if rr_ratio < 1.0:
            answer_parts.append(
                f"\n**Risk-Reward:** Your average win ({avg_win:.2f}) is smaller than "
                f"your average loss ({avg_loss:.2f}). Aim for at least 1:2 risk-reward."
            )
            insights.append("Risk-reward ratio is below 1:1")
            actions.append("Set wider targets or tighter stop-losses")
        elif rr_ratio >= 2.0:
            answer_parts.append(
                f"\n**Risk-Reward:** Excellent ratio of {rr_ratio:.1f}:1. "
                "Your winners are significantly larger than losers."
            )
            insights.append(f"Strong risk-reward ratio of {rr_ratio:.1f}:1")

    # Unused strategies
    used_strats = set(strat_stats.keys())
    unused = [s for s in strategies if s not in used_strats]
    if unused:
        answer_parts.append(
            f"\n**Unused Strategies:** {', '.join(unused)} — "
            "consider testing them to diversify your approach."
        )
        actions.append(f"Paper-trade {unused[0]} to evaluate its performance")

    if not actions:
        actions.append("Maintain current discipline and continue logging trades")

    return {
        "answer": "\n".join(answer_parts),
        "confidence": 0.8,
        "relatedInsights": insights if insights else ["Trading patterns look reasonable overall"],
        "suggestedActions": actions,
    }


def _generate_contextual_response(
    question: str, context: Dict[str, Any]
) -> Dict[str, Any]:
    """Handle general trading questions with contextual awareness."""
    stats = context.get("stats", {})
    recent_trades = context.get("recent_trades", [])
    strategies = context.get("active_strategies", [])

    total_trades = stats.get("total_trades", 0)
    win_rate = stats.get("win_rate", 0)
    total_pnl = stats.get("total_pnl", 0)

    q_lower = question.lower()

    # Try to give a relevant response based on keywords
    insights: List[str] = []
    actions: List[str] = []

    if "risk" in q_lower or "stop" in q_lower or "stoploss" in q_lower:
        answer = (
            "Risk management is the most important factor in long-term trading success. "
            "Here are key principles:\n\n"
            "1. Never risk more than 1-2% of your capital on a single trade\n"
            "2. Always place stop-losses before entering a trade\n"
            "3. Maintain a minimum risk-reward ratio of 1:2\n"
            "4. Set a daily loss limit and stop trading when hit\n"
            "5. Reduce position sizes during losing streaks"
        )
        insights.append("Risk management is the foundation of consistent profits")
        actions.append("Review your current stop-loss placement strategy")

    elif "strategy" in q_lower or "strategies" in q_lower:
        active = ", ".join(strategies) if strategies else "none configured"
        answer = (
            f"Your active strategies: {active}.\n\n"
            f"Recent performance: {total_trades} trades with {win_rate}% win rate."
        )
        if total_trades > 0:
            answer += (
                " I recommend focusing on strategies that show consistent results "
                "in the current market regime and reducing exposure to underperformers."
            )
        insights.append(f"Active strategies: {active}")
        actions.append("Review strategy performance in the Portfolio tab")

    elif "market" in q_lower or "trend" in q_lower or "direction" in q_lower:
        answer = (
            "I analyze your trading data and patterns rather than predicting market direction. "
            "Based on your recent trades, I can tell you:\n\n"
        )
        if recent_trades:
            buy_count = sum(1 for t in recent_trades if t.get("side") == "BUY")
            sell_count = sum(1 for t in recent_trades if t.get("side") == "SELL")
            answer += (
                f"- Recent trade bias: {buy_count} BUY vs {sell_count} SELL\n"
                f"- Win rate: {win_rate}%\n"
                f"- P&L: {'+' if total_pnl >= 0 else ''}{total_pnl:.2f}\n\n"
                "Align your trade direction with market structure for better results."
            )
        else:
            answer += "No recent trade data available to analyze bias."
        insights.append("Trade direction should align with market structure")
        actions.append("Check signal confidence before entering directional trades")

    else:
        # Generic helpful response
        answer = (
            f"I am your AI trading advisor. Here is what I can help with:\n\n"
            f"- **\"How am I doing?\"** — Performance summary\n"
            f"- **\"Why did I lose?\"** — Loss pattern analysis\n"
            f"- **\"Should I take this trade?\"** — Trade assessment\n"
            f"- **\"What should I improve?\"** — Improvement suggestions\n\n"
            f"You can also ask about risk management, strategies, or specific trades."
        )
        if total_trades > 0:
            answer += (
                f"\n\nQuick stats: {total_trades} trades | "
                f"{win_rate}% win rate | "
                f"P&L: {'+' if total_pnl >= 0 else ''}{total_pnl:.2f}"
            )
        insights.append("Try asking specific questions for better insights")
        actions.append("Ask about your performance or recent losses")

    return {
        "answer": answer,
        "confidence": 0.6,
        "relatedInsights": insights,
        "suggestedActions": actions,
    }
