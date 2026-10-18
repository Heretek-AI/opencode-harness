# audit-remediation-F — QA Verification Report

**Stage:** `audit-remediation-F` (follow-up to `AUDIT_REPORT_FINDINGS.md` @ `6d6a76b`)
**Branch:** `audit-remediation-F`
**Worktree:** `/home/john/Projects/Heretek-AI-Rebuild/opencode-harness/worktrees/audit-remediation-F`
**Programmer commit:** `f210bc1dadf1439548a3d4715d7fcd5ac7caca6d`
**QA role:** `agency-qa` (verify + red-proof only; no implementation, no commits)
**Date (UTC):** 2026-10-18

Mandatory reads completed IN FULL from disk before acting: `AGENTS.md`,
`docs/prompts/SPEC.md`, `MASTER_BUILD_PROMPT.md`, `AUDIT_REPORT_FINDINGS.md`
(423 lines), `docs/evidence/audit-remediation-F/stage-brief.md`,
`worktrees/audit-remediation-F/docs/reports/audit-remediation-F.md`.
No subagents spawned. No release operations performed.

## Summary

The programmer's F1 (P1 tilde containment one-liner) + F2 (P3 comment fix) +
F1 regression tests verify cleanly: typecheck exit 0, full suite
**397 pass / 0 fail** (baseline 393 + 4 new, zero new failures), waves 1–8 ALL
GREEN, LOC gates exit 0 (raw 12089 / stripped 10024, byte-identical to
baseline), build exit 0, F1 audit proof re-run denies all six
`~user/`/`~+`/`~-` shapes with `rule-0-shell-target-containment` while legit
relative/`/tmp`/`/dev/null` allows hold, F2 `rg` hits the corrected `plugin/`
path. Both red-proof sabotages went RED on demand and restored cleanly.

## Gates run (commands + exit codes + numbers, all in the worktree)

| Gate | Command | Result |
|------|---------|--------|
| Typecheck | `bun run check` | exit 0 (`tsc --noEmit` clean) |
| Full suite (stock TMPDIR, no override) | `bun test` | **397 pass / 0 fail**, 2173 expects, 16 files — exit 0. Matches programmer claim exactly (393 baseline + 4 new). No `git stash` baseline control needed (stock run green; `/tmp` healthy). |
| Targeted guards | `bun test test/guards.test.ts` | **41 pass / 0 fail** — exit 0 |
| New F1 block | `bun test test/audit-20261018-remediation.test.ts -t "tilde-user-target-escape"` | **4 pass / 0 fail**, 38 expects — exit 0 |
| F4 plumbing | `bun test test/audit-20261018-remediation.test.ts -t "taint-fork-gap"` | **12 pass / 0 fail** — exit 0 |
| Wave-1 accept | `bash scripts/accept/wave-1.sh` | `WAVE 1 ACCEPT: ALL GATES GREEN` — exit 0 |
| All waves | `make accept` | waves 1–7 ALL GREEN — exit 0 |
| Wave-8 accept | `bash scripts/accept/wave-8.sh` | `wave-8: all audit-remediation gates passed` (incl. full 397/0 re-run) — exit 0 |
| LOC tracking | `bash scripts/check-loc.sh` | `files=22 raw=12089 (budget 12100) stripped=10024 (budget 10100)`, tracked — exit 0 |
| LOC hard gate | `bash scripts/check-loc.sh --fail-over=12100 --fail-over-stripped=10100` | within-cap on both — exit 0 |
| Build | `bun run build` | exit 0 (`tsc -p tsconfig.build.json`) |
| F3 read-only (still-open proof) | `npm view … dist-tags.latest` / `git tag --list 'v*'` / `git rev-parse v1.0.11` / `git log --oneline v1.0.9..HEAD \| wc -l` | `1.0.9` / max `v1.0.9` / fatal exit 128 / **17** (16 at audit + 1 F commit — expected, honestly reported) |
| F6 deps | `bun audit` | `No vulnerabilities found (checked 40 packages)` — exit 0 |
| Untouched-files proof | `git diff -- package.json bun.lock src/version.ts scripts/check-loc.sh .github/workflows/ci.yml` | empty output — exit 0 |
| Version identity | `package.json:3` / `src/version.ts:5` | both `1.0.11` |
| Stub scans | `rg TODO src/ test/`; `rg test.skip\|describe.skip\|it.skip\|xdescribe\( src/ test/` | zero hits (exit 1 = no match) |

## Proof re-runs

