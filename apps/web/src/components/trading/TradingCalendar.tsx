import { useState, useEffect, useCallback } from 'react';
import {
  ChevronLeft,
  ChevronRight,
  Calendar,
  TrendingUp,
  AlertTriangle,
  Star,
} from 'lucide-react';
import { cn } from '@/utils/cn';
import api from '@/services/api';

interface CalendarDay {
  date: string;
  dayOfWeek: string;
  isWeekend: boolean;
  isHoliday: boolean;
  holidayName?: string;
  closedExchanges: string[];
  importance: string;
  importanceLabel?: string;
  profitProbability: number;
  newsCount: number;
  newsSentiment: number;
}

interface CalendarHoliday {
  date: string;
  name: string;
  exchanges: string[];
}

interface CalendarData {
  year: number;
  month: number;
  days: CalendarDay[];
  holidays: CalendarHoliday[];
  nextHoliday: CalendarHoliday | null;
}

const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

const DAY_HEADERS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function getProbabilityColor(prob: number): string {
  if (prob === 0) return 'bg-gray-800/40 text-gray-600';
  if (prob >= 75) return 'bg-emerald-500/20 text-emerald-300';
  if (prob >= 60) return 'bg-emerald-500/10 text-emerald-400';
  if (prob >= 45) return 'bg-gray-700/50 text-gray-300';
  return 'bg-amber-500/10 text-amber-400';
}

function getImportanceBadge(importance: string): { icon: React.ReactNode; color: string } | null {
  switch (importance) {
    case 'monthly-expiry':
      return { icon: <Star size={8} />, color: 'text-blue-400' };
    case 'weekly-expiry':
      return { icon: <span className="text-[7px]">E</span>, color: 'text-blue-300/60' };
    case 'budget':
      return { icon: <AlertTriangle size={8} />, color: 'text-amber-400' };
    case 'rbi-policy':
      return { icon: <AlertTriangle size={8} />, color: 'text-purple-400' };
    case 'results-season':
      return { icon: <TrendingUp size={8} />, color: 'text-cyan-400' };
    default:
      return null;
  }
}

