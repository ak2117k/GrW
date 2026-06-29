"""
Strategy Fixer Service — analyzes strategy code errors and generates
intelligent fix suggestions and improvement recommendations.

Uses the same indicator definitions and constants from strategy_validator_service
to ensure consistency.
"""

import logging
import re
from difflib import get_close_matches
from typing import Any

from .strategy_validator_service import (
    INDICATORS,
    INDICATOR_NAMES,
    VALID_SOURCES,
    ENTRY_VARS,
    EXIT_VARS,
    RISK_VARS,
    SPECIAL_VARS,
    _COMMON_TYPOS,
    _RE_FUNC_CALL,
    _RE_ASSIGNMENT,
    _RE_COMMENT,
)

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Known source typos
# ---------------------------------------------------------------------------

_SOURCE_TYPOS: dict[str, str] = {
    "prices": "close",
    "price": "close",
    "closing": "close",
    "cls": "close",
    "c": "close",
    "o": "open",
    "h": "high",
    "l": "low",
    "vol": "volume",
    "v": "volume",
    "hi": "high",
    "lo": "low",
    "op": "open",
}

# Reasonable default parameter ranges
_PARAM_DEFAULTS: dict[str, dict[str, Any]] = {
    "RSI": {"period": 14, "max_period": 100},
    "EMA": {"period": 21, "max_period": 500},
    "SMA": {"period": 50, "max_period": 500},
    "MACD": {"fast": 12, "slow": 26, "signal": 9},
    "BB": {"period": 20, "stddev": 2, "max_period": 200},
    "ATR": {"period": 14, "max_period": 100},
    "SUPERTREND": {"period": 10, "multiplier": 3},
    "ADX": {"period": 14, "max_period": 100},
}

# PineScript remnant patterns
_PINESCRIPT_REMNANTS = [
    (re.compile(r'\bta\.(\w+)'), "PineScript ta.{0}() detected — use {1}() instead"),
    (re.compile(r'\bstrategy\.\w+'), "PineScript strategy.xxx() detected — convert to DSL entry/exit rules"),
    (re.compile(r'\binput\s*\('), "PineScript input() detected — replace with the default value directly"),
    (re.compile(r'\binput\.\w+\s*\('), "PineScript input.xxx() detected — replace with the default value directly"),
    (re.compile(r'\bmath\.\w+\s*\('), "PineScript math.xxx() detected — use plain arithmetic"),
    (re.compile(r'\bcolor\.\w+'), "PineScript color reference detected — remove (not needed in DSL)"),
    (re.compile(r'\bplot\w*\s*\('), "PineScript plot() detected — remove (not needed in DSL)"),
]


# ---------------------------------------------------------------------------
# Fix helpers
# ---------------------------------------------------------------------------

def _try_fix_indicator_name(name: str) -> str | None:
    """Attempt to correct a misspelled indicator name."""
    upper = name.upper()
    if upper in INDICATORS:
        return upper

    lower = name.lower()
    if lower in _COMMON_TYPOS:
        return _COMMON_TYPOS[lower]

    matches = get_close_matches(upper, INDICATOR_NAMES, n=1, cutoff=0.5)
    if matches:
        return matches[0]

    return None


def _try_fix_source(source: str) -> str | None:
    """Attempt to correct a misspelled source variable."""
    if source in VALID_SOURCES:
        return None  # already valid

    lower = source.lower()
    if lower in _SOURCE_TYPOS:
        return _SOURCE_TYPOS[lower]

    matches = get_close_matches(lower, list(VALID_SOURCES), n=1, cutoff=0.6)
    if matches:
        return matches[0]

    return None


