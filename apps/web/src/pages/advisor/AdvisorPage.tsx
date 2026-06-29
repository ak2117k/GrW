import { useRef, useEffect, useState } from 'react';
import { Brain, FileText, RefreshCw } from 'lucide-react';
import { useAdvisor } from '@/hooks/useAdvisor';
import { ChatMessage } from '@/components/ai/ChatMessage';
import { ChatInput } from '@/components/ai/ChatInput';
import { InsightCard } from '@/components/ai/InsightCard';
import { WeeklyReportCard } from '@/components/ai/WeeklyReportCard';
import { PerformanceInsights } from '@/components/ai/PerformanceInsights';
import { cn } from '@/utils/cn';

export default function AdvisorPage() {
  const {
    messages,
    insights,
    reports,
    suggestions,
    isLoading,
    isTyping,
    sendMessage,
    generateReport,
  } = useAdvisor();

  const chatEndRef = useRef<HTMLDivElement>(null);
  const [generatingReport, setGeneratingReport] = useState(false);

  // Auto-scroll chat to bottom on new messages
  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, isTyping]);

  async function handleGenerateReport() {
    setGeneratingReport(true);
    try {
      await generateReport();
    } finally {
      setGeneratingReport(false);
    }
  }

  function handleActionClick(action: string) {
    sendMessage(action);
  }

  return (
    <div className="h-full flex flex-col">
      {/* Header */}
      <div className="flex items-center justify-between px-1 mb-4">
        <div className="flex items-center gap-3">
          <div className="w-9 h-9 rounded-lg bg-purple-500/15 flex items-center justify-center">
            <Brain size={20} className="text-purple-400" />
          </div>
          <div>
            <h1 className="text-xl font-bold text-[var(--color-text-primary)]">
              AI Trading Advisor
            </h1>
            <p className="text-xs text-[var(--color-text-muted)]">
              Intelligent insights, trade analysis, and conversational Q&A
            </p>
          </div>
        </div>

        <button
          onClick={handleGenerateReport}
          disabled={generatingReport || isLoading}
          className={cn(
            'flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition-all',
            generatingReport || isLoading
              ? 'bg-[var(--color-bg-tertiary)] text-[var(--color-text-muted)] cursor-not-allowed'
              : 'bg-purple-500/15 text-purple-400 hover:bg-purple-500/25 border border-purple-500/30',
          )}
        >
          {generatingReport ? (
            <RefreshCw size={16} className="animate-spin" />
          ) : (
            <FileText size={16} />
          )}
          {generatingReport ? 'Generating...' : 'Generate Report'}
        </button>
      </div>

      {/* Main content: Two-column layout */}
      <div className="flex-1 flex gap-4 min-h-0">
        {/* Left column: Chat (65%) */}
        <div className="w-[65%] flex flex-col rounded-xl border border-[var(--color-border-subtle)] bg-[var(--color-bg-secondary)] overflow-hidden">
          {/* Chat messages */}
          <div className="flex-1 overflow-y-auto p-4">
            {messages.length === 0 && (
              <div className="flex flex-col items-center justify-center h-full text-center py-12">
                <div className="w-16 h-16 rounded-2xl bg-purple-500/10 flex items-center justify-center mb-4">
                  <Brain size={32} className="text-purple-400" />
                </div>
                <h3 className="text-lg font-semibold text-[var(--color-text-primary)] mb-2">
                  Ask me anything about your trading
                </h3>
                <p className="text-sm text-[var(--color-text-muted)] max-w-md mb-6">
                  I can analyze your performance, explain losses, assess trades,
                  and suggest improvements based on your trading data.
                </p>
                <div className="flex flex-wrap justify-center gap-2">
                  {[
                    'How am I doing?',
                    'Why did I lose?',
                    'What should I improve?',
                    'Should I take this trade?',
                  ].map((q) => (
                    <button
                      key={q}
                      onClick={() => sendMessage(q)}
                      className="text-sm px-4 py-2 rounded-xl bg-[var(--color-bg-tertiary)] border border-[var(--color-border-subtle)] text-[var(--color-text-secondary)] hover:text-purple-400 hover:border-purple-500/40 transition-colors"
                    >
                      {q}
                    </button>
                  ))}
                </div>
              </div>
            )}

            {messages.map((msg) => (
              <ChatMessage
                key={msg.id}
                message={msg}
                onActionClick={handleActionClick}
              />
            ))}

            {/* Typing indicator in chat area */}
            {isTyping && (
              <div className="flex gap-3 mb-4">
                <div className="w-8 h-8 rounded-full bg-purple-500/20 flex items-center justify-center shrink-0">
                  <Brain size={16} className="text-purple-400" />
                </div>
                <div className="rounded-2xl rounded-bl-md bg-[var(--color-bg-card)] border border-[var(--color-border-subtle)] px-4 py-3">
                  <div className="flex gap-1.5">
                    <span className="w-2 h-2 rounded-full bg-purple-400 animate-pulse-dot" style={{ animationDelay: '0ms' }} />
                    <span className="w-2 h-2 rounded-full bg-purple-400 animate-pulse-dot" style={{ animationDelay: '200ms' }} />
                    <span className="w-2 h-2 rounded-full bg-purple-400 animate-pulse-dot" style={{ animationDelay: '400ms' }} />
                  </div>
                </div>
              </div>
            )}

            <div ref={chatEndRef} />
          </div>

          {/* Input */}
          <ChatInput onSend={sendMessage} isTyping={isTyping} />
        </div>

        {/* Right column: Insights panel (35%) */}
        <div className="w-[35%] flex flex-col gap-4 overflow-y-auto pr-1">
          {/* Performance Insights / Suggestions */}
          <PerformanceInsights suggestions={suggestions} />

          {/* Insights */}
          {insights.length > 0 && (
            <div className="space-y-3">
              <h3 className="text-sm font-semibold text-[var(--color-text-primary)]">
                Current Insights
              </h3>
              {insights.slice(0, 4).map((insight) => (
                <InsightCard key={insight.id} insight={insight} />
              ))}
            </div>
          )}

          {/* Weekly Reports */}
          {reports.length > 0 && (
            <div className="space-y-3">
              <h3 className="text-sm font-semibold text-[var(--color-text-primary)]">
                Weekly Reports
              </h3>
              {reports.slice(0, 3).map((report) => (
                <WeeklyReportCard key={report.id} report={report} />
              ))}
            </div>
          )}

          {/* Empty state when no insights or reports */}
          {insights.length === 0 && reports.length === 0 && suggestions.length === 0 && (
            <div className="rounded-xl border border-[var(--color-border-subtle)] bg-[var(--color-bg-card)] p-6 text-center">
              <Brain size={28} className="mx-auto mb-3 text-[var(--color-text-muted)]" />
              <p className="text-sm text-[var(--color-text-muted)]">
                Insights and reports will appear here as you trade and interact with the advisor.
              </p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
