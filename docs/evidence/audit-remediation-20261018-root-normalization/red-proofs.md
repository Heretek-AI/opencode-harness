# QA Red-Proof Evidence Log — OH-6.5-root-normalization (P0) + OH-6.5-embedded-placeholder (P1)

- Branch: `fix/oh-6-5-root-normalization-embedded-placeholder`
- Worktree: `/home/john/Projects/Heretek-AI-Rebuild/opencode-harness/worktrees/audit-remediation`
- QA date (UTC): 2026-10-18
- Base commit: `551e5fe` (Audit remediation 20261018, 1.0.11)
- Full-context reads completed: AGENTS.md, SPEC.md, AUDIT_REPORT_FINDINGS.md
  (§OH-6.5-root-normalization lines 77-139 + §OH-6.5-embedded-placeholder
  lines 141-172, verbatim), programmer's report
  `docs/reports/audit-remediation-20261018-root-normalization.md`,
  `src/guards/shell-parse.ts`, `test/guards.test.ts`, `docs/prompts/verify-stage.md`.

## 1. Acceptance gates (exact commands + exit codes, from inside the worktree)

| # | Command | Exit | Result |
|---|---------|------|--------|
| 1 | `bun run check` (tsc --noEmit) | 0 | PASS |
| 2 | `bun test test/guards.test.ts` (stock TMPDIR) | 0 | PASS — 41 pass, 0 fail, 497 expects (was 32 tests; +9 new) |
| 3 | `bun test` (stock TMPDIR) | 1 | FAIL *solely* on host `/tmp` inode-exhaustion (ENOSPC on `mkdtemp /tmp/*`); 302 pass / 65 fail, every failure is `ENOSPC: no space left on device, mkdtemp '/tmp/…'` — no assertion failure. Documented host condition, matches audit baseline. |
| 4 | `TMPDIR=/dev/shm/qa-tmp bun test` (override, override dir pre-created) | 1 | 365 pass / 2 fail. Both failures are the audit-documented TMPDIR-flip pair (`OH-6.5-redirect-escape` OS-temp allow + `OH-6.5-cp-mv-argv-targets` absolute-source allow) which pass with stock TMPDIR. |
| 5 | `TMPDIR=/dev/shm/qa-tmp bash scripts/accept/wave-1.sh` | 0 | PASS — `WAVE 1 ACCEPT: ALL GATES GREEN` (84 tests, zero-stub/scope scans clean) |
| 6 | `TMPDIR=/dev/shm/qa-tmp make accept WAVE=1` | 0 | PASS — `WAVE 1 ACCEPT: ALL GATES GREEN` |

Pre-existing proof for the 2 TMPDIR-flip failures (git stash A/B):
- `git stash push -- src/guards/shell-parse.ts test/guards.test.ts` (pristine tree) +
  `TMPDIR=/dev/shm/qa-tmp bun test` → 356 pass / **2 fail** (same 2 tests), exit 1.
- `git stash pop` → programmer changes restored (`M src/guards/shell-parse.ts`,
  `M test/guards.test.ts`).
- Conclusion: the 2 failures are environmental (documented `/tmp` ENOSPC workaround
  flips the `tmpdir()` allowlist at `permission-guard.ts:522`), NOT regressions.
  Matches the audit's own note ("both pass with stock TMPDIR") and the programmer's
  report stash A/B.

## 2. Independent probe matrix (public guard API, no code change)

Probe driver: `bun -e` importing `classifyShellCommand` /
`isDestructiveShellCommand` (`src/guards/shell-parse.ts`), `evaluateBoardGuard`
+ `defaultGuardConfig` (`src/guards/permission-guard.ts`), `evaluateTaintGuard`
+ `recordUntrustedContentTaint` + `clearTaintState` (`src/guards/taint-guard.ts`).
Roles probed per row: builder, architect, director, qa-adversary, agency-qa
(+ tainted-session layer per row). Exit 0, `PROBE-MATRIX: ALL EXPECTED`.

ATTACK rows — every one: `class=destructive`, `destr=true`,
`DENY:rule-1-destructive` for all 5 roles, `taint=DENY:TAINT-DESTRUCTIVE-1`:
- `rm -rf //`, `rm -rf ///`, `rm -rf /.`, `rm -rf /./`, `rm -rf /../`,
  `rm -rf /tmp/../`, `rm -rf ~root`, `rm -rf ~root/.ssh`
- `find // -exec rm -rf {} \;`, `find /./ -exec rm -rf {} \;`,
  `find /tmp/../ -exec rm -rf {} \;`, `find .. -exec rm -rf {} \;`,
  `find ~root -exec rm -rf {} \;`
- `find // -delete`, `find /tmp/../ -delete`, `find .. -delete`
- `find / -exec rm -rf {}/foo \;`, `find / -exec rm -rf {}foo \;`,
  `find / -exec rm -rf prefix{} \;`, `find / -exec rm -rf -- {}/foo \;`
