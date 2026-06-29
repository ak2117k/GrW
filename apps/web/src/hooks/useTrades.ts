import { useEffect, useRef } from 'react';
import { wsService } from '@/services/websocket';
import { useTradeStore } from '@/stores/trade-store';
import type { TradeEvent, Position, RiskStatus } from '@/types';

export function useTrades() {
  const openTrades = useTradeStore((s) => s.openTrades);
  const positions = useTradeStore((s) => s.positions);
  const riskStatus = useTradeStore((s) => s.riskStatus);
  const recentTrades = useTradeStore((s) => s.recentTrades);
  const executionLog = useTradeStore((s) => s.executionLog);
  const isLoading = useTradeStore((s) => s.isLoading);
  const fetchOpenTrades = useTradeStore((s) => s.fetchOpenTrades);
  const fetchPositions = useTradeStore((s) => s.fetchPositions);
  const fetchRiskStatus = useTradeStore((s) => s.fetchRiskStatus);
  const addTradeEvent = useTradeStore((s) => s.addTradeEvent);
  const updatePosition = useTradeStore((s) => s.updatePosition);
  const setRiskStatus = useTradeStore((s) => s.setRiskStatus);
  const setOpenTrades = useTradeStore((s) => s.setOpenTrades);
  const setKillSwitchActive = useTradeStore((s) => s.setKillSwitchActive);

  const intervalRef = useRef<ReturnType<typeof setInterval>>(undefined);

  useEffect(() => {
    fetchOpenTrades();
    fetchPositions();
    fetchRiskStatus();

    // Auto-refresh positions every 5 seconds
    intervalRef.current = setInterval(() => {
      fetchPositions();
    }, 5000);

    return () => {
      clearInterval(intervalRef.current);
    };
  }, [fetchOpenTrades, fetchPositions, fetchRiskStatus]);

  useEffect(() => {
    wsService.connect();

    const unsubTrade = wsService.subscribe('trade-update', (data) => {
      // Backend's TradeGateway emits raw Trade rows (Prisma model with a
      // `status` field). Some auto-trade flows wrap them as TradeEvent
      // (with an `eventType` field). Handle both shapes — refetch open
      // trades on any close-equivalent state. This is what closes the
      // "I closed positions but UI still shows them" loop, since the
      // close-all path emits raw Trade rows with status='CLOSED' and
      // the previous handler only refreshed on TradeEvent.eventType.
      const payload = data as Partial<TradeEvent> & { status?: string };
      if (payload.eventType) {
        addTradeEvent(payload as TradeEvent);
      }

      const closedStatuses = ['CLOSED', 'CANCELLED', 'REJECTED'];
      const closedEventTypes = ['CLOSED', 'SL_HIT', 'TARGET_HIT', 'CANCELLED'];
      const isClose =
        (payload.status && closedStatuses.includes(payload.status)) ||
        (payload.eventType && closedEventTypes.includes(payload.eventType));

      if (isClose) {
        fetchOpenTrades();
        fetchPositions();
      }
    });

    const unsubPosition = wsService.subscribe('position-update', (data) => {
      updatePosition(data as Position);
    });

    const unsubRisk = wsService.subscribe('risk-status', (data) => {
      setRiskStatus(data as RiskStatus);
    });

    const unsubKill = wsService.subscribe('kill-switch-activated', () => {
      setKillSwitchActive(true);
      setOpenTrades([]);
      setTimeout(() => setKillSwitchActive(false), 3000);
    });

    return () => {
      unsubTrade();
      unsubPosition();
      unsubRisk();
      unsubKill();
    };
  }, [addTradeEvent, updatePosition, setRiskStatus, setOpenTrades, setKillSwitchActive, fetchOpenTrades]);

  return {
    openTrades,
    positions,
    riskStatus,
    recentTrades,
    executionLog,
    isLoading,
  };
}
