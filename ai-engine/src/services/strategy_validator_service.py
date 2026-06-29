"""
Strategy Validator Service — validates user-written trading strategy DSL code.

Performs syntax validation, semantic analysis, and generates fix suggestions
for common mistakes in strategy definitions.
"""

import logging
import re
from difflib import get_close_matches
from typing import Any

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Known indicator function signatures
# ---------------------------------------------------------------------------

INDICATORS: dict[str, dict[str, Any]] = {
    "RSI": {
        "params": ["source", "period"],
        "defaults": {"period": 14},
        "min_params": 1,
    },
    "EMA": {
        "params": ["source", "period"],
        "defaults": {"period": 9},
        "min_params": 1,
    },
    "SMA": {
        "params": ["source", "period"],
        "defaults": {"period": 20},
        "min_params": 1,
    },
    "MACD": {
        "params": ["source", "fast", "slow", "signal"],
        "defaults": {"fast": 12, "slow": 26, "signal": 9},
        "min_params": 1,
    },
    "BB": {
        "params": ["source", "period", "stddev"],
        "defaults": {"period": 20, "stddev": 2},
        "min_params": 1,
    },
    "ATR": {
        "params": ["period"],
        "defaults": {"period": 14},
        "min_params": 0,
    },
    "VWAP": {
        "params": [],
        "defaults": {},
        "min_params": 0,
    },
    "SUPERTREND": {
        "params": ["period", "multiplier"],
        "defaults": {"period": 10, "multiplier": 3},
        "min_params": 0,
    },
    "ADX": {
        "params": ["period"],
        "defaults": {"period": 14},
        "min_params": 0,
    },
}

INDICATOR_NAMES = list(INDICATORS.keys())

# Valid source identifiers for indicator calls
VALID_SOURCES = {"close", "open", "high", "low", "volume", "hl2", "hlc3", "ohlc4"}

# Valid comparison / logical operators
COMPARISON_OPS = {"<", ">", "<=", ">=", "==", "!="}
LOGICAL_OPS = {"AND", "OR"}

# Special strategy-rule variable names
ENTRY_VARS = {"long_entry", "short_entry"}
EXIT_VARS = {"long_exit", "short_exit"}
RISK_VARS = {"stoploss", "target", "trailing_stop"}
SPECIAL_VARS = ENTRY_VARS | EXIT_VARS | RISK_VARS

# Regex helpers
_RE_ANNOTATION = re.compile(r'^//@(\w+)\("([^"]*)"\)\s*$')
_RE_FUNC_CALL = re.compile(r'([A-Z_][A-Z_0-9]*)\(([^)]*)\)')
_RE_ASSIGNMENT = re.compile(r'^(\w+)\s*=\s*(.+)$')
_RE_COMMENT = re.compile(r'^(#|//).*$')
_RE_IDENTIFIER = re.compile(r'^[a-zA-Z_]\w*$')

# Common typo map (lowercase -> correct)
_COMMON_TYPOS: dict[str, str] = {
    "rsii": "RSI",
    "rsi": "RSI",
    "ema_": "EMA",
    "emaa": "EMA",
    "smaa": "SMA",
    "macdd": "MACD",
    "mac": "MACD",
    "bollinger": "BB",
    "atrr": "ATR",
    "vwaap": "VWAP",
    "supretrend": "SUPERTREND",
    "supertrnd": "SUPERTREND",
    "adxx": "ADX",
}


# ---------------------------------------------------------------------------
# Error / Warning containers
# ---------------------------------------------------------------------------


class ValidationError:
    """A validation error with location, message, and suggested fix."""

    def __init__(self, line: int, message: str, suggestion: str = ""):
        self.line = line
        self.message = message
        self.suggestion = suggestion

    def to_dict(self) -> dict:
        return {
            "line": self.line,
            "message": self.message,
            "suggestion": self.suggestion,
        }


class ValidationWarning:
    """A validation warning with location and message."""

    def __init__(self, line: int, message: str):
        self.line = line
        self.message = message

    def to_dict(self) -> dict:
        return {"line": self.line, "message": self.message}


