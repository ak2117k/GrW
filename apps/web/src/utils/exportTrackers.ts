import type { TradeTracker } from '@/hooks/useTradeTrackers';

/**
 * Pure, framework-free core shared by both exporters. Turns the loaded trackers
 * into a header row + a 2D body suitable for a spreadsheet cell grid or a PDF
 * table. Numeric cells stay numbers (so xlsx keeps them numeric); missing
 * values render as an em-dash `'—'`, and an absent exit time as `''`.
 *
 * Kept side-effect-free and independent of xlsx/jspdf so it can be unit-tested
 * without mocking any export library.
 */

export const TRACKER_COLUMNS = [
  'Symbol',
  'Exch',
  'Kind',
  'Entry',
  'Qty',
  'Exit',
  'Exit Time',
  'Holding High',
  'Holding Low',
  'Day High',
  'Day Low',
  'P&L',
  'P&L %',
  'Status',
] as const;

const DASH = '—';

/** Round to 2 decimals, keeping the value numeric (NaN-safe passthrough). */
function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/** A numeric cell, or an em-dash when the value is null/undefined/non-finite. */
function num(v: number | null | undefined): number | string {
  return typeof v === 'number' && Number.isFinite(v) ? round2(v) : DASH;
}

/** "+7.14%" / "-3.20%", or em-dash when null. */
function pct(v: number | null | undefined): string {
  if (typeof v !== 'number' || !Number.isFinite(v)) return DASH;
  return `${v > 0 ? '+' : ''}${v.toFixed(2)}%`;
}

/**
 * ISO → "YYYY-MM-DD HH:mm" (UTC, deterministic), or '' when null. A pure string
 * transform — no Date/locale, so it is timezone-stable in tests.
 */
function exitTime(iso: string | null | undefined): string {
  if (!iso || iso.length < 16) return '';
  return `${iso.slice(0, 10)} ${iso.slice(11, 16)}`;
}

export function buildTrackerRows(rows: TradeTracker[]): {
  header: string[];
  body: (string | number)[][];
} {
  const header = [...TRACKER_COLUMNS];
  const body: (string | number)[][] = rows.map((r) => [
    r.symbol,
    r.exchange,
    r.kind,
    num(r.entryPrice),
    num(r.qty),
    num(r.exitPrice),
    exitTime(r.exitTime),
    num(r.holdingHigh),
    num(r.holdingLow),
    num(r.dayHigh),
    num(r.dayLow),
    num(r.pnl),
    pct(r.pnlPercent),
    r.status,
  ]);
  return { header, body };
}

/** Today's date as `YYYY-MM-DD` (local), used for the download filename. */
function fileStamp(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/**
 * Build an .xlsx from the loaded trackers and trigger a browser download.
 * Uses SheetJS (`xlsx`), imported lazily so the (heavy) lib only loads when the
 * user actually exports.
 */
export async function exportTrackersXlsx(rows: TradeTracker[]): Promise<void> {
  const XLSX = await import('xlsx');
  const { header, body } = buildTrackerRows(rows);
  const ws = XLSX.utils.aoa_to_sheet([header, ...body]);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Trade Tracker');
  XLSX.writeFile(wb, `trade-tracker-${fileStamp()}.xlsx`);
}

/**
 * Build a PDF from the loaded trackers and trigger a browser download.
 * Uses `jspdf` + `jspdf-autotable`, both imported lazily.
 */
export async function exportTrackersPdf(rows: TradeTracker[]): Promise<void> {
  const { jsPDF } = await import('jspdf');
  const autoTable = (await import('jspdf-autotable')).default;
  const { header, body } = buildTrackerRows(rows);
  const doc = new jsPDF({ orientation: 'landscape' });
  doc.text('Trade Tracker', 14, 14);
  autoTable(doc, {
    head: [header],
    body,
    startY: 20,
    styles: { fontSize: 7, cellPadding: 1.5 },
    headStyles: { fillColor: [30, 41, 59] },
  });
  doc.save(`trade-tracker-${fileStamp()}.pdf`);
}
