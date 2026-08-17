import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Injectable, Logger } from '@nestjs/common';
import type {
  MessagesTransport,
  TransportMessage,
  TransportRequest,
} from '../services/llm-transport';

/**
 * How long one verdict may take before the subprocess is killed.
 *
 * Generous on purpose: a high-effort Opus verdict thinks for a while, and a
 * timeout that fires mid-reasoning costs the whole call for nothing. The cycle
 * treats a failure here as "no verdict this tick", never as a HOLD.
 */
export const CLI_TIMEOUT_MS = 180_000;

/** Bound on captured output, so a runaway subprocess cannot exhaust memory. */
const MAX_OUTPUT_BYTES = 8 * 1024 * 1024;

/**
 * The flags that starve the CLI down to the prompt we actually want.
 *
 * MEASURED, NOT GUESSED. A default `claude -p` inherits the whole interactive
 * environment — Claude Code's own system prompt, every tool definition, the
 * configured MCP servers, project CLAUDE.md — which measured at ~30,000 tokens
 * of overhead on a call whose real content was nine. At a verdict per position
 * per tripwire fire, that overhead alone would exhaust a subscription's window
 * inside a morning. With these flags the same call measured 994 tokens.
 *
 * `--bare` looks purpose-built for this and MUST NOT be used: it forces
 * `ANTHROPIC_API_KEY`-only auth and never reads the OAuth session, which is the
 * one thing this transport exists to use.
 */
const LEAN_FLAGS = [
  '--tools',
  '',
  '--strict-mcp-config',
  '--setting-sources',
  '',
] as const;

/**
 * The envelope `--output-format json` prints. Only the fields we read.
 *
 * `result` carries the assistant's text; `is_error` and `api_error_status` carry
 * the failure. `stop_reason` is the model's, and is passed through unchanged
 * rather than re-derived — the callers branch on `refusal` and `max_tokens`.
 */
interface CliEnvelope {
  is_error?: boolean;
  result?: string;
  stop_reason?: string | null;
  subtype?: string;
  api_error_status?: number | null;
}

/**
 * Text the model may wrap JSON in when it has not been schema-constrained.
 *
 * The API path pins the reply with `output_config.format.json_schema`; the CLI
 * exposes no equivalent, so the schema travels in the prompt and the model is
 * merely ASKED to comply. Fences are the one deviation common enough to be worth
 * tolerating — anything else is left to fail, because a transport that silently
 * repairs malformed replies hides the prompt regression that caused them.
 */
export function stripFences(text: string): string {
  const trimmed = text.trim();
  if (!trimmed.startsWith('```')) return trimmed;
  return trimmed
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/```$/, '')
    .trim();
}

/**
 * The instruction that replaces `output_config.format.json_schema`.
 *
 * THIS IS A REAL DOWNGRADE AND IT IS STATED HERE RATHER THAN HIDDEN. On the API
 * path the schema is ENFORCED — a reply that does not match it cannot come back.
 * Here it is a request, and a model that ignores it produces a rejected verdict.
 * That is the safe direction to fail (a rejected verdict is no verdict, and no
 * verdict means no action) but it is not the same guarantee, and a corpus
 * collected over this transport must not be compared against one collected over
 * the API as though it were.
 */
export function schemaInstruction(schema: Record<string, unknown>): string {
  return [
    '',
    '## Reply format — MANDATORY',
    '',
    'Reply with a single JSON object and NOTHING else: no prose before or after it, no',
    'markdown code fence, no explanation. It must validate against this JSON Schema,',
    'including every entry in `required` and with no properties beyond those listed:',
    '',
    JSON.stringify(schema, null, 2),
  ].join('\n');
}

/**
 * Wrap one argument for a shell command line, so an EMPTY one survives.
 *
 * `--tools ""` is the CLI's documented way to disable every built-in tool, and
 * an unquoted empty argument vanishes into the join — taking the next flag's
 * value with it. Exported for the test that pins exactly that.
 */
export function quoteArg(arg: string): string {
  return `"${arg.replace(/(["\\])/g, '\\$1')}"`;
}

/**
 * Serves the sentinel from a local `claude -p` subprocess on the operator's own
 * Claude subscription, instead of from the Anthropic API.
 *
 * WHAT THIS IS FOR: shadow-mode research, run on the machine that holds the
 * OAuth session. It costs no API credit, which is what makes a multi-week
 * collection run affordable — a high-effort Opus verdict is a few rupees on the
 * API, and shadow mode produces hundreds a day.
 *
 * WHAT IT IS NOT FOR: serving other tenants. A deployed container has no OAuth
 * session and this transport cannot work there; more importantly, a personal
 * subscription is not a licence to power a service for other people. The default
 * is `api` for exactly that reason (see `judgeTransportFrom`).
 *
 * THE ENVIRONMENT IS SCRUBBED, NOT MERELY LEFT UNSET. See {@link childEnv}.
 */
@Injectable()
export class ClaudeCliTransport implements MessagesTransport {
  private readonly logger = new Logger(ClaudeCliTransport.name);

  /** Cached path of the system-prompt file, written once per distinct prompt. */
  private readonly promptFiles = new Map<string, string>();

  private readonly dir = mkdtempSync(join(tmpdir(), 'sentinel-cli-'));

  readonly messages = {
    create: (params: TransportRequest): Promise<TransportMessage> => this.create(params),
  };

