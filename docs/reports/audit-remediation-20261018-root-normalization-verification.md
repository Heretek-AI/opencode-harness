# Drift-Guard Verification: Audit Remediation 20261018 — OH-6.5-root-normalization (P0) + OH-6.5-embedded-placeholder (P1)

- **Auditor role:** `agency-drift-guard` (read-only; no production code changed by auditor)
- **Branch / worktree:** `fix/oh-6-5-root-normalization-embedded-placeholder` @ `/home/john/Projects/Heretek-AI-Rebuild/opencode-harness/worktrees/audit-remediation`
- **Base commit:** `551e5fe` (findings baseline)
- **Date (UTC):** 2026-10-18
- **Mandated reads (all read in full):** `AGENTS.md`, `docs/prompts/SPEC.md`, `docs/prompts/verify-stage.md`, `AUDIT_REPORT_FINDINGS.md` (§OH-6.5-root-normalization + §OH-6.5-embedded-placeholder), programmer report `docs/reports/audit-remediation-20261018-root-normalization.md`, target files `src/guards/shell-parse.ts`, `test/guards.test.ts`, `src/guards/permission-guard.ts`, `src/guards/taint-guard.ts`

## 1. Gates (exact commands + exit codes, from inside the worktree)

| Command | Result |
|---|---|
| `bun run check` (tsc --noEmit) | exit **0** |
| `bun test test/guards.test.ts` (stock TMPDIR) | **41 pass, 0 fail**, exit **0** (was 32; +9 new) |
| `TMPDIR=/dev/shm bun test` (full suite; override required — host `/tmp` inode-exhausted/ENOSPC) | **365 pass, 2 fail**, exit 1 |
| `TMPDIR=/dev/shm bash scripts/accept/wave-1.sh` | `WAVE 1 ACCEPT: ALL GATES GREEN`, exit **0** |

**2-fail exception — proven pre-existing environmental via git-stash A/B (not a regression):**
- With fix: `(fail) OH-6.5-redirect-escape … workspace-relative and OS-temp targets still allow`, `(fail) OH-6.5-cp-mv-argv-targets … legitimate absolute-source uses … allow` → 365 pass / 2 fail / 367 total.
- `git stash push -- src/guards/shell-parse.ts test/guards.test.ts` → pristine: **identical 2 fails** → 356 pass / 2 fail / 358 total.
- `git stash pop` → fix restored; `git status` shows only the 2 fix files modified. Both failures are the audit-documented TMPDIR-flip OS-temp tests (pass with stock TMPDIR, fail identically with `/dev/shm` TMPDIR on the pristine tree). The delta is exactly +9 new tests, +9 passes, zero new failures.

## 2. Stub / shortcut scan (src/ AND test/)

