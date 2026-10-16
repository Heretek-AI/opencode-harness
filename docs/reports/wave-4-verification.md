# Wave 4 Verification Report — Argon Upgrades (agency-drift-guard)

- **Stage:** Wave 4 (`wave-4-argon-upgrades`)
- **Worktree:** `/home/john/Projects/Heretek-AI-Rebuild/opencode-harness/worktrees/wave-4`
  (branch `wave-4-argon-upgrades`)
- **Auditor:** `agency-drift-guard` (independent adversarial audit; no code changed)
- **Date:** 2026-10-16
- **Contracts read in full:** `AGENTS.md`, `docs/prompts/SPEC.md`
  (§§1–2.5, incl. Wave 3 entrypoint surface), `docs/prompts/verify-stage.md`,
  programmer's report `docs/reports/wave-4.md`.

## 1. Gates run (commands + exit codes)

| Command | Exit | Result |
|---|---|---|
| `make check` (`tsc --noEmit` + `bun test`: 173 pass, 0 fail, 606 expect calls, 9 files) | 0 | GREEN |
| `bash scripts/accept/wave-4.sh` (`WAVE 4 ACCEPT: ALL GATES GREEN`) | 0 | GREEN |
| `bash scripts/accept/wave-1.sh` (`WAVE 1 ACCEPT: ALL GATES GREEN`) | 0 | GREEN |
| `bash scripts/accept/wave-2.sh` (`WAVE 2 ACCEPT: ALL GATES GREEN`) | 0 | GREEN |
| `bash scripts/accept/wave-3.sh` (`WAVE 3 ACCEPT: ALL GATES GREEN`) | 0 | GREEN |
| `bun test test/context-budget.test.ts` (23 pass, 0 fail) | 0 | GREEN |
| `make accept` coverage: `Makefile` `accept` target confirmed to run waves 1–4 in sequence (`WAVE=N` targeted mode intact) | n/a | OK |

QA red-proofs reviewed: `docs/evidence/wave-4/red-proofs.log` documents two
valid sabotages (taint-guard vacuous-allow → 11 pass/1 fail; `computeLineHash`
constant `"0000"` → 170 pass/3 fail + wave-1 accept FAILED), each restored via
`git checkout --` to 173/0 green with clean `git status`. Both are fail-closed
and accepted as genuine.

## 2. Stub / shortcut scan (zero-stubs enforcement)

Grep over `src/` and `test/` (`*.ts`):

- `TODO|test\.skip|describe\.skip|it\.skip|xit(|xdescribe(|...|| true|set +e|cmd: "true"|echo "pass` — **zero hits** in both trees.
- Empty-catch regex `catch\s*(\([^)]*\))?\s*\{\s*\}` — **zero hits**.
- `return true;` — 9 hits, ALL inside `src/guards/shell-parse.ts`
  (`isDestructiveCommand` lines ~292–406, `segmentIsWrite` lines ~395–406).
  Each is a guarded predicate return after a matched destructive/write
  condition (rm-root, `git reset --hard`, force-push, mkfs, dd, `>` redirect,
  `tee`, write-verb set), not a vacuous pass. **Justified, not a stub.**
- `wave-4.sh` Gate 5 zero-stub scan — passed inside the accept run.
- No `dist/` present; no network-dependent paths in the accept gates.

**Result: zero stubs, zero mocks, zero vacuous tests.**

## 3. KV-cache invariants

- `test/context-budget.test.ts`: 23 pass, 0 fail (exit 0).
- `src/context/context-budget.ts` untouched per programmer report; grep confirms
  `a.id.localeCompare(b.id)` sorting, no `relevance=` float scores, no
  timestamps in lesson tags.
- New `src/context/episodic-memory.ts` re-sorts by `id.localeCompare` at every
  selection/persist boundary (lines 43, 75, 81, 154) — byte-stable for KV-cache.
- `buildMuseSystemOverlay()` is a static string (zero per-turn state); the
  `session.context` hook in `contract-adapter.ts` skips
  `compaction`/`summary`/`title` agents and never touches `event.system` on the
  context-budget path (prompt-overlay `event.system.push` is the sanctioned
  prompt-hook surface, distinct from `injectContextBudgetIntoMessages`).