# ---------------------------------------------------------------------------
# Core validator
# ---------------------------------------------------------------------------


def _try_correct_indicator_name(name: str) -> str | None:
    """Attempt to find the correct indicator name for a potential typo."""
    upper = name.upper()
    if upper in INDICATORS:
        return upper

    # Check common typos
    lower = name.lower()
    if lower in _COMMON_TYPOS:
        return _COMMON_TYPOS[lower]

    # Fuzzy match against known indicators
    matches = get_close_matches(upper, INDICATOR_NAMES, n=1, cutoff=0.6)
    if matches:
        return matches[0]

    return None


def _validate_indicator_call(
    func_name: str,
    raw_args: str,
    line_num: int,
    errors: list[ValidationError],
    warnings: list[ValidationWarning],
    indicators_used: set[str],
) -> None:
    """Validate a single indicator function call."""
    corrected = _try_correct_indicator_name(func_name)

    if corrected is None:
        errors.append(
            ValidationError(
                line_num,
                f"Unknown indicator function '{func_name}'.",
                f"Known indicators: {', '.join(INDICATOR_NAMES)}",
            )
        )
        return

    if corrected != func_name:
        errors.append(
            ValidationError(
                line_num,
                f"Unknown indicator '{func_name}'.",
                f"Did you mean {corrected}?",
            )
        )
        # Continue validation using the corrected name
        func_name = corrected

    indicators_used.add(func_name)
    spec = INDICATORS[func_name]
    max_params = len(spec["params"])
    min_params = spec["min_params"]

    # Parse arguments
    args = [a.strip() for a in raw_args.split(",") if a.strip()] if raw_args.strip() else []

    if len(args) < min_params:
        example_args = ", ".join(spec["params"][:min_params])
        defaults_str = ", ".join(
            f"{k}={v}" for k, v in spec["defaults"].items()
        )
        suggestion = f"{func_name} requires at least {min_params} parameter(s)"
        if defaults_str:
            suggestion += f" (defaults: {defaults_str})"
        if spec["params"]:
            suggestion += f", e.g., {func_name}({example_args})"
        errors.append(ValidationError(line_num, f"Too few arguments for {func_name}().", suggestion))

    if len(args) > max_params:
        errors.append(
            ValidationError(
                line_num,
                f"Too many arguments for {func_name}(). Expected at most {max_params}, got {len(args)}.",
                f"{func_name} accepts: {', '.join(spec['params']) if spec['params'] else 'no parameters'}",
            )
        )

    # Validate source parameter if present and indicator expects one
    if args and "source" in spec["params"]:
        source = args[0]
        if _RE_IDENTIFIER.match(source) and source not in VALID_SOURCES:
            # Could be a user-defined variable — just warn
            pass

    # Validate numeric parameters (period, multiplier, etc.)
    for i, arg in enumerate(args):
        if i == 0 and "source" in spec["params"]:
            continue  # skip source
        param_index = i
        if "source" in spec["params"]:
            param_name = spec["params"][i] if i < len(spec["params"]) else None
        else:
            param_name = spec["params"][i] if i < len(spec["params"]) else None

        if param_name is None:
            continue

        # Try parsing as number
        try:
            val = float(arg)
        except ValueError:
            # Not a number — might be a variable reference; skip numeric checks
            continue

        # Range checks
        if param_name == "period":
            if val < 2:
                warnings.append(
                    ValidationWarning(
                        line_num,
                        f"{func_name} period of {int(val)} is very short (minimum recommended: 2).",
                    )
                )
            elif val > 500:
                warnings.append(
                    ValidationWarning(
                        line_num,
                        f"{func_name} period of {int(val)} is unusually long (maximum recommended: 500).",
                    )
                )


