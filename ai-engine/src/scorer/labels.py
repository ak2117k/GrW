"""Outcome labels for closed legacy trades: net-of-fees win and R-multiple.

Risk (the R denominator), in order of preference:
1. ``risk_amount`` stored at entry (adaptive-stop track);
2. ``|entry - stop| * qty`` when a stop price was stored;
3. otherwise the legacy hard loss-cut that actually governed the exit, and the
   outcome is marked ``r_derived=True``:
   - before ``LOSS_CUT_FLAT_INR_BEFORE``: a flat ₹1,000;
   - from then on: 0.4% of deployed capital (``entry_price * qty``).

``r_multiple = net_pnl / risk``. When ``fees`` is unknown (None) it is taken as
0, so both the win flag and R are then effectively on gross P&L.
"""
from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timezone

LOSS_CUT_PCT = 0.004
# TD_Automation commit 2785297 "feat(watch-monitor): stop-loss = 0.4% of deployed capital (R5)",
# 2026-05-19 18:33:00 +0530. Entries before this used HARD_LOSS_CUT_RUPEES = 1000.
LOSS_CUT_FLAT_INR_BEFORE: datetime = datetime(2026, 5, 19, 13, 3, 0, tzinfo=timezone.utc)
LOSS_CUT_FLAT_INR = 1000.0


@dataclass(frozen=True)
class Outcome:
    gross_pnl: float
    fees: float
    net_pnl: float
    win: bool
    r_multiple: float | None
    r_derived: bool
    mfe: float | None
    mae: float | None
    hold_mins: float | None


def _utc(d: datetime) -> datetime:
    return d if d.tzinfo else d.replace(tzinfo=timezone.utc)


def label(*, gross_pnl: float, fees: float | None, entry_price: float, qty: float, entered_at: datetime,
          exited_at: datetime | None, stop_price: float | None, risk_amount: float | None,
          mfe: float | None = None, mae: float | None = None) -> Outcome:
    fees_v = float(fees) if fees is not None else 0.0
    gross = float(gross_pnl)
    net = gross - fees_v
    entered = _utc(entered_at)

    r_derived = False
    if risk_amount is not None:
        risk = float(risk_amount)
    elif stop_price is not None:
        risk = abs(float(entry_price) - float(stop_price)) * float(qty)
    else:
        r_derived = True
        risk = LOSS_CUT_FLAT_INR if entered < LOSS_CUT_FLAT_INR_BEFORE else float(entry_price) * float(qty) * LOSS_CUT_PCT

    r_multiple = net / risk if risk > 0 else None
    hold = (_utc(exited_at) - entered).total_seconds() / 60.0 if exited_at is not None else None

    return Outcome(gross_pnl=gross, fees=fees_v, net_pnl=net, win=net > 0, r_multiple=r_multiple,
                   r_derived=r_derived, mfe=mfe, mae=mae, hold_mins=hold)
