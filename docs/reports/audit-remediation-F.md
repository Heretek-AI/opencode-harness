# audit-remediation-F — Programmer Stage Report

**Stage:** `audit-remediation-F` (follow-up to `AUDIT_REPORT_FINDINGS.md`, baseline `6d6a76b`)
**Branch:** `audit-remediation-F`
**Worktree:** `/home/john/Projects/Heretek-AI-Rebuild/opencode-harness/worktrees/audit-remediation-F`
**Role:** `agency-programmer` (implementation + tests only; no release operations performed)

## Summary

Implemented the P1 code fix **OH-6.5-tilde-user-target-escape** (one-line
fail-closed widening of `shellTargetEscapesWorkspace`: `trimmed === "~" ||
startsWith("~/")` → `trimmed.startsWith("~")`) plus 4 non-vacuous regression
tests pinning all `~user/`/`~+`/`~-` deny shapes, `~`/`~/` deny, and legit
allows; and the P3 comment fix **OH-2.6-stale-metapath-comment** (insert
`plugin/` in the `meta.txt` path). Kept the `src/` LOC delta
net-zero-or-negative (1+/1- per touched `src/` file; `check-loc.sh` raw 12089 /
stripped 10024 byte-identical to baseline), left **F3** (P0/P1/P3 release
identity — prepare-only, verified still-open), **F4** (P2 taint-fork-gap —
document-only, plumbing verified intact), **F5** (P3 taint-name-squat —
document-only, hardening verified intact), and **F6** (P3 deps-caret — no-op,
verified clean) exactly per the stage brief. Full suite **397 pass / 0 fail**
(stock TMPDIR; baseline 393 + 4 new), waves 1–8 ALL GREEN, `bun run build`
exit 0, F1 new block self-proven RED on the pre-fix predicate (3 fail) and
green post-fix.

## Files changed

| File | Change |
|------|--------|
| `src/guards/permission-guard.ts` (F1) | `shellTargetEscapesWorkspace`: `if (trimmed === "~" \|\| trimmed.startsWith("~/"))` → `if (trimmed.startsWith("~"))` (exact audit diff, 1+/1-). Fail-closed widening: `~user/`/`~+`/`~-` shell targets now escape-deny `rule-0-shell-target-containment` for every role. Over-block cost is a literal workspace file named `~foo` (same accepted direction as the documented single-quoted-`$` over-block); mid-path `docs/~notes.txt` unaffected (only a leading `~` expands). |
| `src/muse/muse-calibration.ts` (F2) | Comment-only: `` `packages/core/src/system-prompt/meta.txt` `` → `` `packages/core/src/plugin/system-prompt/meta.txt` `` (exact audit diff, 1+/1-). Zero behavior change. |
| `test/audit-20261018-remediation.test.ts` (F1 tests) | New `describe` block `OH-6.5-tilde-user-target-escape (audit-remediation-F)`, 4 tests: (1) all six `~user/`/`~+`/`~-` write shapes deny `rule-0-shell-target-containment` for role `builder` tool `shell`; (2) `~` and `~/` still deny; (3) `shellTargetEscapesWorkspace` unit semantics (`~`/`~/`/`~root/`/`~other/`/`~+`/`~-`/`~foo` escape, `docs/~notes.txt` does not); (4) legit controls still allow (relative, mid-path tilde, `/tmp`, `/dev/null`) + `~foo` over-block pinned as documented fail-closed cost. Test-file-only addition; does not count toward the `src/` LOC cap. |
| `docs/reports/audit-remediation-F.md` | This report. |

NOT touched (per brief): `package.json`, `bun.lock`, `src/version.ts`,
`scripts/check-loc.sh`, `.github/workflows/ci.yml`, `src/interceptors/`,
`src/host/`, `src/guards/taint-guard.ts` (all proven untouched via
`git diff --` empty output on each listed path; `git status` shows only the
3 files above plus this report).

