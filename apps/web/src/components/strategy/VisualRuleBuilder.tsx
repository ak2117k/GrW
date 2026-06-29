import { useCallback } from 'react';
import { Plus, Trash2, ArrowRight } from 'lucide-react';
import { cn } from '@/utils/cn';
import type {
  RuleConfig,
  RuleCondition,
  IndicatorConfig,
} from '@/stores/strategy-builder-store';
import { INDICATOR_DEFS } from '@/stores/strategy-builder-store';

// ---- Helpers ----

const OPERATORS: { value: RuleCondition['operator']; label: string }[] = [
  { value: 'crosses_above', label: 'Crosses Above' },
  { value: 'crosses_below', label: 'Crosses Below' },
  { value: 'greater_than', label: 'Greater Than' },
  { value: 'less_than', label: 'Less Than' },
  { value: 'between', label: 'Between' },
];

const OPERAND_OPTIONS = [
  ...INDICATOR_DEFS.map((d) => d.snippet),
  'close',
  'open',
  'high',
  'low',
  'volume',
  '0',
  '20',
  '30',
  '35',
  '50',
  '65',
  '70',
  '80',
];

let _condId = 1000;
const condUid = () => `cond_${_condId++}_${Date.now()}`;

// ---- Sub-components ----

function ConditionRow({
  condition,
  onChange,
  onRemove,
  canRemove,
}: {
  condition: RuleCondition;
  onChange: (c: RuleCondition) => void;
  onRemove: () => void;
  canRemove: boolean;
}) {
  return (
    <div className="flex items-center gap-2 flex-wrap">
      {/* Left operand */}
      <select
        value={condition.leftOperand}
        onChange={(e) => onChange({ ...condition, leftOperand: e.target.value })}
        className="rounded-md border border-gray-700 bg-gray-800 px-2 py-1.5 text-xs text-gray-200 focus:border-blue-500 focus:outline-none min-w-[120px]"
      >
        <option value="">Select...</option>
        {OPERAND_OPTIONS.map((o) => (
          <option key={o} value={o}>
            {o}
          </option>
        ))}
      </select>

      {/* Operator */}
      <select
        value={condition.operator}
        onChange={(e) =>
          onChange({ ...condition, operator: e.target.value as RuleCondition['operator'] })
        }
        className="rounded-md border border-gray-700 bg-gray-800 px-2 py-1.5 text-xs text-gray-200 focus:border-blue-500 focus:outline-none"
      >
        {OPERATORS.map((op) => (
          <option key={op.value} value={op.value}>
            {op.label}
          </option>
        ))}
      </select>

      {/* Right operand */}
      <select
        value={condition.rightOperand}
        onChange={(e) => onChange({ ...condition, rightOperand: e.target.value })}
        className="rounded-md border border-gray-700 bg-gray-800 px-2 py-1.5 text-xs text-gray-200 focus:border-blue-500 focus:outline-none min-w-[120px]"
      >
        <option value="">Select...</option>
        {OPERAND_OPTIONS.map((o) => (
          <option key={o} value={o}>
            {o}
          </option>
        ))}
      </select>

      {/* Between — second operand */}
      {condition.operator === 'between' && (
        <>
          <span className="text-xs text-gray-500">and</span>
          <select
            value={condition.rightOperand2 ?? ''}
            onChange={(e) => onChange({ ...condition, rightOperand2: e.target.value })}
            className="rounded-md border border-gray-700 bg-gray-800 px-2 py-1.5 text-xs text-gray-200 focus:border-blue-500 focus:outline-none min-w-[100px]"
          >
            <option value="">Select...</option>
            {OPERAND_OPTIONS.map((o) => (
              <option key={o} value={o}>
                {o}
              </option>
            ))}
          </select>
        </>
      )}

      {/* Remove */}
      {canRemove && (
        <button
          onClick={onRemove}
          className="text-gray-600 hover:text-red-400 transition-colors ml-1"
        >
          <Trash2 size={14} />
        </button>
      )}
    </div>
  );
}