def _fix_operators_in_line(line: str) -> tuple[str, list[dict]]:
    """Fix operator issues in a single line.

    Returns (fixed_line, list_of_changes).
    """
    changes: list[dict] = []
    fixed = line

    # Fix lowercase logical operators
    if re.search(r'\band\b', fixed):
        fixed = re.sub(r'\band\b', 'AND', fixed)
        changes.append({"reason": "Lowercase 'and' converted to 'AND'"})

    if re.search(r'\bor\b', fixed):
        fixed = re.sub(r'\bor\b', 'OR', fixed)
        changes.append({"reason": "Lowercase 'or' converted to 'OR'"})

    if re.search(r'\bnot\b', fixed):
        fixed = re.sub(r'\bnot\b', 'NOT', fixed)
        changes.append({"reason": "Lowercase 'not' converted to 'NOT'"})

    # Fix <> to !=
    if '<>' in fixed:
        fixed = fixed.replace('<>', '!=')
        changes.append({"reason": "Operator '<>' converted to '!='"})

    # Fix single = in comparisons (but not in assignments)
    # Only applies to RHS of assignment lines for rule variables
    assign_match = _RE_ASSIGNMENT.match(fixed)
    if assign_match:
        var_name = assign_match.group(1)
        rhs = assign_match.group(2)
        if var_name in SPECIAL_VARS:
            # Check for bare = that should be == (e.g., rsi = 50 -> rsi == 50)
            # Pattern: identifier = number (but not indicator calls)
            bare_eq = re.findall(r'(\w+)\s*(?<![<>!=])=(?!=)\s*(\d+\.?\d*)', rhs)
            for ref_var, ref_val in bare_eq:
                if ref_var not in SPECIAL_VARS and not ref_var[0].isupper():
                    old = f"{ref_var} = {ref_val}"
                    new = f"{ref_var} == {ref_val}"
                    rhs = rhs.replace(old, new, 1)
                    changes.append({
                        "reason": f"Single '=' in comparison changed to '==' ({old} -> {new})"
                    })
            if changes:
                fixed = f"{var_name} = {rhs}"

    return fixed, changes


def _fix_indicator_params(line: str) -> tuple[str, list[dict]]:
    """Fix indicator parameters that are out of reasonable range."""
    changes: list[dict] = []
    fixed = line

    for match in _RE_FUNC_CALL.finditer(line):
        func_name = match.group(1)
        raw_args = match.group(2)

        if func_name not in _PARAM_DEFAULTS:
            continue

        defaults = _PARAM_DEFAULTS[func_name]
        spec = INDICATORS.get(func_name, {})
        params = spec.get("params", [])
        args = [a.strip() for a in raw_args.split(",") if a.strip()]

        new_args = list(args)
        changed = False

        for idx, arg in enumerate(args):
            if idx == 0 and "source" in params:
                continue  # skip source param

            param_idx = idx
            if params and param_idx < len(params):
                param_name = params[param_idx]
            else:
                continue

            try:
                val = float(arg)
            except ValueError:
                continue

            max_key = f"max_{param_name}"
            if max_key in defaults and val > defaults[max_key]:
                suggested = defaults.get(param_name, 14)
                new_args[idx] = str(suggested)
                changes.append({
                    "reason": f"{func_name} {param_name} of {int(val)} is too large; suggested {suggested}"
                })
                changed = True
            elif param_name == "period" and val < 1:
                suggested = defaults.get("period", 14)
                new_args[idx] = str(suggested)
                changes.append({
                    "reason": f"{func_name} period must be positive; suggested {suggested}"
                })
                changed = True

        if changed:
            old_call = f"{func_name}({raw_args})"
            new_call = f"{func_name}({', '.join(new_args)})"
            fixed = fixed.replace(old_call, new_call, 1)

    return fixed, changes


def _fix_indicator_names(line: str) -> tuple[str, list[dict]]:
    """Fix misspelled indicator names in function calls."""
    changes: list[dict] = []
    fixed = line

    for match in _RE_FUNC_CALL.finditer(line):
        func_name = match.group(1)
        if func_name in INDICATORS:
            continue  # already correct

        corrected = _try_fix_indicator_name(func_name)
        if corrected and corrected != func_name:
            fixed = fixed.replace(f"{func_name}(", f"{corrected}(", 1)
            changes.append({
                "reason": f"Unknown indicator '{func_name}' corrected to '{corrected}'"
            })

    return fixed, changes