def _validate_line(
    line: str,
    line_num: int,
    errors: list[ValidationError],
    warnings: list[ValidationWarning],
    defined_vars: set[str],
    indicators_used: set[str],
) -> None:
    """Validate a single non-empty, non-comment line of strategy code."""

    stripped = line.strip()

    # --- Annotation lines ---
    ann_match = _RE_ANNOTATION.match(stripped)
    if ann_match:
        directive = ann_match.group(1)
        valid_directives = {"strategy", "timeframe", "version", "author"}
        if directive not in valid_directives:
            warnings.append(
                ValidationWarning(
                    line_num,
                    f"Unknown directive '//@{directive}'. Known directives: {', '.join(sorted(valid_directives))}.",
                )
            )
        return

    # Detect malformed annotations
    if stripped.startswith("//@"):
        errors.append(
            ValidationError(
                line_num,
                "Malformed annotation.",
                'Annotations should follow the pattern //@directive("value"), e.g., //@strategy("MyStrategy")',
            )
        )
        return

    # --- Assignment lines ---
    assign_match = _RE_ASSIGNMENT.match(stripped)
    if assign_match:
        var_name = assign_match.group(1)
        rhs = assign_match.group(2).strip()

        defined_vars.add(var_name)

        # Check for "and" / "or" instead of "AND" / "OR"
        if re.search(r'\band\b', rhs):
            errors.append(
                ValidationError(
                    line_num,
                    "Invalid logical operator 'and'.",
                    "Use 'AND' (uppercase) instead of 'and'.",
                )
            )
        if re.search(r'\bor\b', rhs):
            errors.append(
                ValidationError(
                    line_num,
                    "Invalid logical operator 'or'.",
                    "Use 'OR' (uppercase) instead of 'or'.",
                )
            )

        # Check for indicator calls in RHS
        for func_match in _RE_FUNC_CALL.finditer(rhs):
            func_name = func_match.group(1)
            func_args = func_match.group(2)
            _validate_indicator_call(
                func_name, func_args, line_num, errors, warnings, indicators_used
            )

        # Check for bare "=" that should be "==" in conditions for entry/exit/rule vars
        if var_name in SPECIAL_VARS:
            # RHS should be a boolean condition. Check for bare "= <number>"
            # patterns that are likely meant to be comparisons.
            bare_assign = re.match(r'^(\w+)\s*=\s*(\d+\.?\d*)$', rhs)
            if bare_assign:
                ref_var = bare_assign.group(1)
                ref_val = bare_assign.group(2)
                errors.append(
                    ValidationError(
                        line_num,
                        f"Assignment '{ref_var} = {ref_val}' inside a rule variable — did you mean a comparison?",
                        f"Did you mean '{ref_var} < {ref_val}' or '{ref_var} > {ref_val}' or '{ref_var} == {ref_val}'?",
                    )
                )

        return

    # --- Lines with indicator calls but no assignment (bare expressions) ---
    if _RE_FUNC_CALL.search(stripped):
        warnings.append(
            ValidationWarning(
                line_num,
                "Expression result is not assigned to a variable.",
            )
        )
        for func_match in _RE_FUNC_CALL.finditer(stripped):
            func_name = func_match.group(1)
            func_args = func_match.group(2)
            _validate_indicator_call(
                func_name, func_args, line_num, errors, warnings, indicators_used
            )
        return

    # --- Bare comparison line (not an assignment) ---
    # This can happen when someone writes "rsi > 70" without assigning to a variable
    has_comparison = any(op in stripped for op in COMPARISON_OPS)
    if has_comparison and "=" not in stripped.split(">")[0].split("<")[0].split("!")[0]:
        warnings.append(
            ValidationWarning(
                line_num,
                "Comparison expression is not assigned to a variable. "
                "Consider assigning it, e.g., 'long_entry = rsi > 70'.",
            )
        )
        return

    # If we get here and the line isn't blank/comment, it may be unparseable
    if stripped:
        errors.append(
            ValidationError(
                line_num,
                f"Unrecognized statement: '{stripped}'.",
                "Each line should be an assignment (var = expr), an annotation (//@directive(\"value\")), or a comment (# ...).",
            )
        )