Invariants preserved: leadership read-only, QA src-lock, contract-lock, and
all FIXED priors (`$VAR`/backtick escapes, wipe roots, `find -exec {}` matrix,
display-query carve-out) hold — full suite 397/0 includes every prior pin.
Both touched `src/` exports stay wired into `src/index.ts`
(`export * from "./guards/permission-guard.js"`, `export * from
"./muse/muse-calibration.js"`).

## Gate outputs (all commands run in the worktree)

| Gate | Command | Result |
|------|---------|--------|
| Typecheck | `bun run check` | exit 0 (`tsc --noEmit` clean) |
| Full suite (stock TMPDIR) | `bun test` | **397 pass / 0 fail** across 16 files (2173 expects). Baseline was 393; +4 new F1 tests, zero new failures. No TMPDIR override needed (`/tmp` healthy). |
| Targeted guards | `bun test test/guards.test.ts` | **41 pass / 0 fail** |
| New F1 block | `bun test test/audit-20261018-remediation.test.ts -t "tilde-user-target-escape"` | **4 pass / 0 fail** (38 expects) |
| F4 plumbing | `bun test test/audit-20261018-remediation.test.ts -t "taint-fork-gap"` | **12 pass / 0 fail** (10 D + 2 E) |
| Wave-1 accept | `bash scripts/accept/wave-1.sh` | `WAVE 1 ACCEPT: ALL GATES GREEN`, exit 0 |
| Wave-2..7 accept | `bash scripts/accept/wave-N.sh` (N=2..7) | ALL GATES GREEN, exit 0 each |
| Wave-8 accept | `bash scripts/accept/wave-8.sh` | `wave-8: all audit-remediation gates passed`, exit 0 (needed >120 s wall time: re-runs `bun run accept` + full suite; pass on retry with 600 s budget) |
| LOC tracking | `bash scripts/check-loc.sh` | `files=22 raw=12089 (budget 12100) stripped=10024 (budget 10100)` — exit 0, byte-identical to baseline |
| LOC hard gate | `bash scripts/check-loc.sh --fail-over=12100 --fail-over-stripped=10100` | within-cap on both, exit 0 |
| Build | `bun run build` | exit 0 (`tsc -p tsconfig.build.json`) |
| F1 audit proof (verify-the-fix) | `bun -e` verbatim shapes via `evaluateBoardGuard` | all five `~user/`/`~+`/`~-` shapes + `~/evil` + `~` deny `rule-0-shell-target-containment`; `notes.txt`, `/tmp/x`, `/dev/null` allow (full output below) |
| F2 verify-the-fix | `rg 'plugin/system-prompt/meta.txt' src/muse/muse-calibration.ts` | 1 hit (line 9), exit 0 |
| F3 read-only (still-open proof) | `npm view … dist-tags.latest` / `git tag --list 'v*'` / `git rev-parse v1.0.11` / `git log --oneline v1.0.9..HEAD \| wc -l` | `1.0.9` / max `v1.0.9` / fatal exit 128 / 16 — still open, no release ops performed |
| F6 deps | `bun audit` | `No vulnerabilities found (checked 40 packages)`; `git diff -- package.json bun.lock` empty |
| Untouched-files proof | `git diff -- package.json bun.lock src/version.ts scripts/check-loc.sh .github/workflows/ci.yml` | empty output (exit 0) |
| Version identity | `package.json:3` / `src/version.ts:5` | both `1.0.11`, `test/bootstrap.test.ts` green inside full suite |

## Audit-proof re-runs (commands + outputs)

F1 (post-fix, from worktree root):