function RuleBlock({
  label,
  labelColor,
  rule,
  onUpdate,
  onRemove,
}: {
  label: string;
  labelColor: string;
  rule: RuleConfig;
  onUpdate: (r: RuleConfig) => void;
  onRemove: () => void;
}) {
  const handleConditionChange = useCallback(
    (idx: number, cond: RuleCondition) => {
      const updated = [...rule.conditions];
      updated[idx] = cond;
      onUpdate({ ...rule, conditions: updated });
    },
    [rule, onUpdate],
  );

  const handleAddCondition = useCallback(() => {
    onUpdate({
      ...rule,
      conditions: [
        ...rule.conditions,
        { id: condUid(), leftOperand: '', operator: 'greater_than', rightOperand: '' },
      ],
    });
  }, [rule, onUpdate]);

  const handleRemoveCondition = useCallback(
    (idx: number) => {
      if (rule.conditions.length <= 1) return;
      onUpdate({
        ...rule,
        conditions: rule.conditions.filter((_, i) => i !== idx),
      });
    },
    [rule, onUpdate],
  );

  return (
    <div className="rounded-lg border border-gray-700/60 bg-gray-800/20 p-3">
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <ArrowRight size={14} className={labelColor} />
          <span className={cn('text-xs font-semibold uppercase tracking-wide', labelColor)}>
            {label}
          </span>
        </div>
        <div className="flex items-center gap-2">
          {/* Logic toggle */}
          <div className="flex rounded-md border border-gray-700 overflow-hidden">
            {(['AND', 'OR'] as const).map((logic) => (
              <button
                key={logic}
                onClick={() => onUpdate({ ...rule, logic })}
                className={cn(
                  'px-2 py-0.5 text-[10px] font-semibold transition-colors',
                  rule.logic === logic
                    ? 'bg-blue-500/20 text-blue-400'
                    : 'text-gray-500 hover:text-gray-300',
                )}
              >
                {logic}
              </button>
            ))}
          </div>
          <button
            onClick={onRemove}
            className="text-gray-600 hover:text-red-400 transition-colors"
          >
            <Trash2 size={14} />
          </button>
        </div>
      </div>

      <div className="space-y-2">
        {rule.conditions.map((cond, idx) => (
          <div key={cond.id}>
            {idx > 0 && (
              <div className="text-[10px] font-semibold text-purple-400 ml-2 my-1">
                {rule.logic}
              </div>
            )}
            <ConditionRow
              condition={cond}
              onChange={(c) => handleConditionChange(idx, c)}
              onRemove={() => handleRemoveCondition(idx)}
              canRemove={rule.conditions.length > 1}
            />
          </div>
        ))}
      </div>

      <button
        onClick={handleAddCondition}
        className="mt-2 flex items-center gap-1 text-[10px] text-gray-500 hover:text-blue-400 transition-colors"
      >
        <Plus size={12} /> Add condition
      </button>
    </div>
  );
}

// ---- Main Component ----

interface VisualRuleBuilderProps {
  indicators: IndicatorConfig[];
  entryRules: RuleConfig[];
  exitRules: RuleConfig[];
  onUpdateEntryRule: (id: string, rule: Partial<RuleConfig>) => void;
  onRemoveEntryRule: (id: string) => void;
  onAddEntryRule: () => void;
  onUpdateExitRule: (id: string, rule: Partial<RuleConfig>) => void;
  onRemoveExitRule: (id: string) => void;
  onAddExitRule: () => void;
  onRemoveIndicator: (id: string) => void;
}

