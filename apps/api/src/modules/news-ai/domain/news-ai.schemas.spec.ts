import { findTypeArrayEnumCombos, NEWS_BRIEF_SCHEMA, NEWS_READ_SCHEMA } from './news-ai.schemas';

/** Every node of a schema, with its path (for the structural assertions below). */
function walk(node: unknown, path = '$', out: Array<{ path: string; node: Record<string, unknown> }> = []) {
  if (Array.isArray(node)) node.forEach((n, i) => walk(n, `${path}[${i}]`, out));
  else if (node && typeof node === 'object') {
    out.push({ path, node: node as Record<string, unknown> });
    for (const [k, v] of Object.entries(node)) walk(v, `${path}.${k}`, out);
  }
  return out;
}

describe('news-ai schemas (Vertex structured-output rules)', () => {
  it.each([
    ['NEWS_READ_SCHEMA', NEWS_READ_SCHEMA],
    ['NEWS_BRIEF_SCHEMA', NEWS_BRIEF_SCHEMA],
  ])('%s never combines a type array with enum', (_name, schema) => {
    expect(findTypeArrayEnumCombos(schema)).toEqual([]);
    // Belt and braces: no type ARRAY anywhere (a nullable must be anyOf), so the rule cannot regress.
    expect(walk(schema).filter(({ node }) => Array.isArray(node.type)).map(({ path }) => path)).toEqual([]);
  });

  it.each([
    ['NEWS_READ_SCHEMA', NEWS_READ_SCHEMA],
    ['NEWS_BRIEF_SCHEMA', NEWS_BRIEF_SCHEMA],
  ])('%s: every object is closed and requires all its properties; no numeric / length constraints', (_name, schema) => {
    for (const { path, node } of walk(schema)) {
      if (node.type === 'object' && node.properties) {
        expect({ path, additionalProperties: node.additionalProperties }).toEqual({ path, additionalProperties: false });
        expect({ path, required: [...(node.required as string[])].sort() }).toEqual({ path, required: Object.keys(node.properties).sort() });
      }
      for (const k of ['minimum', 'maximum', 'minItems', 'maxItems', 'minLength', 'maxLength']) expect({ path, k, has: k in node }).toEqual({ path, k, has: false });
    }
  });

  it('the detector finds the forbidden shape (nested, in arrays and anyOf)', () => {
    const bad = {
      type: 'object',
      properties: {
        a: { type: ['string', 'null'], enum: ['X', null] },
        b: { type: 'array', items: { anyOf: [{ type: ['string', 'null'], enum: ['Y'] }, { type: 'null' }] } },
        ok: { anyOf: [{ type: 'string', enum: ['Z'] }, { type: 'null' }] },
      },
    };
    expect(findTypeArrayEnumCombos(bad)).toEqual(['$.properties.a', '$.properties.b.items.anyOf[0]']);
  });
});
