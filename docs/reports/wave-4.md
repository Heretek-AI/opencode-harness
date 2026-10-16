# Wave 4 Implementation Report — Argon Upgrades (Ported Harness Modules)

- **Stage ID:** Wave 4 (`wave-4-argon-upgrades`)
- **Scope:** Adopt the 8 ported SwarmOS single-session harness modules plus
  the extended `src/index.ts` (852-line version), hardened
  `src/guards/shell-parse.ts` (+221 lines), `test/ported-harness.test.ts`,
  `scripts/accept/wave-4.sh`, and `docs/reports/wave-4.md` from the
  `opencode-harness-v2-upgraded` bundle (extracted at
  `/tmp/opencode/argon-review/opencode-harness/`). `dist/` explicitly
  excluded — never copied.
- **Branch:** `wave-4-argon-upgrades` (worktree `worktrees/wave-4`, based on
  `main` @ `7cde788` release v1.0.2, `git status` clean at start)
- **Date:** 2026-10-16

## 1. Summary of deliverables

Incorporated the bundle with zero stubs and fail-closed semantics
throughout, applying exactly five surgical strict-TS fixes on top of the
verbatim copies (all other bytes identical to the bundle):

1. **New modules (8), copied verbatim from the bundle:**
   - `src/context/episodic-memory.ts` — scope-scored episodic lesson
     selection (`selectRelevantLessons`, always re-sorted by
     `id.localeCompare` so `packBlocks` stays byte-stable for KV-cache),
     circuit-breaker recovery proposals (`proposeEpisodicLesson`,
     `getPendingLessonProposals`), and JSON lesson-store persistence
     (`loadStoredLessons`, `commitEpisodicLesson`, bounded at 50, sorted).
   - `src/guards/taint-guard.ts` — prompt-injection taint tracking:
     `recordUntrustedContentTaint` on `webfetch`/`websearch`/`codesearch`/
     `browser`/`fetch`/`mcp_*` ingestion, `evaluateTaintGuard` denying
     credential exfiltration (`TAINT-NET-1`), env dumps (`TAINT-ENV-1`,
     `ask`), and git-hook/shell-rc mutation (`TAINT-FILE-1`).
   - `src/diagnostics/diagnostics-runner.ts` — warm-cached
     post-mutation diagnostics (`collectFileDiagnostics`, keyed by
     `mtimeMs:size`, JSON + TS/JS + Python syntax) with
     `<diagnostics file status count>` tags, plus stack-frame fault
     localization (`localizeFaultContext`) emitting hash-anchored
     `<fault-context>` slices via `hashReadFile`.
   - `src/transactions/edit-transaction.ts` — all-or-nothing atomic edit
     transactions (snapshot/restore/remove with `<harness-transaction
     status="rolled-back">` tags), time-travel checkpoints
     (`createCheckpoint`/`rollbackCheckpoint`/`listCheckpoints`), and the
     stale-read detector (`recordFileReadTimestamp`/`checkStaleFileRead`,
     2 ms mtime tolerance, fail-closed `requirePriorRead` mode).
   - `src/repomap/repomap.ts` — multi-language PageRank RepoMap
     (`buildRepoMap`, comment/string-stripped import graphs, 16-iteration
     PageRank with sink redistribution), `analyzeBlastRadius` (direct +
     transitive dependents, symbol callers, affected tests),
     `moveModuleAndRewriteImports` (safe move + importer rewrite).
   - `src/verify/verifier.ts` — incremental verification
     (`discoverRepoChecks`, `runIncrementalVerification` with scoped bun
     tests, `parseVerificationFailures` for tsc/lint/test formats),
     `auditDiffCoverageAndTautology` (zero-assertion + self-mock
     detection, LCOV diff coverage), `assertTaskInvariants`.
   - `src/muse/muse-calibration.ts` — static Muse 1.3 system overlay
     (`buildMuseSystemOverlay`, zero per-turn state so KV-cache prefixes
     survive), compaction pseudo-transcript sanitizer, SHA-256 workspace
     digests + `<mutation-receipt>` blocks.
   - `src/host/contract-adapter.ts` — native OpenCode V2
     `PromiseContext` adapter (`wireOpenCodeV2PromiseContext`:
     `tool.transform` registration, `execute.before` stale-read +
     transaction-begin, `execute.after` read-stamp/taint/diagnostics/
     fault/circuit-breaker appending, `permission.evaluate` board-guard +
     taint layering, `session.prompt` calibration overlay with compaction
     isolation, `session.context` KV-safe injection) plus
     `inspectHostContract` `/doctor` report.