export function VisualRuleBuilder({
  indicators,
  entryRules,
  exitRules,
  onUpdateEntryRule,
  onRemoveEntryRule,
  onAddEntryRule,
  onUpdateExitRule,
  onRemoveExitRule,
  onAddExitRule,
  onRemoveIndicator,
}: VisualRuleBuilderProps) {
  return (
    <div className="space-y-5">
      {/* Active Indicators */}
      {indicators.length > 0 && (
        <div>
          <h4 className="text-xs font-semibold text-gray-400 uppercase tracking-wide mb-2">
            Active Indicators
          </h4>
          <div className="flex flex-wrap gap-2">
            {indicators.map((ind) => (
              <div
                key={ind.id}
                className="flex items-center gap-1.5 rounded-md border border-blue-500/30 bg-blue-500/10 px-2.5 py-1.5"
              >
                <span className="text-xs font-medium text-blue-300">{ind.name}</span>
                <span className="text-[10px] text-gray-500">
                  ({Object.values(ind.params).join(', ')})
                </span>
                <button
                  onClick={() => onRemoveIndicator(ind.id)}
                  className="text-gray-500 hover:text-red-400 ml-1 transition-colors"
                >
                  <Trash2 size={12} />
                </button>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Entry Rules */}
      <div>
        <div className="flex items-center justify-between mb-2">
          <h4 className="text-xs font-semibold text-emerald-400 uppercase tracking-wide">
            Entry Rules
          </h4>
          <button
            onClick={onAddEntryRule}
            className="flex items-center gap-1 text-[10px] text-gray-400 hover:text-emerald-400 transition-colors border border-gray-700 rounded-md px-2 py-1"
          >
            <Plus size={12} /> Add Entry Rule
          </button>
        </div>
        {entryRules.length === 0 ? (
          <p className="text-xs text-gray-600 italic">No entry rules defined. Click "Add Entry Rule" to begin.</p>
        ) : (
          <div className="space-y-3">
            {entryRules.map((rule) => (
              <RuleBlock
                key={rule.id}
                label="Entry"
                labelColor="text-emerald-400"
                rule={rule}
                onUpdate={(r) => onUpdateEntryRule(rule.id, r)}
                onRemove={() => onRemoveEntryRule(rule.id)}
              />
            ))}
          </div>
        )}
      </div>

      {/* Exit Rules */}
      <div>
        <div className="flex items-center justify-between mb-2">
          <h4 className="text-xs font-semibold text-amber-400 uppercase tracking-wide">
            Exit Rules
          </h4>
          <button
            onClick={onAddExitRule}
            className="flex items-center gap-1 text-[10px] text-gray-400 hover:text-amber-400 transition-colors border border-gray-700 rounded-md px-2 py-1"
          >
            <Plus size={12} /> Add Exit Rule
          </button>
        </div>
        {exitRules.length === 0 ? (
          <p className="text-xs text-gray-600 italic">No exit rules defined. Click "Add Exit Rule" to begin.</p>
        ) : (
          <div className="space-y-3">
            {exitRules.map((rule) => (
              <RuleBlock
                key={rule.id}
                label="Exit"
                labelColor="text-amber-400"
                rule={rule}
                onUpdate={(r) => onUpdateExitRule(rule.id, r)}
                onRemove={() => onRemoveExitRule(rule.id)}
              />
            ))}
          </div>
        )}
      </div>

      {/* Risk Settings */}
      <div>
        <h4 className="text-xs font-semibold text-red-400 uppercase tracking-wide mb-2">
          Risk Settings
        </h4>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="text-[10px] text-gray-500 mb-1 block">
              Stoploss (ATR multiplier)
            </label>
            <input
              type="number"
              min={0.5}
              max={10}
              step={0.5}
              defaultValue={1.5}
              className="w-full rounded-md border border-gray-700 bg-gray-800 px-2.5 py-1.5 text-xs text-gray-200 focus:border-blue-500 focus:outline-none"
            />
          </div>
          <div>
            <label className="text-[10px] text-gray-500 mb-1 block">
              Target (ATR multiplier)
            </label>
            <input
              type="number"
              min={0.5}
              max={20}
              step={0.5}
              defaultValue={3}
              className="w-full rounded-md border border-gray-700 bg-gray-800 px-2.5 py-1.5 text-xs text-gray-200 focus:border-blue-500 focus:outline-none"
            />
          </div>
        </div>
      </div>
    </div>
  );
}
