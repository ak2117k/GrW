"""
PineScript-to-DSL Converter — converts TradingView PineScript code to the
TD Automation custom strategy DSL format.

Handles common PineScript patterns including indicator calls, entry/exit logic,
crossovers, input() defaults, and operator conversion.
"""

import logging
import re
from typing import Any

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# PineScript indicator mapping: ta.xxx(...) -> DSL equivalent
# ---------------------------------------------------------------------------

# Mapping of PineScript ta.xxx functions to DSL indicator names.
# Value is (dsl_name, arg_transform) where arg_transform is a callable or None.
_TA_INDICATOR_MAP: dict[str, str] = {
    "ta.rsi": "RSI",
    "ta.ema": "EMA",
    "ta.sma": "SMA",
    "ta.atr": "ATR",
    "ta.macd": "MACD",
    "ta.bb": "BB",
    "ta.supertrend": "SUPERTREND",
    "ta.adx": "ADX",
}

# Lines that start with these patterns are stripped entirely
_STRIP_PREFIXES = (
    "//@version",
    "strategy(",
    'strategy("',
    "indicator(",
    'indicator("',
    "plot(",
    "plotshape(",
    "plotchar(",
    "plotarrow(",
    "plotcandle(",
    "plotbar(",
    "bgcolor(",
    "barcolor(",
    "hline(",
    "fill(",
    "alertcondition(",
    "label.",
    "line.",
    "box.",
    "table.",
    "log.",
    "runtime.",
    "syminfo.",
    "import ",
    "export ",
    "library(",
    "method ",
    "type ",
)

# Patterns for lines we always strip (regex)
_STRIP_PATTERNS = [
    re.compile(r"^\s*//@version\s*=?\s*\d+\s*$"),
    re.compile(r'^\s*strategy\s*\('),
    re.compile(r'^\s*indicator\s*\('),
    re.compile(r'^\s*plot\w*\s*\('),
    re.compile(r'^\s*bgcolor\s*\('),
    re.compile(r'^\s*barcolor\s*\('),
    re.compile(r'^\s*hline\s*\('),
    re.compile(r'^\s*fill\s*\('),
    re.compile(r'^\s*alertcondition\s*\('),
    re.compile(r'^\s*var\s+'),  # var declarations (PineScript persistence)
    re.compile(r'^\s*varip\s+'),
]

# ---------------------------------------------------------------------------
# Regex patterns for PineScript constructs
# ---------------------------------------------------------------------------

# ta.xxx(args) call
_RE_TA_CALL = re.compile(r'ta\.(\w+)\s*\(([^)]*)\)')

# ta.vwap (no parens) or ta.vwap(source)
_RE_TA_VWAP = re.compile(r'ta\.vwap\b(?:\s*\([^)]*\))?')

# ta.crossover(a, b) and ta.crossunder(a, b)
_RE_CROSSOVER = re.compile(r'ta\.crossover\s*\(\s*([^,]+?)\s*,\s*([^)]+?)\s*\)')
_RE_CROSSUNDER = re.compile(r'ta\.crossunder\s*\(\s*([^,]+?)\s*,\s*([^)]+?)\s*\)')

# input() calls: input(defval=14, ...) or input.int(14, ...) etc.
_RE_INPUT_CALL = re.compile(
    r'input(?:\.(?:int|float|bool|string|source|timeframe|color))?\s*\(([^)]*)\)'
)

# strategy.entry
_RE_STRATEGY_ENTRY = re.compile(
    r'strategy\.entry\s*\(\s*["\'](\w+)["\']\s*,\s*strategy\.(long|short)\s*(?:,\s*([^)]*))?\)'
)

# strategy.close
_RE_STRATEGY_CLOSE = re.compile(
    r'strategy\.close\s*\(\s*["\'](\w+)["\']\s*\)'
)

# strategy.exit with stop/limit
_RE_STRATEGY_EXIT = re.compile(
    r'strategy\.exit\s*\(\s*["\'](\w+)["\']\s*(?:,\s*["\'](\w+)["\'])?\s*(?:,\s*(.+?))?\s*\)'
)