2. **Extended files, bundle versions adopted:**
   - `src/index.ts` (852 lines) — preserves `HARNESS_NAME`,
     `HARNESS_VERSION` (`1.0.0`), the 5 core tools, the 3 hooks, and the
     exact `getRecommendedMcpConfig()` shape; adds
     `EXTENDED_HARNESS_TOOL_NAMES` (`repo_map`, `blast_radius`,
     `file_outline`, `verify_scoped`, `checkpoint_create`,
     `checkpoint_rollback`), `buildExtendedHarnessTools`, and the
     `OpenCodeV2Plugin` default export (`{ id, setup(ctx) }`).
   - `src/guards/shell-parse.ts` (479 lines) — preserves all Wave 1
     exports/classification behavior and adds quote-aware POSIX
     tokenization (`splitShellPipeline`, `tokenizeSegment`), `ParsedSegment`
     AST (`parseCommandSegments` with recursive `bash -c`/`eval`/`xargs`/
     `$(...)` unwrapping to depth 4), so `classifyShellCommand` flags
     destructive payloads hidden in subshells.
3. **Tests:** `test/ported-harness.test.ts` adopted verbatim (12 tests, 6
   ported-module describes). All 161 prior tests untouched and green.
4. **Acceptance:** new `scripts/accept/wave-4.sh` (10 gates, exit 0/1);
   `Makefile` `accept` now runs waves 1–4 in sequence (`WAVE=N` targeted
   mode unchanged).
5. **Out-of-scope note:** `apply_opencode_v2_core_fixes.bash` targets the
   `opencode-2` core repository, NOT this repo — deliberately NOT applied
   here. No core-repo files exist in this worktree; no action taken.

## 2. Files created / modified

- Created: `src/context/episodic-memory.ts`,
  `src/guards/taint-guard.ts`, `src/diagnostics/diagnostics-runner.ts`,
  `src/transactions/edit-transaction.ts`, `src/repomap/repomap.ts`,
  `src/verify/verifier.ts`, `src/muse/muse-calibration.ts`,
  `src/host/contract-adapter.ts`, `test/ported-harness.test.ts`,
  `scripts/accept/wave-4.sh`, `docs/reports/wave-4.md` (this file).
- Modified: `src/index.ts`, `src/guards/shell-parse.ts`, `Makefile`.
- Bundle-exact except five strict-TS fixes (see §4):
  `src/guards/taint-guard.ts`, `src/transactions/edit-transaction.ts`,
  `src/repomap/repomap.ts`, `src/muse/muse-calibration.ts`,
  `src/guards/shell-parse.ts`, `test/ported-harness.test.ts` are
  byte-identical to the bundle (`diff -q` clean).

## 3. Test results

- `bun run check` (`tsc --noEmit`): exit 0.
- `bun test`: **173 pass, 0 fail** (606 `expect()` calls, 9 files) —
  161 prior tests intact plus 12 new ported tests.
- `npm run build` (`tsc -p tsconfig.build.json`): exit 0.
- `make check`: exit 0.
- `make accept` (waves 1–4): exit 0 —
  `WAVE 1 ACCEPT: ALL GATES GREEN`,
  `WAVE 2 ACCEPT: ALL GATES GREEN`,
  `WAVE 3 ACCEPT: ALL GATES GREEN`,
  `WAVE 4 ACCEPT: ALL GATES GREEN` (68 `ok:` lines, zero `FAIL:`).
- `scripts/accept/wave-4.sh` alone: exit 0 (Gates 1–10: typecheck, full
  suite, ported suite isolation, waves 1–3 regressions, zero-stub scan,
  32 new-module symbols, 8/8 modules wired into `src/index.ts`, core
  5-tool/3-hook/MCP surface + exact MCP shape, 7 extended-tool symbols,
  scope refusal over `src`/`test`/`wave-4.sh`).
