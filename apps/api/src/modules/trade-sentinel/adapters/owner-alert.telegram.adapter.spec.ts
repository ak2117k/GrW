import { TelegramOwnerAlerts, ownerAlertsEnabled } from './owner-alert.telegram.adapter';
import { formatOwnerAlert, type OwnerAlert } from '../ports/owner-alerts.port';

const alert = (over: Partial<OwnerAlert> = {}): OwnerAlert => ({
  kind: 'square-off-decision',
  key: 'square-off:t1:2026-10-29:FIRST',
  userId: 'u1',
  trackerId: 't1',
  symbol: 'JPL-EQ',
  exchange: 'NSE',
  side: 'LONG',
  qty: 40,
  entryPrice: 1481.7,
  ltp: 1421.5,
  netPnl: -2408.4,
  verdict: 'HOLD',
  confidence: 'medium',
  reason: 'still above the day low',
  minutesToSquareOff: 10,
  deadlineIst: '15:15',
  ...over,
});

describe('owner alerts over the Telegram ops bot', () => {
  it('formats symbol, side/qty, LTP, net P&L, the verdict with its reason and the minutes to square-off', () => {
    const text = formatOwnerAlert(alert());
    expect(text).toContain('JPL-EQ (NSE): square-off decision');
    expect(text).toContain('LONG 40 @ 1481.7 · LTP 1421.5 · P&L −₹2,408 (net)');
    expect(text).toContain('AI: HOLD (medium) — still above the day low');
    expect(text).toContain('10 min to the broker square-off (15:15 IST).');
    expect(formatOwnerAlert(alert({ kind: 'observe-only-exit', verdict: 'EXIT_NOW', netPnl: 120 }))).toContain('AI says EXIT_NOW');
    expect(formatOwnerAlert(alert({ minutesToSquareOff: -2 }))).toContain('Past the broker square-off');
  });

  it('sends through sendOpsAlert under a sentinel-owner key; SENTINEL_OWNER_ALERTS=false/off sends nothing', async () => {
    const send = jest.fn().mockResolvedValue(true);
    await new TelegramOwnerAlerts({}, send).send(alert());
    expect(send).toHaveBeenCalledWith('sentinel-owner:square-off:t1:2026-10-29:FIRST', formatOwnerAlert(alert()));
    const off = jest.fn().mockResolvedValue(true);
    await new TelegramOwnerAlerts({ SENTINEL_OWNER_ALERTS: 'false' }, off).send(alert());
    expect(off).not.toHaveBeenCalled();
    expect([ownerAlertsEnabled({}), ownerAlertsEnabled({ SENTINEL_OWNER_ALERTS: ' OFF ' }), ownerAlertsEnabled({ SENTINEL_OWNER_ALERTS: 'on' })]).toEqual([true, false, true]);
  });
});
