# Wave 1 Implementation Report — Deterministic Editors & Guards

- **Stage ID:** Wave 1 (`wave-1-editors-guards`)
- **Scope:** `docs/prompts/SPEC.md` Section 2.3 (A–D) — `src/editors/*`, `src/guards/*`
- **Branch:** `wave-1-editors-guards`
- **Date:** 2026-10-15

## 1. Summary of deliverables

Implemented all four Wave 1 module groups with zero stubs and fail-closed
semantics throughout:

1. **`src/editors/hashline-tools.ts`** — deterministic 4-hex FNV-1a line hash
   (`computeLineHash`, 32-bit FNV-1a over trimmed content narrowed to 16 bits,
   `0000`–`ffff`); `hashReadFile` rendering `<lineNo>#<hash>| <content>` with
   1-based `offset`/`limit` paging; `hashEditFile` validating
   `startHash`/`endHash` per hunk, resolving shifted anchors outward
   (`0, +1, -1, ...`) across +/-25 lines (`HASH_SHIFT_WINDOW`), and failing
   closed with zero disk writes on any mismatch, malformed hash, or bad line
   numbers. Includes shared `resolveSafePath` traversal guard and
   `splitLines` CRLF handling with trailing-newline preservation.
2. **`src/editors/ast-codemod.ts`** — `astSearch` via `@ast-grep/napi`
   (`parse(lang, code).root().findAll({ rule: { pattern } })`, 0-based ranges
   converted to 1-based lines) with a deterministic structural-metavariable
   (`$VAR`, `$$$ARGS`) regex fallback when native bindings are unavailable
   (verified: `Lang` accepts `Python`/`Rust`/`Go` as custom language strings);
   `astRewriteFile` locating matches natively when possible and always
   substituting captured metavariable bindings positionally into the rewrite
   template, applying edits back-to-front and writing only when matches exist.
3. **`src/guards/shell-parse.ts`** — pure token-based classifier
   (`classifyShellCommand`, `isDestructiveShellCommand`,
   `isFileMutatingShellCommand`) covering all six SPEC Rule 1 operations
   (including `sudo`/flag-order variants), write-class detection
   (redirections, `tee`, mutating file verbs, mutating `git` subcommands,
   package installs, in-place `sed`), and read-only verification commands
   (`bun test`, `make check`, `scripts/accept/*`, `git status/log/diff`).
   Chains resolve to the most severe segment class.
4. **`src/guards/circuit-breaker.ts`** — per-session attempt ledger
   (`sessionAttempts: Map<string, ToolAttemptRecord[]>`, bounded at 200
   entries) with critical intervention (`shouldEscalateModel: true`,
   `<circuit-breaker-intervention severity="critical">`) at >= 2 consecutive
   failed edit-family attempts on one path or >= 3 consecutive failed
   shell-family attempts on one two-token command prefix. Streaks break on
   any success, family change, or key change.
5. **`src/guards/permission-guard.ts`** — `evaluateBoardGuard` enforcing
   Rules 0 (path safety/unknown tools/empty roles fail closed), 1
   (destructive denied for ALL roles), 2 (leadership read-only), 3 (QA
   red-team `src/**` lock with test/spec/accept/docs allow-list), 4
   (architect-only contract globs, defaulting per SPEC), plus optional
   per-role `taskOwnedPaths` confinement. Dependency-free glob matcher
   supports `**`, `*`, `?`.

## 2. Files created / modified

Created:

- `src/editors/hashline-tools.ts`
- `src/editors/ast-codemod.ts`
- `src/guards/shell-parse.ts`
- `src/guards/permission-guard.ts`
- `src/guards/circuit-breaker.ts`
- `test/editors.test.ts` (27 tests)
- `test/guards.test.ts` (19 tests)
- `test/circuit-breaker.test.ts` (15 tests)
- `scripts/accept/wave-1.sh` (executable; exits 0/1)
- `docs/reports/wave-1.md` (this report)

Unmodified: `src/index.ts` (Wave 3 entrypoint placeholder), `test/bootstrap.test.ts`.

## 3. Test results

- `bun run check` (`tsc --noEmit`): exit 0, zero diagnostics.
- `bun test`: **62 pass, 0 fail, 217 expect() calls** across 4 files
  (editors 27, guards 19, circuit-breaker 15, bootstrap 1).
- `bash scripts/accept/wave-1.sh`: exit 0 — typecheck, unit suites,
  zero-stub scan, 12 required-export checks, and scope-refusal scan all green.
- Native `@ast-grep/napi` path verified live (`parse("TypeScript", ...)`
  returns structural matches); regex fallback covers unregistered languages.

## 4. Self-audit notes

- **Zero stubs:** no `TODO`, no `test.skip`/`describe.skip`, no empty `catch`
  blocks (every catch performs the specified fallback or captures the error
  into an assertion), no `|| true` / `set +e` in `src/` or `test/`, no bare
  vacuous `return true;` statements. The acceptance script scans only `src/`
  and `test/` so its own `grep` plumbing cannot self-trigger; it contains no
  `set +e` and uses `set -euo pipefail`.
- **Fail-closed:** escaping/absolute paths throw or deny; edits never
  half-write (all hunks resolve before a single `Bun.write`); unknown tools,
  empty roles, empty shell commands, and underivable rewrite bindings all
  reject with descriptive errors naming the rule.
- **One defect found and fixed during implementation:** a JSDoc comment
  containing a literal `*/` (inside a glob example) prematurely closed its
  block comment (`TS1434`); reworded. One classifier defect found by tests:
  the `bash scripts/accept/*` read-only prefix alternative was over-anchored;
  corrected to a prefix match (test failed 61/62 before the fix, 62/62 after).
- **Deviations from SPEC:** none. `shiftedLines` is defined as the net
  line-count delta after a successful edit; `commandPrefixOf` uses the first
  two whitespace-separated tokens; contract-glob default is exactly
  `["**/contracts/**", "**/schemas/*.schema.json"]`.
- **Scope:** no WebUI, HTTP server, DAG scheduler, worktree manager, or
  epistemic-engine code added; scope-refusal grep in the accept script is green.
