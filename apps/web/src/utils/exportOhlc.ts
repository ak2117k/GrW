/**
 * Per-sold-trade OHLC export. Turns a daily OHLC series (fetched on demand from
 * `GET /api/portfolio/sold/:id/ohlc`) into an Excel/PDF the user can download
 * for post-trade review ("did I sell too early / how far did it run").
 *
 * `buildOhlcRows` is the pure, framework-free core shared by both exporters —
 * side-effect-free and independent of xlsx/jspdf, so it can be unit-tested
 * without mocking any export library.
 */

/**
 * A single daily OHLC bar as returned by `GET /api/portfolio/sold/:id/ohlc`.
 * This is the EXACT backend contract (`DailyOhlcDto`). `date` is a date string.
 */
export interface DailyOhlc {
  date: string;
  open: number;
  high: number;
  low: number;
  close: number;
}

export const OHLC_COLUMNS = ['Date', 'Open', 'High', 'Low', 'Close'] as const;

/** Round to 2 decimals, keeping the value numeric (NaN-safe passthrough). */
function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * Pure core: a daily OHLC series → a header row + a 2D body (Date · Open · High
 * · Low · Close). Numeric cells stay numbers, rounded to 2 decimals, so xlsx
 * keeps them numeric. An empty series yields an empty body.
 */
export function buildOhlcRows(ohlc: DailyOhlc[]): {
  header: string[];
  body: (string | number)[][];
} {
  const header = [...OHLC_COLUMNS];
  const body: (string | number)[][] = ohlc.map((d) => [
    d.date,
    round2(d.open),
    round2(d.high),
    round2(d.low),
    round2(d.close),
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
 * Build an .xlsx from the daily OHLC series and trigger a browser download as
 * `sold-<symbol>-<date>.xlsx`. Uses SheetJS (`xlsx`), imported lazily so the
 * (heavy) lib only loads when the user actually exports.
 */
export async function exportOhlcXlsx(symbol: string, ohlc: DailyOhlc[]): Promise<void> {
  const XLSX = await import('xlsx');
  const { header, body } = buildOhlcRows(ohlc);
  const ws = XLSX.utils.aoa_to_sheet([header, ...body]);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, symbol.slice(0, 31) || 'OHLC');
  XLSX.writeFile(wb, `sold-${symbol}-${fileStamp()}.xlsx`);
}

/**
 * Build a PDF from the daily OHLC series and trigger a browser download as
 * `sold-<symbol>-<date>.pdf`. Uses `jspdf` + `jspdf-autotable`, both imported
 * lazily. The PDF title is the symbol.
 */
export async function exportOhlcPdf(symbol: string, ohlc: DailyOhlc[]): Promise<void> {
  const { jsPDF } = await import('jspdf');
  const autoTable = (await import('jspdf-autotable')).default;
  const { header, body } = buildOhlcRows(ohlc);
  const doc = new jsPDF();
  doc.text(symbol, 14, 14);
  autoTable(doc, {
    head: [header],
    body,
    startY: 20,
    styles: { fontSize: 8, cellPadding: 1.5 },
    headStyles: { fillColor: [30, 41, 59] },
  });
  doc.save(`sold-${symbol}-${fileStamp()}.pdf`);
}