  /**
   * The subprocess environment, with the API key REMOVED rather than simply not
   * added.
   *
   * Node's `spawn` inherits `process.env` by default, so a deployment that sets
   * `ANTHROPIC_API_KEY` for the API transport would have every CLI call silently
   * pick it up and bill API credit — no error, no warning, and the subscription
   * this transport exists to use left untouched. "We did not configure it" and
   * "it is not set" are different statements, and only the second is safe.
   */
  private childEnv(): NodeJS.ProcessEnv {
    const env = { ...process.env };
    delete env.ANTHROPIC_API_KEY;
    delete env.ANTHROPIC_AUTH_TOKEN;
    return env;
  }

  /**
   * The system prompt as a FILE, never as an argv string.
   *
   * The sentinel's system prompt is thousands of characters and Windows caps a
   * command line at ~32k. Passing it inline would work in development and fail
   * on a longer prompt with an opaque spawn error.
   */
  private promptFileFor(text: string): string {
    const cached = this.promptFiles.get(text);
    if (cached) return cached;
    const path = join(this.dir, `system-${this.promptFiles.size}.txt`);
    writeFileSync(path, text, 'utf8');
    this.promptFiles.set(text, path);
    return path;
  }

  private async create(params: TransportRequest): Promise<TransportMessage> {
    const system = params.system.map((s) => s.text).join('\n\n');
    const schema = params.output_config.format.schema;
    const promptFile = this.promptFileFor(system + schemaInstruction(schema));

    const args = [
      '-p',
      '--output-format',
      'json',
      '--model',
      params.model,
      '--system-prompt-file',
      promptFile,
      ...LEAN_FLAGS,
    ];

    const stdout = await this.run(args, params.messages.map((m) => m.content).join('\n\n'));

    let envelope: CliEnvelope;
    try {
      envelope = JSON.parse(stdout) as CliEnvelope;
    } catch {
      throw new Error(
        `claude CLI: could not parse the --output-format json envelope: ${stdout.slice(0, 300)}`,
      );
    }

    if (envelope.is_error) {
      // The OAuth session expiring is the one failure an operator can actually
      // fix, and it must not read as a rate limit or a network blip — those are
      // waited out, this one needs a human to run `claude` and sign in.
      const status = envelope.api_error_status;
      const detail = envelope.result ?? envelope.subtype ?? 'no detail';
      if (status === 401 || status === 403 || /auth|login|expired/i.test(detail)) {
        throw new Error(
          'claude CLI: NOT AUTHENTICATED — the OAuth session on this host has expired or was ' +
            'never established. Run `claude` interactively on this machine and sign in. No ' +
            `verdict recorded. (${detail.slice(0, 200)})`,
        );
      }
      throw new Error(
        `claude CLI: the call failed (status ${String(status ?? 'none')}): ${detail.slice(0, 300)}`,
      );
    }

    const text = envelope.result;
    if (typeof text !== 'string' || text.trim() === '') {
      throw new Error('claude CLI: the envelope carried no result text — no verdict recorded');
    }

    return {
      // Passed through, never defaulted: `end_turn` invented here would turn a
      // truncated reply into a parse failure downstream.
      stop_reason: envelope.stop_reason ?? null,
      content: [{ type: 'text', text: stripFences(text) }],
    };
  }

  /** Spawns the CLI and resolves its stdout. Rejects on spawn failure or timeout. */
  private run(args: string[], input: string): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      // ONE PRE-QUOTED COMMAND STRING, not an argv array.
      //
      // The CLI is a `.cmd` shim on Windows, so `spawn` needs a shell to run it
      // at all — and with `shell: true` Node joins the argv array into a command
      // line ITSELF, which silently DROPS empty-string arguments. `--tools ""`
      // is the documented way to disable every tool, so the empty string is not
      // an edge case here, it is the value: the flag arrived bare and the CLI
      // exited with `option '--setting-sources <sources>' argument missing`.
      //
      // Quoting every argument ourselves makes `""` survive on both platforms.
      // Safe because every input is ours — a constant model name and a path from
      // `mkdtemp` — never user or model text, which rides on stdin.
      const commandLine = ['claude', ...args].map(quoteArg).join(' ');
      const child = spawn(commandLine, {
        env: this.childEnv(),
        shell: true,
        windowsHide: true,
      });

      let out = '';
      let err = '';
      let truncated = false;
      let settled = false;

      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        child.kill();
        reject(new Error(`claude CLI: timed out after ${CLI_TIMEOUT_MS}ms — no verdict recorded`));
      }, CLI_TIMEOUT_MS);

      const finish = (fn: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        fn();
      };

      child.stdout.on('data', (d: Buffer) => {
        if (out.length > MAX_OUTPUT_BYTES) {
          truncated = true;
          return;
        }
        out += d.toString();
      });
      child.stderr.on('data', (d: Buffer) => {
        if (err.length < 64_000) err += d.toString();
      });

      child.on('error', (e) =>
        finish(() =>
          reject(
            new Error(
              `claude CLI: could not start the \`claude\` executable — is it installed and on ` +
                `PATH? (${e.message})`,
            ),
          ),
        ),
      );

      child.on('close', (code) =>
        finish(() => {
          if (truncated) {
            reject(new Error('claude CLI: output exceeded the capture limit — no verdict recorded'));
            return;
          }
          if (code !== 0) {
            reject(
              new Error(
                `claude CLI: exited with code ${String(code)}: ${err.slice(0, 300) || 'no stderr'}`,
              ),
            );
            return;
          }
          resolve(out);
        }),
      );

      child.stdin.on('error', () => {
        // EPIPE when the child died before reading stdin. The `close` handler
        // above already carries the real reason; swallowing here only stops an
        // unhandled error event from masking it.
      });
      child.stdin.end(input);
    });
  }
}
