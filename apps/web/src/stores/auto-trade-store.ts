import { create } from 'zustand';
import api from '@/services/api';
import toast from 'react-hot-toast';

interface AutoTradeStats {
  processed: number;
  executed: number;
  pending: number;
  skipped: number;
  errors: number;
  timestamp: string | null;
}

interface PendingApproval {
  signalId: string;
  symbol: string;
  exchange: string;
  side: string;
  entryPrice: number;
  targetPrice: number;
  stoplossPrice: number;
  confidence: string;
  confidenceScore: number;
  strategy: string;
  quantity: number;
  timestamp: string;
}

interface AutoTradeStatus {
  mode: string;
  isRunning: boolean;
  pendingApprovals: number;
  lastScanStats: AutoTradeStats;
}

interface AutoTradeState {
  status: AutoTradeStatus;
  pendingApprovals: PendingApproval[];
  isLoading: boolean;

  fetchStatus: () => Promise<void>;
  fetchPendingApprovals: () => Promise<void>;
  approveSignal: (signalId: string) => Promise<void>;
  rejectSignal: (signalId: string) => Promise<void>;
  forceExecute: (signalId: string) => Promise<void>;
  triggerScan: () => Promise<void>;
  addPendingApproval: (approval: PendingApproval) => void;
  removePendingApproval: (signalId: string) => void;
  setStatus: (status: AutoTradeStatus) => void;
}

const defaultStatus: AutoTradeStatus = {
  mode: 'OFF',
  isRunning: false,
  pendingApprovals: 0,
  lastScanStats: {
    processed: 0,
    executed: 0,
    pending: 0,
    skipped: 0,
    errors: 0,
    timestamp: null,
  },
};

export const useAutoTradeStore = create<AutoTradeState>((set) => ({
  status: defaultStatus,
  pendingApprovals: [],
  isLoading: false,

  fetchStatus: async () => {
    try {
      const { data } = await api.get<AutoTradeStatus>('/auto-trade/status');
      set({ status: data });
    } catch {
      console.warn('Failed to fetch auto-trade status');
    }
  },

  fetchPendingApprovals: async () => {
    try {
      const { data } = await api.get<PendingApproval[]>('/auto-trade/pending');
      set({ pendingApprovals: data });
    } catch {
      console.warn('Failed to fetch pending approvals');
    }
  },

  approveSignal: async (signalId) => {
    set({ isLoading: true });
    try {
      await api.post(`/auto-trade/approve/${signalId}`);
      set((state) => ({
        pendingApprovals: state.pendingApprovals.filter((a) => a.signalId !== signalId),
      }));
      toast.success('Signal approved for execution');
    } catch {
      toast.error('Failed to approve signal');
    } finally {
      set({ isLoading: false });
    }
  },

  rejectSignal: async (signalId) => {
    set({ isLoading: true });
    try {
      await api.post(`/auto-trade/reject/${signalId}`);
      set((state) => ({
        pendingApprovals: state.pendingApprovals.filter((a) => a.signalId !== signalId),
      }));
      toast.success('Signal rejected');
    } catch {
      toast.error('Failed to reject signal');
    } finally {
      set({ isLoading: false });
    }
  },

  forceExecute: async (signalId) => {
    set({ isLoading: true });
    try {
      await api.post(`/auto-trade/force-execute/${signalId}`);
      set((state) => ({
        pendingApprovals: state.pendingApprovals.filter((a) => a.signalId !== signalId),
      }));
      toast.success('Trade force-executed');
    } catch {
      toast.error('Failed to force-execute trade');
    } finally {
      set({ isLoading: false });
    }
  },

  triggerScan: async () => {
    try {
      await api.post('/auto-trade/scan');
      toast.success('Signal scan triggered');
    } catch {
      toast.error('Failed to trigger scan');
    }
  },

  addPendingApproval: (approval) =>
    set((state) => ({
      pendingApprovals: [approval, ...state.pendingApprovals],
    })),

  removePendingApproval: (signalId) =>
    set((state) => ({
      pendingApprovals: state.pendingApprovals.filter((a) => a.signalId !== signalId),
    })),

  setStatus: (status) => set({ status }),
}));
