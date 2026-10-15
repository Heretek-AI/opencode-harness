# Wave 3 Verification Report — Unified OpenCode v2 Plugin Entrypoint

- **Role:** `agency-drift-guard` (auditor; changed NO code — see §6 for method note)
- **Stage:** Wave 3 final (`wave-3-plugin-entry`), worktree `worktrees/wave-3`
- **Contract read in full:** `AGENTS.md` (§§1–9), `docs/prompts/SPEC.md` (§§1, 2.1–2.5),
  `docs/reports/wave-3.md` (programmer report), `docs/prompts/verify-stage.md` (checklist)
- **Date:** 2026-10-15

## 1. Gates — commands + exit codes

| Command | Exit | Result |
|---|---|---|
| `make check` (`bun run check` + `bun test`) | 0 | `tsc --noEmit` clean; **161 pass, 0 fail, 543 expect() calls** across 8 files |
| `make accept` (wave-1.sh && wave-2.sh && wave-3.sh) | 0 | `WAVE 1 ACCEPT: ALL GATES GREEN` (62-pass subset + export/scope gates); `WAVE 2 ACCEPT: ALL GATES GREEN` (KV/DOM invariant gates); `WAVE 3 ACCEPT: ALL GATES GREEN` (typecheck, full suite, wave-1/2 regressions, zero-stub scan, 18 SPEC-2.5 export checks, 8 wiring checks, plugin coverage, MCP exactness, scope-refusal) |
| `git status --short` (after audit) | 0 | Only pre-existing staged QA entry `A docs/evidence/wave-3/red-proofs.log`; no auditor modifications |
| `git diff --stat` | 0 | Empty — zero uncommitted src/test modifications |

## 2. Stub / shortcut scan (zero-stubs enforcement, `src/` AND `test/`)

| Pattern | `src/` | `test/` | Disposition |
|---|---|---|---|
| `TODO` | zero hits | zero hits | clean |
| `\|\| true` | zero hits | zero hits | clean |
| `test.skip` / `describe.skip` / `it.skip` / `set +e` / `cmd: "true"` / `echo "passed"` | zero hits | zero hits | clean |
| `return true;` | 9 hits, all in `src/guards/shell-parse.ts` (lines 74, 79, 82, 85, 88, 177, 180, 185, 188) | zero hits | **legitimate, NOT vacuous** — each sits inside a boolean predicate (`segmentIsDestructive` / `segmentIsWrite`) guarded by real logic (flag parsing, `rm` target analysis, `git reset --hard` / `push --force` / `mkfs` / `dd` regexes, redirection/`tee`/verb/set checks). These are classifier verdicts with logic, not hardcoded passes |
| Empty `catch {}` / `catch (e) {}` | zero hits | zero hits | clean |
| Unwired modules | — | — | clean: all 8 module paths (`editors/hashline-tools`, `editors/ast-codemod`, `guards/shell-parse`, `guards/permission-guard`, `guards/circuit-breaker`, `context/context-budget`, `ui-auditor/dom-auditor`, `ui-auditor/mcp-defaults`) imported AND re-exported from `src/index.ts` (7× `export *` + named `getRecommendedMcpConfig` re-export) |

Accept-script zero-stub scans green for all 3 waves independently.

## 3. KV-cache invariants (SPEC §2.4 A)

- `injectContextBudgetIntoMessages` (`src/context/context-budget.ts:328`): never assigns to
  `event.system`; mutates ONLY the last `role === "user"` message (reverse scan, `:353`);
  throws fail-closed on empty/missing messages or no user message (`:345`, `:358`) — never falls
  back to `system`. Empty pack is a strict no-op (`:342`).
- Dynamic context wrapped in `<opencode-harness-context>` appended to trailing user message only.
- Episodic lessons sorted by `a.id.localeCompare(b.id)` (two sites, `:187` and `:295`); tag shape
  `` `<episodic-repository-memory id="${id}">\n- (${trigger}): ${lesson}\n</episodic-repository-memory>` ``
  (`:229`) — ZERO floating-point `relevance=` scores, ZERO timestamps.
