# TD → GrW Phase 1: Parity Port — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bring GrW's indicator/swing/ungated backend modules to functional parity with the TD base repo at a fixed baseline, adopting TD's newer logic while preserving every GrW adaptation, and record the baseline SHA for the future sync pipeline.

**Architecture:** One-way reconciliation of ~21 differing files across 7 modules. Each differing file gets a 3-way judgment: port TD's change, preserve GrW's adaptation, or merge both. Modules are independent → the per-module tasks parallelize. A final integration task builds, tests, records the baseline, and opens one PR.

**Tech Stack:** NestJS + TypeScript (pnpm workspace, SWC build), Jest, Prisma. TD baseline is a local clone.

## Global Constraints

- **TD baseline commit (port from THIS, nothing later):** `3ae21c742a6fbf23e92016f0f8d566cc7c0b41a6`
- **TD local clone path:** `C:/Users/AryanKumar/AppData/Local/Temp/claude/C--Users-AryanKumar-Desktop-GrW/1735aeef-7f4d-4a35-8a68-07dadc073c34/scratchpad/TD` (if absent, `git clone https://github.com/ak2117k/TD.git` then `git checkout 3ae21c7`).
- **GrW repo root:** `C:/Users/AryanKumar/Desktop/GrW`
- **Surface:** backend only (`apps/api/`). Never touch `apps/web`, `ai-engine`, or GrW-only modules (`billing`, `subscription`, `consent`, `credential-vault`, `signal-fanout`, `auto-execution`).
- **MUST-PRESERVE GrW adaptations** (do NOT let a TD port strip these):
  - Auth/authorization decorators & guards on controllers (e.g. `@AdminOnly()` from `apps/api/src/common/decorators`).
  - Multi-tenant scoping: CLS/`TenantContext`, `req.user`/`userId` filtering, per-user socket rooms in gateways.
  - GrW-only DTO validation (e.g. `anand-dual-track/dto/` — exists in GrW, not TD).
  - `signal-fanout` wiring where present.
  - **Session boot-resilience fixes**, specifically `watch-monitor/workers/watch-rescore.worker.ts` — GrW wraps `onModuleInit`'s queue calls in try/catch (commit `5e10fe9`). TD lacks this. **Keep the try/catch guard** even while porting any new TD logic in that file.
