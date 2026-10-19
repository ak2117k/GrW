# MBM M3 — consumers (observe first) · build contract

Design §5.8, §10.4. M2 is live: `MbmClient.behaviour(instrument)` (apps/api/src/modules/mbm, fail-open,
60 s cache) returns `{status:'ok'|'stale'|'absent', horizons:{'30m'|'60m':{p,regime,q25Bp,q50Bp,q75Bp}}, asOf, modelIds}`.
Shared helper (use it, do not re-implement): `apps/api/src/modules/mbm/domain/mbm-applies.ts` —
`mbmInstrumentFor({symbol,exchange}, cfg.instruments)`, `mbmHorizonFor(minutesLeft)`, `usableHorizon(b, h)`.

Global rule: `MBM_ENABLED=off` ⇒ every consumer is inert and every output byte-identical to today.
Per-consumer flags (each `off|observe|on`, default **off**; M3 deploys them as `observe`):

## Stream A — exit side (sentinel + exit discipline)
1. `MBM_PACKET`: sentinel packet block `marketBehaviour` for positions whose underlying `mbmInstrumentFor`
   maps (NIFTY index options/futures). Content ≤ ~200 chars JSON:
   `{"i":"NIFTY","h":"60m","regime":"ACTIVE","p":0.86,"rangeBp":[37,68],"asOf":"09:45"}` (horizon from
   minutes left; IST hh:mm). `observe` = build it and log `[mbm-packet] would add …` once per position per
   15 min, packet unchanged; `on` = add the block. Absent/stale/null ⇒ no block, no log. Follow the
   packet's existing optional-Block pattern (grep the packet builder) and its prompt docs if a prompt
   lists blocks (update the prompt text ONLY under `on`, or note why not).
2. `MBM_EXIT_SHADOW`: exit discipline LOGS ONLY what an MBM-sized floor/giveback would have done:
   at each exit-discipline evaluation of an MBM-mapped position, record the MBM regime + expected range
   next to the actual decision (structured log line `[mbm-exit-shadow] …`, or a column/JSON field on the
   existing exit-gate record if one fits without a migration). Never changes a decision. A null MBM value
   never justifies anything.
## Stream B — entry side (trade-core)
`GATE_EVALUATORS` key `market-behaviour` (trade-core/intake/gate-evaluators.ts pattern), params from the
strategy version, e.g. `{ "skipRegimes": ["QUIET"], "horizon": "auto" }`. `MBM_ENTRY_GATE=observe` ⇒ the
evaluator always PASSES but records in `evidence.gates` what it WOULD have done (`wouldSkip`, regime, p);
`on` ⇒ it can fail the gate. Non-NIFTY entries and absent/stale answers ⇒ pass with `applies:false`.
Write the MBM output to `ai_decision_records.features/featureSet/mlScore` where the intake already writes
decision records (if that path exists; otherwise note it).

## Rules
Own worktree + branch (`feature/mbm-m3-a|b`), explicit-pathspec commits, never push/merge/touch prod,
commit trailer `Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>`. Jest specs for
every flag state (off ⇒ byte-identical). `npx tsc --noEmit -p tsconfig.json` baseline is 174 errors —
add none. Token budget: grep/`sed -n`, no file dumps, < 120k. Final report ≤ 250 words.
