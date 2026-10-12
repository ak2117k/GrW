import { EventEmitter } from 'node:events';
import { spawn } from 'node:child_process';
import { AnthropicApiProvider } from './anthropic-api.provider';
import { ClaudeCliProvider, ClaudeCliTransport } from './claude-cli.provider';
import type { TransportMessage, TransportRequest } from '../transport.types';

jest.mock('node:child_process', () => ({ spawn: jest.fn() }));
const spawnMock = spawn as unknown as jest.Mock;

/** A fake child process that emits one envelope on stdout and closes cleanly. */
function fakeChild(envelope: unknown) {
  const child = new EventEmitter() as EventEmitter & {
    stdout: EventEmitter;
    stderr: EventEmitter;
    stdin: EventEmitter & { end: jest.Mock };
    kill: jest.Mock;
  };
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  const stdin = new EventEmitter() as EventEmitter & { end: jest.Mock };
  stdin.end = jest.fn();
  child.stdin = stdin;
  child.kill = jest.fn();
  setImmediate(() => {
    child.stdout.emit(
      'data',
      Buffer.from(typeof envelope === 'string' ? envelope : JSON.stringify(envelope)),
    );
    child.emit('close', 0);
  });
  return child;
}

const request = (): TransportRequest => ({
  model: 'claude-opus-5',
  max_tokens: 16000,
  output_config: {
    effort: 'high',
    format: { type: 'json_schema', schema: { type: 'object', required: ['verdict'] } },
  },
  system: [{ type: 'text', text: 'You are the sentinel.', cache_control: { type: 'ephemeral' } }],
  messages: [{ role: 'user', content: '{"packet":1}' }],
});

describe('AnthropicApiProvider', () => {
  it('calls messages.create with exactly the request and passes the SDK reply through by reference', async () => {
    const reply = {
      content: [{ type: 'text', text: '{"verdict":"HOLD"}' }],
      stop_reason: 'end_turn',
      usage: { input_tokens: 1234, output_tokens: 56 },
    };
    const create = jest.fn().mockResolvedValue(reply);
    const provider = new AnthropicApiProvider({ messages: { create } });
    const req = request();

    const result = await provider.send(req);

    expect(provider.name).toBe('anthropic-api');
    expect(create).toHaveBeenCalledTimes(1);
    expect(create.mock.calls[0]).toHaveLength(1);
    expect(create.mock.calls[0][0]).toEqual(request());
    expect(result.message).toBe(reply);
    expect(result.meta).toEqual({ inputTokens: 1234, outputTokens: 56, billed: true });
  });

  it('records null tokens when the SDK reply carries no usage', async () => {
    const reply = { content: [{ type: 'text', text: '{}' }], stop_reason: 'end_turn' };
    const provider = new AnthropicApiProvider({
      messages: { create: jest.fn().mockResolvedValue(reply) },
    });
    const result = await provider.send(request());
    expect(result.meta).toEqual({ inputTokens: null, outputTokens: null, billed: true });
  });

  it('propagates an SDK rejection as the same error instance', async () => {
    const boom = new Error('529 overloaded');
    const provider = new AnthropicApiProvider({
      messages: { create: jest.fn().mockRejectedValue(boom) },
    });
    await expect(provider.send(request())).rejects.toBe(boom);
  });
});

describe('ClaudeCliProvider', () => {
  beforeEach(() => spawnMock.mockReset());

  it('reads tokens from the envelope usage and is never billed', async () => {
    spawnMock.mockImplementation(() =>
      fakeChild('{"result":"{}","stop_reason":"end_turn","usage":{"input_tokens":12,"output_tokens":3}}'),
    );
    const provider = new ClaudeCliProvider(new ClaudeCliTransport());
    const result = await provider.send(request());

    expect(provider.name).toBe('claude-cli');
    expect(result.meta).toEqual({ inputTokens: 12, outputTokens: 3, billed: false });
    expect(result.message).toEqual({
      stop_reason: 'end_turn',
      content: [{ type: 'text', text: '{}' }],
    });
  });

  it('records null tokens — never invented — when the envelope has no usage (Review Focus 3)', async () => {
    spawnMock.mockImplementation(() => fakeChild('{"result":"{}","stop_reason":"end_turn"}'));
    const result = await new ClaudeCliProvider(new ClaudeCliTransport()).send(request());
    expect(result.meta).toEqual({ inputTokens: null, outputTokens: null, billed: false });
  });

  it('records null for usage fields that are not numbers', async () => {
    spawnMock.mockImplementation(() =>
      fakeChild('{"result":"{}","stop_reason":"end_turn","usage":{"input_tokens":"12","output_tokens":null}}'),
    );
    const result = await new ClaudeCliProvider(new ClaudeCliTransport()).send(request());
    expect(result.meta).toEqual({ inputTokens: null, outputTokens: null, billed: false });
  });

  it('messages.create returns the same message as createWithMeta for the same envelope', async () => {
    const envelope = JSON.stringify({
      result: '```json\n{"verdict":"HOLD"}\n```',
      stop_reason: 'end_turn',
      usage: { input_tokens: 12, output_tokens: 3 },
    });
    spawnMock.mockImplementation(() => fakeChild(envelope));
    const cli = new ClaudeCliTransport();

    const viaCreate: TransportMessage = await cli.messages.create(request());
    const viaMeta = await cli.createWithMeta(request());

    expect(viaCreate).toEqual(viaMeta.message);
    expect(viaCreate).toEqual({
      stop_reason: 'end_turn',
      content: [{ type: 'text', text: '{"verdict":"HOLD"}' }],
    });
  });
});