- `test/context-budget.test.ts` green inside the 161-pass suite; Wave 2 accept script confirms
  `event.system`, `role === "user"`, `localeCompare` invariant coverage.

## 4. Scope refusal + SPEC §2.5 entrypoint checks

- Forbidden-code grep (`listen\(`, `http.createServer`, `express`, `WebUI`, `DAG`, `scheduler`,
  `worktree`, `literature`) over `src/`: only benign hits are the out-of-scope disclaimer comment in
  `src/ui-auditor/mcp-defaults.ts:8` and legitimate `RegExp.exec` calls in `ast-codemod.ts` — NO
  WebUI, HTTP server, scheduler, worktree manager, or research-engine code. Scope-refusal scans in
  all 3 accept scripts green.
- `src/index.ts` verified by reading in full (671 lines): `activate(context)` takes exactly one
  parameter; `createHarnessPlugin(options?)` fail-closed via `resolveHarnessOptions`; registers
  exactly the 5 tools (`file_hash_read`, `file_hash_edit`, `ast_structural_search`,
  `ast_structural_rewrite`, `ui_geometry_audit`) + 3 hooks (`permission.hook("evaluate")` →
  `evaluateBoardGuard`; `tool.execute.after` → `recordAndEvaluateCircuitBreaker`;
  `session.hook("context")` → `registerContextBudgetHook`); no `any` (zod `ZodType` schemas).
- `getRecommendedMcpConfig()` independently executed: returns EXACTLY
  `lsp-mcp-server` (`bunx` + `["lsp-mcp-server"]`) and `fallow-mcp`
  (`npx` + `["--yes", "--package", "fallow", "fallow-mcp"]`) — no extra servers; fresh object per
  call (mutation-safe). Exit 0.
- Programmer deliverables present: `test/plugin.test.ts` (61 tests), executable
  `scripts/accept/wave-3.sh`, `README.md`, `docs/reports/wave-3.md`.

## 5. QA red-proof review

`docs/evidence/wave-3/red-proofs.log` reviewed: QA sabotage A (phantom tool name in `src/index.ts` →
`bun test` exit 1, 10 fail) and B (`computeLineHash` constant `"0000"` → exit 1, 3 fail), each
restored via `git checkout --` with clean `git status` and green re-verification. Both are genuine
fail-closed proofs, distinct from each other.

## 6. Independent sabotage test (drift-guard, distinct from QA A/B)

Target: SPEC §2.3 C **Rule 3 (QA Red-Team Source Lock)** — neither QA proof touched the guard rules.

- Method note: this session's permission system denied the auditor's direct repo `edit`
  (`permission.rejected` on `src/guards/permission-guard.ts`) — itself a live demonstration of
  SPEC Rule 2 leadership read-only separation (`agency-drift-guard` is read-only). The sabotage was
  therefore executed against an isolated `/tmp/opencode/drift-sabotage/` copy of the guard module
  (repo files NEVER mutated — `git diff` empty, §1). `/tmp` scratch use is audit evidence, not a
  deliverable change.
- LIVE (intact repo module): `evaluateBoardGuard({ role: "qa-adversary", tool: "edit",
  path: "src/index.ts" })` → `{"allowed":false,"rule":"rule-3-qa-source-lock"}` — exit 0.
- SABOTAGED (copy with `if (QA_RED_TEAM_ROLES.has(role) && …)` forced to `if (false)`, line 234):
  same request → `{"allowed":true,"reason":"guard: allowed (no rule denied the request)"}` — the
  suite's deny assertion FAILS, `bun -e` exit **1** (fail-closed confirmed).
- Depth note: a narrower sabotage (disabling only the `src/`-prefix branch) still denied via the
  `QA_WRITABLE_GLOBS` fallback under the same rule id — defense in depth, not a silent pass.
- Restore: not required — repo was never modified; `git status` shows only the pre-existing staged
  QA evidence file; `git diff --stat` empty.

## 7. Findings

No findings. Zero stubs, all gates green, KV invariants hold, scope clean, MCP config exact,
entrypoint wiring complete, QA red-proofs valid, independent sabotage proves fail-closed.

VERDICT: PASS
