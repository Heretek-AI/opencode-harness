# QA Red-Proof Re-verification — rework cycle 1 (2026-10-18 UTC)

**Role:** agency-qa. **Base:** commit `e8acb05` (remediation COMMITTED; `git checkout -- <file>` restores the fix).
**Scope:** re-applied `src/guards/permission-guard.ts` (OH-6.3-qa-shell-bypass, OH-6.4-contract-shell-bypass,
OH-6.4-task-owned-shell-bypass, OH-6.3-src-prefix-untested, OH-8.3-staff-roles).
Tracked companion to the gitignored `red-proofs.log` (which carries the same entries).

## A. Full gates (intact re-applied file)

| Command | Result |
|---|---|
| `bun run check` | EXIT 0 (tsc --noEmit; prior TS2305 resolved) |
| `bun test` | 292 pass, 0 fail, 1252 expects, 15 files — EXIT 0 |
| `make check` | EXIT 0 |
| `make accept` (waves 1–7) | ALL GATES GREEN — EXIT 0 |
| `bash scripts/accept/wave-8.sh` | all audit-remediation gates passed — EXIT 0 |

## B. Per-vector probes (bun probe scripts, EXIT 0)

- **OH-6.3-qa-shell-bypass:** `qa-adversary`+bash `echo evil > src/evil.ts` → `allowed=false`, `rule-3-qa-source-lock` — **PASS**
- **OH-6.4-contract-shell-bypass:** `programmer`+bash `echo x > contracts/v1.json` → `allowed=false`, `rule-4-contract-lock`; `architect`+same → allowed — **PASS**
- **OH-6.4-task-owned-shell-bypass** (owned globs passed as the config arg): `worker` shell outside `src/a/**` → `allowed=false`, `rule-5-task-owned-paths`; inside → allowed; `programmer` outside → denied `rule-5`; inside → allowed; `programmer` edit outside → denied `rule-5` — **PASS**
- **OH-6.3-src-prefix:** `qa-adversary`+edit `src/a.test.ts` → `allowed=false`, `rule-3a-qa-src-lock` (distinct from `rule-3b-qa-allowlist`) — **PASS**
- **OH-8.3 staff-backend:** `staff-backend`+edit `src/x.ts` → allowed — **PASS**

## C. Red-proof sabotage (2 vectors in `src/guards/permission-guard.ts`)

- **R1 (Rule 3 shell leg weakened):** line 556 `!== "read-only"` → `=== "destructive"`.
  `bun test test/guards.test.ts` → **31 pass, 1 fail, EXIT 1 (RED as required)** —
  `(fail) … denies file-mutating shell for QA roles (OH-6.3-qa-shell-bypass)`.
  Restored via `git checkout -- src/guards/permission-guard.ts`.
- **R2 (staff role renamed):** `"staff-backend",` → `"staff-backend-x",`.
  `bun test test/guards.test.ts` → **31 pass, 1 fail, EXIT 1 (RED as required)** —
  `(fail) … staff-backend and staff-ui follow the builder policy`.
  Restored via `git checkout -- src/guards/permission-guard.ts`.

## D. Post-restore state

- `bun test` → 292 pass, 0 fail, 1252 expects — EXIT 0 (green).
- `git status --short` → only `?? AUDIT_REPORT_FINDINGS.md` (no modified files; no sabotage residue).
- Line 556 verified restored to `if (classifyShellCommand(command).class !== "read-only") {`.

## Verdict

**ACCEPT** — all gates green, all 5 re-applied vectors PASS with correct rule ids, both red-proofs go RED under sabotage and GREEN after restore, worktree clean.
