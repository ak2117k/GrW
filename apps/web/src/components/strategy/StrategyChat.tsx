import { useState, useCallback, useRef, useEffect } from 'react';
import ReactMarkdown from 'react-markdown';
import { Send, X, MessageSquare, Loader2, AlertCircle, Sparkles } from 'lucide-react';
import { cn } from '@/utils/cn';
import { requestInsight, getLatestInsight, type AIInsight } from '@/services/insights';

/**
 * A chat message in local state. Each user message triggers a new insight
 * row; the assistant slot that follows it polls that row by contextKey and
 * streams the completed markdown back in.
 */
interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  // For assistant messages: the contextKey used to identify this turn's
  // insight row. We use this in the render tree to mount a useInsight hook.
  contextKey?: string;
  // Snapshot of chat + strategy at the moment the user message was sent —
  // passed as contextData so Claude sees exactly what you see right now.
  contextData?: Record<string, unknown>;
}

// Persistent chat session ID for the life of the page. Reload = new chat.
function useChatSessionId(): string {
  const ref = useRef<string>('');
  if (!ref.current) {
    ref.current = `chat_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
  }
  return ref.current;
}

interface StrategyChatProps {
  open: boolean;
  onClose: () => void;
  /** Which insight queue this chat posts into. Defaults to 'strategy-chat'. */
  sectionKey?: string;
  /** Drawer header title. Defaults to 'Strategy Chat'. */
  title?: string;
  /** Snapshot of the page's state that Claude sees alongside every message. */
  snapshot: Record<string, unknown>;
  /** Placeholder text for the input. */
  placeholder?: string;
}

export function StrategyChat({
  open,
  onClose,
  sectionKey = 'strategy-chat',
  title = 'Strategy Chat',
  snapshot,
  placeholder = 'Ask about your strategy... (Enter to send, Shift+Enter for new line)',
}: StrategyChatProps) {
  const sessionId = useChatSessionId();
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState('');
  const scrollRef = useRef<HTMLDivElement>(null);

  // Auto-scroll to bottom on new messages.
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages]);

  // When an assistant bubble completes, write the content back into local
  // state so the next user message includes it in chatHistory. Without this,
  // every new turn ships an empty "assistant" placeholder and Claude has no
  // memory of what it said before.
  const handleAssistantComplete = useCallback((messageId: string, content: string) => {
    setMessages((prev) =>
      prev.map((m) => (m.id === messageId && m.role === 'assistant' ? { ...m, content } : m)),
    );
  }, []);

  const handleSend = useCallback(() => {
    const text = input.trim();
    if (!text) return;

    const userMsgId = `msg_${messages.length}_user`;
    const assistantMsgId = `msg_${messages.length + 1}_assistant`;
    const contextKey = `${sessionId}:msg-${messages.length + 1}`;

    // Chat history Claude will see: everything up to and including this
    // user message. Previous assistant messages are included too, so the
    // conversation has continuity.
    const historyForClaude = [
      ...messages.map((m) => ({ role: m.role, content: m.content })),
      { role: 'user' as const, content: text },
    ];

    const contextData = {
      snapshot,
      chatHistory: historyForClaude,
      sessionId,
    };

    setMessages((prev) => [
      ...prev,
      { id: userMsgId, role: 'user', content: text },
      { id: assistantMsgId, role: 'assistant', content: '', contextKey, contextData },
    ]);
    setInput('');
  }, [input, messages, sessionId, snapshot]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        handleSend();
      }
    },
    [handleSend],
  );

  return (
    <>
      {/* Backdrop */}
      {open && (
        <div
          className="fixed inset-0 z-40 bg-black/40 backdrop-blur-sm transition-opacity"
          onClick={onClose}
        />
      )}

      {/* Drawer */}
      <aside
        className={cn(
          'fixed right-0 top-0 z-50 flex h-full w-full max-w-md flex-col border-l border-[var(--color-border-subtle)] bg-[var(--color-bg-primary)] shadow-2xl transition-transform duration-300',
          open ? 'translate-x-0' : 'translate-x-full',
        )}
      >
        {/* Header */}
        <div className="flex items-center justify-between border-b border-[var(--color-border-subtle)] bg-[var(--color-bg-secondary)] px-4 py-3">
          <div className="flex items-center gap-2">
            <Sparkles size={16} className="text-[var(--color-accent-purple,#a78bfa)]" />
            <h2 className="text-sm font-semibold text-[var(--color-text-primary)]">
              {title}
            </h2>
            <span className="text-[10px] text-[var(--color-text-muted)]">
              {messages.length > 0 ? `${messages.length / 2} turns` : 'new session'}
            </span>
          </div>
          <button
            onClick={onClose}
            className="rounded p-1 text-[var(--color-text-muted)] transition-colors hover:bg-[var(--color-bg-tertiary)] hover:text-[var(--color-text-primary)]"
            aria-label="Close chat"
          >
            <X size={16} />
          </button>
        </div>

        {/* Message list */}
        <div ref={scrollRef} className="flex-1 overflow-y-auto p-4 space-y-4">
          {messages.length === 0 && (
            <div className="flex h-full items-center justify-center text-center">
              <div className="text-xs text-[var(--color-text-muted)] max-w-[240px] space-y-2">
                <MessageSquare size={20} className="mx-auto opacity-50" />
                <p>Ask Claude anything about your strategy.</p>
                <p className="opacity-70">
                  Your current code, rules, and settings are included automatically — just ask.
                </p>
              </div>
            </div>
          )}

          {messages.map((msg) =>
            msg.role === 'user' ? (
              <UserBubble key={msg.id} content={msg.content} />
            ) : (
              <AssistantBubble
                key={msg.id}
                sectionKey={sectionKey}
                contextKey={msg.contextKey!}
                contextData={msg.contextData!}
                onComplete={(content) => handleAssistantComplete(msg.id, content)}
              />
            ),
          )}
        </div>

        {/* Input */}
        <div className="border-t border-[var(--color-border-subtle)] bg-[var(--color-bg-secondary)] p-3">
          <div className="flex items-end gap-2">
            <textarea
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder={placeholder}
              rows={2}
              className="flex-1 resize-none rounded-md border border-[var(--color-border-default)] bg-[var(--color-bg-tertiary)] px-3 py-2 text-xs text-[var(--color-text-primary)] placeholder:text-[var(--color-text-muted)] focus:border-[var(--color-accent-blue)] focus:outline-none"
            />
            <button
              onClick={handleSend}
              disabled={!input.trim()}
              className="flex h-9 w-9 items-center justify-center rounded-md bg-[var(--color-accent-blue)] text-white transition-colors hover:bg-blue-500 disabled:cursor-not-allowed disabled:opacity-40"
              aria-label="Send"
            >
              <Send size={14} />
            </button>
          </div>
          <p className="mt-2 text-[10px] text-[var(--color-text-muted)]">
            Responses take ~60 s (next /loop tick drains the queue).
          </p>
        </div>
      </aside>
    </>
  );
}

function UserBubble({ content }: { content: string }) {
  return (
    <div className="flex justify-end">
      <div className="max-w-[85%] rounded-2xl rounded-br-sm bg-[var(--color-accent-blue)]/20 px-3 py-2 text-xs text-[var(--color-text-primary)] whitespace-pre-wrap break-words">
        {content}
      </div>
    </div>
  );
}

/**
 * Self-contained insight requester + poller for a single chat turn.
 *
 * Why not reuse `useInsight`: that hook is built for the "mount, show empty
 * state, user clicks Ask" pattern used by options/news cards. Here we need
 * to POST on mount, which races with useInsight's initial 404 fetch and
 * causes the pending row to be clobbered by the 404 result. A dedicated
 * minimal flow is simpler than making useInsight support both patterns.
 *
 * On completion we call onComplete(content) so the parent can write the
 * response into the chat history — critical for multi-turn continuity,
 * since each new user message ships the full history to Claude.
 */
const POLL_INTERVAL_MS = 3_000;
const MAX_POLL_ATTEMPTS = 60; // ~3 minutes

function AssistantBubble({
  sectionKey,
  contextKey,
  contextData,
  onComplete,
}: {
  sectionKey: string;
  contextKey: string;
  contextData: Record<string, unknown>;
  onComplete: (content: string) => void;
}) {
  const [insight, setInsight] = useState<AIInsight | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [debug, setDebug] = useState<string>('init');

  const onCompleteRef = useRef(onComplete);
  const contextDataRef = useRef(contextData);
  const completedNotifiedRef = useRef(false);

  useEffect(() => {
    onCompleteRef.current = onComplete;
  }, [onComplete]);
  useEffect(() => {
    contextDataRef.current = contextData;
  }, [contextData]);

  /**
   * Run-ID pattern instead of a cancelled-flag: each effect invocation
   * gets a new runId via ++runIdRef.current. Inside async callbacks we
   * check isLive() which compares the closure's captured runId to the
   * current ref. In StrictMode dev the effect runs twice: run 1 is
   * immediately stale once run 2 bumps the ref, so run 1's state writes
   * are dropped without needing cleanup-time invalidation.
   */
  const runIdRef = useRef(0);

  useEffect(() => {
    const runId = ++runIdRef.current;
    const isLive = () => runIdRef.current === runId;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let attempts = 0;

    // eslint-disable-next-line no-console
    console.log(`[chat ${contextKey}] effect start, runId=${runId}`);
    setDebug(`start runId=${runId}`);

    const poll = async () => {
      if (!isLive()) return;
      attempts += 1;
      if (attempts > MAX_POLL_ATTEMPTS) {
        setError('Taking longer than expected. Please retry.');
        setDebug(`timeout`);
        return;
      }
      try {
        const row = await getLatestInsight(sectionKey, contextKey);
        if (!isLive()) return;
        // eslint-disable-next-line no-console
        console.log(`[chat ${contextKey}] poll#${attempts} → ${row?.status ?? 'null'}`);
        setDebug(`poll#${attempts} ${row?.status ?? 'null'}`);
        if (row) {
          setInsight(row);
          if (row.status === 'pending' || row.status === 'in_progress') {
            timer = setTimeout(poll, POLL_INTERVAL_MS);
          } else if (row.status === 'completed' && row.insight && !completedNotifiedRef.current) {
            completedNotifiedRef.current = true;
            onCompleteRef.current(row.insight);
          }
        } else {
          timer = setTimeout(poll, POLL_INTERVAL_MS);
        }
      } catch (err) {
        if (!isLive()) return;
        setError(err instanceof Error ? err.message : 'Poll failed');
        setDebug(`poll-err`);
      }
    };

    const start = async () => {
      try {
        // eslint-disable-next-line no-console
        console.log(`[chat ${contextKey}] POST requestInsight`);
        const row = await requestInsight(sectionKey, contextKey, contextDataRef.current);
        // eslint-disable-next-line no-console
        console.log(`[chat ${contextKey}] POST → ${row.status} ${row.id}`);
        if (!isLive()) return;
        setInsight(row);
        setDebug(`post ${row.status}`);
        if (row.status === 'completed' && row.insight) {
          if (!completedNotifiedRef.current) {
            completedNotifiedRef.current = true;
            onCompleteRef.current(row.insight);
          }
          return;
        }
        timer = setTimeout(poll, POLL_INTERVAL_MS);
      } catch (err) {
        if (!isLive()) return;
        // eslint-disable-next-line no-console
        console.error(`[chat ${contextKey}] POST error`, err);
        setError(err instanceof Error ? err.message : 'Request failed');
        setDebug(`post-err`);
      }
    };

    void start();

    return () => {
      // Do NOT invalidate the runId here — StrictMode cleanup+re-mount
      // would then invalidate the very run about to commit state. The
      // NEXT effect invocation will bump runIdRef, implicitly cancelling
      // any in-flight work from this run.
      if (timer) clearTimeout(timer);
      // eslint-disable-next-line no-console
      console.log(`[chat ${contextKey}] cleanup runId=${runId}`);
    };
  }, [contextKey]);

  return (
    <div className="flex justify-start">
      <div className="max-w-[90%] rounded-2xl rounded-bl-sm border border-[var(--color-border-subtle)] bg-[var(--color-bg-secondary)] px-3 py-2 text-xs text-[var(--color-text-secondary)]">
        {error && (
          <div className="flex items-center gap-1.5 text-red-400">
            <AlertCircle size={12} />
            <span>{error}</span>
          </div>
        )}
        {!error && (!insight || insight.status === 'pending' || insight.status === 'in_progress') && (
          <div className="flex flex-col gap-1">
            <div className="flex items-center gap-1.5 text-[var(--color-text-muted)]">
              <Loader2 size={12} className="animate-spin" />
              <span>Thinking...</span>
            </div>
            <span className="text-[9px] text-[var(--color-text-muted)] opacity-60 font-mono">
              dbg: {debug}
            </span>
          </div>
        )}
        {!error && insight?.status === 'completed' && insight.insight && (
          <div className="text-xs leading-relaxed [&_h1]:mb-2 [&_h1]:text-sm [&_h1]:font-semibold [&_h1]:text-[var(--color-text-primary)] [&_h2]:mb-2 [&_h2]:mt-3 [&_h2]:text-sm [&_h2]:font-semibold [&_h2]:text-[var(--color-text-primary)] [&_h3]:mb-1 [&_h3]:mt-2 [&_h3]:text-xs [&_h3]:font-semibold [&_h3]:text-[var(--color-text-primary)] [&_p]:mb-2 [&_ul]:mb-2 [&_ul]:list-disc [&_ul]:pl-4 [&_ol]:mb-2 [&_ol]:list-decimal [&_ol]:pl-4 [&_li]:mb-1 [&_strong]:font-semibold [&_strong]:text-[var(--color-text-primary)] [&_code]:rounded [&_code]:bg-[var(--color-bg-tertiary)] [&_code]:px-1 [&_code]:py-0.5 [&_code]:text-[10px] [&_pre]:my-2 [&_pre]:overflow-x-auto [&_pre]:rounded [&_pre]:bg-[var(--color-bg-tertiary)] [&_pre]:p-2 [&_pre]:text-[10px] [&_table]:my-2 [&_table]:text-[10px] [&_th]:border [&_th]:border-[var(--color-border-subtle)] [&_th]:px-1.5 [&_th]:py-0.5 [&_td]:border [&_td]:border-[var(--color-border-subtle)] [&_td]:px-1.5 [&_td]:py-0.5">
            <ReactMarkdown>{insight.insight}</ReactMarkdown>
          </div>
        )}
        {!error && insight?.status === 'failed' && (
          <div className="flex items-center gap-1.5 text-red-400">
            <AlertCircle size={12} />
            <span>{insight.errorMessage ?? 'Analysis failed'}</span>
          </div>
        )}
      </div>
    </div>
  );
}
