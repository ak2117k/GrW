interface ScoreCheck {
  name: string;
  points: number;
  pointsPossible: number;
  passed: boolean;
  detail?: Record<string, unknown>;
}

interface ChartinkScoreTableProps {
  score: number;
  lotCount: 0 | 1 | 2 | 3;
  checks: ScoreCheck[];
}

function scoreColor(score: number): string {
  if (score >= 80) return 'text-emerald-400 bg-emerald-500/15';
  if (score >= 65) return 'text-blue-400 bg-blue-500/15';
  if (score >= 50) return 'text-amber-400 bg-amber-500/15';
  return 'text-gray-400 bg-gray-500/10';
}

function formatDetail(detail: Record<string, unknown> | undefined): string {
  if (!detail) return '';
  if (detail.reason) return String(detail.reason);
  if (detail.error) return `error: ${detail.error}`;
  const parts: string[] = [];
  for (const [k, v] of Object.entries(detail)) {
    if (typeof v === 'number') parts.push(`${k}=${v.toFixed(2)}`);
    else if (typeof v === 'string') parts.push(`${k}=${v}`);
  }
  return parts.join(' · ');
}

export default function ChartinkScoreTable({ score, lotCount, checks }: ChartinkScoreTableProps) {
  return (
    <div className="mt-2 text-xs">
      <div className="flex items-center gap-3 mb-2">
        <span className={`px-2 py-0.5 rounded text-sm font-medium ${scoreColor(score)}`}>
          {score}/100
        </span>
        <span className="text-[var(--color-text-secondary)]">
          → {lotCount === 0 ? 'SKIP' : `${lotCount} lot${lotCount > 1 ? 's' : ''}`}
        </span>
      </div>
      <table className="w-full">
        <tbody>
          {checks.map((c, i) => (
            <tr key={i} className="border-b border-[var(--color-border-subtle)]">
              <td className="py-1 px-2 w-6">{c.passed ? '✓' : '✗'}</td>
              <td className="py-1 px-2 text-[var(--color-text-primary)]">{c.name}</td>
              <td className="py-1 px-2 w-14 tabular-nums text-right">
                {c.points}/{c.pointsPossible}
              </td>
              <td className="py-1 px-2 text-[var(--color-text-muted)]">{formatDetail(c.detail)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
