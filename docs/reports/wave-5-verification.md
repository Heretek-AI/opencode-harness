# Wave 5 Verification Report — Drift Guard Audit

- **Role:** `agency-drift-guard` (auditor only; no implementation changes)
- **Stage:** Wave 5 (`wave-5-interceptors`) — Zero-Patch Interceptors + Architecture Advisor
- **Worktree:** `/home/john/Projects/Heretek-AI-Rebuild/opencode-harness/worktrees/wave-5`
- **Branch:** `wave-5-interceptors` @ `7f5fec9` (base `main` @ `7a49471` release v1.0.3)
- **Date (UTC):** 2026-10-16
- **Contracts read in full:** `AGENTS.md`, `docs/prompts/SPEC.md` (§1–2.5), `docs/reports/wave-5.md` (programmer report), `docs/prompts/verify-stage.md`

## 1. Programmer deliverable cross-check (vs `docs/reports/wave-5.md` + SPEC)

All claimed deliverables found on disk and cross-referenced:

1. **3 new modules (bundle-identical claim accepted; zero `any`; `.js` imports):**
   - `src/interceptors/tool-interceptors.ts` — Edit auto-repair, near-miss recovery, fuzzy read resolve, shell hardening, non-zero-exit detection, `normalizePluginToolResult`
   - `src/interceptors/session-interceptors.ts` — meta.txt repair, system calibration, compaction decontamination, session-affinity propagation
   - `src/verify/architecture-advisor.ts` — Tarjan SCC, contract-impact, smell scan, `runArchitectureAudit`
2. **`src/host/contract-adapter.ts` (3-way merge):** interceptor wiring + Wave-4 fail-closed `typeof updated !== "string"` throw present; `.js` imports; required `system`; release `1.0.4`
3. **`src/index.ts` merge:** 16 re-exported modules intact; `export *` for both interceptors + architecture-advisor; explicit `export { computeLineHash }` disambiguation; `HARNESS_RELEASE_VERSION = "1.0.4"`; `architecture_audit` in extended tools + schema + executor; broader root inference; `toTrippedDirective()` dual-shape adapter
4. **Canonical `EpisodicLesson`:** exactly one `interface EpisodicLesson {` repo-wide at `src/context/context-budget.ts:42`; `src/context/episodic-memory.ts` imports it via `.js`
5. **Tests:** `test/plugin-interceptors.test.ts` (10 tests) present; 173 prior tests intact
6. **Acceptance + release:** `scripts/accept/wave-5.sh` (11 gates); `Makefile` accept chain extended to wave-5; `package.json` `1.0.4`
7. **Deliberate non-adoptions verified as justified:** `scripts/upstream-patch.sh` not copied (reference-only `scripts/upstream/apply_opencode_v2_core_fixes.bash` already vendored + documented); `src/guards/*`, `src/repomap/*`, `src/muse/*`, `src/ui-auditor/*`, `src/transactions/*`, `src/editors/*` kept as Wave-4 bytes

## 2. Gates run (commands + exit codes)

- `make check` → exit **0** (`bun run check` tsc clean; `bun test` **183 pass, 0 fail**, 665 expects, 10 files)
- `bash scripts/accept/wave-5.sh` → exit **0**, `WAVE 5 ACCEPT: ALL GATES GREEN` (65 direct `ok:` + 149 prior-wave sublog `ok:` = 214 total, 0 `FAIL:`)
- `bash scripts/accept/wave-1.sh` → exit **0** (15 ok, 0 fail)
- `bash scripts/accept/wave-2.sh` → exit **0** (26 ok, 0 fail)
- `bash scripts/accept/wave-3.sh` → exit **0** (40 ok, 0 fail)
- `bash scripts/accept/wave-4.sh` → exit **0** (68 ok, 0 fail)
- `make accept` (waves 1–5) → exit **0**, ends `WAVE 5 ACCEPT: ALL GATES GREEN`
- `bun test test/plugin-interceptors.test.ts` (isolation, via wave-5.sh Gate 3) → exit **0** (10 pass)
- `bun test test/context-budget.test.ts` → exit **0** (23 pass)
- `bun test test/circuit-breaker.test.ts` → exit **0** (16 pass)
- `getRecommendedMcpConfig()` runtime check → exact `fallow-mcp,lsp-mcp-server`; `lsp-mcp-server` via `bunx lsp-mcp-server`; `fallow-mcp` via `npx --yes --package fallow fallow-mcp`; no extra servers

