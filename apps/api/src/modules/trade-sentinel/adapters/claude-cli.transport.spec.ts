import { EventEmitter } from 'node:events';
import { spawn } from 'node:child_process';
import { ClaudeCliTransport, schemaInstruction, stripFences } from './claude-cli.transport';
import { judgeTransportFrom } from '../services/llm-transport';
import type { TransportRequest } from '../services/llm-transport';

jest.mock('node:child_process', () => ({ spawn: jest.fn() }));
const spawnMock = spawn as unknown as jest.Mock;

/** A fake child process that emits one envelope on stdout and closes cleanly. */
function fakeChild(envelope: unknown, opts: { code?: number; stderr?: string } = {}) {
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
    if (opts.stderr) child.stderr.emit('data', Buffer.from(opts.stderr));
    if (envelope !== undefined) {
      child.stdout.emit(
        'data',
        Buffer.from(typeof envelope === 'string' ? envelope : JSON.stringify(envelope)),
      );
    }
    child.emit('close', opts.code ?? 0);
  });
  return child;
}

const request = (over: Partial<TransportRequest> = {}): TransportRequest => ({
  model: 'claude-opus-5',
  max_tokens: 16000,
  output_config: {
    effort: 'high',
    format: { type: 'json_schema', schema: { type: 'object', required: ['verdict'] } },
  },
  system: [{ type: 'text', text: 'You are the sentinel.', cache_control: { type: 'ephemeral' } }],
  messages: [{ role: 'user', content: '{"packet":1}' }],
  ...over,
});

const ok = (text: string) => ({ is_error: false, stop_reason: 'end_turn', result: text });

describe('judgeTransportFrom', () => {
  it('resolves to cli ONLY on an exact opt-in, and to api on everything else', () => {
    // A misspelt value must land on the transport that works from configuration
    // alone, never on the one that needs an OAuth session on somebody's laptop.
    expect(judgeTransportFrom('cli')).toBe('cli');
    expect(judgeTransportFrom('  CLI  ')).toBe('cli');
    expect(judgeTransportFrom('api')).toBe('api');
    expect(judgeTransportFrom('clii')).toBe('api');
    expect(judgeTransportFrom('')).toBe('api');
    expect(judgeTransportFrom(undefined)).toBe('api');
  });
});

describe('stripFences', () => {
  it('unwraps a fenced reply but leaves bare JSON untouched', () => {
    expect(stripFences('```json\n{"a":1}\n```')).toBe('{"a":1}');
    expect(stripFences('```\n{"a":1}\n```')).toBe('{"a":1}');
    expect(stripFences('  {"a":1}  ')).toBe('{"a":1}');
  });

  it('leaves anything else alone rather than trying to repair it', () => {
    // A transport that silently repairs malformed replies hides the prompt
    // regression that caused them.
    expect(stripFences('Here you go: {"a":1}')).toBe('Here you go: {"a":1}');
  });
});

describe('schemaInstruction', () => {
  it('carries the whole schema, since the CLI cannot enforce one', () => {
    const out = schemaInstruction({ type: 'object', required: ['verdict'] });
    expect(out).toContain('"required"');
    expect(out).toContain('verdict');
    expect(out).toMatch(/NOTHING else/i);
  });
});

