import { setCoreKillSwitchReader } from '../../src/modules/trade-core/risk-wall/kill-gate';

/**
 * Jest only (apps/api package.json "setupFiles", and the opt-in test/tda010 and
 * test/tda011int configs). Unit tests that do not install their own reader see every
 * core kill switch as OFF, so existing silo specs keep their behaviour. Production has
 * no default: until CoreKillSwitchReader registers on module init, every guarded silo
 * entry is refused (fail closed).
 */
setCoreKillSwitchReader({ isOn: async () => false, isOnForPlatform: async () => false, invalidate: () => undefined });
