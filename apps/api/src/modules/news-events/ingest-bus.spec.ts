import { InProcessNewsIngestBus } from './ingest-bus';
import { article } from './testing';

it('delivers to every subscriber, survives a throwing one, and unsubscribes', () => {
  const errors: unknown[] = [];
  const bus = new InProcessNewsIngestBus((e) => errors.push(e));
  const got: string[] = [];
  bus.subscribe(() => {
    throw new Error('boom');
  });
  const off = bus.subscribe((items) => items.forEach((i) => got.push(i.id)));
  bus.publish([article({ id: 'a' })]);
  off();
  bus.publish([article({ id: 'b' })]);
  expect(got).toEqual(['a']);
  expect(errors).toHaveLength(2);
});
