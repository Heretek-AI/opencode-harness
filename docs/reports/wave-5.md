# Wave 5 Implementation Report — Zero-Patch Interceptors + Architecture Advisor

- **Stage ID:** Wave 5 (`wave-5-interceptors`)
- **Scope:** Rebase the `v1.0.4` bundle
  (`/tmp/opencode/v104/opencode-harness/`) onto the Wave-4 tree without
  dropping Wave-4 behavior: 3 new modules
  (`src/interceptors/tool-interceptors.ts`,
  `src/interceptors/session-interceptors.ts`,
  `src/verify/architecture-advisor.ts`), a 3-way merge of
  `src/host/contract-adapter.ts` (442-line Wave-4 base + bundle
  interceptor wiring), an `src/index.ts` merge (Wave-4 wiring +
  `runArchitectureAudit` re-export, interceptor exports,
  `HARNESS_RELEASE_VERSION`, `architecture_audit` tool, broader root
  inference, dual-shape circuit-breaker mapping), canonical
  `EpisodicLesson`, `test/plugin-interceptors.test.ts`,
  `scripts/accept/wave-5.sh`, and `docs/reports/wave-5.md` (this file).
  `dist/` explicitly excluded — never committed.
- **Branch:** `wave-5-interceptors` (worktree `worktrees/wave-5`, based on
  `main` @ `7a49471` release v1.0.3, `git status` clean at start)
- **Date:** 2026-10-16

## 1. Summary of deliverables

Rebased the bundle with zero stubs and fail-closed semantics throughout,
preserving every Wave-4 fix and applying the minimum strict-TS corrections
the bundle needs to pass `tsc --noEmit`:

1. **New modules (3), byte-identical to the bundle
   (`diff` clean, 631/166/375 lines, zero `any`, `.js` imports native):**
   - `src/interceptors/tool-interceptors.ts` — plugin-over-patch
     built-in tool interceptors: in-place `EditTool` auto-repair
     (ReadTool `12: ` / `file_hash_read` `12#xxxx| ` prefix stripping +
     indentation-drift alignment), `<near-miss-anchor>` 4-hex FNV-1a
     recovery slices, `read` fuzzy-path auto-resolution with
     repo-relative suggestions, `shell.hook("create.before")`
     non-interactive env hardening (`CI=1`, `GIT_TERMINAL_PROMPT=0`,
     `PAGER`/`GIT_PAGER=cat`), non-zero-exit detection for `ShellTool`
     (`status: "completed"` with `output.exit !== 0`), dual-shape
     `Tool.Result` block appending, and `normalizePluginToolResult`
     (`Tool.Result` contract wrapper so `runtime.ts` never
     `Effect.die`s on a missing output schema).
   - `src/interceptors/session-interceptors.ts` — zero-patch session
     interceptors: deterministic `meta.txt` subagent over-trigger repair
     + static Muse 1.3 overlay calibration in `event.system[0]`
     (idempotent, KV-cache stable), compaction decontamination (strips
     coding-agent prompt / `# Your Model` blocks, clears `event.tools`),
     and multi-hop root session-affinity header propagation
     (`x-session-affinity` / `X-Session-Id` / `x-opencode-session`).
   - `src/verify/architecture-advisor.ts` — Tarjan SCC circular
     dependency detection, pre/post-mutation exported-contract impact
     analysis (`<contract-impact>` tags with importers, affected tests,
     callers), file-level engineering-smell scanning (empty catch,
     god-file >650 lines, ≥7 positional params), and
     `runArchitectureAudit` (`<architecture-audit>` report).
2. **`src/host/contract-adapter.ts` (3-way merge, 817-line bundle base +
   Wave-4 fixes re-applied):** full interceptor wiring
   (`tool.transform` with `options: { codemode: false }` +
   `normalizePluginToolResult`, `explore` read-only hardening via
   `agent.transform`, MCP seeding via `mcp.transform`, `/doctor` +
   `/audit` slash commands via `command.transform`, shell hardening,
   explore/plan→director permission mapping + taint guard, edit
   auto-repair / read resolver / subagent digest + mutation-receipt /
   stale-read + transaction + diagnostics + contract-impact /
   non-zero-exit fault localization / windowed-read outline summary in
   `execute.after`, and `prompt` / `context`+`generate` / `compaction` /
   `model.request` session hooks) **plus** Wave-4 preservations:
   fail-closed `typeof updated !== "string"` throw in the context
   write-back (the bundle silently coerced with `?? ""`), `.js`
   extension imports (`../repomap/repomap.js`), required (non-optional)
   `OpenCodeV2SessionPromptEvent.system` so the 173 prior tests compile
   unmodified, `location?: { directory?; worktree? }` passthrough, and
   release version `1.0.4`.