# if (condition) ... on a single line
_RE_IF_ENTRY = re.compile(
    r'if\s*\(?\s*(.+?)\s*\)?\s*\n?\s*strategy\.entry\s*\(\s*["\'](\w+)["\']\s*,\s*strategy\.(long|short)',
    re.MULTILINE,
)

# Single-line if + strategy.entry
_RE_IF_ENTRY_SINGLE = re.compile(
    r'^\s*if\s+(.+?)\s*$'
)

# Pine operators to DSL operators
_RE_AND = re.compile(r'\band\b')
_RE_OR = re.compile(r'\bor\b')
_RE_NOT = re.compile(r'\bnot\b')

# Assignment with := (Pine reassignment)
_RE_REASSIGN = re.compile(r':=')

# Pine ternary: cond ? a : b
_RE_TERNARY = re.compile(r'(.+?)\s*\?\s*(.+?)\s*:\s*(.+)')

# math.xxx calls
_RE_MATH_CALL = re.compile(r'math\.(\w+)\s*\(')

# Pine built-in variables to strip or ignore
_UNSUPPORTED_BUILTINS = {
    "bar_index", "time", "timenow", "last_bar_index",
    "na", "nz", "fixnan",
    "color.new", "color.rgb",
}

# MACD tuple destructuring: [macdLine, signalLine, hist] = ta.macd(...)
_RE_MACD_TUPLE = re.compile(
    r'\[([^,\]]+),\s*([^,\]]+),\s*([^\]]+)\]\s*=\s*ta\.macd\s*\(([^)]*)\)'
)

# BB tuple destructuring: [middle, upper, lower] = ta.bb(...)
_RE_BB_TUPLE = re.compile(
    r'\[([^,\]]+),\s*([^,\]]+),\s*([^\]]+)\]\s*=\s*ta\.bb\s*\(([^)]*)\)'
)


# ---------------------------------------------------------------------------
# Input extraction
# ---------------------------------------------------------------------------

def _extract_input_default(input_call: str) -> str:
    """Extract the default value from a PineScript input() call.

    Handles patterns like:
      input(14)
      input(defval=14, title="RSI Length")
      input.int(14, "RSI Length", ...)
      input.float(1.5, "Multiplier")
    """
    args = input_call.strip()

    # Check for defval= keyword argument
    defval_match = re.search(r'defval\s*=\s*([^,)]+)', args)
    if defval_match:
        return defval_match.group(1).strip().strip('"').strip("'")

    # Otherwise take the first positional argument
    parts = args.split(",")
    if parts:
        first = parts[0].strip().strip('"').strip("'")
        # Skip if the first arg is clearly a title string
        if first and not first.startswith('"') and not first.startswith("'"):
            return first

    return "14"  # fallback default


# ---------------------------------------------------------------------------
# Core conversion logic
# ---------------------------------------------------------------------------

def _should_strip_line(line: str) -> tuple[bool, str]:
    """Check if a line should be stripped from output.

    Returns (should_strip, reason).
    """
    stripped = line.strip()

    if not stripped:
        return False, ""

    # Comments are kept (converted to DSL comment style)
    if stripped.startswith("//"):
        # But strip //@version lines
        if stripped.startswith("//@version"):
            return True, "PineScript version directive"
        return False, ""

    # Check against strip patterns
    for pattern in _STRIP_PATTERNS:
        if pattern.match(stripped):
            return True, "Unsupported PineScript construct"

    # Check prefix-based stripping
    stripped_lower = stripped.lower()
    for prefix in _STRIP_PREFIXES:
        if stripped_lower.startswith(prefix.lower()):
            return True, f"Unsupported PineScript construct ({prefix.rstrip('(')})"

    return False, ""


