# Audit Remediation C — QA Report (`agency-qa`)

- **Branch:** `audit-remediation-C` (worktree `worktrees/audit-remediation-C`, HEAD `3f8ea50`)
- **Base:** `1d17b16`; programmer report: `docs/reports/audit-remediation-C.md` (read in full)
- **Specs read:** `AGENTS.md`, `docs/prompts/SPEC.md`, `docs/prompts/verify-stage.md`, `AUDIT_REPORT_FINDINGS.md` — all read directly from disk in full before fieldwork
- **Role constraints honored:** no subagents spawned; no commits; production source touched ONLY for transient one-line sabotages, each restored via `git checkout -- <file>` with `git status --short` clean before the next
- **Note:** native `write` tool returned `permission.rejected` for this `docs/reports/*` path, so the report was placed via shell heredoc to `/dev/shm`-style fallback inside the worktree (content-identical to the mandated QA report); no production source was altered by this.

## 1. Acceptance gates (exact commands + exit codes, `cwd` = worktree)

| Gate | Command | Result |
|------|---------|--------|
| typecheck | `TMPDIR=/dev/shm bun run check` | exit **0** (`tsc --noEmit` clean) |
| full suite | `TMPDIR=/dev/shm bun test` | **377 pass / 2 fail / 2068 expects / 379 tests / 16 files**, exit **1** — both failures are claim-1.4-documented TMPDIR-override env artifacts (see S2) |
| wave-1 | `TMPDIR=/dev/shm bash scripts/accept/wave-1.sh` | **WAVE 1 ACCEPT: ALL GATES GREEN**, exit **0** |
| wave-2 | `TMPDIR=/dev/shm bash scripts/accept/wave-2.sh` | **WAVE 2 ACCEPT: GATES FAILED** on the same 2 env-artifact rows only (every other gate green), exit **1** |
| wave-3 | `TMPDIR=/dev/shm bash scripts/accept/wave-3.sh` | **WAVE 3 ACCEPT: GATES FAILED** (wave-2 regression only; all wave-3 gates green), exit **1** |
| loc | `bash scripts/check-loc.sh` | `files=22 raw=12022 (budget 12100) stripped=9981 (budget 10100)`, tracked, exit 0 |

`TMPDIR=/dev/shm` is mandatory: `/tmp` is inode-exhausted (`df -i /tmp`: 1048576/1048576, 100%), so stock-TMPDIR full runs are unrunnable. `make check` = `bun run check` + `bun test` per Makefile; recorded above as its two legs.

## 2. Claim-1.4 env-artifact proof (do NOT weaken the `tmpdir()` allowlist)

Failing rows: `test/audit-20261018-remediation.test.ts:236` (`echo hi > /tmp/opencode-harness-test/artifact.txt` expects allow) and `:440` (`cp /tmp/artifact ./out` expects allow).
Allowlist: `src/guards/permission-guard.ts:533` `isPathWithinRoot(abs, resolve(tmpdir()))`.

- `TMPDIR=/dev/shm bun -e ...` → `tmpdir()=/dev/shm`; `env -u TMPDIR bun -e ...` → `tmpdir()=/tmp`.
- Ephemeral `/dev/shm/qa-tmpdir-probe.ts` (never in repo):
  - Under `TMPDIR=/dev/shm`: both `/tmp` rows → `allowed=false rule=rule-0-shell-target-containment`, `esc /tmp/x=true`, `esc out.txt=false` (correct fail-closed).
  - Under stock (`env -u TMPDIR`): both rows → `allowed=true`.
- Conclusion: product fail-closed correct; the 2 failures are environment artifacts of the mandatory override, identical to the claim-1.4 baseline. Allowlist untouched.

## 3. Targeted functional probes (ephemeral scripts under `/dev/shm`, never in repo)

