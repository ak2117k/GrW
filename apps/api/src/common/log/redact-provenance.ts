// Defensive log helper: strips provenance/IP keys from an object before it is
// logged, so provenance can't leak via request/response logs. Reuses the anand
// allowlist exported by the serializer (TDA-006 §3) so the two stay in sync,
// and adds the signal-side provenance keys. See TDA-006 spec §5.

import { ANAND_PROVENANCE_KEYS } from '../../modules/anand-dual-track/dto/public-entry.dto';

const SIGNAL_PROVENANCE_KEYS = [
  'strategy', 'reason', 'setupContext', 'confidence', 'confidenceScore', 'chartinkSource',
] as const;

const ALL = new Set<string>([...ANAND_PROVENANCE_KEYS, ...SIGNAL_PROVENANCE_KEYS]);

export function redactProvenance<T>(obj: T): T {
  if (obj == null || typeof obj !== 'object') return obj;
  const clone: Record<string, unknown> = Array.isArray(obj)
    ? ([...(obj as unknown[])] as unknown as Record<string, unknown>)
    : { ...(obj as Record<string, unknown>) };
  for (const k of Object.keys(clone)) if (ALL.has(k)) delete clone[k];
  return clone as T;
}