## 3. Stub / shortcut scan (zero-stubs enforcement)

Scanned `src/` + `test/` (+ `wave-5.sh` for shell patterns):

- `TODO` (incl. `// TODO`) → **zero hits** in `src`, `test`
- `test.skip|describe.skip|it.skip|set +e` → **zero hits** in `src`, `test`
- `||` + `true` (excluding `metrics-true`) → **zero hits** in `src`, `test`
- `catch\s*(\(...\))?\s*\{\s*\}` (empty catch) → **zero hits** in `src`, `test`
- `cmd: "true"`, `echo "passed"` → **zero hits** in `src`, `test`, `wave-5.sh`
- `return true;` audit → 9 hits, all legitimate non-vacuous logic, NOT dummy passes:
  - `src/guards/shell-parse.ts:292,297,300,303,306,395,398,403,406` — destructive/write-classifier predicates (each guarded by a distinct regex/condition, ending in `return false`)
  - `src/interceptors/tool-interceptors.ts:474,481,486` — `didToolExecutionFail` non-zero-exit detectors (guarded by `status === "error"` / exit-code checks, ending in `return false`)
- `catch` audit → 20+ sites, every body non-empty (e.g. `episodic-memory.ts:134-137` returns `[]`; `diagnostics-runner.ts:56-58` returns `null`; `ast-codemod.ts:252-255` rethrows fail-closed; `contract-adapter.ts:525-527,609-611,677-680` `if (err) continue` guards; no swallowed-error vacuity)
- Unwired modules → **none**: `src/index.ts:82,84,85` re-exports `verify/architecture-advisor.js`, `interceptors/tool-interceptors.js`, `interceptors/session-interceptors.js`; `runArchitectureAudit` imported at `src/index.ts:63`; wave-5.sh Gates 6–7 confirm 21/21 symbols present + 3/3 modules wired

## 4. KV-cache invariants (Wave 2 onward)

- `injectContextBudgetIntoMessages` **never mutates `event.system`**: `test/context-budget.test.ts` green (23 pass); code path (`src/context/context-budget.ts:340-395`) touches only `event.messages[targetIndex]`, throws fail-closed on missing/empty/no-user-message
- Dynamic context lands strictly on **last `role === "user"`** message (reverse scan `messages.length-1` → `0`, first `role === "user"` wins; throws instead of falling back to `system`/assistant)
- Episodic lessons sorted by `a.id.localeCompare(b.id)` (`context-budget.ts:199,307`); tags carry **zero float `relevance=` scores, zero timestamps** (grep confirms only `localeCompare` + doc comment stating zero scores/timestamps)
- `calibrateSystemPromptInPlace` idempotent; compaction agents skipped in prompt/context hooks; context-budget path never touches `event.system` (programmer claim confirmed by test + code read)

## 5. Scope refusal check

- `grep -rni 'http\.createServer|app\.listen|Server\.listen|multi-agent DAG|epistemic research|worktree manager' src test` → **zero hits**
- `wave-5.sh` self-scan → clean
- Interceptors operate 100% through in-process OpenCode V2 plugin hooks (`tool.transform`, `agent.transform`, `mcp.transform`, `command.transform`, `prompt`/`context`+`generate`/`compaction`/`model.request`); no servers, daemons, or subprocess supervisors
- `getRecommendedMcpConfig()` returns **only** `lsp-mcp-server` + `fallow-mcp` with exact commands/args (runtime-verified above)
- Upstream scripts remain reference-only: `scripts/upstream/README.md` contains `reference-only`/`NOT applied` (wave-5.sh Gate 11 green)
- `.js`-extension audit → **clean** (no extensionless relative imports); `dist/` not committed

