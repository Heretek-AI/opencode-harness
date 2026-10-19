# Drift-Guard Verification — Code-Scanning Remediation (`fix/code-scanning-13-alerts`)

- Role: `agency-drift-guard` (auditor only; NO production code changed — the single sabotage mutation below was applied via shell, confirmed red, and restored via `git checkout --`).
- Branch: `fix/code-scanning-13-alerts`, worktree `worktrees/code-scanning`. NOT merged.
- Contracts read in full: `AGENTS.md`, `docs/prompts/SPEC.md`, `docs/prompts/verify-stage.md`, programmer report `docs/reports/code-scanning-fix.md`, QA log `docs/evidence/code-scanning/red-proofs.log` (present on disk; gitignored `*.log` noted but readable for audit).

## 1. Gates (commands + exit codes)

| Command | Exit | Result |
|---|---|---|
| `make check` (`bun run check` tsc --noEmit + `bun test`: 398 pass, 0 fail, 2179 expects, 16 files) | 0 | PASS |
| `bash scripts/accept/run.sh` (waves 1–7, final `accept: 7 wave script(s) passed`, `WAVE 7 ACCEPT: ALL GATES GREEN`) | 0 | PASS |
| `bun test test/context-budget.test.ts` (spot-check) | 0 (23 pass) | PASS |

## 2. Stub / shortcut scan (`src/` + `test/`)

- `TODO|FIXME|test.skip|describe.skip|it.skip|xit(|xdescribe(|cmd: "true"|echo "passed"`: single hit `test/wave8-audit.test.ts:121` = the string `"node -e \"process.exit(0)\""` inside a mutating-shell test corpus asserting `classifyShellCommand(...) !== "read-only"` + director DENY. Test *data*, not a shortcut. Justified, not a stub.
- `|| true` in `src/ test/`: zero hits (exit 1). `set +e` in `scripts/accept/ src/`: zero hits.
- Empty `catch {}` / `catch (e) {}` in `src/ test/`: zero hits. `catch {` without body in hashline `isPathWithinRoot` returns `false` (fail-closed probe with logic) — not empty.
- `return true` hits (e.g. `src/editors/hashline-tools.ts:156` containment probe after `assertPathWithinRoot` try, all `src/guards/shell-parse.ts` classifier branches): every one sits inside a conditional/predicate with surrounding logic. Zero vacuous passes.
- Unwired exports: `src/index.ts` re-exports all modules (`editors`, `guards/*`, `context/*`, `ui-auditor/dom-auditor`, `diagnostics/*`, `transactions/edit-transaction`, `repomap/repomap`, `verify/*`, `muse/muse-calibration`, `host/contract-adapter`). No orphan `src/**` module found. (Code-scan wave touches many modules; all wired.)

## 3. Scope refusal

- Searched `src/ scripts/ test/` for WebUI / `http.createServer` / `app.listen` / `Server.listen` / multi-agent DAG / worktree manager / research engine: only hits are the refusal-doc comment in `src/ui-auditor/mcp-defaults.ts:8` and the accept scripts' own self-scan greps. Zero implementation hits.
- `getRecommendedMcpConfig` untouched by this wave; accept `scope refusal scan` gate green.
- Result: NO scope violation. PASS.

## 4. 13-alert verification (each fix confirmed present on disk)

