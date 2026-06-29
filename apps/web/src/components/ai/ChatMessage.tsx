import { Bot, User } from 'lucide-react';
import { cn } from '@/utils/cn';

export interface ChatMessageData {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  timestamp: Date;
  suggestedActions?: string[];
}

interface ChatMessageProps {
  message: ChatMessageData;
  onActionClick?: (action: string) => void;
}

/**
 * Format assistant messages with basic markdown-like styling:
 * **bold**, bullet points (- or *), numbered lists, newlines
 */
function formatContent(content: string): React.ReactNode[] {
  const lines = content.split('\n');
  const elements: React.ReactNode[] = [];

  lines.forEach((line, i) => {
    const trimmed = line.trim();

    // Empty line = spacer
    if (!trimmed) {
      elements.push(<div key={i} className="h-2" />);
      return;
    }

    // Bullet points
    if (/^[-*]\s/.test(trimmed)) {
      const text = trimmed.replace(/^[-*]\s/, '');
      elements.push(
        <div key={i} className="flex gap-2 ml-2 mb-1">
          <span className="text-[var(--color-accent-blue)] mt-1 shrink-0">&#8226;</span>
          <span>{renderInline(text)}</span>
        </div>,
      );
      return;
    }

    // Numbered lists
    const numMatch = trimmed.match(/^(\d+)\.\s(.+)/);
    if (numMatch) {
      elements.push(
        <div key={i} className="flex gap-2 ml-2 mb-1">
          <span className="text-[var(--color-text-muted)] shrink-0">{numMatch[1]}.</span>
          <span>{renderInline(numMatch[2])}</span>
        </div>,
      );
      return;
    }

    // Regular line
    elements.push(
      <p key={i} className="mb-1">
        {renderInline(trimmed)}
      </p>,
    );
  });

  return elements;
}

function renderInline(text: string): React.ReactNode {
  // Bold: **text**
  const parts = text.split(/(\*\*[^*]+\*\*)/g);
  return parts.map((part, i) => {
    if (part.startsWith('**') && part.endsWith('**')) {
      return (
        <strong key={i} className="text-[var(--color-text-primary)] font-semibold">
          {part.slice(2, -2)}
        </strong>
      );
    }
    return <span key={i}>{part}</span>;
  });
}

export function ChatMessage({ message, onActionClick }: ChatMessageProps) {
  const isUser = message.role === 'user';
  const time = new Date(message.timestamp).toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
  });

  return (
    <div className={cn('flex gap-3 mb-4', isUser ? 'flex-row-reverse' : 'flex-row')}>
      {/* Avatar */}
      <div
        className={cn(
          'w-8 h-8 rounded-full flex items-center justify-center shrink-0 mt-1',
          isUser
            ? 'bg-[var(--color-accent-blue)]/20 text-[var(--color-accent-blue)]'
            : 'bg-purple-500/20 text-purple-400',
        )}
      >
        {isUser ? <User size={16} /> : <Bot size={16} />}
      </div>

      {/* Message bubble */}
      <div className={cn('max-w-[80%] flex flex-col', isUser ? 'items-end' : 'items-start')}>
        <div
          className={cn(
            'rounded-2xl px-4 py-3 text-sm leading-relaxed',
            isUser
              ? 'bg-[var(--color-accent-blue)] text-white rounded-br-md'
              : 'bg-[var(--color-bg-card)] border border-[var(--color-border-subtle)] text-[var(--color-text-primary)] rounded-bl-md',
          )}
        >
          {isUser ? (
            <p>{message.content}</p>
          ) : (
            <div className="space-y-0">{formatContent(message.content)}</div>
          )}
        </div>

        {/* Suggested actions */}
        {!isUser && message.suggestedActions && message.suggestedActions.length > 0 && (
          <div className="flex flex-wrap gap-2 mt-2">
            {message.suggestedActions.map((action, i) => (
              <button
                key={i}
                onClick={() => onActionClick?.(action)}
                className="text-xs px-3 py-1.5 rounded-full bg-[var(--color-bg-tertiary)] border border-[var(--color-border-subtle)] text-[var(--color-text-secondary)] hover:text-[var(--color-accent-blue)] hover:border-[var(--color-accent-blue)]/50 transition-colors"
              >
                {action}
              </button>
            ))}
          </div>
        )}

        {/* Timestamp */}
        <span className="text-[10px] text-[var(--color-text-muted)] mt-1 px-1">{time}</span>
      </div>
    </div>
  );
}