```bash
bun -e '
import { evaluateBoardGuard } from "./src/guards/permission-guard.ts";
for (const c of ["echo x > ~root/evil","echo x | tee ~root/evil","cp a.txt ~root/evil","mv a.txt ~other/evil","echo x > ~+/evil","echo x > ~-/evil","echo x > ~/evil","echo x > ~"]) {
  const v = evaluateBoardGuard({role:"builder",tool:"shell",command:c});
  console.log(JSON.stringify(c), "allowed=" + v.allowed, "rule=" + v.rule);
}
for (const c of ["echo hi > notes.txt","echo hi > /tmp/x","echo hi > /dev/null"]) {
  const v = evaluateBoardGuard({role:"builder",tool:"shell",command:c});
  console.log(JSON.stringify(c), "allowed=" + v.allowed, "rule=" + v.rule);
}'
```

```
"echo x > ~root/evil" allowed=false rule=rule-0-shell-target-containment
"echo x | tee ~root/evil" allowed=false rule=rule-0-shell-target-containment
"cp a.txt ~root/evil" allowed=false rule=rule-0-shell-target-containment
"mv a.txt ~other/evil" allowed=false rule=rule-0-shell-target-containment
"echo x > ~+/evil" allowed=false rule=rule-0-shell-target-containment
"echo x > ~-/evil" allowed=false rule=rule-0-shell-target-containment
"echo x > ~/evil" allowed=false rule=rule-0-shell-target-containment
"echo x > ~" allowed=false rule=rule-0-shell-target-containment
"echo hi > notes.txt" allowed=true rule=undefined
"echo hi > /tmp/x" allowed=true rule=undefined
"echo hi > /dev/null" allowed=true rule=undefined
```

F2:

```bash
rg 'plugin/system-prompt/meta.txt' src/muse/muse-calibration.ts
#  * three failure modes in OpenCode V2's default `packages/core/src/plugin/system-prompt/meta.txt`:
```

F3 (read-only, still-open confirmation — expected values per brief):

```bash
npm view @heretek-ai/opencode-harness dist-tags.latest   # 1.0.9
git tag --list 'v*'                                       # max v1.0.9 (v1.0.1 v1.0.2 v1.0.3 v1.0.4 v1.0.7 v1.0.8 v1.0.9)
git rev-parse v1.0.11                                    # fatal exit 128
git log --oneline v1.0.9..HEAD | wc -l                   # 16
```

## Self-proven RED (programmer-run, pre-fix predicate)

Reverted `src/guards/permission-guard.ts` to the pre-fix predicate
(`trimmed === "~" || trimmed.startsWith("~/")`) via native edit, ran the new
block, restored via native edit, re-greened:

```bash
bun test test/audit-20261018-remediation.test.ts -t "tilde-user-target-escape"
# pre-fix:  1 pass / 3 fail (the `~`/`~/` control test passes on both predicates, as expected;
#           the ~user/~+/~/~-/unit/over-block tests fail) — exit 1
# post-fix (restored): 4 pass / 0 fail — exit 0
```

The RED run proves the new tests are non-vacuous: they fail on the exact
vulnerable predicate the audit filed, not on scaffolding.

## Sabotage-readiness notes (for QA)

- Suggested red-proofs (all restore via `git checkout --` on the single file):
  (1) revert the F1 predicate → new tilde block RED 1/3 (this report's
  self-proof); (2) revert the F2 comment (`plugin/` deletion) →
  `rg 'plugin/system-prompt/meta.txt'` zero hits (no unit test pins it —
  file a red-proof on the F1 predicate instead, which IS unit-pinned);
  (3) allow `qa-adversary` to edit `src/index.ts` → `test/guards.test.ts`
  RED (prior-wave pin, unaffected by this diff).
- Residual-honesty pins assert `allow` for silent forks and bare squats only
  in the pre-existing D/E tests — they pin documented limitations, not fixes;
  QA must NOT file them as regressions. This wave adds one documented
  over-block pin (`~foo` denies) — same category: intended fail-closed cost,
  not a regression.

## F4/F5 document-only residuals (verified intact, no logic change)