- **Build must stay green:** `pnpm --filter @td/shared build && pnpm --filter @td/api build` (SWC — does NOT type-check; run `npx tsc --noEmit -p apps/api/tsconfig.json` for the touched files' package to catch type errors, ignoring pre-existing errors unrelated to touched files).
- **Tests:** run the affected module's Jest specs; keep them green.
- **Commits:** conventional commits; one commit per module task.

---

## Task 0: Setup working branch + confirm baseline

**Files:**
- Create: none (branch + verification only)

- [ ] **Step 1: Create the feature branch off main**

```bash
cd "C:/Users/AryanKumar/Desktop/GrW"
git checkout main && git pull origin main
git checkout -b feature/td-parity-port
```

- [ ] **Step 2: Confirm TD is at the baseline**

```bash
TD="C:/Users/AryanKumar/AppData/Local/Temp/claude/C--Users-AryanKumar-Desktop-GrW/1735aeef-7f4d-4a35-8a68-07dadc073c34/scratchpad/TD"
git -C "$TD" rev-parse HEAD
```
Expected: `3ae21c742a6fbf23e92016f0f8d566cc7c0b41a6`

- [ ] **Step 3: Baseline build to confirm green start**

Run: `pnpm --filter @td/shared build && pnpm --filter @td/api build`
Expected: `Successfully compiled … with swc`, exit 0.

---

## Tasks 1–7: Per-module parity port (PARALLELIZABLE)

Each task follows the **same procedure** on one module. They touch disjoint files → they can run concurrently (each agent works its module only, no commits to shared branch until integration, OR each commits only its own module's files).

**Per-module procedure (apply to the module and its differing files listed below):**

- [ ] **Step A: Diff each differing file** — `diff "$TD/apps/api/src/modules/<M>/<f>" "$GRW/apps/api/src/modules/<M>/<f>"` for every file listed.
- [ ] **Step B: Attribute each hunk** — for every difference decide: *TD-new* (a feature/logic TD added → port), *GrW-adapt* (auth/tenant/DTO/boot-fix GrW added → keep), or *incidental* (imports/formatting → normalize toward TD unless it breaks GrW). Use `git -C "$GRW" log -p -- <path>` if unsure whether GrW deliberately changed a line.
- [ ] **Step C: Apply the reconciliation** — edit the GrW file so it contains TD-new logic AND all GrW-adapt code. Wire any new TD service/endpoint into the module's providers/imports.
- [ ] **Step D: Preserve check** — grep the touched files to confirm every MUST-PRESERVE item still present (`@AdminOnly`, tenant/userId scoping, DTO usage, the watch-rescore try/catch).
- [ ] **Step E: Build** — `pnpm --filter @td/api build` (exit 0).
- [ ] **Step F: Test** — run the module's specs, e.g. `pnpm --filter @td/api test -- <module-name>`; keep green.
- [ ] **Step G: Commit** — `git add apps/api/src/modules/<M> && git commit -m "feat(<M>): port TD parity changes, preserve GrW adaptations"`.

### Task 1: signal-generator (indicator engine) — 8 files
`controllers/signal-generator.controller.ts` (+`.spec.ts`), `controllers/strategy-builder.controller.ts`, `gateways/signal.gateway.ts`, `services/sr-evidence.service.ts` (+`.spec.ts`), `services/timeframe-lookback.ts` (+`.spec.ts`).
Note: `services/*` are `auto`-lane logic — most likely TD-new to port. `controllers/*`+`gateways/*` are the GrW-adapted layer — expect auth/tenant to preserve. `strategies/` is identical (do not touch).

### Task 2: ungated-track — 2 files
`controllers/ungated-track.controller.ts`, `gateways/ungated-watch.gateway.ts`.
Known: TD's controller adds a `square-off` POST endpoint + `UngatedTickPoller` (port these); GrW's controller has `@AdminOnly()` (preserve).

### Task 3: breakout-swing-track — 1 file
`controllers/breakout-swing.controller.ts`.

### Task 4: anand-dual-track — 4 files (+ GrW-only `dto/`)
`anand-dual-track.module.ts`, `controllers/anand-dual-track.controller.ts`, `repositories/anand-dual-track.repository.ts`, `services/anand-dual-track.service.ts`. **Preserve GrW's `dto/` dir** (TD has none) and any DTO validation wired through the controller/module.

### Task 5: adaptive-stop-track — 2 files
`controllers/adaptive-stop.controller.ts`, `gateways/adaptive-stop.gateway.ts`.

### Task 6: sell-futures-track — 1 file
`controllers/sell-futures.controller.ts`.

### Task 7: watch-monitor — 3 files
`controllers/watch.controller.ts`, `gateways/watch.gateway.ts`, `workers/watch-rescore.worker.ts`. **CRITICAL:** in `watch-rescore.worker.ts`, keep GrW's `onModuleInit` try/catch guard (commit `5e10fe9`) while porting any TD logic — do not revert to TD's unguarded version.

---

## Task 8: Integration — full build, tests, baseline, PR

**Files:**
- Create: `.sync/state.json`

- [ ] **Step 1: Full workspace build**

Run: `pnpm --filter @td/shared build && pnpm --filter @td/api build`
Expected: exit 0.

- [ ] **Step 2: Run the affected modules' test suites**

Run: `pnpm --filter @td/api test -- signal-generator ungated-track breakout-swing-track anand-dual-track adaptive-stop-track sell-futures-track watch-monitor`
Expected: all green (or pre-existing-failure parity with main — note any).

- [ ] **Step 3: Verify no MUST-PRESERVE regression across the diff**

Run: `git diff main --stat` then grep the diff for accidental removals:
`git diff main -- apps/api/src/modules | grep -E '^-.*(@AdminOnly|tenant|userId|try \{|catch)'`
Expected: review every such removed line is intentional (it almost never should be).

- [ ] **Step 4: Write the sync baseline**

Create `.sync/state.json`:
```json
{
  "lastSyncedTdSha": "3ae21c742a6fbf23e92016f0f8d566cc7c0b41a6",
  "syncedAt": "2026-07-08T00:00:00Z",
  "note": "Baseline set by Phase 1 parity port. Pipeline (Phase 2) syncs TD commits after this SHA."
}
```

- [ ] **Step 5: Commit + push + open PR**

```bash
git add .sync/state.json
git commit -m "chore(sync): record TD parity baseline 3ae21c7"
git push origin feature/td-parity-port
gh pr create --base main --head feature/td-parity-port \
  --title "TD parity port (indicator/swing/ungated) + sync baseline" \
  --body "Phase 1 of the TD→GrW sync. Ports TD@3ae21c7 changes across 7 backend modules, preserving GrW adaptations. Sets .sync/state.json baseline."
```

- [ ] **Step 6: Post-merge verification (after human review + merge)**

After the PR merges to main and Render redeploys, smoke the affected endpoints (e.g. `GET /api/docs-json` 200; the new ungated `square-off` route present in the spec). Confirm the app still boots (no watch-rescore crash loop).

---

## Notes for the executor

- The heavy judgment is in Tasks 1, 2, 4, 7 (files with real logic divergence). Tasks 3, 5, 6 are single controller files, likely small.
- Do NOT push directly to `main` (it auto-deploys to prod). Everything lands on `feature/td-parity-port` → one PR → human review → merge.
- If a file turns out byte-identical after all (no real diff), skip it and note so.
- Phase 2 (pipeline) and monitoring are separate plans, written after this baseline merges.