3. **`src/index.ts` merge (Wave-4 852-line base + additions):** kept all
   Wave-4 wiring (16 re-exported modules, 5 core tools, 3 hooks, exact
   MCP config, KV invariants, `recordAndEvaluateCircuitBreaker`,
   `registerContextBudgetHook`, extended Wave-4 tool table) and added
   `runArchitectureAudit` import, `export *` for `architecture-advisor`
   + both interceptor modules, explicit `export { computeLineHash }`
   (resolves the `export *` ambiguity between `hashline-tools` and
   `tool-interceptors`, which would otherwise leave the name
   unexported), `HARNESS_RELEASE_VERSION = "1.0.4"`,
   `architecture_audit` in `EXTENDED_HARNESS_TOOL_NAMES` + zod schema +
   executor, broader root inference (`directory ?? worktree ??
   location.directory ?? location.worktree ?? cwd`), and
   `toTrippedDirective()` — a fail-closed adapter that accepts both the
   canonical Wave-4 verdict (`triggered` / `intervention` / `message`)
   and the alternate `tripped` / `directive` shape (canonical fields
   win; non-object verdicts and missing trip flags throw).
4. **Canonical `EpisodicLesson`:** added
   `EpisodicLesson { id: string; summary: string }` to
   `src/context/context-budget.ts`; `src/context/episodic-memory.ts`
   now `import type`s it from `./context-budget.js` with its local
   redefinition removed (exactly one `interface EpisodicLesson {`
   remains repo-wide; supersedes the Wave-4 local-def workaround and
   repairs the bundle's dangling extensionless import of a type
   `context-budget` never exported).
5. **Verifier import:** Wave-4 already used
   `"../repomap/repomap.js"` (verified — no change needed); the bundle's
   extensionless import was not adopted.
6. **Tests:** adopted `test/plugin-interceptors.test.ts` (10 tests:
   edit auto-repair ×3, read fuzzy-resolve + result normalization,
   shell exit detection + env hardening, meta calibration +
   compaction decontamination, multi-hop affinity, Tarjan SCC +
   contract impact + smells, end-to-end `setup` interception) with one
   surgical strict-TS fix (`require("node:fs")` → top-level
   `mkdirSync` import; `require` is unavailable under `tsc --noEmit`
   ESM). All 173 prior tests pass unmodified.
7. **Acceptance + release:** `scripts/accept/wave-5.sh` (11 gates),
   `Makefile` accept chain extended to wave-5, `package.json` bumped to
   `1.0.4` (bundle description + keywords).

## 2. Files created / modified

- Created: `src/interceptors/tool-interceptors.ts`,
  `src/interceptors/session-interceptors.ts`,
  `src/verify/architecture-advisor.ts`,
  `test/plugin-interceptors.test.ts`, `scripts/accept/wave-5.sh`,
  `docs/reports/wave-5.md` (this file).
- Modified: `src/index.ts`, `src/host/contract-adapter.ts`,
  `src/context/context-budget.ts`, `src/context/episodic-memory.ts`,
  `package.json`, `Makefile`.
- Bundle-exact (`diff` clean): `src/interceptors/tool-interceptors.ts`,
  `src/interceptors/session-interceptors.ts`,
  `src/verify/architecture-advisor.ts`.
- Deliberately NOT adopted from the bundle: `scripts/upstream-patch.sh`
  (upstream `opencode-2` patch script — this repo already vendors the
  equivalent reference-only script at
  `scripts/upstream/apply_opencode_v2_core_fixes.bash`, documented in
  `scripts/upstream/README.md` as never executed here; see §4),
  `src/verify/verifier.ts` (Wave-4 `.js` import already correct),
  `src/diagnostics/diagnostics-runner.ts` (Wave-4 `createRequire`
  fix is newer than the bundle), `src/guards/*`, `src/repomap/*`,
  `src/muse/*`, `src/ui-auditor/*`, `src/transactions/*`,
  `src/editors/*` (all `diff -q` identical — kept Wave-4 bytes).

## 3. Test results

- `bun run check` (`tsc --noEmit`): exit 0.
- `bun test`: **183 pass, 0 fail** (665 `expect()` calls, 10 files) —
  173 prior tests intact plus 10 new interceptor tests.
- `bun test test/plugin-interceptors.test.ts` (isolation): exit 0
  (10 pass).
- `npm run build` (`tsc -p tsconfig.build.json`): exit 0
  (`dist/interceptors/*`, `dist/verify/architecture-advisor.*`
  emitted; `dist/` git-ignored, never committed).
- `make accept` (waves 1–5): exit 0 —
  `WAVE 1 ACCEPT: ALL GATES GREEN`,
  `WAVE 2 ACCEPT: ALL GATES GREEN`,
  `WAVE 3 ACCEPT: ALL GATES GREEN`,
  `WAVE 4 ACCEPT: ALL GATES GREEN`,
  `WAVE 5 ACCEPT: ALL GATES GREEN` (214 `ok:` lines, zero `FAIL:`).