## 6. QA red-proof review (`docs/evidence/wave-5/red-proofs.log`)

- Baseline recorded: `bun run check` 0; `bun test` 183/0; `wave-5.sh` green; waves 1–4 individually green
- **Red-proof A** (Wave-5 surface): renamed `runArchitectureAudit(` → `runArchitectureAudit_BROKEN(` in `src/verify/architecture-advisor.ts` → `bun run check` exit **2** (TS2305 ×3), `wave-5.sh` exit **1**; reverted via `git checkout --`; clean + green. **Valid, fail-closed, distinct.**
- **Red-proof B** (prior invariant): flipped `deny()` `allowed: false` → `allowed: true` in `src/guards/permission-guard.ts` → `guards.test.ts` exit **1** (11 pass, 8 fail), `wave-1.sh` exit **1**; reverted via `git checkout --`; `bun test` 183/0 + `wave-5.sh` green after restore. **Valid, fail-closed, distinct.**
- Handoff gate: `git status` clean; edits via native tool; no commits; no subagents. **Accepted.**

## 7. Independent drift-guard sabotage (distinct from QA A/B)

Note: `default.edit` on `src/**` is permission-denied for the drift-guard role (RULE 1 enforced by tooling). Both sabotages below were applied via shell file mutation, verified fail-closed, and restored exclusively via `git checkout -- <file>` with `diff` + `git status` confirmation. No permanent changes; `git status --short` empty after each restore and at final check.

### D1 — Doom-loop threshold (circuit-breaker, distinct from QA A/B)

- **Condition asserted:** `EDIT_FAILURE_THRESHOLD = 2` (`src/guards/circuit-breaker.ts:17`); 2 consecutive failed edits on one path must trigger critical intervention
- **Sabotage:** `sed -i 's/EDIT_FAILURE_THRESHOLD = 2/EDIT_FAILURE_THRESHOLD = 99/' src/guards/circuit-breaker.ts` (verified `grep` shows `= 99`)
- **Check run — EXPECTED FAIL:** `bun test test/circuit-breaker.test.ts` → exit **1**; **13 pass, 3 fail** (44 expects); failure at `test/circuit-breaker.test.ts:173` (`isolates sessions from each other`, expected `triggered` true got false)
- **Restore:** `git checkout -- src/guards/circuit-breaker.ts` → exit **0**; `git status --short` clean; `bun test test/circuit-breaker.test.ts` → exit **0** (16 pass, 0 fail)

### D2 — KV-cache system immutability (context-budget, distinct from QA A/B and D1)

- **Condition asserted:** `injectContextBudgetIntoMessages` leaves `event.system` bit-for-bit identical
- **Sabotage:** inserted `(event as unknown as { system?: Array<{ text: string }> }).system?.push({ text: "drift-guard-sabotage" });` before `const wrapped = ...` in `src/context/context-budget.ts:375`
- **Check run — EXPECTED FAIL:** `bun test test/context-budget.test.ts` → exit **1**; **22 pass, 1 fail** (56 expects); failure at `test/context-budget.test.ts:227` (`leaves event.system bit-for-bit identical`, received extra `{"text":"drift-guard-sabotage"}`)
- **Restore:** `git checkout -- src/context/context-budget.ts` → exit **0**; `diff -q` vs pre-sabotage backup clean; `git status --short` clean

Both D1 and D2 prove the suites are NOT vacuous for the doom-loop and KV-cache invariants. Sabotage set `{D1, D2}` is fully disjoint from QA set `{A: architecture rename, B: deny flip}`.

## 8. Final state

- `make check` → exit 0 (183 pass, 0 fail) after all restores
- `git status --short` → empty (clean)
- `git log --oneline -2` → `7f5fec9` wave-5 work on top of `7a49471`
- No `src/`/`test/`/`scripts/` modifications remain; only this verification report is added under `docs/reports/`

VERDICT: PASS
