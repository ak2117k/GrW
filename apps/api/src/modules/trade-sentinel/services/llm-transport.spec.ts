import { bedrockModelId, judgeTransportFrom } from './llm-transport';

describe('judgeTransportFrom', () => {
  it('defaults to the API when unset', () => {
    // A deployed container has no interactive OAuth session and no AWS role by
    // default, so an absent value must land on the transport that works from
    // configuration alone.
    expect(judgeTransportFrom(undefined)).toBe('api');
  });

  it('selects the CLI transport', () => {
    expect(judgeTransportFrom('cli')).toBe('cli');
  });

  it('selects Bedrock', () => {
    expect(judgeTransportFrom('bedrock')).toBe('bedrock');
  });

  it('tolerates case and surrounding whitespace', () => {
    expect(judgeTransportFrom('  BEDROCK ')).toBe('bedrock');
  });

  it('falls back to the API on a misspelt value, never to a host-bound one', () => {
    // 'bedrok' must not silently become 'bedrock' -- and must not become 'cli'
    // either. A typo lands on the only transport a container can actually serve.
    expect(judgeTransportFrom('bedrok')).toBe('api');
  });
});

describe('bedrockModelId', () => {
  it('prefixes a first-party model id for Bedrock', () => {
    // Bedrock namespaces model ids by vendor. Passing the bare first-party id
    // is rejected by the endpoint, so SENTINEL_MODEL_* can stay portable and
    // the transport maps it at the boundary.
    expect(bedrockModelId('claude-opus-5')).toBe('anthropic.claude-opus-5');
    expect(bedrockModelId('claude-sonnet-5')).toBe('anthropic.claude-sonnet-5');
  });

  it('leaves an already-prefixed id alone rather than doubling it', () => {
    expect(bedrockModelId('anthropic.claude-opus-5')).toBe('anthropic.claude-opus-5');
  });

  it('leaves a cross-region inference profile id alone', () => {
    // Bedrock inference profiles carry a region prefix (us./eu./apac.) and are
    // how you reach a model that is not directly available in one region.
    expect(bedrockModelId('us.anthropic.claude-opus-5')).toBe('us.anthropic.claude-opus-5');
    expect(bedrockModelId('apac.anthropic.claude-opus-5')).toBe('apac.anthropic.claude-opus-5');
  });
});

describe('bedrockModelId — the region prefix must be a real prefix', () => {
  it('does not mistake a model whose name merely starts with those letters', () => {
    // The guard looks for a geography prefix followed by a DOT. With an
    // unescaped dot in the pattern it matches any character, so 'eu-model'
    // reads as the 'eu.' inference profile and is returned unqualified —
    // which Bedrock then rejects as an unknown model.
    expect(bedrockModelId('eu-model')).toBe('anthropic.eu-model');
    expect(bedrockModelId('usurper-1')).toBe('anthropic.usurper-1');
  });
});
