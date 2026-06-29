import { Injectable, Logger } from '@nestjs/common';
import {
  SUPPORTED_INDICATORS,
  IndicatorConfig,
  RuleConfig,
  IndicatorType,
} from '../dto/user-strategy.dto';

// ── Public types ─────────────────────────────────────────────────────

export interface ParsedIndicator {
  /** Variable name the user assigned, e.g. "rsi" */
  variable: string;
  /** Canonical indicator type */
  type: IndicatorType;
  /** Source field the indicator reads from (close, high, low, etc.) */
  source: string;
  /** Primary period / length */
  period: number;
  /** Additional numeric params (MACD fast/slow/signal, etc.) */
  extraParams: number[];
  /** For MACD-style multi-output: sub-variable names */
  outputs?: string[];
}

export interface ParsedRule {
  operator: 'AND' | 'OR';
  conditions: ParsedCondition[];
}

export interface ParsedCondition {
  left: ConditionOperand;
  comparator: '<' | '>' | '<=' | '>=' | '==' | 'CROSSES_ABOVE' | 'CROSSES_BELOW';
  right: ConditionOperand;
}

export interface ConditionOperand {
  type: 'variable' | 'number' | 'expression';
  /** Variable reference ("rsi", "ema_fast") */
  variable?: string;
  /** Literal number */
  value?: number;
  /** For ATR(14) * 1.5 style expressions */
  expression?: { variable: string; operator: '*' | '+' | '-' | '/'; value: number };
}

export interface ParsedStrategy {
  name: string;
  timeframe: string;
  indicators: ParsedIndicator[];
  entryRules: { long: ParsedRule; short: ParsedRule };
  exitRules: { long: ParsedRule; short: ParsedRule };
  riskConfig: { stoploss: ConditionOperand | null; target: ConditionOperand | null };
}

export interface ParseError {
  line: number;
  message: string;
  suggestion?: string;
}

export interface ParseResult {
  valid: boolean;
  errors: ParseError[];
  warnings: ParseError[];
  parsed?: ParsedStrategy;
}

// ── Indicator metadata ───────────────────────────────────────────────

interface IndicatorMeta {
  minParams: number;
  maxParams: number;
  defaultParams: number[];
  outputs: number; // how many values it returns
  description: string;
}

const INDICATOR_META: Record<string, IndicatorMeta> = {
  RSI:        { minParams: 1, maxParams: 2, defaultParams: [14],           outputs: 1, description: 'Relative Strength Index' },
  EMA:        { minParams: 1, maxParams: 2, defaultParams: [20],           outputs: 1, description: 'Exponential Moving Average' },
  SMA:        { minParams: 1, maxParams: 2, defaultParams: [20],           outputs: 1, description: 'Simple Moving Average' },
  MACD:       { minParams: 1, maxParams: 4, defaultParams: [12, 26, 9],    outputs: 3, description: 'MACD (line, signal, histogram)' },
  VWAP:       { minParams: 0, maxParams: 0, defaultParams: [],             outputs: 1, description: 'Volume Weighted Average Price' },
  BB:         { minParams: 1, maxParams: 3, defaultParams: [20, 2],        outputs: 3, description: 'Bollinger Bands (upper, middle, lower)' },
  ATR:        { minParams: 1, maxParams: 1, defaultParams: [14],           outputs: 1, description: 'Average True Range' },
  SUPERTREND: { minParams: 1, maxParams: 2, defaultParams: [10, 3],        outputs: 1, description: 'Supertrend' },
  ADX:        { minParams: 1, maxParams: 1, defaultParams: [14],           outputs: 1, description: 'Average Directional Index' },
  VOLUME:     { minParams: 0, maxParams: 0, defaultParams: [],             outputs: 1, description: 'Volume' },
  OI:         { minParams: 0, maxParams: 0, defaultParams: [],             outputs: 1, description: 'Open Interest' },
};

// ── Service ──────────────────────────────────────────────────────────

@Injectable()
export class StrategyParserService {
  private readonly logger = new Logger(StrategyParserService.name);

  // ────────────────────────────────────────────────────────────────────
  // Public API
  // ────────────────────────────────────────────────────────────────────