- `scripts/accept/wave-5.sh` alone: exit 0 (Gates 1–11: typecheck, full
  suite, interceptors isolation, waves 1–4 regressions, zero-stub scan,
  21 new-module symbols, 3/3 modules wired into `src/index.ts`, core
  5-tool/3-hook/MCP surface + exact MCP shape, 7+1 extended-tool
  symbols, 6 Wave-4 fix markers, `.js`-extension audit, canonical
  single `EpisodicLesson`, scope refusal over `src`/`test`/`wave-5.sh`,
  upstream reference-only documentation).
- `getRecommendedMcpConfig()` exactness re-verified at runtime
  (`lsp-mcp-server` via `bunx`, `fallow-mcp` via
  `npx --yes --package fallow fallow-mcp`, no extra servers).

## 4. Self-audit notes

- **Bundle deviations (all required for `tsc --noEmit` or Wave-4
  preservation; no `any` introduced):**
  1. `src/index.ts` — the bundle mapped
     `verdict.tripped`/`verdict.directive`, which do not exist on
     `CircuitBreakerVerdict` (`triggered`/`intervention`, identical in
     bundle and Wave-4 circuit-breakers — the bundle would not
     typecheck). Replaced with `toTrippedDirective()`, which supports
     both shapes fail-closed instead of assuming one.
  2. `src/host/contract-adapter.ts` — re-applied the Wave-4
     fail-closed `typeof updated !== "string"` throw that the bundle
     dropped (`?? ""` silent coercion), fixed
     `"../repomap/repomap"` → `"../repomap/repomap.js"`, and kept
     `system` required on `OpenCodeV2SessionPromptEvent` so
     `test/ported-harness.test.ts` compiles unmodified.
  3. `src/context/episodic-memory.ts` + `src/context/context-budget.ts`
     — the bundle imports `EpisodicLesson` from `./context-budget`
     (extensionless), which exports no such type; fixed by adding the
     canonical interface to `context-budget.ts` and importing it with
     `.js`, removing the local redefinition (supersedes the Wave-4
     local-def workaround noted in `wave-4.md` §4).
  4. `test/plugin-interceptors.test.ts` — replaced mid-file
     `require("node:fs")` with a top-level `mkdirSync` import (only
     deviation from the bundle test file).
  5. `src/index.ts` — added explicit
     `export { computeLineHash } from "./editors/hashline-tools.js"`
     after the `export *` block: without it, `computeLineHash` is
     ambiguous between `hashline-tools` and `tool-interceptors`
     (`export *` silently drops ambiguous names) and the
     `plugin.test.ts` / `plugin-interceptors.test.ts` imports would
     fail. Verified `computeLineHash` is the only colliding export
     repo-wide.
- **Stub/shortcut scan:** `TODO`, `test.skip`/`describe.skip`/`it.skip`,
  `set +e`, `|| … true`, empty `catch {}` — zero hits across `src/` and
  `test/` (wave-5.sh Gate 5). No vacuous passes; every `catch` carries
  a handling body (`if (err) continue/return` guards on
  filesystem-facing helpers are non-empty error paths, not swallowed
  errors).
- **Scope scan:** zero hits for WebUI/HTTP-server/DAG-scheduler/
  worktree-manager/epistemic constructs in `src/`, `test/`, and
  `wave-5.sh` (Gate 10). The interceptor modules operate 100% through
  in-process OpenCode V2 plugin hooks — no servers, daemons, or
  subprocess supervisors.
- **KV-cache invariants:** `injectContextBudgetIntoMessages` untouched;
  episodic lessons still sorted by `id.localeCompare` with zero float
  scores/timestamps (`context-budget.test.ts` green);
  `calibrateSystemPromptInPlace` is idempotent (second call
  byte-identical, covered by test); compaction agents are skipped in
  `prompt`/`context` hooks; the context-budget path never touches
  `event.system`.
- **Fail-closed posture preserved:** permission Rules 1–4 untouched;
  circuit-breaker thresholds (edit ≥2, shell ≥3) untouched;
  `resolveHarnessOptions` still rejects non-object options, empty
  `rootDir`, and non-finite budgets; `HARNESS_VERSION` stays `"1.0.0"`
  (asserted by `plugin.test.ts`); release version is tracked separately
  in `HARNESS_RELEASE_VERSION = "1.0.4"` and `package.json`.
- **Upstream script reference-only:** `scripts/upstream/README.md`
  already documents `apply_opencode_v2_core_fixes.bash` as
  never-executed-against-this-repo (targets upstream `opencode-2`
  `packages/core`, outside this repo's Hard Refusal boundary). The
  bundle's `scripts/upstream-patch.sh` is the same class of artifact
  and was deliberately not copied — vendoring a second upstream patch
  script would duplicate reference material with zero harness effect.
  Gate 11 asserts the reference-only documentation is present.
