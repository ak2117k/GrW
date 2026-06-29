import { useEffect, useRef } from 'react';
import { useAdvisorStore } from '@/stores/advisor-store';

const REFRESH_INTERVAL = 60_000; // 60 seconds

export function useAdvisor() {
  const fetchInsights = useAdvisorStore((s) => s.fetchInsights);
  const fetchReports = useAdvisorStore((s) => s.fetchReports);
  const fetchSuggestions = useAdvisorStore((s) => s.fetchSuggestions);
  const messages = useAdvisorStore((s) => s.messages);
  const insights = useAdvisorStore((s) => s.insights);
  const reports = useAdvisorStore((s) => s.reports);
  const suggestions = useAdvisorStore((s) => s.suggestions);
  const isLoading = useAdvisorStore((s) => s.isLoading);
  const isTyping = useAdvisorStore((s) => s.isTyping);
  const sendMessage = useAdvisorStore((s) => s.sendMessage);
  const generateReport = useAdvisorStore((s) => s.generateReport);
  const clearMessages = useAdvisorStore((s) => s.clearMessages);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    // Fetch initial data
    fetchInsights();
    fetchReports(5);
    fetchSuggestions();

    // Refresh insights periodically
    intervalRef.current = setInterval(() => {
      fetchInsights();
      fetchSuggestions();
    }, REFRESH_INTERVAL);

    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
  }, [fetchInsights, fetchReports, fetchSuggestions]);

  return {
    messages,
    insights,
    reports,
    suggestions,
    isLoading,
    isTyping,
    sendMessage,
    generateReport,
    clearMessages,
  };
}
