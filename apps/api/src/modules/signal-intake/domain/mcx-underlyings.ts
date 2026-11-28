/**
 * MCX commodity underlyings (the instrument master's `name` on MCX), main and mini contracts. The ONE list used by
 * signal-intake (segment + expiry rules) and signal-trader (contract segment), so a mini contract never resolves in
 * intake and is then refused by the trader as NFO (Fix 3 re-review 2026-11-29).
 */
export const MCX_UNDERLYINGS: ReadonlySet<string> = new Set([
  'CRUDEOIL', 'CRUDEOILM', 'NATURALGAS', 'NATGASMINI',
  'GOLD', 'GOLDM', 'GOLDPETAL', 'GOLDGUINEA', 'GOLDTEN',
  'SILVER', 'SILVERM', 'SILVERMIC',
  'COPPER', 'ZINC', 'ZINCMINI', 'ALUMINIUM', 'ALUMINI', 'LEAD', 'LEADMINI', 'NICKEL',
]);
