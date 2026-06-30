import { createHash } from 'crypto';

/**
 * Canonical JSON serializer for the tamper-evident audit log (TDA-008).
 *
 * Produces a deterministic, byte-for-byte reproducible string for any value so
 * that the same logical payload always hashes to the same digest. This is the
 * SINGLE SOURCE OF TRUTH for canonicalization — every audit task (append,
 * verifyChain, backfill) imports from here. Never re-implement this logic
 * elsewhere (especially not in SQL).
 *
 * Rules:
 *  - object keys are recursively sorted (lexicographic, by UTF-16 code unit)
 *  - arrays preserve their element order
 *  - `Date`   -> ISO-8601 string via `.toISOString()`
 *  - `bigint` -> decimal string
 *  - `string` / `number` / `boolean` -> JSON primitive
 *  - `null` / `undefined` -> the literal `null` (undefined object properties
 *    are omitted, matching JSON.stringify, so missing vs. explicit-undefined
 *    keys canonicalize identically)
 *
 * The function is TOTAL (handles every input type above without throwing) and
 * SIDE-EFFECT-FREE (it never mutates its argument).
 */
export function canonicalize(value: unknown): string {
  return serialize(value);
}

function serialize(value: unknown): string {
  // null and undefined both collapse to the JSON null literal.
  if (value === null || value === undefined) {
    return 'null';
  }

  const type = typeof value;

  if (type === 'string') {
    return JSON.stringify(value);
  }

  if (type === 'number') {
    // Match JSON.stringify: non-finite numbers are not representable, emit null.
    return Number.isFinite(value as number) ? String(value) : 'null';
  }

  if (type === 'boolean') {
    return (value as boolean) ? 'true' : 'false';
  }

  if (type === 'bigint') {
    // Decimal string, unquoted, so 5n and 5 are indistinguishable by design.
    return (value as bigint).toString();
  }

  if (value instanceof Date) {
    return JSON.stringify(value.toISOString());
  }

  if (Array.isArray(value)) {
    // Arrays preserve order; undefined/function elements become null (as JSON).
    return `[${value.map((item) => serialize(item)).join(',')}]`;
  }

  if (type === 'object') {
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj).sort();
    const parts: string[] = [];
    for (const key of keys) {
      const entry = obj[key];
      // Omit keys whose value is undefined, matching JSON.stringify semantics.
      if (entry === undefined) {
        continue;
      }
      parts.push(`${JSON.stringify(key)}:${serialize(entry)}`);
    }
    return `{${parts.join(',')}}`;
  }

  // Unsupported types (function, symbol) are not representable — emit null,
  // keeping the function total rather than throwing.
  return 'null';
}

/**
 * SHA-256 hex digest of a string. Lowercase hex, 64 chars.
 *
 * This is the ONLY place the audit hash is computed. Tasks that build the hash
 * chain must call this — never duplicate the algorithm.
 */
export function sha256(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex');
}
