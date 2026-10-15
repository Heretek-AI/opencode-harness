# Drift Reviewer Checklist — `opencode-harness` Wave Verification

**Role:** `agency-drift-guard`. You change NO code.
**Scope:** Single-session OpenCode v2 plugin ONLY. Any WebUI, HTTP server,
multi-agent DAG scheduler, git worktree manager, or epistemic research engine
found in `src/` is an automatic `VERDICT: FAIL`.

For wave `N` (1, 2, or 3), in the wave worktree/branch:

## 1. Read the contract

1. Read `AGENTS.md` and `docs/prompts/SPEC.md` in full.
2. Read the programmer's report `docs/reports/wave-N.md`.

## 2. Run gates

1. Run `make check` — MUST exit 0 (`bun run check` + `bun test`).
2. Run the wave acceptance script(s):
   - Wave 1: `bash scripts/accept/wave-1.sh` — MUST exit 0.
   - Wave 2: `bash scripts/accept/wave-2.sh` — MUST exit 0.
   - Wave 3 / final: `make accept` (all three scripts) — MUST exit 0.
   - Or targeted: `make accept WAVE=N`.
3. Record exact commands + exit codes in your verification report.

## 3. Stub / shortcut scan (zero-stubs enforcement)

Scan `src/` AND `test/` for ALL of the following. ANY hit is `VERDICT: FAIL`
unless the hit is inside a comment explicitly quoting the forbidden pattern as
documentation (which itself must be justified in your report):

- `TODO` (including `// TODO`, `TODO: implement later`)
- `|| true`, `set +e`, `cmd: "true"`, `echo "passed"`
- `test.skip`, `describe.skip`, `it.skip`, `xit(`, `xdescribe(`
- Hardcoded vacuous passes: `return true;` with no logic, empty function bodies
- Swallowed errors: empty `catch {}` / `catch (e) {}` blocks
- Unwired modules: any `src/**/*.ts` export not imported (directly or via
  re-export) from `src/index.ts` (Wave 3 onward; Waves 1–2 note as pending)

## 4. KV-cache invariants check (every wave from Wave 2 onward; spot-check in Wave 1)

1. Confirm `injectContextBudgetIntoMessages` (or its absence pre-Wave-2) never
   mutates `event.system` — run `test/context-budget.test.ts` and confirm green.
2. Confirm dynamic context lands strictly on the last `role === "user"` message.
3. Confirm episodic lesson tags carry NO floating-point `relevance=` scores and
   NO timestamps; lessons sorted by `a.id.localeCompare(b.id)`.

## 5. Scope refusal check

1. Confirm NO WebUI, HTTP server/`listen(`, multi-agent DAG scheduler, git
   worktree manager, or epistemic research engine code exists in `src/`,
   `scripts/`, or `test/`.
2. Confirm `getRecommendedMcpConfig()` (Wave 3) returns ONLY the
   `lsp-mcp-server` (`bunx lsp-mcp-server`) and `fallow-mcp`
   (`npx --yes --package fallow fallow-mcp`) blocks — no extra servers.

## 6. Independent sabotage test

1. Perform your OWN sabotage test (distinct from QA's): break one guard rule or
   one core invariant (e.g. allow `qa-adversary` to edit `src/index.ts`, or
   mutate `event.system` in the context hook), confirm `bun test` exits
   NON-ZERO, then restore cleanly with `git checkout -- <file>`.
2. Confirm `git status` is clean afterward.
3. Log sabotage commands + exit codes in your report.

## 7. Write the verdict

Write `docs/reports/wave-N-verification.md` containing:

- Commands run + exit codes
- Stub scan results (patterns grepped + hits, or "zero hits")
- KV-cache invariant results
- Scope refusal result
- Independent sabotage test log + restore confirmation
- Ending with EXACTLY one of (final line, verbatim):
  - `VERDICT: PASS`
  - `VERDICT: FAIL`

No wave merges to `main` on `VERDICT: FAIL`. No Wave N+1 starts until Wave N
has `VERDICT: PASS` and is merged with `git merge --no-ff`.