def _fix_source_names(line: str) -> tuple[str, list[dict]]:
    """Fix misspelled source variable names in indicator calls."""
    changes: list[dict] = []
    fixed = line

    for match in _RE_FUNC_CALL.finditer(line):
        func_name = match.group(1)
        raw_args = match.group(2)
        spec = INDICATORS.get(func_name, {})
        params = spec.get("params", [])

        if not params or "source" not in params:
            continue

        args = [a.strip() for a in raw_args.split(",") if a.strip()]
        if not args:
            continue

        source = args[0]
        corrected = _try_fix_source(source)
        if corrected:
            old_call = f"{func_name}({raw_args})"
            args[0] = corrected
            new_call = f"{func_name}({', '.join(args)})"
            fixed = fixed.replace(old_call, new_call, 1)
            changes.append({
                "reason": f"Unknown source '{source}' corrected to '{corrected}'"
            })

    return fixed, changes


def _detect_pinescript_remnants(line: str, line_num: int) -> list[dict]:
    """Detect leftover PineScript code patterns."""
    changes: list[dict] = []

    for pattern, msg_template in _PINESCRIPT_REMNANTS:
        match = pattern.search(line)
        if match:
            if "{0}" in msg_template:
                # Extract the specific function name
                func = match.group(1) if match.lastindex else ""
                corrected = _try_fix_indicator_name(func) or func.upper()
                reason = msg_template.format(func, corrected)
            else:
                reason = msg_template
            changes.append({
                "line": line_num,
                "reason": reason,
            })

    return changes


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------


async def fix_strategy(
    code: str,
    errors: list[dict],
    warnings: list[dict],
) -> dict[str, Any]:
    """Analyze strategy code errors and generate intelligent fix suggestions.

    Args:
        code: The strategy DSL source code.
        errors: List of validation errors (each with line, message, suggestion).
        warnings: List of validation warnings (each with line, message).

    Returns:
        Dict with keys:
            - fixed_code: The corrected strategy code.
            - changes: List of changes made.
            - confidence: Float 0.0 to 1.0 indicating fix confidence.
    """
    if not code or not code.strip():
        return {
            "fixed_code": "",
            "changes": [],
            "confidence": 0.0,
        }

    lines = code.split("\n")
    all_changes: list[dict[str, Any]] = []
    total_fixes = 0
    total_attempted = len(errors) + len(warnings)

    # Process each line
    for i, raw_line in enumerate(lines):
        line_num = i + 1
        stripped = raw_line.strip()

        if not stripped or _RE_COMMENT.match(stripped):
            continue

        original = stripped
        current = stripped

        # Fix indicator names (typos)
        current, name_changes = _fix_indicator_names(current)
        for c in name_changes:
            all_changes.append({
                "line": line_num,
                "original": original,
                "fixed": current,
                "reason": c["reason"],
            })
            total_fixes += 1

        # Fix source names
        current, src_changes = _fix_source_names(current)
        for c in src_changes:
            all_changes.append({
                "line": line_num,
                "original": original,
                "fixed": current,
                "reason": c["reason"],
            })
            total_fixes += 1

        # Fix operators
        current, op_changes = _fix_operators_in_line(current)
        for c in op_changes:
            all_changes.append({
                "line": line_num,
                "original": original,
                "fixed": current,
                "reason": c["reason"],
            })
            total_fixes += 1

        # Fix indicator parameters
        current, param_changes = _fix_indicator_params(current)
        for c in param_changes:
            all_changes.append({
                "line": line_num,
                "original": original,
                "fixed": current,
                "reason": c["reason"],
            })
            total_fixes += 1

        # Detect PineScript remnants
        remnant_changes = _detect_pinescript_remnants(current, line_num)
        for c in remnant_changes:
            # Try auto-fix ta.xxx calls
            ta_match = re.search(r'ta\.(\w+)\s*\(([^)]*)\)', current)
            if ta_match:
                func = ta_match.group(1).upper()
                args = ta_match.group(2)
                corrected_name = _try_fix_indicator_name(func) or func
                old = ta_match.group(0)
                new = f"{corrected_name}({args})"
                current = current.replace(old, new, 1)
                all_changes.append({
                    "line": line_num,
                    "original": original,
                    "fixed": current,
                    "reason": c["reason"],
                })
                total_fixes += 1
            else:
                all_changes.append({
                    "line": line_num,
                    "original": original,
                    "fixed": current,
                    "reason": c["reason"],
                })

        # Update the line if changed
        if current != stripped:
            lines[i] = current

    # Check for missing entry rules
    defined_vars = set()
    for line in lines:
        assign_match = _RE_ASSIGNMENT.match(line.strip())
        if assign_match:
            defined_vars.add(assign_match.group(1))

    has_entry = bool(defined_vars & ENTRY_VARS)
    has_exit = bool(defined_vars & EXIT_VARS)
    has_risk = bool(defined_vars & RISK_VARS)

    # Detect indicator comparison that could be an entry rule
    if not has_entry:
        for i, raw_line in enumerate(lines):
            stripped = raw_line.strip()
            if not stripped or _RE_COMMENT.match(stripped):
                continue
            assign_match = _RE_ASSIGNMENT.match(stripped)
            if assign_match:
                var_name = assign_match.group(1)
                rhs = assign_match.group(2)
                # If RHS looks like a boolean condition but isn't assigned to an entry var
                has_comparison = any(op in rhs for op in ("<", ">", "==", "!=", "CROSSES"))
                if has_comparison and var_name not in SPECIAL_VARS:
                    all_changes.append({
                        "line": i + 1,
                        "original": stripped,
                        "fixed": f"long_entry = {rhs}",
                        "reason": f"Variable '{var_name}' looks like an entry condition. Consider renaming to 'long_entry' or 'short_entry'.",
                    })
                    break  # only suggest once

    # Auto-suggest missing risk management
    if not has_risk:
        risk_lines = [
            "",
            "// Risk management (auto-suggested)",
            "stoploss = ATR(14) * 1.5",
            "target = ATR(14) * 3.0",
        ]
        lines.extend(risk_lines)
        all_changes.append({
            "line": len(lines) - 1,
            "original": "",
            "fixed": "stoploss = ATR(14) * 1.5\ntarget = ATR(14) * 3.0",
            "reason": "No risk management defined. Auto-added ATR-based stoploss and target.",
        })
        total_fixes += 1

    # Calculate confidence
    if total_attempted == 0:
        confidence = 1.0
    else:
        confidence = min(1.0, max(0.1, total_fixes / max(total_attempted, 1)))

    # Boost confidence if we fixed most issues
    if total_fixes > 0 and total_fixes >= total_attempted * 0.8:
        confidence = min(1.0, confidence + 0.2)

    fixed_code = "\n".join(lines)

    logger.info(
        "Strategy fix complete: %d changes, confidence %.2f",
        len(all_changes),
        confidence,
    )

    return {
        "fixed_code": fixed_code,
        "changes": all_changes,
        "confidence": round(confidence, 2),
    }