  /**
   * Parse and validate a strategy. Dispatches to the correct parser
   * based on type ('script' or 'visual').
   */
  parse(code: string, type: 'script' | 'visual'): ParseResult {
    if (type === 'visual') {
      return this.parseVisual(code);
    }
    return this.parseScript(code);
  }

  // ────────────────────────────────────────────────────────────────────
  // Visual / JSON mode
  // ────────────────────────────────────────────────────────────────────

  parseVisual(jsonString: string): ParseResult {
    const errors: ParseError[] = [];
    const warnings: ParseError[] = [];

    let data: any;
    try {
      data = JSON.parse(jsonString);
    } catch {
      errors.push({ line: 1, message: 'Invalid JSON', suggestion: 'Ensure the strategy definition is valid JSON' });
      return { valid: false, errors, warnings };
    }

    const indicators: ParsedIndicator[] = [];

    // Validate indicators
    if (Array.isArray(data.indicators)) {
      for (let i = 0; i < data.indicators.length; i++) {
        const ind: IndicatorConfig = data.indicators[i];
        if (!SUPPORTED_INDICATORS.includes(ind.type as any)) {
          errors.push({
            line: 1,
            message: `Unknown indicator type "${ind.type}"`,
            suggestion: `Supported indicators: ${SUPPORTED_INDICATORS.join(', ')}`,
          });
          continue;
        }
        const meta = INDICATOR_META[ind.type];
        const period = ind.period ?? meta.defaultParams[0] ?? 0;
        if (meta.minParams > 0 && period < 1) {
          errors.push({ line: 1, message: `${ind.type} period must be >= 1` });
        }
        indicators.push({
          variable: `${ind.type.toLowerCase()}_${i}`,
          type: ind.type as IndicatorType,
          source: 'close',
          period,
          extraParams: Object.values(ind.params ?? {}),
        });
      }
    }

    // Validate rules
    const validateRules = (rules: RuleConfig[] | undefined, label: string): ParsedRule => {
      const conditions: ParsedCondition[] = [];
      if (!rules || rules.length === 0) {
        warnings.push({ line: 1, message: `No ${label} rules defined` });
        return { operator: 'AND', conditions: [] };
      }
      for (const rule of rules) {
        const toOperand = (op: any): ConditionOperand => {
          if (op.value !== undefined) return { type: 'number', value: op.value };
          if (op.indicator) return { type: 'variable', variable: `${op.indicator.toLowerCase()}_0` };
          return { type: 'number', value: 0 };
        };
        const comparatorMap: Record<string, ParsedCondition['comparator']> = {
          CROSSES_ABOVE: 'CROSSES_ABOVE',
          CROSSES_BELOW: 'CROSSES_BELOW',
          GREATER_THAN: '>',
          LESS_THAN: '<',
        };
        const comparator = comparatorMap[rule.condition] ?? '>';
        conditions.push({ left: toOperand(rule.left), comparator, right: toOperand(rule.right) });
      }
      return { operator: 'AND', conditions };
    };

    const entryRule = validateRules(data.entryRules, 'entry');
    const exitRule = validateRules(data.exitRules, 'exit');

    if (errors.length > 0) {
      return { valid: false, errors, warnings };
    }

    return {
      valid: true,
      errors: [],
      warnings,
      parsed: {
        name: data.name ?? 'Untitled Visual Strategy',
        timeframe: data.timeframes?.[0] ?? '15m',
        indicators,
        entryRules: { long: entryRule, short: { operator: 'AND', conditions: [] } },
        exitRules: { long: exitRule, short: { operator: 'AND', conditions: [] } },
        riskConfig: { stoploss: null, target: null },
      },
    };
  }

  // ────────────────────────────────────────────────────────────────────
  // Script mode (Pine Script-like DSL)
  // ────────────────────────────────────────────────────────────────────