- **F4 OH-6.6-taint-fork-gap (P2, STILL OPEN):** remediation-D/E plumbing
  intact — `recordSessionForkLink`/`linkForkLineageFromEventMetadata`/
  evaluate-time 4th-param + headers holder + headerless `model.request` link
  present (6 taint-guard hits), fork-matrix 12/12 green. Residual silent
  metadata-free fork shedding stays open by upstream design (no fork/revert
  event in `SessionHooks` at pin `ed772f5` or head `da9d436`; fork is a
  DB-level `SessionEvent.Forked → projectFork` projection). Hosts MUST call
  `recordSessionForkLink(child, parent)` at fork time. NOT claimed closed.
- **F5 OH-6.6-taint-name-squat (P3, STILL OPEN):** remediation-E hardening
  intact — `isMcpProvenanceEvent` wired at both call sites
  (`taint-guard.ts:2` + `contract-adapter.ts:2`), documented residual note
  next to `KNOWN_SAFE_TOOL_NAMES` (`taint-guard.ts:49`). Fix needs registry
  lookup or upstream marker plumbing, not a one-liner. NOT claimed closed.
- **F6 OH-deps-caret (P3, informational):** `bun audit` clean (40 pkgs),
  no `deprecated` pins, `package.json`/`bun.lock` untouched.
- **F7 OH-scope-loc-budget (P2):** 12089/10024 byte-identical to baseline;
  headroom still 11 lines. This wave is net-zero in `src/` (F1 shortens one
  line, F2 rewrites one comment line, zero net-new `src/` lines). Budget and
  CI wiring (`ci.yml:23-24`) untouched per brief.

## HUMAN-ONLY release checklist (NOT executed — hard limit)

The programmer performed NO release operations. A human must run, in order:

```bash
make check && make accept && make host-test && bun run build
npm version patch            # 1.0.11 -> 1.0.12 (keeps pkg==src identity; bootstrap test pins it)
git tag v1.0.12 && git push --tags
npm publish --provenance --access public
npm view @heretek-ai/opencode-harness dist-tags.latest   # expect 1.0.12
gh release create v1.0.12 --generate-notes               # closes OH-1.1-no-gh-release
```

Verify-the-fix (post-publish): repack published tarball and confirm
`grep -c UNRESOLVED_NESTING_SENTINEL package/dist/guards/shell-parse.js` is non-zero
(closes OH-1.3); `git rev-parse v1.0.12` resolves and `npm view versions` lists it
(closes OH-1.1).

## Self-audit

- Vanilla `read`/`edit`/`write`/`glob`/`grep` used for all file content; `bash`
  only for build/test/accept/audit-proof/`rg` scans + `git` ops; no file content
  was read or written through the shell (audit proof ran via `bun -e` against
  `src/`, writing nothing outside OS temp dirs).
- Zero stubs/vacuous tests: no `TODO` (zero hits `src/`+`test/`); no
  `|| true`/`set +e`/`cmd: "true"`/`echo "passed"` (zero hits outside the
  wave-8 scanner's own self-pattern exclusion); no `test.skip`; no empty
  `catch`. Two scan hits justified as pre-existing scanner self-pattern
  artifacts in files this wave did not touch: `test/wave8-audit.test.ts:121`
  matches `xit(` only inside `process.exit(` (wave-8's own narrower scan is
  green), and `test/plugin-interceptors.test.ts:485` is a fixture *string*
  (`"try { work(); } catch (e) " + "{}"`) constructing code text, not an
  actual empty catch.
- No forbidden surfaces added (no WebUI/HTTP/daemon/scheduler/worktree-manager/
  research-engine strings in `src/`); `package.json`, `bun.lock`,
  `src/version.ts`, `scripts/check-loc.sh`, `ci.yml` gate wiring untouched;
  version stays `1.0.11`.
- `git status --short` in the worktree shows only the intended files
  (2 `src/` fixes + test file + this report). No subagents spawned. No merge
  to `main`. No tags, no pushes, no registry writes.
