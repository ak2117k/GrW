/**
 * Contract value factor: the rupees one unit of `quantity` earns for a 1-point price move.
 *
 * Everywhere we compute rupees as Δprice × qty, where qty is the broker's netqty (real) or
 * lots × master lotSize (paper). That is right for NSE/BSE and for MCX contracts whose quotation
 * unit equals the master's lot unit (CRUDEOIL: 100 bbl lot, quoted per bbl, master lotSize 100).
 * It is wrong for MCX contracts quoted in a different unit than Angel's master lotsize counts:
 * GOLD is a 1 kg lot quoted per 10 g (₹100 per point per lot) but the master lotSize is 1.
 *
 *   factor = (₹ per 1-point move per lot) ÷ master lotSize
 *   rupees = Δprice × qty × factor
 *
 * Verified 2026-11-04 against the prod instruments table (lotSize) and MCX contract specs
 * (algotest.in MCX lot-size table, broker notes on the SILVER100 launch). Futures and options on
 * the same underlying share the factor. Non-MCX → 1. Unknown MCX → 1, warned once per name.
 */
export const MCX_CONTRACT_VALUE_FACTOR: Readonly<Record<string, number>> = {
  GOLD: 100, // 1 kg lot, quoted ₹/10 g, lotSize 1 → ₹100/pt/lot
  GOLDM: 0.1, // 100 g, ₹/10 g, lotSize 100 → ₹10/pt/lot
  GOLDGUINEA: 0.125, // 8 g, ₹/8 g, lotSize 8 → ₹1/pt/lot
  GOLDPETAL: 1, // 1 g, ₹/g, lotSize 1
  GOLDTEN: 0.1, // 10 g, ₹/10 g, lotSize 10 → ₹1/pt/lot
  SILVER: 1, // 30 kg, ₹/kg, lotSize 30
  SILVERM: 1, // 5 kg, ₹/kg, lotSize 5
  SILVERMIC: 1, // 1 kg, ₹/kg, lotSize 1
  SILVER100: 0.1, // 100 g, ₹/10 g, lotSize 100 → ₹10/pt/lot
  CRUDEOIL: 1, // 100 bbl, ₹/bbl, lotSize 100
  CRUDEOILM: 1, // 10 bbl, ₹/bbl, lotSize 10
  NATURALGAS: 1, // 1250 mmBtu, ₹/mmBtu, lotSize 1250
  NATGASMINI: 1, // 250 mmBtu, ₹/mmBtu, lotSize 250
  COPPER: 1, // 2500 kg, ₹/kg, lotSize 2500
  NICKEL: 1, // 250 kg, ₹/kg, lotSize 250
  ZINC: 1000, // 5 MT, ₹/kg, lotSize 5 → ₹5000/pt/lot
  ALUMINIUM: 1000, // 5 MT, ₹/kg, lotSize 5
  LEAD: 1000, // 5 MT, ₹/kg, lotSize 5
  ZINCMINI: 1000, // 1 MT, ₹/kg, lotSize 1 → ₹1000/pt/lot
  ALUMINI: 1000, // 1 MT, ₹/kg, lotSize 1
  LEADMINI: 1000, // 1 MT, ₹/kg, lotSize 1
};

/** Longest names first so GOLDM wins over GOLD and SILVER100 over SILVER. */
const MCX_NAMES_LONGEST_FIRST = Object.keys(MCX_CONTRACT_VALUE_FACTOR).sort((a, b) => b.length - a.length);

const warnedUnknown = new Set<string>();

function isMcx(exchange: string | null | undefined): boolean {
  return typeof exchange === 'string' && exchange.toUpperCase().startsWith('MCX');
}

/**
 * The MCX underlying a name or tradingsymbol belongs to, from the known roster, or null.
 * Accepts a bare name ("GOLDM") or a tradingsymbol ("GOLDM05DEC26FUT", "GOLD27NOV26125000PE"):
 * the name must be followed by a digit or the end, so GOLD never swallows GOLDM.
 */
export function mcxUnderlyingOf(nameOrSymbol: string | null | undefined): string | null {
  const s = String(nameOrSymbol ?? '').trim().toUpperCase();
  if (!s) return null;
  for (const name of MCX_NAMES_LONGEST_FIRST) {
    if (!s.startsWith(name)) continue;
    const next = s.charAt(name.length);
    if (next === '' || (next >= '0' && next <= '9')) return name;
  }
  return null;
}

/**
 * Rupees per unit of quantity per 1-point price move. 1 for everything outside MCX.
 * `nameOrSymbol` is the underlying name or the tradingsymbol; pass whichever you have.
 */
export function contractValueFactor(
  exchange: string | null | undefined,
  nameOrSymbol: string | null | undefined,
): number {
  if (!isMcx(exchange)) return 1;
  const name = mcxUnderlyingOf(nameOrSymbol);
  if (name) return MCX_CONTRACT_VALUE_FACTOR[name];
  const key = String(nameOrSymbol ?? '').trim().toUpperCase().replace(/\d.*$/, '') || '(empty)';
  if (!warnedUnknown.has(key)) {
    warnedUnknown.add(key);
    // eslint-disable-next-line no-console
    console.warn(`[contractValueFactor] unknown MCX contract "${nameOrSymbol}" — using factor 1; add it to MCX_CONTRACT_VALUE_FACTOR`);
  }
  return 1;
}