**Result: KV-cache invariants hold.**

## 4. Scope refusal (single-session plugin only)

- Grep for `http.createServer|app.listen|Server.listen|epistemic|worktree
  manager|WebUI|DAG|fleet daemon|express()|fastify` over `src/` — **zero
  substantive hits**. The single `dashboard` mention is inside a comment in
  `src/ui-auditor/mcp-defaults.ts` (lines 7–10) explicitly declaring
  dashboard/daemon/scheduler/VCS-automation/literature-review OUT OF SCOPE —
  documentation of refusal, not a violation.
- `moveModuleAndRewriteImports` (repomap) is single-session module refactoring,
  not a VCS worktree manager. `spawnSync(node --check|python3 -m py_compile)`
  are synchronous syntax probes, not servers/daemons.
- `getRecommendedMcpConfig()` verified exact at runtime by accept Gate 8
  (`lsp-mcp-server` via `bunx`, `fallow-mcp` via
  `npx --yes --package fallow fallow-mcp`, keys exactly
  `fallow-mcp,lsp-mcp-server`); `mcp-defaults.ts` type shape contains ONLY the
  two sanctioned servers.

**Result: scope refusal holds — automatic-FAIL constructs absent.**

## 5. Wiring (Wave 3 onward rule: every `src/**/*.ts` wired into `src/index.ts`)

All 16 non-entrypoint `src/**/*.ts` files referenced from `src/index.ts`
(independently re-verified, matching accept Gate 7's 8/8 new-module wiring):
`context/context-budget`, `context/episodic-memory`,
`diagnostics/diagnostics-runner`, `editors/ast-codemod`,
`editors/hashline-tools`, `guards/circuit-breaker`,
`guards/permission-guard`, `guards/shell-parse`, `guards/taint-guard`,
`host/contract-adapter`, `muse/muse-calibration`, `repomap/repomap`,
`transactions/edit-transaction`, `ui-auditor/dom-auditor`,
`ui-auditor/mcp-defaults`, `verify/verifier`. Core Wave 3 surface intact
(5 tools, 3 hooks, MCP shape) per accept Gate 8; extended tool table
(`EXTENDED_HARNESS_TOOL_NAMES`, `repo_map`, `blast_radius`, `file_outline`,
`verify_scoped`, `checkpoint_create`, `checkpoint_rollback`) present per Gate 9.

**Result: zero unwired modules.**

## 6. Independent sabotage test (distinct from QA's taint-guard + hashline)

Target: NEW Wave 4 invariant — stale-read guard
`checkStaleFileRead` in `src/transactions/edit-transaction.ts`
(covered by `test/ported-harness.test.ts` > "detects stale file reads when a
file is modified externally on disk", asserting `check.stale === true` after
`utimesSync` bumps mtime). QA sabotaged `taint-guard.ts` and
`hashline-tools.ts`; this target is distinct.

- Sabotage (temporary, via shell; `edit` tool is permission-denied for the
  auditor role): flipped the `st.mtimeMs > lastReadMtime + 2` branch's
  `stale: true` → `stale: false` (vacuous never-stale).
- Run: `bun test test/ported-harness.test.ts` → **11 pass, 1 fail**
  (`Expected: true / Received: false` at `ported-harness.test.ts:160:25`),
  `SABOTAGE_BUN_EXIT=1` — FAILS as required, check is non-vacuous.
- Restore: `git checkout -- src/transactions/edit-transaction.ts`
  (`RESTORE_EXIT=0`, byte-identical to pre-sabotage backup via `diff -q`).
- Re-verify: `bun test test/ported-harness.test.ts` → **12 pass, 0 fail**
  (`RESTORE_VERIFY_EXIT=0`).
- `git status --short` after restore shows only the pre-existing staged QA
  artifact `A docs/evidence/wave-4/red-proofs.log`; **zero `src/`/`test/`/
  `scripts/` modifications remain**.

**Result: independent sabotage proves fail-closed; restore clean.**

## 7. Findings

No findings. Zero stubs, all gates green, KV-cache invariants hold, scope
refusal holds, all modules wired, both QA red-proofs and the independent
sabotage are fail-closed with clean restores.

VERDICT: PASS