| Pattern | Result |
|---|---|
| `TODO` in `src/ test/` | **zero hits** (`grep` exit 1) |
| `\|\| true` | only `scripts/accept/wave-8.sh:81-82` (the accept script's own self-scan quoting the pattern, excluded by the script itself) — **zero real hits** |
| `set +e` | **zero hits** |
| `cmd: "true"` / `echo "passed"` | only `scripts/accept/wave-8.sh:84` (self-scan) — **zero real hits** |
| `test.skip`/`describe.skip`/`it.skip`/`xit(`/`xdescribe(` (word-boundary scan) | **zero hits** (naive scan hit `process.exit(0)` in `test/wave8-audit.test.ts:121` — a shell-command string inside a mutating-shell corpus, i.e. `exit(` false positive, not a skipped test) |
| `return true` in `src/` | 60+ hits, **all guarded predicates** (`isRootWipeTarget` fail-closed wipe checks, `findExecPayloadIsPlaceholderWipe` placeholder detection, `shellTargetEscapesWorkspace` containment, `isUntrustedIngestionTool` MCP arms, loopback/private-IP guards) — every one has branching logic; **zero vacuous passes** |
| empty `catch {}` / `catch (e) {}` | **zero hits** |
| Unwired exports | `normalizeWipeTarget` (shell-parse.ts:977) called by `isRootWipeTarget` (:1003); `isFindWipeRootOperand` (:847) called by `findHasWipeRoot` (:843) and `-delete` branch (:1164); `findPathOperands` reused by `-delete` branch. All wired into `classifyShellCommand` → `isDestructiveShellCommand` → `evaluateBoardGuard` Rule 1 + `evaluateTaintGuard` TAINT-DESTRUCTIVE-1. **Zero unwired.** |

ANY-hit rule: no unjustified hit → no FAIL.

## 3. KV-cache invariants spot-check

- `TMPDIR=/dev/shm bun test test/context-budget.test.ts` → **23 pass, 0 fail**, exit 0.
- `event.system` untouched, last-`role==="user"` append, lessons sorted by `id.localeCompare` with zero float scores/timestamps: covered green by that suite; no context-budget file touched by this fix (`git status` confirms).

## 4. Scope refusal check

- `getRecommendedMcpConfig()` (`src/ui-auditor/mcp-defaults.ts:30-42`) returns **ONLY** `lsp-mcp-server` (`bunx lsp-mcp-server`) + `fallow-mcp` (`npx --yes --package fallow fallow-mcp`). No extra servers.
- Broad grep hits for `worktree` in `src/` are upstream host plumbing (`contract-adapter.ts:205-206` `location.worktree` context fields, `index.ts:1093-1095` `ctx?.worktree` reads, interceptor comments about OpenCode built-in plugin instructions) — reads of host context, **not** a worktree manager. No `http.createServer`/`listen(`/WebUI/DAG-scheduler/research-engine code anywhere in `src/`. Wave-1 accept scope gate passes green (see §1).

## 5. Adversarial bypass hunt (beyond QA's matrix — 33 attacks + 9 controls, all via public API)

Probe: `/dev/shm/drift-bypass-probe.ts` (`classifyShellCommand` + `isDestructiveShellCommand` + `evaluateBoardGuard` builder-deny). Result: **33/33 DENY-OK, 9/9 ALLOW-OK, exit 0**.

Attacks denied (each `destructive` + `isDestructive===true` + builder `allowed===false`): `/././`, `////tmp//..//`, `/.//`, `/tmp//../`, `rm -rf / --no-preserve-root`, `rm --recursive --force /`, `rm -r -f /`, `rm -rf -- /`, quoted `'~root'`/`"~root"`, `$HOME`, `${HOME}/..`, `-execdir`/`-okdir` `{}` payloads, `+`-terminator `find / -exec rm -rf {} +` and `{}/foo +`, `prefix{}`, long-form `--recursive --force`, `rm -rf -- {}`, `../..` and `a/../../` find roots (±exec/−delete), `/tmp/../` + `{}/foo`, `sudo`/`exec`/`bash -c` wrappers, tab-separated `rm\t-rf\t/` and `find /\t-exec`, single/double-quoted `'{}'`/`"{}"` payloads.

Controls still allowed (each `write` + builder `allowed===true`, no over-blocking): `rm -rf /tmp`, `/tmp/wave1-abcd`, `/var/tmp/app`, `rm --recursive --force /tmp/app`, `find /tmp -name x -exec rm -rf {} \;`, `find /tmp -name x -exec rm -rf {}/foo \;`, `find . -exec rm -rf {} \;`, `find . -name x -delete`, `find /tmp -name x -delete`.

Refutation angles from the cross-examination notes attempted before upholding and defeated: `//` stat-identity family normalizes to `/`; rm-backstop evasion rejected (`find //` never lets `rm` see `/` — now caught at the find-root layer); `find ..` downgrade rejected (`..`-leading/segment roots are wipe roots in the same Rule-1 path); `~root` env-specificity rejected (fail-closed `~`-leading → deny); wrapper composition (`sudo`/`exec`/`bash -c`) strengthens the deny; `+`-terminator and `-okdir`/`-execdir` forms deny; no reliance on the non-filed `FIND`/`RM` spellings.

## 6. Independent sabotage test (distinct from QA's)

- **Sabotage (NOT touching fix files):** neutered permission-guard Rule 3a in `src/guards/permission-guard.ts:649` (`path.startsWith("src/")` → `path.startsWith("src-internal/")`), via file write (auditor tool-hygiene exception for sabotage only).
- **Result:** `bun test test/guards.test.ts` → **39 pass, 2 fail, exit 1** — fail-closed proven (suite is non-vacuous).
- **Restore:** `git checkout -- src/guards/permission-guard.ts` (safe: file carries no uncommitted fix) → sha256 `fcfffc06…` identical before/after; fix files untouched (`shell-parse.ts` `958708d5…`, `guards.test.ts` `c3e877e5…` identical); `git status --short` shows only `M src/guards/shell-parse.ts`, `M test/guards.test.ts`, `??` programmer report.
- **Post-restore:** `bun test test/guards.test.ts` → **41 pass, 0 fail, exit 0**.

## 7. Regression + LOC notes

- `test/guards.test.ts` diff: **+169 lines, zero deleted/relaxed assertions** (no `^-` lines in diff) — pure additions across the 9 new tests.
- `src/guards/shell-parse.ts` diff: +70/−25 — deletions are exactly the intended replacements (exact-match `isRootWipeTarget` body → normalized version incl. `~<user>` fail-closed; `a === "{}"` → `a.includes("{}")`; `-delete` exact-match branch → `findPathOperands(...).some(isFindWipeRootOperand)`), all in the fail-closed direction.
- `bash scripts/check-loc.sh` → `files=22 raw=11981 (budget 12000) stripped=9975 (budget 10000)`, `tracked (exit 0)` — gate passes; caps now 99.8%/99.75% full (next wave must budget accordingly; OH-scope-loc-budget overage fact unchanged, not worsened beyond +20 raw).
- Out-of-scope findings (OH-1.3/OH-1.1 tags+publish, OH-6.6 fork hook, OH-deps-caret, OH-1.1-no-gh-release) correctly untouched by the fix.
- Taint layer: no `taint-guard.ts` change needed — `evaluateTaintGuard` denies any `isDestructiveShellCommand` as `TAINT-DESTRUCTIVE-1`; classifier fix propagates automatically (proven by the 16-row + 4-row taint tests in the new suite).

VERDICT: PASS