def _convert_ta_calls(line: str) -> str:
    """Convert ta.xxx() calls to DSL indicator calls."""

    # Handle ta.vwap specially (can appear without parens)
    line = _RE_TA_VWAP.sub("VWAP()", line)

    # Handle crossover/crossunder before general ta calls
    line = _RE_CROSSOVER.sub(r'\1 CROSSES_ABOVE \2', line)
    line = _RE_CROSSUNDER.sub(r'\1 CROSSES_BELOW \2', line)

    # Handle MACD tuple destructuring
    macd_tuple = _RE_MACD_TUPLE.search(line)
    if macd_tuple:
        macd_var = macd_tuple.group(1).strip()
        signal_var = macd_tuple.group(2).strip()
        hist_var = macd_tuple.group(3).strip()
        args = macd_tuple.group(4).strip()
        # Return multiple lines joined with newline
        lines = [
            f"{macd_var} = MACD({args}).macd",
            f"{signal_var} = MACD({args}).signal",
            f"{hist_var} = MACD({args}).hist",
        ]
        return "\n".join(lines)

    # Handle BB tuple destructuring
    bb_tuple = _RE_BB_TUPLE.search(line)
    if bb_tuple:
        middle_var = bb_tuple.group(1).strip()
        upper_var = bb_tuple.group(2).strip()
        lower_var = bb_tuple.group(3).strip()
        args = bb_tuple.group(4).strip()
        lines = [
            f"{middle_var} = BB({args}).middle",
            f"{upper_var} = BB({args}).upper",
            f"{lower_var} = BB({args}).lower",
        ]
        return "\n".join(lines)

    # General ta.xxx(args) -> DSL(args)
    def replace_ta_call(match: re.Match) -> str:
        func_name = match.group(1).lower()
        args = match.group(2).strip()
        ta_key = f"ta.{func_name}"

        if ta_key in _TA_INDICATOR_MAP:
            dsl_name = _TA_INDICATOR_MAP[ta_key]
            return f"{dsl_name}({args})"

        # Unknown ta function — leave as-is but uppercase
        return f"{func_name.upper()}({args})"

    line = _RE_TA_CALL.sub(replace_ta_call, line)

    return line


def _convert_operators(line: str) -> str:
    """Convert PineScript logical operators to DSL operators."""
    line = _RE_AND.sub("AND", line)
    line = _RE_OR.sub("OR", line)
    line = _RE_NOT.sub("NOT", line)
    return line


def _convert_input_calls(line: str) -> tuple[str, list[str]]:
    """Replace input() calls with their default values.

    Returns (converted_line, list_of_warnings).
    """
    warnings: list[str] = []

    def replace_input(match: re.Match) -> str:
        default_val = _extract_input_default(match.group(1))
        warnings.append(
            f"input() call replaced with default value: {default_val}"
        )
        return default_val

    converted = _RE_INPUT_CALL.sub(replace_input, line)
    return converted, warnings


def _convert_reassignment(line: str) -> str:
    """Convert := (Pine reassignment) to = (DSL assignment)."""
    return _RE_REASSIGN.sub("=", line)


def _convert_math_calls(line: str) -> str:
    """Convert math.xxx() to plain function calls (best effort)."""
    def replace_math(match: re.Match) -> str:
        func = match.group(1)
        return f"{func}("

    return _RE_MATH_CALL.sub(replace_math, line)


# ---------------------------------------------------------------------------
# Entry/Exit extraction (multi-line aware)
# ---------------------------------------------------------------------------

