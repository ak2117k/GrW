import { hasNoCaseSignal } from '../../news/services/extract-symbols';
import type { AliasRow } from './alias-derivation';

interface Node { next: Map<string, Node>; symbol?: string }
const TOKEN_RE = /[A-Za-z0-9]+(?:[&'’.][A-Za-z0-9]+)*/g;

function tokens(text: string): Array<{ t: string; start: number; end: number }> {
  const out: Array<{ t: string; start: number; end: number }> = [];
  for (const m of text.matchAll(TOKEN_RE)) out.push({ t: m[0].replace(/’/g, "'"), start: m.index!, end: m.index! + m[0].length });
  return out;
}

/**
 * Company-name matcher (spec §5.2): one token-trie compiled at build time, one pass
 * per article, case-sensitive on the alias as written, longest match wins, and a
 * matched name CONSUMES its span (the caller blanks it before keyword matching).
 */
export class NameMatcher {
  private readonly root: Node = { next: new Map() };
  private count = 0;
  private bytes = 0;

  constructor(rows: readonly AliasRow[]) {
    for (const r of rows) {
      if (r.kind === 'blocked') continue;
      let n = this.root;
      for (const { t } of tokens(r.alias)) {
        let c = n.next.get(t);
        if (!c) {
          c = { next: new Map() };
          n.next.set(t, c);
          this.bytes += 64 + t.length * 2;
        }
        n = c;
      }
      if (n !== this.root && !n.symbol) {
        n.symbol = r.symbol;
        this.count++;
        this.bytes += r.symbol.length * 2;
      }
    }
  }

  get size(): number {
    return this.count;
  }

  /** Structural estimate for the spec §6/§12 memory ceiling (Map entry + node + string bytes). */
  approxBytes(): number {
    return this.bytes;
  }

  match(text: string): { symbols: string[]; spans: Array<[number, number]> } {
    const symbols: string[] = [];
    const spans: Array<[number, number]> = [];
    if (!text || hasNoCaseSignal(text)) return { symbols, spans };
    const tk = tokens(text);
    let i = 0;
    while (i < tk.length) {
      let n: Node | undefined = this.root;
      let best: { j: number; symbol: string } | null = null;
      for (let j = i; j < tk.length && n; j++) {
        n = n.next.get(tk[j].t);
        if (n?.symbol) best = { j, symbol: n.symbol };
      }
      if (best) {
        spans.push([tk[i].start, tk[best.j].end]);
        if (!symbols.includes(best.symbol)) symbols.push(best.symbol);
        i = best.j + 1;
      } else i++;
    }
    return { symbols, spans };
  }
}

/** Replaces each span with spaces (same length, so later offsets stay valid). */
export function blankSpans(text: string, spans: ReadonlyArray<[number, number]>): string {
  let out = text;
  for (const [s, e] of spans) out = out.slice(0, s) + ' '.repeat(e - s) + out.slice(e);
  return out;
}