- `getRecommendedMcpConfig()` exactness re-verified at runtime
  (`lsp-mcp-server` via `bunx`, `fallow-mcp` via
  `npx --yes --package fallow fallow-mcp`, no extra servers).

## 4. Self-audit notes

- **Bundle deviations (all required for `tsc --noEmit`, no `any`
  introduced):**
  1. `src/context/episodic-memory.ts` — the bundle imports
     `EpisodicLesson` from `./context-budget`, which exports no such type
     (only `LessonInput { id, trigger, lesson }`); the import fails
     closed under `tsc`. Fixed by defining
     `EpisodicLesson { id: string; summary: string }` locally (matching
     the store/test shape) and dropping the unused `resolve` import.
  2. `src/diagnostics/diagnostics-runner.ts` — the bundle calls bare
     `require("@babel/core")` with no `require` in scope (ESM,
     `module: ESNext`). Fixed with the established Wave 1 pattern
     `createRequire(import.meta.url)` from `node:module`.
  3. `src/index.ts` — `OpenCodeV2Plugin.setup` mapped
     `verdict.tripped`/`verdict.directive`, which do not exist on
     `CircuitBreakerVerdict` (`{ triggered, shouldEscalateModel,
     consecutiveFailures, message, intervention? }`). Fixed to
     `tripped: verdict.triggered`,
     `directive: verdict.intervention ?? verdict.message`.
  4. `src/host/contract-adapter.ts` — the `session.context` hook
     assigned `SessionMessage["content"]` (`unknown`) into the
     `string | parts[]` host content slots (TS18048/TS2322 ×4). Fixed
     with an explicit `typeof updated !== "string"` fail-closed throw;
     no `any`.
  5. `src/verify/verifier.ts` — normalized
     `"../repomap/repomap"` → `"../repomap/repomap.js"` per the Wave 3
     `.js`-extension convention (behavior-identical under
     `moduleResolution: bundler`).
- **Stub/shortcut scan:** `TODO`, `test.skip`/`describe.skip`/`it.skip`,
  `set +e`, `|| … true`, empty `catch {}` — zero hits across `src/` and
  `test/`. No `return true;` vacuous passes; every `catch` carries a
  handling body. (Pre-existing `if (err) return …` guards in
  filesystem-facing helpers are non-empty error paths, not swallowed
  errors.)
- **Scope scan:** zero hits for WebUI/HTTP-server/DAG-scheduler/worktree-
  manager/epistemic constructs in `src/`, `test/`, and `wave-4.sh`.
  `moveModuleAndRewriteImports` is single-session module refactoring, not
  a VCS worktree manager; `spawnSync(node --check|python3 -m py_compile)`
  are synchronous syntax probes, not servers or daemons.
- **KV-cache invariants:** `injectContextBudgetIntoMessages` untouched
  (byte-identical `context-budget.ts` to `main`); episodic lessons still
  sorted by `id.localeCompare` with zero float scores/timestamps;
  `buildMuseSystemOverlay()` is a static string; the adapter's context
  hook skips `compaction`/`summary`/`title` agents and never touches
  `event.system` (prompt overlay appends to `event.system`, which is the
  sanctioned prompt-hook surface, not the context-budget path).
- **Fail-closed posture preserved:** permission Rules 1–4 untouched;
  circuit-breaker thresholds (edit ≥2, shell ≥3) untouched; stale-read
  `checkStaleFileRead` defaults to advisory (`requirePriorRead: false`)
  with fail-closed opt-in; `OpenCodeV2Plugin.setup` resolves options
  through the same `resolveHarnessOptions` validator.
- **Fixes script non-applicability:** `apply_opencode_v2_core_fixes.bash`
  was inspected by path/name only — it targets the `opencode-2` core
  repo (`packages/core/...`), which is outside this repository's Hard
  Refusal boundary; applying it here would be an out-of-scope mutation,
  so it was documented and skipped.
