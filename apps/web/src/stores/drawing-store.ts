import { create } from 'zustand';
import type { Drawing, ToolKind } from '@/types/drawings';

interface DrawingState {
  drawings: Record<string, Drawing[]>;
  selectedId: string | null;
  activeTool: ToolKind | null;
  inFlight: { kind: ToolKind; points: { time: number; price: number }[] } | null;

  addDrawing: (token: string, drawing: Drawing) => void;
  updateDrawing: (token: string, id: string, patch: Partial<Drawing>) => void;
  deleteDrawing: (token: string, id: string) => void;
  clearToken: (token: string) => void;
  setDrawingsForToken: (token: string, list: Drawing[]) => void;
  setActiveTool: (kind: ToolKind | null) => void;
  setSelected: (id: string | null) => void;
  startInFlight: (kind: ToolKind) => void;
  pushInFlightPoint: (point: { time: number; price: number }) => void;
  clearInFlight: () => void;
}

export const useDrawingStore = create<DrawingState>((set) => ({
  drawings: {},
  selectedId: null,
  activeTool: null,
  inFlight: null,

  addDrawing: (token, drawing) =>
    set((s) => ({
      drawings: {
        ...s.drawings,
        [token]: [...(s.drawings[token] ?? []), drawing],
      },
    })),

  updateDrawing: (token, id, patch) =>
    set((s) => ({
      drawings: {
        ...s.drawings,
        [token]: (s.drawings[token] ?? []).map((d) =>
          d.id === id ? ({ ...d, ...patch } as Drawing) : d,
        ),
      },
    })),

  deleteDrawing: (token, id) =>
    set((s) => ({
      drawings: {
        ...s.drawings,
        [token]: (s.drawings[token] ?? []).filter((d) => d.id !== id),
      },
      selectedId: s.selectedId === id ? null : s.selectedId,
    })),

  clearToken: (token) =>
    set((s) => ({
      drawings: { ...s.drawings, [token]: [] },
      selectedId: null,
    })),

  setDrawingsForToken: (token, list) =>
    set((s) => ({
      drawings: { ...s.drawings, [token]: list },
    })),

  setActiveTool: (kind) => set({ activeTool: kind, selectedId: null, inFlight: null }),

  setSelected: (id) => set({ selectedId: id }),

  startInFlight: (kind) => set({ inFlight: { kind, points: [] } }),

  pushInFlightPoint: (point) =>
    set((s) =>
      s.inFlight
        ? { inFlight: { ...s.inFlight, points: [...s.inFlight.points, point] } }
        : {},
    ),

  clearInFlight: () => set({ inFlight: null }),
}));

// Stable empty array reference. Returning a fresh `[]` each call would
// trip React's useSyncExternalStore "result of getSnapshot should be cached"
// warning and re-render the consumer on every store tick.
const EMPTY_DRAWINGS: Drawing[] = [];

export const selectDrawingsForToken = (token: string) =>
  (s: DrawingState): Drawing[] => s.drawings[token] ?? EMPTY_DRAWINGS;
