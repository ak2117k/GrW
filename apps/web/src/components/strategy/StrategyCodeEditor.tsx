import { useRef, useCallback, useMemo } from 'react';
import { cn } from '@/utils/cn';
import type { ParseResult } from '@/stores/strategy-builder-store';

// ---- Syntax highlighting ----
// Content is sanitized by escapeHtml before any spans are inserted.

const KEYWORDS = ['AND', 'OR'];
const INDICATORS = ['RSI', 'EMA', 'SMA', 'MACD', 'VWAP', 'BB', 'ATR', 'SUPERTREND', 'ADX'];
const BUILTINS = ['close', 'open', 'high', 'low', 'volume'];
const RULE_NAMES = ['long_entry', 'short_entry', 'long_exit', 'short_exit', 'stoploss', 'target'];

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function highlightLine(line: string): string {
  // Sanitize all user content first
  let html = escapeHtml(line);

  // Comments
  if (html.trimStart().startsWith('//')) {
    return `<span class="strat-comment">${html}</span>`;
  }

  // Numbers
  html = html.replace(/\b(\d+(?:\.\d+)?)\b/g, '<span class="strat-number">$1</span>');

  // Strings (already escaped quotes)
  html = html.replace(/&quot;([^&]*)&quot;/g, '<span class="strat-string">&quot;$1&quot;</span>');

  // Keywords (AND, OR)
  for (const kw of KEYWORDS) {
    html = html.replace(
      new RegExp(`\\b(${kw})\\b`, 'g'),
      '<span class="strat-keyword">$1</span>',
    );
  }

  // Indicators
  for (const ind of INDICATORS) {
    html = html.replace(
      new RegExp(`\\b(${ind})\\b`, 'g'),
      '<span class="strat-indicator">$1</span>',
    );
  }

  // Builtins
  for (const b of BUILTINS) {
    html = html.replace(
      new RegExp(`\\b(${b})\\b`, 'g'),
      '<span class="strat-builtin">$1</span>',
    );
  }

  // Rule names
  for (const r of RULE_NAMES) {
    html = html.replace(
      new RegExp(`\\b(${r})\\b`, 'g'),
      '<span class="strat-rule">$1</span>',
    );
  }

  // Operators (use escaped entities for < and >)
  html = html.replace(/(=|&lt;|&gt;|!|\*|\+|-|\/)/g, '<span class="strat-operator">$1</span>');

  return html;
}

// ---- Component ----

interface StrategyCodeEditorProps {
  code: string;
  onChange: (code: string) => void;
  validation: ParseResult | null;
  className?: string;
}

export function StrategyCodeEditor({ code, onChange, validation, className }: StrategyCodeEditorProps) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const preRef = useRef<HTMLPreElement>(null);

  const errorLines = useMemo(() => {
    if (!validation) return new Set<number>();
    return new Set(
      validation.items.filter((i) => i.type === 'error').map((i) => i.line),
    );
  }, [validation]);

  const lines = code.split('\n');
  const lineCount = lines.length;

  const highlightedHtml = useMemo(() => {
    return lines.map((l) => highlightLine(l)).join('\n');
  }, [code]); // eslint-disable-line react-hooks/exhaustive-deps

  const handleScroll = useCallback(() => {
    if (textareaRef.current && preRef.current) {
      preRef.current.scrollTop = textareaRef.current.scrollTop;
      preRef.current.scrollLeft = textareaRef.current.scrollLeft;
    }
  }, []);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      // Tab support
      if (e.key === 'Tab') {
        e.preventDefault();
        const ta = textareaRef.current!;
        const start = ta.selectionStart;
        const end = ta.selectionEnd;
        const newCode = code.substring(0, start) + '  ' + code.substring(end);
        onChange(newCode);
        requestAnimationFrame(() => {
          ta.selectionStart = ta.selectionEnd = start + 2;
        });
      }
    },
    [code, onChange],
  );

  return (
    <div className={cn('flex rounded-lg border border-[var(--color-border-subtle)] overflow-hidden', className)}>
      {/* Line numbers */}
      <div className="flex flex-col items-end py-3 px-2 bg-[#06060f] text-gray-600 text-xs font-mono select-none shrink-0 border-r border-gray-800/60">
        {Array.from({ length: lineCount }, (_, i) => (
          <div
            key={i}
            className={cn(
              'leading-[1.625rem] px-1',
              errorLines.has(i + 1) && 'text-red-400 font-semibold',
            )}
          >
            {i + 1}
          </div>
        ))}
      </div>

      {/* Editor area */}
      <div className="relative flex-1 min-h-[320px]">
        {/* Highlighted pre overlay — content is HTML-escaped before span insertion */}
        <pre
          ref={preRef}
          className="absolute inset-0 p-3 m-0 overflow-hidden pointer-events-none font-mono text-sm leading-[1.625rem] whitespace-pre text-transparent"
          aria-hidden="true"
          dangerouslySetInnerHTML={{ __html: highlightedHtml + '\n' }}
        />

        {/* Error line backgrounds */}
        <div className="absolute inset-0 pointer-events-none">
          {lines.map((_, i) =>
            errorLines.has(i + 1) ? (
              <div
                key={i}
                className="absolute left-0 right-0 bg-red-500/8"
                style={{ top: `${12 + i * 26}px`, height: '26px' }}
              />
            ) : null,
          )}
        </div>

        {/* Actual textarea */}
        <textarea
          ref={textareaRef}
          value={code}
          onChange={(e) => onChange(e.target.value)}
          onScroll={handleScroll}
          onKeyDown={handleKeyDown}
          spellCheck={false}
          className="absolute inset-0 w-full h-full p-3 m-0 resize-none font-mono text-sm leading-[1.625rem] bg-[#0a0a1a] text-gray-200 caret-blue-400 outline-none"
          style={{ caretColor: '#60a5fa', color: 'transparent', WebkitTextFillColor: 'transparent' }}
          placeholder="// Write your strategy here..."
        />
      </div>

      {/* Syntax highlighting CSS */}
      <style>{`
        .strat-comment { color: #6b7280; font-style: italic; }
        .strat-keyword { color: #c084fc; font-weight: 600; }
        .strat-indicator { color: #60a5fa; font-weight: 600; }
        .strat-builtin { color: #34d399; }
        .strat-rule { color: #fbbf24; }
        .strat-number { color: #fb923c; }
        .strat-string { color: #a78bfa; }
        .strat-operator { color: #94a3b8; }
      `}</style>
    </div>
  );
}
