# TD → GrW Strategy Sync Pipeline — Design

> Date: 2026-07-07 · Status: approved design, pending spec review
> Scope: backend only. One-way sync of the indicator/swing/ungated strategy code
> from the base repo **TD** (`github.com/ak2117k/TD`) into **GrW**
> (`github.com/ak2117k/GrW`), plus a minimal monitoring safety net.

---

## 1. Problem & goals

TD is the original single-tenant base; GrW is the multi-tenant SaaS rebuild. The
strategy logic (indicators, swing tracks, ungated) is actively developed in TD
and is ahead of GrW on features. GrW has its own divergence too — SaaS
adaptations (`@AdminOnly()`, tenant scoping, `signal-fanout` wiring) woven into
the same modules.

**Goals**
1. **Phase 1 — parity:** bring GrW's indicator/swing/ungated backend modules to
   functional parity with TD (adopt TD's newer features), *preserving* GrW's
   adaptations.
2. **Phase 2 — pipeline:** keep GrW in sync with future TD changes to those
   modules, **auto-merging** safe changes gated by an automated review check,
   and routing risky changes to human review.
3. **Monitoring:** a minimal safety net (post-deploy smoke + uptime) so an
   auto-merged change that breaks production is caught immediately.

**Non-goals**
- Frontend (`apps/web`) sync — backend only.
- Bidirectional sync — one-way TD → GrW only; GrW never writes back to TD.
- Syncing GrW-only modules (`billing`, `subscription`, `consent`,
  `credential-vault`, `signal-fanout`, `auto-execution`).
- Full APM/error-tracking (Sentry etc.) — noted as future work.
- Python `ai-engine` indicators — out of scope (backend TS only).

**Success criteria**
- *Phase 1:* GrW's tracked modules match TD@baseline functionally; `pnpm --filter
  @td/api build` + module tests green; deployed; ported endpoints verified live.
- *Phase 2:* a TD change to an **auto-lane** file flows to a GrW PR, passes all
  checks, auto-merges, deploys, and post-deploy smoke passes — with no human. A
  TD change to a **review-lane** file (or a conflicting auto-lane file) opens a
  PR that `sync-guard` blocks until a human adapts/approves and merges.
- *Monitoring:* the post-deploy smoke test fails loudly on a broken deploy; the
  uptime workflow alerts on sustained downtime.

---

## 2. Context: measured divergence (2026-07-07)

The two repos are structurally parallel (same module names). Within the tracked
modules most files are byte-identical; a minority differ, and the differences mix
*both* sides:

- `signal-generator/strategies/` — **100% identical** today (clean auto-sync core).
- Differing files cluster in `controllers/`, `gateways/`, `*.module.ts`, and a
  few `services/`. Example: `ungated-track.controller.ts` — TD has newer features
  (a `square-off` endpoint, `UngatedTickPoller`) GrW lacks, while GrW has an
  `@AdminOnly()` guard TD lacks.
- Divergence magnitude is small and concentrated: `ungated-track` 2/22 files,
  `breakout-swing-track` 1/8, `signal-generator` 8/103.

**Implication:** this is a *merge* problem, not a *mirror* problem. A blind
file copy would silently delete GrW's adaptations (e.g. drop `@AdminOnly()` →
open an admin endpoint to all users). Tests would not necessarily catch that.
The design must reconcile both sides and protect the adaptation-critical files.

---

## 3. Architecture

- **Direction:** one-way, TD → GrW.
- **Surface:** backend only, `apps/api/src/modules/`.
- **Tracked modules & lanes** (a coarse manifest classification, refined by a
  real 3-way merge — see §5):

  | Module | Rationale | Default lane split |
  | --- | --- | --- |
  | `signal-generator` | indicators + strategy engine | `auto`: `strategies/`, `services/`, `repositories/`, `utils/`, `types/`, `dto/`, `workers/`; `review`: `controllers/`, `gateways/`, `*.module.ts` |
  | `ungated-track` | ungated | same split |
  | `breakout-swing-track` | swing | same split |
  | `anand-dual-track` | swing | same split |
  | `adaptive-stop-track` | swing | same split |
  | `sell-futures-track` | swing | same split |
  | `watch-monitor` | shared tracking infra | **entire module → `review`** (conservative; reclassify per-subdir later once its pure-logic files are confirmed) |

  Lanes, in short:
  - **`auto`** — pure logic (calculations, strategy classes, indicators, poller
    services, repos). No GrW divergence expected → eligible for auto-merge.
  - **`review`** — the tenant/admin/wiring layer (`controllers/`, `gateways/`,
    `*.module.ts`, and all of `watch-monitor`). Always human-reviewed.

- **Two phases:** Phase 1 (§4) is a normal reviewed changeset done *before* the
  pipeline (§5) is armed, so the pipeline starts from a known-good, in-parity
  baseline recorded in `.sync/state.json`.

---

## 4. Phase 1 — one-time parity port

1. For each tracked module, diff TD vs GrW and categorize every difference:
   *(a)* TD feature GrW lacks → **port it**; *(b)* GrW adaptation TD lacks →
   **keep it**; *(c)* incidental (formatting/imports) → normalize.
2. Port TD's new features into GrW, adapting to GrW's architecture (tenant
   context/CLS, `@AdminOnly()`, `signal-fanout`, DTO validation). Wire new
   services/endpoints into GrW's module providers.
3. `pnpm --filter @td/shared build && pnpm --filter @td/api build`, then run the
   affected module tests. Fix breakage.
4. Record the exact TD commit SHA ported-from into `.sync/state.json`
   (`{ "lastSyncedTdSha": "<sha>", "syncedAt": "<iso>" }`).
5. Commit + push → auto-deploy. Verify the ported endpoints against the live API.

Phase 1 is delivered as its own reviewed PR with green build + tests before the
pipeline exists.

---

## 5. Phase 2 — the sync pipeline

Three artifacts committed to GrW:

### 5.1 `.sync/td-sync.yml` (manifest)
```yaml
source:
  repo: https://github.com/ak2117k/TD.git
  branch: main
paths:
  - glob: apps/api/src/modules/signal-generator/strategies/**
    lane: auto
  - glob: apps/api/src/modules/signal-generator/{services,repositories,utils,types,dto,workers}/**
    lane: auto
  - glob: apps/api/src/modules/signal-generator/{controllers,gateways}/**
    lane: review
  - glob: apps/api/src/modules/signal-generator/*.module.ts
    lane: review
  # …same pattern for ungated-track and each *-track module…
  - glob: apps/api/src/modules/watch-monitor/**
    lane: review
```
First matching glob wins; anything not matched is **untracked** (never touched —
this protects GrW-only files).

### 5.2 `.sync/state.json` (baseline)
`{ "lastSyncedTdSha": "<sha>", "syncedAt": "<iso>" }` — set by Phase 1, bumped by
each successful sync PR.

### 5.3 `.github/workflows/td-sync.yml` (the sync workflow)
Trigger: `schedule` (cron, ~every 6h) + manual `workflow_dispatch`.

1. Checkout GrW. Fetch TD (public → no token) at `lastSyncedTdSha` and `main`.
2. Compute the set of **tracked** files changed between the two TD SHAs. Empty → exit.
3. For each changed tracked file, do a **3-way merge**:
   `base = TD@baseline`, `theirs = TD@new`, `ours = GrW current` (`git merge-file`).
   - Clean merge **and** path lane == `auto` → **auto-eligible**.
   - Conflict, **or** lane == `review`, **or** file added, **or** file deleted →
     **needs-review**. (Never auto-delete a GrW file; TD deletions are always review.)
4. Commit the merged tree to branch `sync/td-<shortSha>`; bump `.sync/state.json`.
5. Open a PR → `main`, label `td-sync`, body listing **auto** vs **needs-review**
   files and the TD commit range. Enable GitHub **auto-merge** on the PR.

### 5.4 Gating — the "code-review check"
Branch protection on `main` requires status checks: `build`, `test`,
`typecheck`, and **`sync-guard`**.
- `sync-guard` **passes** iff the PR is *auto-lane-clean-only* (no needs-review
  files) → with the other checks green, GitHub auto-merge fires → auto-deploy.
- Any **needs-review** file → `sync-guard` **fails** → auto-merge blocked. A
  human adapts the change (re-applying GrW adaptations) and/or approves + merges.
  Adapting a needs-review change into a clean state can turn the guard green.

### 5.5 Auth
Reading TD requires no token (public repo). The PR + auto-merge run on
`GITHUB_TOKEN`; if branch-protection settings prevent the default token from
enabling auto-merge, a fine-grained PAT (repo scope on GrW) is used instead —
confirmed during implementation.

---

## 6. Minimal monitoring (safety net)

- **`.github/workflows/post-deploy-smoke.yml`** — on push/merge to `main`, wait
  for Render to redeploy, then run the manual smoke checks: `GET /api/docs-json`
  == 200 + valid OpenAPI; bogus `POST /auth/login` == 401; a rate-limit probe
  confirms Redis is reachable. On failure, open/update a GitHub issue (labelled
  `prod-broken`) and fail the run. This catches a bad **auto-merged** deploy.
- **`.github/workflows/uptime.yml`** — scheduled (~every 15 min) `GET /api/docs`;
  on sustained non-200 (with cold-start retries), open/update an alert issue.
  *Trade-off:* frequent pings keep Render's free dyno awake, consuming its
  monthly free hours — the interval is tuned to monitor without exhausting the
  budget.
- Explicitly minimal: no Sentry/APM yet (future work).

---

## 7. Risks & mitigations

| Risk | Mitigation |
| --- | --- |
| 3-way merge is textually clean but semantically drops a GrW adaptation | Force `review` lane for adaptation-critical dirs (`controllers/`, `gateways/`, `*.module.ts`, all `watch-monitor`); post-deploy smoke; optional `// @grw-adapt` markers + a guard that flags their removal (future hardening). |
| GrW locally edits an `auto`-lane file, then TD changes it | 3-way merge surfaces the conflict → routed to needs-review, never silently overwritten. |
| TD history rewrite / force-push invalidates the baseline diff | Workflow detects a non-ancestor baseline and falls back to a full tracked-path re-diff, opening a review PR. |
| New/deleted files in TD | New tracked files default to needs-review; deletions never auto-applied. |
| Uptime pings exhaust Render free hours | Conservative interval; documented trade-off. |
| Auto-merge bypasses intended review | `sync-guard` + branch protection are the hard gate; auto-merge only ever fires for auto-lane-clean PRs. |

---

## 8. Testing & rollout

1. Implement the sync workflow in **dry-run mode** first (compute + open PR;
   auto-merge disabled). Validate the 3-way merge with a synthetic TD change to
   an `auto` file and to a `review` file; confirm lane routing and `sync-guard`.
2. Configure branch protection so `needs-review` genuinely blocks merge.
3. Land Phase 1 (parity port) as a reviewed PR with green build + tests; set the
   baseline SHA.
4. Arm the pipeline (enable auto-merge); land the monitoring workflows.
5. Observe the first few real syncs before trusting the auto lane unattended.

---

## 9. Open items (resolve during implementation)

- Confirm whether the default `GITHUB_TOKEN` can enable auto-merge under GrW's
  branch protection, or a fine-grained PAT is needed.
- Confirm `watch-monitor`'s pure-logic files to (optionally) move some to `auto`.
- Decide the exact cron cadence for `td-sync` and `uptime`.