| # | File:line | Alert class | Fix confirmed |
|---|---|---|---|
| 1–2 | `src/guards/permission-guard.ts:277` | js/incomplete-sanitization (HIGH) | `g` flag present: `/[.*+?^${}()|[\]\\]/g` |
| 3–10 (8) | `src/transactions/edit-transaction.ts` | js/file-system-race (HIGH, x8) | Zero `existsSync` references (grep exit 1); `statSync`/`readFileSync` in try/catch with `ENOENT` ⇒ fail-closed values (`:52`, `:75`, `:311`); import removed |
| 11 | `scripts/host-test/harness-host.upstream.ts:576,596,674-675` | js/insecure-temporary-file (HIGH) | `mkdtempSync(join(tmpdir(),"harness-probe-fmt-"))`, `writeFileSync(...,{mode:0o600})`, `finally` → `rmSync(fmtDir,{recursive:true,force:true})` |
| 12 | `src/muse/muse-calibration.ts:44-53` | js/polynomial-redos (HIGH) | No regex for tag span; `indexOf` open/close scan loop, `MAX_INNER_CHARS = 20000` cap |
| 13 | `src/diagnostics/diagnostics-runner.ts:373-381` | js/polynomial-redos (HIGH) | Per-line scan with `at `/`File "`/`-->` prefilter (`:378`), 500-char window (`:381`), bounded `([^"]{1,500}\.py)` + `\d{1,7}` (`:373`) |
| 14–17 (4: 10/11/12/13) | `src/diagnostics/import-verifier.ts:146-153,175-178,281,287` | js/polynomial-redos (HIGH x4) | 500 KB input cap (`:146-147`), `([\s\S]{0,2000}?)`, `(\.[^"']{1,500})`, manual `indexOf("{"/"}")` brace scan with 2000 cap, both `as`-splits bounded `[ \t]{1,100}as[ \t]{1,100}` (`:197`, `:287`), bounded export-list `\{([\s\S]{0,2000}?)\}` (`:281`) |
| 18–19 (15 + 14) | `src/repomap/repomap.ts:249-356` | js/polynomial-redos (HIGH x2) | `buildCodeOnlyMask` manual single-pass scan (no regex); per-line `if (line.length > 1000) continue` (`:356`); all 11 outline patterns bounded (`\s{0,100}`, `[ \t]{1,100}`, `[\w$]{0,100}`, `[^)]{0,200}`) |
| 20–21 (9 + 20) | `src/verify/architecture-advisor.ts:281-304` | js/polynomial-redos (HIGH x2) | `indexOf("catch")` → `mayBeCatch` prefilter (`:287`, gates only the two catch checks), hoisted bounded `/\bcatch[ \t]{0,100}(?:\([^)]{0,200}\))?[ \t]*\{[ \t]*\}/` + opener variant |
| reg | `test/guards.test.ts` | regression test | `matchesAnyGlob` escaping case present (fails when escaping dropped — proven by QA sabotage A-effective) |

All 13 alerts addressed; no signature changes (bodies/internals only + one added test). Parity evidence in programmer report accepted (manual mask divergence on adjacent mixed quotes is lexer-correct; outline counts match on all 7 files).

## 5. KV-cache invariants spot-check

- `test/context-budget.test.ts`: 23 pass, 0 fail. `event.system` untouched by `injectContextBudgetIntoMessages`; context lands on last `role === "user"`; no float scores/timestamps (sorted by `id.localeCompare`). PASS.

## 6. Independent sabotage test (distinct from QA's glob + import-verifier sabotages)

QA sabotaged `permission-guard.ts` (glob escape) and `import-verifier.ts` (`from` keyword). Mine targets a third invariant — the KV-cache `event.system` rule in `src/context/context-budget.ts:376`:

- Sabotage: inserted `(event as unknown as { system: unknown }).system = [{ text: "DRIFT-GUARD-SABOTAGE" }];` before the target-mutation line (via shell; `default.edit` correctly denied permission for this role).
- `bun test test/context-budget.test.ts` → EXIT 1 (22 pass, 1 fail: `leaves event.system bit-for-bit identical`).
- `bun test` (full) → EXIT 1 (393 pass, 5 fail).
- Restore: `git checkout -- src/context/context-budget.ts` → byte-identical to pre-sabotage backup (`diff -q` clean); `git status --short` → empty (clean); `git stash list` → empty.
- Post-restore `bun test` → EXIT 0 (398 pass, 0 fail, 2179 expects).

Fail-closed proven independently: any `event.system` mutation turns the suite red.

## 7. QA log review

QA's `red-proofs.log` is honest and complete: A-literal (`g`-flag removal, exit 0) and B-literal (unbounded quantifier, exit 0) correctly documented as vacuous/non-functional on their own, with effective variants (A: drop escaping → exit 1 on `test/guards.test.ts:170`; B: corrupt `from` → exit 1, 4 fail) proving gate coverage, all restored cleanly. No disagreement.

No merge performed (requires this verdict + coordinator action per AGENTS.md §6).

VERDICT: PASS