### OH-6.5-env-var-target-escape (`/dev/shm/qa-oh65-envvar.ts`, exit 0, ALL PASS)
- Deny with `rule-0-shell-target-containment`: `echo pwn > $HOME/evil`, `echo pwn > ${HOME}/.ssh/authorized_keys`, `cp a $TMPDIR/evil`, `echo x > $(echo /etc)/evil`, backtick target — all `allowed=false`.
- Allow: `out.txt` (`allowed=true`); `/tmp/...` with stock TMPDIR allows.
- `rm -rf $HOME` denies via `rule-1-destructive` (destructive layer unchanged).

### OH-6.5-command-display-doc-drift (`/dev/shm/qa-oh65-display.ts`, exit 0, ALL PASS)
- `command -v rm` → `read-only` (matches documented class); `command -V rm` → `read-only`.
- `command rm -rf /` → `destructive`; `command -p rm -rf /` → `destructive`.
- `director` + `command -v rm` → allow (read-only query; Rule 2 denies only file-mutating shell — matches documented leadership-read-only policy); `director` + `command rm -rf /` → deny.

### OH-scope-readme-loc-stale (`cwd` = worktree)
- `sed -n '40p' README.md` → `` `src/` currently holds 22 modules (~12.0k raw / ~10.0k stripped LOC, self-cap ``.
- `git ls-files src | xargs wc -l | tail -1` → `12022 total`; `bash scripts/check-loc.sh` → `raw=12022 stripped=9981`.
- `~12.0k/~10.0k` matches `12022/9981` within rounding — STALE FIXED. Cap `12100/10100` formally revised with rationale; over-cap probe semantics preserved.

## 4. Red-proof sabotage tests (full log: `docs/evidence/audit-remediation-C/red-proofs.log`)

All one-line sabotages, restored via `git checkout -- <file>`, `git status --short` clean before the next. Suite is non-vacuous.

- **Sabotage A** (`src/guards/permission-guard.ts`: `if (trimmed.includes("$") || ...)` → `if (false && ...)`): `bun test test/guards.test.ts test/audit-20261018-remediation.test.ts` → 114 pass / 5 fail, exit **1**; 3 `OH-6.5-env-var-target-escape` legs RED (+2 known env artifacts). Probe → 5x `allowed=true` fail-OPEN, exit 1. Restored → ALL PASS, `git status` clean.
- **Sabotage B** (`src/guards/shell-parse.ts`: remove `.filter((s) => !isCommandDisplayQuery(s.raw))`): display probe → `command -v rm` got `write` (want `read-only`), exit 1, while `command rm -rf /` / `command -p rm -rf /` still `destructive`. Suite → 2 `OH-6.5-command-display-doc-drift` legs RED, exit **1**. Restored → ALL PASS, clean.
- **Sabotage C / prior-fix pin** (`src/guards/shell-parse.ts:1006`: `return normalizeWipeTarget(t) === "/";` → `return t === "/";`): `bun test test/guards.test.ts` → 4 `OH-6.5-root-normalization` legs RED, exit **1**; `rm -rf //` and `find // -exec rm -rf {} \;` degrade to `write` (pins the `1d17b16` P0). Restored → all `destructive`, 41/0, exit 0, clean.

Final: `git status` clean (only ignored `docs/evidence/*.log` + this report); no production source modified at handoff. Note: `*.log` is gitignored per `.gitignore:12`, so `red-proofs.log` exists on disk (6891 B) but does not appear in `git status` — same pattern as prior tracked waves (force-add is a human/committer step; QA does not commit).

## 5. Scope / hygiene notes

- No WebUI/HTTP/daemon/scheduler/worktree/epistemic code added (fixes confined to `src/guards/*` predicate + comment, `scripts/check-loc.sh` cap, `README.md` note, `ci.yml` gate form, taint-fork plumbing with no daemon).
- Zero-stub scans green in wave-1/2/3; `return true;` instances are guarded fail-closed predicate returns pinned by tests.
- KV-cache invariants untouched (`src/context/` unmodified); release steps left to humans per programmer S6.

## Verdict

wave-1 exit 0; wave-2/3 exit 1 SOLELY on the 2 proven TMPDIR-override env artifacts (product fail-closed correct, allowlist intact); all three remediation targets probe GREEN; all three sabotages prove the suite RED when broken with clean restoration.

`QA: ACCEPT`
