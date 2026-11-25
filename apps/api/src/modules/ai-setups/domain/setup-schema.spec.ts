import { findTypeArrayEnumCombos } from '../../news-ai/domain/news-ai.schemas';
import { SETUP_REPLY_SCHEMA } from './setup.types';

/** Every node of a schema, with its path (for the structural assertions below). */
function walk(node: unknown, path = '$', out: Array<{ path: string; node: Record<string, unknown> }> = []) {
  if (Array.isArray(node)) node.forEach((n, i) => walk(n, `${path}[${i}]`, out));
  else if (node && typeof node === 'object') {
    out.push({ path, node: node as Record<string, unknown> });
    for (const [k, v] of Object.entries(node)) walk(v, `${path}.${k}`, out);
  }
  return out;
}

describe('SETUP_REPLY_SCHEMA (Vertex structured-output rules)', () => {
  it('never uses a type array (a nullable is anyOf), so never type array + enum', () => {
    expect(findTypeArrayEnumCombos(SETUP_REPLY_SCHEMA)).toEqual([]);
    expect(walk(SETUP_REPLY_SCHEMA).filter(({ node }) => Array.isArray(node.type)).map(({ path }) => path)).toEqual([]);
  });

  it('every object is closed and requires all its properties; no numeric / length constraints', () => {
    for (const { path, node } of walk(SETUP_REPLY_SCHEMA)) {
      if (node.type === 'object' && node.properties) {
        expect({ path, additionalProperties: node.additionalProperties }).toEqual({ path, additionalProperties: false });
        expect({ path, required: [...(node.required as string[])].sort() }).toEqual({ path, required: Object.keys(node.properties).sort() });
      }
      for (const k of ['minimum', 'maximum', 'minItems', 'maxItems', 'minLength', 'maxLength']) expect({ path, k, has: k in node }).toEqual({ path, k, has: false });
    }
  });

  it('v1 is option BUYS only: the schema allows no cash, future or sell', () => {
    const setup = (SETUP_REPLY_SCHEMA.properties.setup.anyOf[1] as any).properties;
    expect(setup.instrument.properties.kind.enum).toEqual(['OPT']);
    expect(setup.side.enum).toEqual(['BUY']);
    expect(setup.instrument.properties.optionType.enum).toEqual(['CE', 'PE']);
    expect(SETUP_REPLY_SCHEMA.properties.decision.enum).toEqual(['NO_TRADE', 'SETUP']);
  });
});