def _extract_entry_exit_blocks(code: str) -> tuple[list[str], list[dict]]:
    """Extract strategy.entry/exit/close patterns and convert them.

    Handles multi-line if blocks:
        if condition
            strategy.entry(...)

    Returns (dsl_lines, unsupported_entries).
    """
    dsl_lines: list[str] = []
    unsupported: list[dict] = []

    lines = code.split("\n")
    i = 0
    processed_line_numbers: set[int] = set()

    while i < len(lines):
        stripped = lines[i].strip()

        # Check for if + strategy.entry on next line
        if stripped.startswith("if ") or stripped.startswith("if("):
            condition = stripped[2:].strip().lstrip("(").rstrip(")")

            # Look ahead for strategy calls on the next indented line(s)
            j = i + 1
            found_strategy = False
            while j < len(lines) and (not lines[j].strip() or lines[j].startswith("    ") or lines[j].startswith("\t")):
                next_stripped = lines[j].strip()

                # strategy.entry
                entry_match = _RE_STRATEGY_ENTRY.search(next_stripped)
                if entry_match:
                    direction = entry_match.group(2).lower()
                    rule_name = f"{direction}_entry"
                    condition = _convert_ta_calls(condition)
                    condition = _convert_operators(condition)
                    dsl_lines.append(f"{rule_name} = {condition}")
                    processed_line_numbers.add(i)
                    processed_line_numbers.add(j)
                    found_strategy = True
                    break

                # strategy.close
                close_match = _RE_STRATEGY_CLOSE.search(next_stripped)
                if close_match:
                    label = close_match.group(1).lower()
                    direction = "long" if "long" in label.lower() else "short"
                    rule_name = f"{direction}_exit"
                    condition = _convert_ta_calls(condition)
                    condition = _convert_operators(condition)
                    dsl_lines.append(f"{rule_name} = {condition}")
                    processed_line_numbers.add(i)
                    processed_line_numbers.add(j)
                    found_strategy = True
                    break

                j += 1

            if found_strategy:
                i = j + 1
                continue

        # Check for strategy.exit on its own line (risk management)
        exit_match = _RE_STRATEGY_EXIT.search(stripped)
        if exit_match:
            rest = exit_match.group(3) or ""
            # Extract stop and limit values
            stop_match = re.search(r'stop\s*=\s*([^,)]+)', rest)
            limit_match = re.search(r'limit\s*=\s*([^,)]+)', rest)
            profit_match = re.search(r'profit\s*=\s*([^,)]+)', rest)
            loss_match = re.search(r'loss\s*=\s*([^,)]+)', rest)

            if stop_match:
                val = _convert_ta_calls(stop_match.group(1).strip())
                dsl_lines.append(f"stoploss = {val}")
            if loss_match:
                val = _convert_ta_calls(loss_match.group(1).strip())
                dsl_lines.append(f"stoploss = {val}")
            if limit_match:
                val = _convert_ta_calls(limit_match.group(1).strip())
                dsl_lines.append(f"target = {val}")
            if profit_match:
                val = _convert_ta_calls(profit_match.group(1).strip())
                dsl_lines.append(f"target = {val}")

            processed_line_numbers.add(i)
            i += 1
            continue

        # Single-line strategy.entry
        entry_match = _RE_STRATEGY_ENTRY.search(stripped)
        if entry_match and stripped.startswith("strategy."):
            # Bare entry without condition — can't convert meaningfully
            unsupported.append({
                "line": i + 1,
                "original": stripped,
                "reason": "strategy.entry() without a condition cannot be converted",
            })
            processed_line_numbers.add(i)
            i += 1
            continue

        i += 1

    return dsl_lines, unsupported


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------