F1 (verbatim audit shapes + `~-` variant + controls, via `evaluateBoardGuard`
with `defaultGuardConfig()` + `workspaceRoot: process.cwd()`):

```
"echo x > ~root/evil" allowed=false rule=rule-0-shell-target-containment
"echo x | tee ~root/evil" allowed=false rule=rule-0-shell-target-containment
"cp a.txt ~root/evil" allowed=false rule=rule-0-shell-target-containment
"mv a.txt ~other/evil" allowed=false rule=rule-0-shell-target-containment
"echo x > ~+/evil" allowed=false rule=rule-0-shell-target-containment
"echo x > ~-/evil" allowed=false rule=rule-0-shell-target-containment
"echo x > ~/evil" [control] allowed=false rule=rule-0-shell-target-containment
"echo x > ~" [control] allowed=false rule=rule-0-shell-target-containment
"echo hi > notes.txt" [allow] allowed=true rule=undefined
"echo hi > /tmp/x" [allow] allowed=true rule=undefined
"echo hi > /dev/null" [allow] allowed=true rule=undefined
```

F2:

```bash
rg 'plugin/system-prompt/meta.txt' src/muse/muse-calibration.ts
#  * three failure modes in OpenCode V2's default `packages/core/src/plugin/system-prompt/meta.txt`:
# exit 0, 1 hit (line 9)
```

## Red-proof sabotage (both restored immediately via `git checkout --`)

Full command-by-command log: `docs/evidence/audit-remediation-F/red-proofs.log`
(same directory as this report).

1. **Sabotage 1 (required, F1 predicate):** native `edit` reverted
   `src/guards/permission-guard.ts` to `if (trimmed === "~" ||
   trimmed.startsWith("~/"))` → `bun test
   test/audit-20261018-remediation.test.ts -t "tilde-user-target-escape"` →
   **RED 1 pass / 3 fail, exit 1** (all three non-control tests fail as the
   programmer predicted) → `git checkout -- src/guards/permission-guard.ts`
   → `git status --short` clean → re-green **4 pass / 0 fail, exit 0**.
2. **Sabotage 2 (QA choice, DIFFERENT file/invariant — `isMcpProvenanceEvent`
   in `src/guards/taint-guard.ts`):** native `edit` neutered one disjunct
   (`if (typeof h[key] === "string" && h[key] !== "") return true;` →
   `if (false && typeof h[key] === "string") return true;`) → `bun test
   test/audit-20261018-remediation.test.ts -t "taint-name-squat"` →
   **RED 2 pass / 2 fail, exit 1** (both marked-provenance expects fail) →
   `git checkout -- src/guards/taint-guard.ts` → `git status --short` clean →
   re-green **4 pass / 0 fail, exit 0** and full suite **397 pass / 0 fail,
   exit 0**.

Neither sabotage was vacuous: each flipped pinned tests RED and restored to
full green. The programmer's own self-proof (RED 1/3 on the pre-fix predicate)
is independently confirmed.

## Residuals / honesty notes

- F3 (P0/P1/P3 release identity): verified STILL OPEN as required
  (`latest` 1.0.9, max tag `v1.0.9`, no release ops performed — no `npm
  publish`/`npm version`/`git tag`/`git push`/`gh release create` in this
  session). The `v1.0.9..HEAD` count is 17 (16 at audit + 1 F commit).
- F4 (P2 fork-gap) / F5 (P3 name-squat): document-only per brief; plumbing and
  hardening verified intact and green (12 fork-matrix + 4 squat tests pass).
  QA did not file the pinned `allow` residuals as regressions.
- The documented `~foo` over-block pin is an intended fail-closed cost (same
  accepted direction as the single-quoted-`$` over-block), not a regression.

## Commit / handoff state (explicit)

**Do NOT commit these QA files — the programmer owns commits; these files are
left uncommitted for drift-guard review.** QA created exactly two new files
and modified nothing else:

```bash
git status --short   # in the worktree:
#  ?? docs/evidence/audit-remediation-F/
```

(i.e. only the untracked `docs/evidence/audit-remediation-F/` directory
containing `red-proofs.log` + this `audit-remediation-F-qa.md`; all `src/` /
`test/` / report paths are committed and clean — verified empty `git status`
after each sabotage restore and empty `git diff --` on all protected paths.)

## Verdict

**QA: ACCEPT**

Rationale: all acceptance gates exit 0 with exact expected numbers (397/0,
raw 12089 / stripped 10024); both audit verify-the-fix re-runs hold; both
red-proofs went RED on sabotage and restored to green with a clean tree; no
untouched-file, stub, scope, or release violations found.
