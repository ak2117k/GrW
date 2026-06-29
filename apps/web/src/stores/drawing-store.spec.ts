import { beforeEach, describe, expect, it } from 'vitest';
import { useDrawingStore } from './drawing-store';
import { makeDrawing } from '@/types/drawings';

beforeEach(() => {
  useDrawingStore.setState({
    drawings: {},
    selectedId: null,
    activeTool: null,
    inFlight: null,
  });
});

describe('drawing-store', () => {
  it('adds a drawing for a token', () => {
    const d = makeDrawing('hline', { price: 100 });
    useDrawingStore.getState().addDrawing('TOK1', d);
    expect(useDrawingStore.getState().drawings.TOK1).toEqual([d]);
  });

  it('isolates drawings per token', () => {
    const a = makeDrawing('hline', { price: 100 });
    const b = makeDrawing('hline', { price: 200 });
    useDrawingStore.getState().addDrawing('TOK1', a);
    useDrawingStore.getState().addDrawing('TOK2', b);
    expect(useDrawingStore.getState().drawings.TOK1).toEqual([a]);
    expect(useDrawingStore.getState().drawings.TOK2).toEqual([b]);
  });

  it('updates an existing drawing via patch', () => {
    const d = makeDrawing('hline', { price: 100 });
    useDrawingStore.getState().addDrawing('TOK1', d);
    useDrawingStore.getState().updateDrawing('TOK1', d.id, { price: 150 } as Partial<typeof d>);
    expect((useDrawingStore.getState().drawings.TOK1[0] as typeof d).price).toBe(150);
  });

  it('deletes a drawing by id', () => {
    const d1 = makeDrawing('hline', { price: 100 });
    const d2 = makeDrawing('hline', { price: 200 });
    useDrawingStore.getState().addDrawing('TOK1', d1);
    useDrawingStore.getState().addDrawing('TOK1', d2);
    useDrawingStore.getState().deleteDrawing('TOK1', d1.id);
    expect(useDrawingStore.getState().drawings.TOK1).toEqual([d2]);
  });

  it('clears all drawings for a token', () => {
    useDrawingStore.getState().addDrawing('TOK1', makeDrawing('hline', { price: 100 }));
    useDrawingStore.getState().addDrawing('TOK1', makeDrawing('hline', { price: 200 }));
    useDrawingStore.getState().clearToken('TOK1');
    expect(useDrawingStore.getState().drawings.TOK1).toEqual([]);
  });

  it('manages active tool', () => {
    useDrawingStore.getState().setActiveTool('hline');
    expect(useDrawingStore.getState().activeTool).toBe('hline');
    useDrawingStore.getState().setActiveTool(null);
    expect(useDrawingStore.getState().activeTool).toBeNull();
  });

  it('manages selection', () => {
    useDrawingStore.getState().setSelected('abc');
    expect(useDrawingStore.getState().selectedId).toBe('abc');
    useDrawingStore.getState().setSelected(null);
    expect(useDrawingStore.getState().selectedId).toBeNull();
  });

  it('replaces an entire token list (for hydration from localStorage)', () => {
    const list = [makeDrawing('hline', { price: 100 })];
    useDrawingStore.getState().setDrawingsForToken('TOK1', list);
    expect(useDrawingStore.getState().drawings.TOK1).toEqual(list);
  });
});