async def suggest_improvements(code: str) -> list[dict[str, Any]]:
    """Analyze valid strategy code and suggest improvements.

    Args:
        code: The strategy DSL source code (assumed to be valid).

    Returns:
        List of suggestion dicts with keys: suggestion, priority, line.
    """
    if not code or not code.strip():
        return []

    suggestions: list[dict[str, Any]] = []
    lines = code.split("\n")

    # Collect defined variables and their values
    defined_vars: dict[str, str] = {}
    indicators_used: set[str] = set()
    has_volume_check = False
    has_atr_stoploss = False
    has_trailing_stop = False
    has_multi_timeframe = False
    entry_lines: dict[str, int] = {}
    exit_lines: dict[str, int] = {}

    for i, raw_line in enumerate(lines):
        stripped = raw_line.strip()
        if not stripped or _RE_COMMENT.match(stripped):
            continue

        assign_match = _RE_ASSIGNMENT.match(stripped)
        if assign_match:
            var_name = assign_match.group(1)
            rhs = assign_match.group(2).strip()
            defined_vars[var_name] = rhs

            if var_name in ENTRY_VARS:
                entry_lines[var_name] = i + 1
            if var_name in EXIT_VARS:
                exit_lines[var_name] = i + 1

            # Track indicators
            for func_match in _RE_FUNC_CALL.finditer(rhs):
                indicators_used.add(func_match.group(1))

            # Check for volume usage
            if "volume" in rhs.lower():
                has_volume_check = True

            # Check for ATR-based stoploss
            if var_name == "stoploss" and "ATR" in rhs:
                has_atr_stoploss = True

            # Check for trailing stop
            if var_name == "trailing_stop":
                has_trailing_stop = True

    # --- Volume confirmation ---
    if not has_volume_check and entry_lines:
        first_entry_line = min(entry_lines.values())
        suggestions.append({
            "suggestion": (
                "Add volume confirmation to entry rules. "
                "Example: long_entry = <your_condition> AND volume > SMA(volume, 20)"
            ),
            "priority": "high",
            "line": first_entry_line,
        })

    # --- ATR-based dynamic stoploss ---
    if "stoploss" in defined_vars and not has_atr_stoploss:
        stoploss_val = defined_vars["stoploss"]
        try:
            float(stoploss_val)
            # It's a fixed number
            suggestions.append({
                "suggestion": (
                    "Consider using ATR-based dynamic stoploss instead of a fixed value. "
                    "Example: stoploss = ATR(14) * 1.5"
                ),
                "priority": "high",
                "line": None,
            })
        except ValueError:
            pass

    # --- RSI period suggestion ---
    for i, raw_line in enumerate(lines):
        rsi_match = re.search(r'RSI\([^,]*,\s*(\d+)\)', raw_line)
        if rsi_match:
            period = int(rsi_match.group(1))
            if period == 14:
                suggestions.append({
                    "suggestion": (
                        "RSI period 14 is standard but consider 7 for faster signals "
                        "on lower timeframes or 21 for smoother signals on higher timeframes."
                    ),
                    "priority": "low",
                    "line": i + 1,
                })

    # --- Multi-timeframe confirmation ---
    if not has_multi_timeframe and entry_lines:
        suggestions.append({
            "suggestion": (
                "Add multi-timeframe confirmation for higher win rate. "
                "Use indicators from a higher timeframe to confirm the trend direction."
            ),
            "priority": "medium",
            "line": None,
        })

    # --- Trailing stop ---
    if not has_trailing_stop and "stoploss" in defined_vars:
        suggestions.append({
            "suggestion": (
                "Consider adding a trailing stop for trend-following strategies. "
                "Example: trailing_stop = ATR(14) * 2.0"
            ),
            "priority": "medium",
            "line": None,
        })

    # --- Missing exit rules ---
    if "long_entry" in defined_vars and "long_exit" not in defined_vars:
        suggestions.append({
            "suggestion": (
                "No long_exit rule defined. Consider adding an exit condition "
                "to automatically close long positions. Example: long_exit = RSI(close, 14) > 70"
            ),
            "priority": "high",
            "line": None,
        })

    if "short_entry" in defined_vars and "short_exit" not in defined_vars:
        suggestions.append({
            "suggestion": (
                "No short_exit rule defined. Consider adding an exit condition "
                "to automatically close short positions. Example: short_exit = RSI(close, 14) < 30"
            ),
            "priority": "high",
            "line": None,
        })

    # --- Single indicator reliance ---
    if len(indicators_used) == 1:
        indicator = list(indicators_used)[0]
        suggestions.append({
            "suggestion": (
                f"Strategy relies on a single indicator ({indicator}). "
                "Consider combining 2-3 indicators for more reliable signals "
                "(e.g., trend + momentum + volume)."
            ),
            "priority": "high",
            "line": None,
        })

    # --- EMA crossover without trend filter ---
    if "EMA" in indicators_used and "ADX" not in indicators_used:
        suggestions.append({
            "suggestion": (
                "EMA crossover strategies benefit from a trend strength filter. "
                "Consider adding ADX(14) > 25 to confirm trending conditions."
            ),
            "priority": "medium",
            "line": None,
        })

    # --- MACD without signal line ---
    if "MACD" in indicators_used:
        has_signal = any(".signal" in v for v in defined_vars.values())
        if not has_signal:
            suggestions.append({
                "suggestion": (
                    "MACD is used but signal line is not referenced. "
                    "Consider using MACD().signal for crossover-based entries."
                ),
                "priority": "low",
                "line": None,
            })

    # Sort by priority
    priority_order = {"high": 0, "medium": 1, "low": 2}
    suggestions.sort(key=lambda s: priority_order.get(s["priority"], 9))

    logger.info("Generated %d improvement suggestions", len(suggestions))

    return suggestions