def _semantic_analysis(
    defined_vars: set[str],
    indicators_used: set[str],
    warnings: list[ValidationWarning],
    total_lines: int,
) -> dict:
    """Perform semantic analysis after all lines are parsed."""

    has_entry = bool(defined_vars & ENTRY_VARS)
    has_exit = bool(defined_vars & EXIT_VARS)
    has_risk = bool(defined_vars & RISK_VARS)

    if not has_entry:
        warnings.append(
            ValidationWarning(
                0,
                "No entry rules defined. Define 'long_entry' or 'short_entry' for the strategy to generate signals.",
            )
        )

    if not has_exit:
        warnings.append(
            ValidationWarning(
                0,
                "No exit rules defined. Define 'long_exit' or 'short_exit' to close positions automatically.",
            )
        )

    if not has_risk:
        warnings.append(
            ValidationWarning(
                0,
                "No risk management defined. Consider adding 'stoploss' and/or 'target' to limit losses.",
            )
        )

    # Check for conflicting entries — both long and short entry defined
    if "long_entry" in defined_vars and "short_entry" in defined_vars:
        warnings.append(
            ValidationWarning(
                0,
                "Both 'long_entry' and 'short_entry' are defined. "
                "Ensure they cannot trigger simultaneously to avoid conflicting positions.",
            )
        )

    # Complexity score: based on indicator count, rule count, line count
    indicator_count = len(indicators_used)
    var_count = len(defined_vars)
    complexity = min(10, max(1, (indicator_count * 2) + (var_count // 2) + (total_lines // 10)))

    return {
        "indicators_used": sorted(indicators_used),
        "has_entry_rules": has_entry,
        "has_exit_rules": has_exit,
        "has_risk_management": has_risk,
        "complexity_score": complexity,
    }


def _check_rsi_levels(
    defined_vars: set[str],
    lines: list[str],
    warnings: list[ValidationWarning],
) -> None:
    """Warn if RSI comparison levels are outside 0-100."""
    rsi_level_pattern = re.compile(r'\brsi\w*\s*[<>=!]+\s*(-?\d+\.?\d*)', re.IGNORECASE)
    for i, line in enumerate(lines, start=1):
        stripped = line.strip()
        if stripped.startswith("#") or stripped.startswith("//"):
            continue
        for m in rsi_level_pattern.finditer(stripped):
            try:
                val = float(m.group(1))
                if val < 0 or val > 100:
                    warnings.append(
                        ValidationWarning(
                            i,
                            f"RSI level {val} is outside the normal range (0-100).",
                        )
                    )
            except ValueError:
                pass


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------


def validate_strategy(code: str, strategy_type: str = "script") -> dict:
    """Validate a trading strategy DSL script.

    Args:
        code: The strategy source code.
        strategy_type: "script" or "visual".

    Returns:
        Dict with keys: valid, errors, warnings, analysis.
    """
    errors: list[ValidationError] = []
    warnings: list[ValidationWarning] = []
    defined_vars: set[str] = set()
    indicators_used: set[str] = set()

    lines = code.split("\n") if code else []

    # Handle empty / whitespace-only code
    non_empty = [l for l in lines if l.strip() and not _RE_COMMENT.match(l.strip())]
    if not non_empty:
        errors.append(
            ValidationError(
                1,
                "Strategy code is empty or contains only comments.",
                "Add indicator calculations and entry/exit rules to define a strategy.",
            )
        )
        return {
            "valid": False,
            "errors": [e.to_dict() for e in errors],
            "warnings": [w.to_dict() for w in warnings],
            "analysis": {
                "indicators_used": [],
                "has_entry_rules": False,
                "has_exit_rules": False,
                "has_risk_management": False,
                "complexity_score": 1,
            },
        }

    # --- Line-by-line validation ---
    for line_num, raw_line in enumerate(lines, start=1):
        stripped = raw_line.strip()

        # Skip blank lines and comments
        if not stripped or _RE_COMMENT.match(stripped):
            continue

        _validate_line(
            stripped,
            line_num,
            errors,
            warnings,
            defined_vars,
            indicators_used,
        )

    # --- RSI level checks ---
    _check_rsi_levels(defined_vars, lines, warnings)

    # --- Semantic analysis ---
    analysis = _semantic_analysis(
        defined_vars, indicators_used, warnings, len(non_empty)
    )

    return {
        "valid": len(errors) == 0,
        "errors": [e.to_dict() for e in errors],
        "warnings": [w.to_dict() for w in warnings],
        "analysis": analysis,
    }
