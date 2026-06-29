# Ungated Track — Hull-Only Scanner Entry Filter

**Date:** 2026-06-27
**Area:** Ungated shadow track (`apps/api/src/modules/ungated-track`)
**Status:** Approved design — ready for implementation

---

## Motivation

The candle-replay / scanner-attribution research (`docs/research/2026-06-26-scanner-pnl-threshold-candle-replay-findings.md`) found the ungated track's profit is **concentrated in a single scanner**, `Anand 100Hull >200 hull` (+₹59,223 over the last 30 days), while the other scanners collectively bleed. This change adds an entry-level filter so the ungated track **only admits signals from the Hull scanner**, isolating the proven edge.

---

## Requirements

1. Ungated track admits an entry **only** when the originating Chartink scanner name matches the Hull keyword.
2. **Match rule:** case-insensitive substring match on `"hull"` (robust to renames / future Hull variants; no other current scanner contains "hull").
3. **Toggle:** env var `UNGATED_HULL_ONLY`, default **ON**. Set `UNGATED_HULL_ONLY=false` to revert ungated to all-scanners.
4. **Fail-closed:** when the toggle is ON and the scanner name is null/unresolved, **reject** the entry (admit only *confirmed* Hull signals).
5. Non-Hull signals are **recorded as rejections** (reason `scanner-not-allowed`) so comparison/visibility into filtered signals is preserved.
6. **Gated track is untouched.** Change is ungated-only.

---

## Design

### Placement
The filter is the **first gate (gate 0)** inside `UngatedWatchService.createFromAlert`, ahead of the existing BUY-only / dedup / cooldown gates. All ungated entry policy stays in one place. (Alternative considered: filter upstream in `chartink-process.service.ts` — rejected because it would bypass rejection logging and split entry policy across two files.)

### Components

| # | Component | Location | Purpose |
|---|-----------|----------|---------|
| 1 | `isHullScanner(name: string \| null): boolean` | new `ungated-scanner-filter.ts` (or top of `ungated-watch.service.ts`) | Pure, case-insensitive `"hull"` substring test. Unit-testable in isolation. |
| 2 | `UNGATED_HULL_ONLY` env read | `ungated-watch.service.ts` | `process.env.UNGATED_HULL_ONLY !== 'false'` → default ON. |
| 3 | `UngatedScannerNotAllowedError` | `ungated-watch.service.ts` | New error class; mirrors `UngatedSellDirectionError`. Carries `symbol` + `scannerName`. |
| 4 | `'scanner-not-allowed'` | `UngatedRejectionReason` union in `ungated-rejection.repository.ts` | New rejection reason. |
| 5 | `scannerName: string \| null` | `UngatedCreateFromAlertInput` | New input field; caller passes `scanName ?? null`. |

### Data flow

```
Chartink alert
  → ChartinkProcessService.processOne()   [already resolves scanName]
  → UngatedWatchService.createFromAlert({ …, scannerName })
       gate 0:  if HULL_ONLY && !isHullScanner(scannerName)
                  → record { reason: 'scanner-not-allowed' } + throw UngatedScannerNotAllowedError
       gate 1:  BUY-only            (existing)
       gate 2:  symbol dedup        (existing)
       gate 3:  cooldown / …        (existing)
```

The rejection is recorded by the same error→rejection mapping path the other ungated errors use (e.g. in `processOne`'s catch / the existing rejection-record call site). `UngatedScannerNotAllowedError` maps to reason `scanner-not-allowed`.

### Caller change
`chartink-process.service.ts` `processOne()` already has `scanName` in scope at the `ungatedWatch.createFromAlert(input)` call — add `scannerName: scanName ?? null` to the input object. No new lookups.

---

## Testing

- **Unit (`isHullScanner`):** `"Anand 100Hull >200 hull"` → true; `"ANAND 100HULL >200 HULL"` → true; `"Anand 100Hull >200 hull v2"` → true; `"ANAND HIGH GAINER BULLISH MAY26"` → false; `null` → false.
- **Service (`createFromAlert`):**
  - Non-Hull scanner + toggle ON → throws `UngatedScannerNotAllowedError`, records `scanner-not-allowed`, creates no entry.
  - Hull scanner + toggle ON → passes gate 0, proceeds to existing gates.
  - Non-Hull scanner + toggle OFF (`UNGATED_HULL_ONLY=false`) → passes gate 0 (back to all-scanners).
  - Null scanner name + toggle ON → rejected (fail-closed).
- **Regression:** existing ungated gate tests still pass; gated `WatchService` tests unaffected.

---

## Out of scope

- No change to gated track, adaptive-stop track, or breakout-swing track.
- No change to the Hull scanner's scoring, sizing, or exit logic.
- No retro-cleanup of historical non-Hull ungated trades.
- Threshold/exit-tuning (separate research track) is not part of this change.

---

## Files touched

| File | Change |
|------|--------|
| `apps/api/src/modules/ungated-track/services/ungated-watch.service.ts` | gate 0, error class, env read, `scannerName` input field, `isHullScanner` (or import) |
| `apps/api/src/modules/ungated-track/services/ungated-scanner-filter.ts` | new — `isHullScanner` helper (if extracted) |
| `apps/api/src/modules/ungated-track/repositories/ungated-rejection.repository.ts` | add `'scanner-not-allowed'` reason |
| `apps/api/src/modules/chartink/services/chartink-process.service.ts` | pass `scannerName: scanName ?? null` |
| `apps/api/src/modules/ungated-track/.../*.spec.ts` | unit + service tests |
| `.env` / `.env.example` | document `UNGATED_HULL_ONLY` (default ON) |