export default function TradingCalendar() {
  const now = new Date();
  const [year, setYear] = useState(now.getFullYear());
  const [month, setMonth] = useState(now.getMonth() + 1);
  const [data, setData] = useState<CalendarData | null>(null);
  const [hoveredDay, setHoveredDay] = useState<CalendarDay | null>(null);
  const [isLoading, setIsLoading] = useState(false);

  const fetchCalendar = useCallback(async () => {
    setIsLoading(true);
    try {
      const res = await api.get(`/market-data/trading-calendar?month=${month}&year=${year}`);
      setData(res.data);
    } catch {
      // Silently fail
    } finally {
      setIsLoading(false);
    }
  }, [month, year]);

  useEffect(() => {
    fetchCalendar();
  }, [fetchCalendar]);

  const prevMonth = () => {
    if (month === 1) {
      setMonth(12);
      setYear(year - 1);
    } else {
      setMonth(month - 1);
    }
  };

  const nextMonth = () => {
    if (month === 12) {
      setMonth(1);
      setYear(year + 1);
    } else {
      setMonth(month + 1);
    }
  };

  const goToToday = () => {
    setYear(now.getFullYear());
    setMonth(now.getMonth() + 1);
  };

  // Build calendar grid with empty cells for alignment
  const firstDayOfMonth = new Date(year, month - 1, 1).getDay();

  const todayStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;

  return (
    <div className="rounded-lg border border-gray-700/60 bg-gray-800/40 p-4">
      {/* Header */}
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <Calendar size={16} className="text-blue-400" />
          <h3 className="text-sm font-semibold text-gray-200">Trading Calendar</h3>
        </div>

        <div className="flex items-center gap-2">
          <button
            onClick={goToToday}
            className="rounded px-2 py-0.5 text-[10px] font-medium text-gray-400 hover:text-gray-200 hover:bg-gray-700/50 transition-colors"
          >
            Today
          </button>
          <button onClick={prevMonth} className="p-1 text-gray-400 hover:text-gray-200 transition-colors">
            <ChevronLeft size={14} />
          </button>
          <span className="text-xs font-medium text-gray-200 min-w-[110px] text-center">
            {MONTH_NAMES[month - 1]} {year}
          </span>
          <button onClick={nextMonth} className="p-1 text-gray-400 hover:text-gray-200 transition-colors">
            <ChevronRight size={14} />
          </button>
        </div>
      </div>

      {/* Legend */}
      <div className="flex flex-wrap items-center gap-3 mb-3 text-[9px] text-gray-500">
        <span className="flex items-center gap-1">
          <span className="h-2 w-2 rounded-sm bg-emerald-500/20" /> High Profit Probability
        </span>
        <span className="flex items-center gap-1">
          <span className="h-2 w-2 rounded-sm bg-amber-500/10" /> Low Probability
        </span>
        <span className="flex items-center gap-1">
          <span className="h-2 w-2 rounded-sm bg-red-500/20" /> Holiday
        </span>
        <span className="flex items-center gap-1">
          <Star size={8} className="text-blue-400" /> Monthly Expiry
        </span>
        <span className="flex items-center gap-1">
          <AlertTriangle size={8} className="text-purple-400" /> RBI/Budget
        </span>
      </div>

      {/* Day headers */}
      <div className="grid grid-cols-7 gap-1 mb-1">
        {DAY_HEADERS.map((d) => (
          <div key={d} className="text-center text-[9px] font-medium text-gray-500 py-1">
            {d}
          </div>
        ))}
      </div>

      {/* Calendar grid */}
      {isLoading ? (
        <div className="grid grid-cols-7 gap-1">
          {Array.from({ length: 35 }).map((_, i) => (
            <div key={i} className="h-9 rounded bg-gray-800/40 animate-pulse" />
          ))}
        </div>
      ) : (
        <div className="grid grid-cols-7 gap-1">
          {/* Empty cells for alignment */}
          {Array.from({ length: firstDayOfMonth }).map((_, i) => (
            <div key={`empty-${i}`} className="h-9" />
          ))}

          {/* Day cells */}
          {data?.days.map((day) => {
            const dayNum = parseInt(day.date.slice(-2));
            const isToday = day.date === todayStr;
            const badge = getImportanceBadge(day.importance);

            return (
              <div
                key={day.date}
                className={cn(
                  'relative h-9 rounded flex flex-col items-center justify-center cursor-default transition-all',
                  day.isHoliday
                    ? 'bg-red-500/10 text-red-400'
                    : day.isWeekend
                      ? 'bg-gray-800/30 text-gray-600'
                      : getProbabilityColor(day.profitProbability),
                  isToday && 'ring-1 ring-blue-400/60',
                  'hover:ring-1 hover:ring-gray-500/50',
                )}
                onMouseEnter={() => setHoveredDay(day)}
                onMouseLeave={() => setHoveredDay(null)}
              >
                <span className={cn('text-[11px] font-medium', isToday && 'font-bold')}>
                  {dayNum}
                </span>

                {/* Importance indicator */}
                {badge && (
                  <span className={cn('absolute top-0.5 right-0.5', badge.color)}>
                    {badge.icon}
                  </span>
                )}

                {/* Profit probability mini-bar */}
                {!day.isWeekend && !day.isHoliday && day.profitProbability > 0 && (
                  <div className="absolute bottom-0.5 left-1 right-1 h-[2px] rounded-full bg-gray-700/50 overflow-hidden">
                    <div
                      className={cn(
                        'h-full rounded-full',
                        day.profitProbability >= 65 ? 'bg-emerald-400/60' : 'bg-gray-500/40',
                      )}
                      style={{ width: `${day.profitProbability}%` }}
                    />
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* Tooltip / Hovered day info */}
      {hoveredDay && (
        <div className="mt-3 rounded-md border border-gray-700/60 bg-gray-900/80 px-3 py-2 text-xs">
          <div className="flex items-center justify-between">
            <span className="font-medium text-gray-200">
              {new Date(hoveredDay.date + 'T00:00:00').toLocaleDateString('en-IN', {
                weekday: 'long',
                day: 'numeric',
                month: 'short',
                year: 'numeric',
              })}
            </span>
            {!hoveredDay.isWeekend && !hoveredDay.isHoliday && (
              <span
                className={cn(
                  'rounded-full px-2 py-0.5 text-[10px] font-semibold',
                  hoveredDay.profitProbability >= 65
                    ? 'bg-emerald-500/15 text-emerald-400'
                    : hoveredDay.profitProbability >= 45
                      ? 'bg-gray-700 text-gray-300'
                      : 'bg-amber-500/15 text-amber-400',
                )}
              >
                {hoveredDay.profitProbability}% Profit Probability
              </span>
            )}
          </div>

          <div className="mt-1 flex flex-wrap gap-2 text-[10px] text-gray-400">
            {hoveredDay.isHoliday && (
              <span className="text-red-400">
                Holiday: {hoveredDay.holidayName}
              </span>
            )}
            {hoveredDay.isWeekend && <span>Weekend — Markets closed</span>}
            {hoveredDay.importanceLabel && (
              <span className="text-blue-400">{hoveredDay.importanceLabel}</span>
            )}
            {hoveredDay.newsCount > 0 && (() => {
              const isFuture = hoveredDay.date > todayStr;
              const sentimentLabel = hoveredDay.newsSentiment > 0.1
                ? 'Bullish'
                : hoveredDay.newsSentiment < -0.1
                  ? 'Bearish'
                  : 'Neutral';
              return (
                <span>
                  {isFuture ? (
                    <>Projected from {hoveredDay.newsCount} recent articles • Mood: {sentimentLabel}</>
                  ) : (
                    <>{hoveredDay.newsCount} article{hoveredDay.newsCount > 1 ? 's' : ''} • Sentiment: {sentimentLabel}</>
                  )}
                </span>
              );
            })()}
            {!hoveredDay.isWeekend && !hoveredDay.isHoliday && hoveredDay.closedExchanges.length === 0 && (
              <span className="text-emerald-400/70">NSE & MCX open</span>
            )}
          </div>
        </div>
      )}

      {/* Next holiday banner */}
      {data?.nextHoliday && (
        <div className="mt-3 flex items-center gap-2 rounded-md bg-red-500/5 border border-red-500/10 px-3 py-1.5 text-[10px] text-gray-400">
          <AlertTriangle size={12} className="text-red-400/60" />
          <span>
            Next holiday:{' '}
            <span className="text-red-400 font-medium">{data.nextHoliday.name}</span>
            {' — '}
            {new Date(data.nextHoliday.date + 'T00:00:00').toLocaleDateString('en-IN', {
              weekday: 'short',
              day: 'numeric',
              month: 'short',
            })}
          </span>
        </div>
      )}
    </div>
  );
}