async def convert_pinescript(code: str) -> dict[str, Any]:
    """Convert PineScript code to the TD Automation DSL format.

    Args:
        code: The PineScript source code to convert.

    Returns:
        Dict with keys:
            - converted_code: The DSL code string.
            - warnings: List of warning strings.
            - unsupported_lines: List of dicts with line, original, reason.
    """
    if not code or not code.strip():
        return {
            "converted_code": "",
            "warnings": ["Empty PineScript code provided."],
            "unsupported_lines": [],
        }

    warnings: list[str] = []
    unsupported_lines: list[dict[str, Any]] = []
    dsl_output_lines: list[str] = []

    # First pass: extract entry/exit blocks (multi-line patterns)
    entry_exit_lines, entry_exit_unsupported = _extract_entry_exit_blocks(code)
    unsupported_lines.extend(entry_exit_unsupported)

    # Track which line numbers were consumed by entry/exit extraction
    # We re-process all lines but skip strategy.entry/close/exit lines
    lines = code.split("\n")

    for line_num_0, raw_line in enumerate(lines):
        line_num = line_num_0 + 1
        stripped = raw_line.strip()

        # Skip empty lines (but preserve blank line spacing)
        if not stripped:
            if dsl_output_lines and dsl_output_lines[-1] != "":
                dsl_output_lines.append("")
            continue

        # Strip unsupported lines
        should_strip, reason = _should_strip_line(stripped)
        if should_strip:
            unsupported_lines.append({
                "line": line_num,
                "original": stripped,
                "reason": reason,
            })
            continue

        # Skip lines that contain strategy.entry/exit/close (handled above)
        if re.search(r'strategy\.(entry|exit|close)\s*\(', stripped):
            continue

        # Skip bare 'if' lines that precede a strategy call (already handled)
        if stripped.startswith("if ") or stripped.startswith("if("):
            # Check if next line has a strategy call
            next_idx = line_num_0 + 1
            if next_idx < len(lines) and re.search(
                r'strategy\.(entry|exit|close)\s*\(', lines[next_idx].strip()
            ):
                continue

        # Keep comments (convert // to //)
        if stripped.startswith("//"):
            dsl_output_lines.append(stripped)
            continue

        # Convert the line
        converted = stripped

        # Handle input() calls first
        converted, input_warnings = _convert_input_calls(converted)
        for w in input_warnings:
            warnings.append(f"Line {line_num}: {w}")

        # Convert ta.xxx calls
        converted = _convert_ta_calls(converted)

        # Convert operators
        converted = _convert_operators(converted)

        # Convert := to =
        converted = _convert_reassignment(converted)

        # Convert math.xxx calls
        converted = _convert_math_calls(converted)

        # Strip type declarations (int, float, bool, string prefix)
        converted = re.sub(r'^\s*(int|float|bool|string)\s+', '', converted)

        # Handle for/while loops — not supported
        if re.match(r'^\s*(for|while)\b', converted):
            unsupported_lines.append({
                "line": line_num,
                "original": stripped,
                "reason": "Loop constructs are not supported in DSL",
            })
            continue

        # Handle function definitions — not supported
        if re.match(r'^\s*\w+\s*\([^)]*\)\s*=>', converted):
            unsupported_lines.append({
                "line": line_num,
                "original": stripped,
                "reason": "Function definitions are not supported in DSL",
            })
            continue

        # Handle switch/if-else blocks
        if re.match(r'^\s*(switch|else)\b', converted):
            unsupported_lines.append({
                "line": line_num,
                "original": stripped,
                "reason": "Control flow constructs are not supported in DSL",
            })
            continue

        # Strip remaining indentation
        converted = converted.strip()

        # Skip lines that are just closing brackets or empty after conversion
        if converted in ("", ")", "}"):
            continue

        # If the converted line has multi-line output (e.g., tuple destructuring)
        if "\n" in converted:
            for sub_line in converted.split("\n"):
                dsl_output_lines.append(sub_line)
        else:
            dsl_output_lines.append(converted)

    # Append entry/exit lines from the extraction pass
    if entry_exit_lines:
        if dsl_output_lines and dsl_output_lines[-1] != "":
            dsl_output_lines.append("")
        dsl_output_lines.append("// Entry/Exit rules")
        dsl_output_lines.extend(entry_exit_lines)

    # Clean up consecutive blank lines
    cleaned: list[str] = []
    for line in dsl_output_lines:
        if line == "" and cleaned and cleaned[-1] == "":
            continue
        cleaned.append(line)

    # Strip trailing blank lines
    while cleaned and cleaned[-1] == "":
        cleaned.pop()

    converted_code = "\n".join(cleaned)

    # Add summary warnings
    if unsupported_lines:
        warnings.append(
            f"{len(unsupported_lines)} line(s) were stripped as unsupported PineScript constructs."
        )

    if not entry_exit_lines:
        warnings.append(
            "No entry/exit rules were detected. You may need to manually add "
            "long_entry, short_entry, long_exit, and short_exit rules."
        )

    logger.info(
        "PineScript conversion complete: %d lines -> %d DSL lines, %d warnings",
        len(lines),
        len(cleaned),
        len(warnings),
    )

    return {
        "converted_code": converted_code,
        "warnings": warnings,
        "unsupported_lines": unsupported_lines,
    }