- `find / -ok rm -rf {}/foo \;`, `find / -ok rm -rf {}foo \;`,
  `find / -ok rm -rf prefix{} \;`

CONTROL rows — every one: `class=write`, builder `ALLOW` (no over-blocking):
- `rm -rf /tmp`, `rm -rf /tmp/wave1-abcd`, `rm -rf /var/tmp/app`
- `find /tmp -name x -exec rm -rf {} \;`,
  `find /tmp -name x -exec rm -rf {}/foo \;`,
  `find . -exec rm -rf {} \;`, `find . -exec rm -rf {}/foo \;`,
  `find . -name x -exec rm -rf {}/foo \;`, `find /tmp -name x -delete`

## 3. Red-proof sabotage log (distinct per invariant)

Restore method note: the mandated `git checkout -- <file>` would destroy the
programmer's uncommitted remediation (the file carries the fix under test), so
each sabotage was applied as a minimal `edit` on top of the remediated file and
reverted with the exact inverse `edit`; restoration is proven by byte-identical
sha256 vs the pre-sabotage hash plus `git status`/`git diff --stat` showing only
the intended programmer modifications. Pre-sabotage hashes:
`shell-parse.ts = 958708d5a426e47fa012e0c64070afb3078cc399038c376c330e0e82dd5c7c26`,
`guards.test.ts = c3e877e58c692905d1f0a55dec49f7d8885eccc2d29fd34f79be1269bac49e48`.

- Sabotage A (OH-6.5-embedded-placeholder invariant):
  file:line `src/guards/shell-parse.ts:905`,
  before `if (a.includes("{}")) {` → after `if (a === "{}") {`.
  Suite: `bun test test/guards.test.ts` → **38 pass / 3 fail, EXIT 1** (RED —
  the 3 embedded-`{}` guard tests fail, incl. the taint-layer test).
  Reverted via inverse edit; post-restore sha256 `958708d5…` identical;
  `bun test test/guards.test.ts` → 41 pass / 0 fail, EXIT 0 (GREEN).
- Sabotage B (OH-6.5-root-normalization invariant):
  file:line `src/guards/shell-parse.ts:981` (`normalizeWipeTarget`),
  before `return posix.normalize(s.replace(…).replace(/\/+/g, "/"));`
  → after `return s.replace(…).replace(/\/+/g, "/");`
  (slash-collapse only, no `..`/root resolution — exact-match-only behavior).
  Suite: `bun test test/guards.test.ts` → **38 pass / 3 fail, EXIT 1** (RED —
  the 3 root-normalization guard tests fail, incl. the taint-layer test).
  Reverted via inverse edit; post-restore sha256 `958708d5…` identical;
  `bun test test/guards.test.ts` → 41 pass / 0 fail, EXIT 0 (GREEN).

Both checks are non-vacuous: each breaks RED under targeted sabotage and returns
GREEN on restoration. `git status --short` after each restore shows only:
`M src/guards/shell-parse.ts`, `M test/guards.test.ts`,
`?? docs/reports/audit-remediation-20261018-root-normalization.md`
(+ this evidence file) — no sabotage residue in tracked production files.

## 4. Stub / shortcut scan (changed files)

- `grep -rnE 'TODO|\|\| true|set \+e|cmd: "true"|test\.skip|describe\.skip|it\.skip|catch *\(.*\) *\{\}' src/guards/shell-parse.ts test/guards.test.ts` → zero hits (exit 1).
- `return true` occurrences audited: all are genuine guard-predicate outcomes
  (destructive/write/allow decisions with surrounding logic), none vacuous.
- Wave-1 accept zero-stub scan (covers all of `src/` + `test/`) → clean (gate 5 above).
- No `|| true`, `set +e`, `cmd: "true"`, `test.skip`, empty catch, dummy passes.

## 5. Scope compliance

- No WebUI/HTTP-server/fleet/DAG/worktree/research-engine code in the changed
  files. The only grep hits for scope terms are `scripts/accept/wave-1.sh`'s own
  scope-refusal gate (comments + its grep pattern), which passes green.
- Single-session in-process OpenCode v2 plugin shape preserved; no new
  dependencies (fix uses stdlib `node:path` only).
- Net `src/` delta stays under the OH-scope-loc-budget hard caps per the
  programmer's report (raw 11981 ≤ 12000, stripped 9975 ≤ 10000; cap test green
  under the TMPDIR override run).

## QA verdict

All verify-the-fix criteria from AUDIT_REPORT_FINDINGS.md hold: every Raw-output
probe row now classifies `destructive` + denies `rule-1-destructive` for
builder/architect/director/qa (+ agency-qa) and `TAINT-DESTRUCTIVE-1` while
tainted; all scoped controls stay `write`/ALLOW; gates green (modulo the proven
pre-existing TMPDIR-flip pair); both sabotages RED then restore byte-identical;
zero stubs; scope clean.

QA ACCEPT