  parseScript(code: string): ParseResult {
    const errors: ParseError[] = [];
    const warnings: ParseError[] = [];
    const lines = code.split('\n');

    let strategyName = 'Untitled Strategy';
    let timeframe = '15m';
    const indicators: ParsedIndicator[] = [];
    const variableMap = new Map<string, ParsedIndicator>();
    // Multi-output variable map: "macd" -> indicator, "signal" -> same indicator output index 1
    const multiOutputMap = new Map<string, { indicator: ParsedIndicator; outputIndex: number }>();
    const entryLong: ParsedCondition[] = [];
    const entryShort: ParsedCondition[] = [];
    const exitLong: ParsedCondition[] = [];
    const exitShort: ParsedCondition[] = [];
    let stoploss: ConditionOperand | null = null;
    let target: ConditionOperand | null = null;

    for (let i = 0; i < lines.length; i++) {
      const lineNum = i + 1;
      const raw = lines[i];
      const trimmed = raw.trim();

      // Skip empty lines and pure comments (that aren't directives)
      if (trimmed === '' || (trimmed.startsWith('//') && !trimmed.startsWith('//@'))) {
        continue;
      }

      // Strip inline comments
      const line = trimmed.replace(/\/\/(?!@).*$/, '').trim();
      if (line === '') continue;

      // ── Directives ────────────────────────────────────────────────
      if (line.startsWith('//@strategy')) {
        const match = line.match(/\/\/@strategy\s*\(\s*"([^"]+)"\s*\)/);
        if (match) {
          strategyName = match[1];
        } else {
          errors.push({
            line: lineNum,
            message: 'Invalid @strategy directive',
            suggestion: 'Use: //@strategy("My Strategy Name")',
          });
        }
        continue;
      }
      if (line.startsWith('//@timeframe')) {
        const match = line.match(/\/\/@timeframe\s*\(\s*"([^"]+)"\s*\)/);
        if (match) {
          timeframe = match[1];
        } else {
          errors.push({
            line: lineNum,
            message: 'Invalid @timeframe directive',
            suggestion: 'Use: //@timeframe("15m")',
          });
        }
        continue;
      }

      // ── Assignment lines ──────────────────────────────────────────
      const assignMatch = line.match(/^([a-zA-Z_][\w]*(?:\s*,\s*[a-zA-Z_][\w]*)*)\s*=\s*(.+)$/);
      if (!assignMatch) {
        errors.push({
          line: lineNum,
          message: `Syntax error: cannot parse line "${trimmed}"`,
          suggestion: 'Expected format: variable = INDICATOR(source, params) or variable = condition',
        });
        continue;
      }

      const lhsRaw = assignMatch[1];
      const rhs = assignMatch[2].trim();

      // Check if RHS is an indicator call
      const indicatorCallMatch = rhs.match(/^([A-Z_]+)\s*\(([^)]*)\)$/);
      if (indicatorCallMatch) {
        const indName = indicatorCallMatch[1];
        const argsRaw = indicatorCallMatch[2];

        if (!INDICATOR_META[indName]) {
          errors.push({
            line: lineNum,
            message: `Unknown indicator "${indName}"`,
            suggestion: `Supported indicators: ${Object.keys(INDICATOR_META).join(', ')}`,
          });
          continue;
        }

        const meta = INDICATOR_META[indName];
        const args = argsRaw.split(',').map((a) => a.trim()).filter(Boolean);

        // First arg can be a source field (close, open, high, low)
        let source = 'close';
        const numericArgs: number[] = [];
        for (const arg of args) {
          if (['close', 'open', 'high', 'low', 'volume'].includes(arg)) {
            source = arg;
          } else {
            const num = Number(arg);
            if (isNaN(num)) {
              errors.push({
                line: lineNum,
                message: `Invalid parameter "${arg}" for ${indName}`,
                suggestion: `Parameters must be numbers or source fields (close, open, high, low, volume)`,
              });
            } else if (num <= 0) {
              errors.push({
                line: lineNum,
                message: `Parameter ${num} for ${indName} must be > 0`,
              });
            } else {
              numericArgs.push(num);
            }
          }
        }

        // Fill defaults where needed
        const period = numericArgs[0] ?? meta.defaultParams[0] ?? 1;
        const extraParams = numericArgs.slice(1);

        // Handle multi-output (e.g., "macd, signal, hist = MACD(...)")
        const lhsVars = lhsRaw.split(',').map((v) => v.trim());
        if (lhsVars.length > 1 && lhsVars.length !== meta.outputs) {
          errors.push({
            line: lineNum,
            message: `${indName} returns ${meta.outputs} values but ${lhsVars.length} variables given`,
            suggestion: `${indName} returns ${meta.outputs} value(s). Adjust the variable list.`,
          });
          continue;
        }

        const parsed: ParsedIndicator = {
          variable: lhsVars[0],
          type: indName as IndicatorType,
          source,
          period,
          extraParams,
          outputs: lhsVars.length > 1 ? lhsVars : undefined,
        };

        indicators.push(parsed);
        variableMap.set(lhsVars[0], parsed);

        if (lhsVars.length > 1) {
          for (let oi = 0; oi < lhsVars.length; oi++) {
            multiOutputMap.set(lhsVars[oi], { indicator: parsed, outputIndex: oi });
          }
        }

        continue;
      }

      // ── Condition assignment ──────────────────────────────────────
      const lhsName = lhsRaw.trim();
      const isEntry = lhsName.startsWith('long_entry') || lhsName.startsWith('short_entry');
      const isExit = lhsName.startsWith('long_exit') || lhsName.startsWith('short_exit');
      const isRisk = lhsName === 'stoploss' || lhsName === 'target';

      if (isRisk) {
        const riskOperand = this.parseOperand(rhs, variableMap, multiOutputMap);
        if (!riskOperand) {
          errors.push({
            line: lineNum,
            message: `Cannot parse risk expression: "${rhs}"`,
            suggestion: 'Use: stoploss = ATR(14) * 1.5 or stoploss = 50',
          });
        } else if (lhsName === 'stoploss') {
          stoploss = riskOperand;
        } else {
          target = riskOperand;
        }
        continue;
      }

      if (!isEntry && !isExit) {
        // Could be a computed variable reference — treat as inline expression for conditions later
        // For now, store as a virtual indicator
        const operand = this.parseOperand(rhs, variableMap, multiOutputMap);
        if (operand && operand.type === 'expression' && operand.expression) {
          // Store as derived variable
          const fakeIndicator: ParsedIndicator = {
            variable: lhsName,
            type: 'ATR' as IndicatorType, // placeholder — the actual value will be resolved at runtime
            source: 'close',
            period: 0,
            extraParams: [],
          };
          variableMap.set(lhsName, fakeIndicator);
          warnings.push({
            line: lineNum,
            message: `Variable "${lhsName}" treated as derived expression — may not be fully supported`,
          });
        } else {
          errors.push({
            line: lineNum,
            message: `Unknown assignment target "${lhsName}"`,
            suggestion: 'Entry conditions must start with long_entry/short_entry, exit with long_exit/short_exit, or risk with stoploss/target',
          });
        }
        continue;
      }

      // Parse conditions joined by AND / OR
      const parsedConds = this.parseConditionExpression(rhs, lineNum, variableMap, multiOutputMap, errors);
      if (parsedConds) {
        if (lhsName.startsWith('long_entry')) entryLong.push(...parsedConds.conditions);
        else if (lhsName.startsWith('short_entry')) entryShort.push(...parsedConds.conditions);
        else if (lhsName.startsWith('long_exit')) exitLong.push(...parsedConds.conditions);
        else if (lhsName.startsWith('short_exit')) exitShort.push(...parsedConds.conditions);
      }
    }