describe('ClaudeCliTransport', () => {
  let svc: ClaudeCliTransport;

  beforeEach(() => {
    spawnMock.mockReset();
    svc = new ClaudeCliTransport();
  });

  it('DELETES ANTHROPIC_API_KEY from the child environment, not merely omits it', async () => {
    // THE TRAP THIS EXISTS FOR. `spawn` inherits process.env by default, so a
    // deployment that sets the key for the API transport would have every CLI
    // call silently pick it up and bill API credit — no error, no warning, and
    // the subscription this transport exists to use left untouched.
    const prev = process.env.ANTHROPIC_API_KEY;
    const prevToken = process.env.ANTHROPIC_AUTH_TOKEN;
    process.env.ANTHROPIC_API_KEY = 'sk-ant-should-not-reach-the-child';
    process.env.ANTHROPIC_AUTH_TOKEN = 'tok-should-not-reach-the-child';
    try {
      spawnMock.mockReturnValue(fakeChild(ok('{"verdict":"HOLD"}')));
      await svc.messages.create(request());

      const env = spawnMock.mock.calls[0][2].env as NodeJS.ProcessEnv;
      expect('ANTHROPIC_API_KEY' in env).toBe(false);
      expect('ANTHROPIC_AUTH_TOKEN' in env).toBe(false);
      // The rest of the environment must survive — PATH among it, or `claude`
      // is not findable at all.
      expect(env.PATH ?? env.Path).toBeDefined();
    } finally {
      process.env.ANTHROPIC_API_KEY = prev;
      process.env.ANTHROPIC_AUTH_TOKEN = prevToken;
      if (prev === undefined) delete process.env.ANTHROPIC_API_KEY;
      if (prevToken === undefined) delete process.env.ANTHROPIC_AUTH_TOKEN;
    }
  });

  it('starves the CLI of its interactive environment, and never uses --bare', async () => {
    // A default `claude -p` drags ~30k tokens of Claude Code scaffolding into
    // every call. `--bare` trims the same overhead but forces API-key-only auth,
    // which defeats the entire point of this transport.
    spawnMock.mockReturnValue(fakeChild(ok('{"verdict":"HOLD"}')));
    await svc.messages.create(request());

    const args = spawnMock.mock.calls[0][1] as string[];
    expect(args).toEqual(expect.arrayContaining(['--strict-mcp-config', '--tools', '-p']));
    expect(args).not.toContain('--bare');
    expect(args).toContain('--model');
    expect(args[args.indexOf('--model') + 1]).toBe('claude-opus-5');
  });

  it('passes the system prompt as a FILE and the packet on stdin', async () => {
    // The sentinel's system prompt is thousands of characters and Windows caps a
    // command line at ~32k — inline it works in development and fails later with
    // an opaque spawn error.
    const child = fakeChild(ok('{"verdict":"HOLD"}'));
    spawnMock.mockReturnValue(child);
    await svc.messages.create(request());

    const args = spawnMock.mock.calls[0][1] as string[];
    expect(args).toContain('--system-prompt-file');
    expect(args).not.toContain('--system-prompt');
    expect(child.stdin.end).toHaveBeenCalledWith('{"packet":1}');
  });

  it('passes stop_reason through rather than defaulting it', async () => {
    // A fabricated `end_turn` would turn a truncated reply into a parse failure,
    // and the replay harness reads "could not parse" as a prompt regression.
    spawnMock.mockReturnValue(
      fakeChild({ is_error: false, stop_reason: 'max_tokens', result: '{"a":1}' }),
    );
    const out = await svc.messages.create(request());
    expect(out.stop_reason).toBe('max_tokens');

    spawnMock.mockReturnValue(fakeChild({ is_error: false, result: '{"a":1}' }));
    expect((await svc.messages.create(request())).stop_reason).toBeNull();
  });

  it('returns the reply as a single text block, fences stripped', async () => {
    spawnMock.mockReturnValue(fakeChild(ok('```json\n{"verdict":"HOLD"}\n```')));
    const out = await svc.messages.create(request());
    expect(out.content).toEqual([{ type: 'text', text: '{"verdict":"HOLD"}' }]);
  });

  describe('failures', () => {
    it('names an expired OAuth session as such, not as a rate limit', async () => {
      // The one failure an operator can actually fix. A rate limit is waited
      // out; this needs a human to run `claude` and sign in.
      spawnMock.mockReturnValue(
        fakeChild({ is_error: true, api_error_status: 401, result: 'unauthorized' }),
      );
      await expect(svc.messages.create(request())).rejects.toThrow(/NOT AUTHENTICATED/);
    });

    it('reports a non-zero exit with its stderr', async () => {
      spawnMock.mockReturnValue(fakeChild(undefined, { code: 2, stderr: 'boom' }));
      await expect(svc.messages.create(request())).rejects.toThrow(/exited with code 2.*boom/s);
    });

    it('rejects an unparseable envelope rather than guessing', async () => {
      spawnMock.mockReturnValue(fakeChild('not json at all'));
      await expect(svc.messages.create(request())).rejects.toThrow(/could not parse/i);
    });

    it('rejects an envelope with no result text', async () => {
      spawnMock.mockReturnValue(fakeChild({ is_error: false, result: '   ' }));
      await expect(svc.messages.create(request())).rejects.toThrow(/no result text/i);
    });

    it('says the binary is missing when spawn itself fails', async () => {
      // An `error` event and no `close` — what `spawn` does for a missing
      // executable. "claude is not installed" must not read as a bad reply.
      spawnMock.mockImplementation(() => {
        const child = new EventEmitter() as EventEmitter & Record<string, unknown>;
        child.stdout = new EventEmitter();
        child.stderr = new EventEmitter();
        const stdin = new EventEmitter() as EventEmitter & { end: jest.Mock };
        stdin.end = jest.fn();
        child.stdin = stdin;
        child.kill = jest.fn();
        setImmediate(() => child.emit('error', new Error('ENOENT')));
        return child;
      });
      await expect(svc.messages.create(request())).rejects.toThrow(/on PATH/);
    });
  });
});
