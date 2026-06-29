import { useState, useRef, type KeyboardEvent } from 'react';
import { Send } from 'lucide-react';
import { cn } from '@/utils/cn';

const QUICK_QUESTIONS = [
  'How am I doing?',
  'What should I improve?',
  'Analyze my last trade',
  'Best strategy this week?',
];

interface ChatInputProps {
  onSend: (message: string) => void;
  isTyping: boolean;
}

export function ChatInput({ onSend, isTyping }: ChatInputProps) {
  const [value, setValue] = useState('');
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  function handleSend() {
    const trimmed = value.trim();
    if (!trimmed || isTyping) return;
    onSend(trimmed);
    setValue('');
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto';
    }
  }

  function handleKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  }

  function handleInput() {
    const el = textareaRef.current;
    if (el) {
      el.style.height = 'auto';
      el.style.height = `${Math.min(el.scrollHeight, 120)}px`;
    }
  }

  function handleQuickQuestion(q: string) {
    if (isTyping) return;
    onSend(q);
  }

  return (
    <div className="border-t border-[var(--color-border-subtle)] bg-[var(--color-bg-secondary)] p-4">
      {/* Quick question chips */}
      <div className="flex flex-wrap gap-2 mb-3">
        {QUICK_QUESTIONS.map((q) => (
          <button
            key={q}
            onClick={() => handleQuickQuestion(q)}
            disabled={isTyping}
            className="text-xs px-3 py-1.5 rounded-full bg-[var(--color-bg-tertiary)] border border-[var(--color-border-subtle)] text-[var(--color-text-secondary)] hover:text-[var(--color-accent-blue)] hover:border-[var(--color-accent-blue)]/50 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {q}
          </button>
        ))}
      </div>

      {/* Input area */}
      <div className="flex items-end gap-2">
        <textarea
          ref={textareaRef}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={handleKeyDown}
          onInput={handleInput}
          placeholder="Ask your AI trading advisor..."
          rows={1}
          className="flex-1 resize-none rounded-xl bg-[var(--color-bg-tertiary)] border border-[var(--color-border-subtle)] px-4 py-3 text-sm text-[var(--color-text-primary)] placeholder:text-[var(--color-text-muted)] focus:outline-none focus:border-[var(--color-accent-blue)] transition-colors"
        />
        <button
          onClick={handleSend}
          disabled={!value.trim() || isTyping}
          className={cn(
            'w-10 h-10 rounded-xl flex items-center justify-center shrink-0 transition-all',
            value.trim() && !isTyping
              ? 'bg-[var(--color-accent-blue)] text-white hover:bg-[var(--color-accent-blue)]/80'
              : 'bg-[var(--color-bg-tertiary)] text-[var(--color-text-muted)] cursor-not-allowed',
          )}
        >
          <Send size={18} />
        </button>
      </div>

      {/* Typing indicator */}
      {isTyping && (
        <div className="flex items-center gap-1.5 mt-2 ml-1">
          <span className="text-xs text-[var(--color-text-muted)]">AI is thinking</span>
          <span className="flex gap-1">
            <span className="w-1.5 h-1.5 rounded-full bg-purple-400 animate-pulse-dot" style={{ animationDelay: '0ms' }} />
            <span className="w-1.5 h-1.5 rounded-full bg-purple-400 animate-pulse-dot" style={{ animationDelay: '200ms' }} />
            <span className="w-1.5 h-1.5 rounded-full bg-purple-400 animate-pulse-dot" style={{ animationDelay: '400ms' }} />
          </span>
        </div>
      )}
    </div>
  );
}