    // ── Validation warnings ──────────────────────────────────────────
    if (indicators.length === 0) {
      warnings.push({ line: 1, message: 'No indicators defined — strategy will have no signals' });
    }
    if (entryLong.length === 0 && entryShort.length === 0) {
      warnings.push({ line: 1, message: 'No entry conditions defined' });
    }
    if (exitLong.length === 0 && exitShort.length === 0) {
      warnings.push({ line: 1, message: 'No exit conditions defined — positions may never close' });
    }

    if (errors.length > 0) {
      return { valid: false, errors, warnings };
    }

    return {
      valid: true,
      errors: [],
      warnings,
      parsed: {
        name: strategyName,
        timeframe,
        indicators,
        entryRules: {
          long: { operator: 'AND', conditions: entryLong },
          short: { operator: 'AND', conditions: entryShort },
        },
        exitRules: {
          long: { operator: 'OR', conditions: exitLong },
          short: { operator: 'OR', conditions: exitShort },
        },
        riskConfig: { stoploss, target },
      },
    };
  }

  // ────────────────────────────────────────────────────────────────────
  // Helpers
  // ────────────────────────────────────────────────────────────────────

  /**
   * Parse a compound condition expression like:
   *   rsi < 30 AND ema_fast > ema_slow AND hist > 0
   *
   * We split on AND/OR and parse each atomic condition.
   */
  private parseConditionExpression(
    expr: string,
    lineNum: number,
    variableMap: Map<string, ParsedIndicator>,
    multiOutputMap: Map<string, { indicator: ParsedIndicator; outputIndex: number }>,
    errors: ParseError[],
  ): ParsedRule | null {
    // Determine top-level operator. We support a single operator type per line.
    const hasAnd = / AND /i.test(expr);
    const hasOr = / OR /i.test(expr);
    const operator: 'AND' | 'OR' = hasOr && !hasAnd ? 'OR' : 'AND';

    const splitter = hasOr ? / OR /i : / AND /i;
    const parts = expr.split(splitter).map((p) => p.trim());

    const conditions: ParsedCondition[] = [];

    for (const part of parts) {
      const cond = this.parseAtomicCondition(part, lineNum, variableMap, multiOutputMap);
      if (!cond) {
        errors.push({
          line: lineNum,
          message: `Cannot parse condition: "${part}"`,
          suggestion: 'Expected format: indicator <|>|<=|>=|== value  (e.g., rsi < 30)',
        });
        return null;
      }
      conditions.push(cond);
    }

    return { operator, conditions };
  }

  /**
   * Parse a single atomic condition like "rsi < 30" or "ema_fast > ema_slow"
   */
  private parseAtomicCondition(
    expr: string,
    lineNum: number,
    variableMap: Map<string, ParsedIndicator>,
    multiOutputMap: Map<string, { indicator: ParsedIndicator; outputIndex: number }>,
  ): ParsedCondition | null {
    // Match: left operator right
    const match = expr.match(/^(.+?)\s*(<=|>=|==|<|>)\s*(.+)$/);
    if (!match) return null;

    const left = this.parseOperand(match[1].trim(), variableMap, multiOutputMap);
    const right = this.parseOperand(match[3].trim(), variableMap, multiOutputMap);
    if (!left || !right) return null;

    return { left, comparator: match[2] as ParsedCondition['comparator'], right };
  }

  /**
   * Parse a single operand: could be a number, a variable, or an expression like ATR(14) * 1.5
   */
  private parseOperand(
    text: string,
    variableMap: Map<string, ParsedIndicator>,
    multiOutputMap: Map<string, { indicator: ParsedIndicator; outputIndex: number }>,
  ): ConditionOperand | null {
    const trimmed = text.trim();

    // Pure number
    const asNum = Number(trimmed);
    if (!isNaN(asNum) && trimmed !== '') {
      return { type: 'number', value: asNum };
    }

    // Expression: variable * number  (e.g. ATR(14) * 1.5)
    const exprMatch = trimmed.match(/^([a-zA-Z_]\w*(?:\([^)]*\))?)\s*([*+\-/])\s*([\d.]+)$/);
    if (exprMatch) {
      const varPart = exprMatch[1];
      const op = exprMatch[2] as '*' | '+' | '-' | '/';
      const val = Number(exprMatch[3]);

      // The variable part might be a function call like ATR(14) — extract just the name
      const funcMatch = varPart.match(/^([A-Z_]+)\(([^)]*)\)$/);
      const varName = funcMatch ? varPart.replace(/[^a-zA-Z_]/g, '').toLowerCase() : varPart;

      return { type: 'expression', expression: { variable: varName, operator: op, value: val } };
    }

    // Simple variable reference
    if (/^[a-zA-Z_]\w*$/.test(trimmed)) {
      if (variableMap.has(trimmed) || multiOutputMap.has(trimmed)) {
        return { type: 'variable', variable: trimmed };
      }
      // Could be a forward reference or a built-in — allow it with the variable name
      return { type: 'variable', variable: trimmed };
    }

    // Inline indicator call: ATR(14)
    const inlineCall = trimmed.match(/^([A-Z_]+)\(([^)]*)\)$/);
    if (inlineCall) {
      return { type: 'variable', variable: trimmed.toLowerCase().replace(/[^a-z0-9_]/g, '_') };
    }

    return null;
  }
}
