# Stage Report — Audit Remediation 20261018 (`audit-remediation-20261018`)

- **Stage ID:** `audit-remediation-20261018`
- **Branch:** `audit-remediation-20261018` (worktree: `worktrees/audit-remediation-20261018`)
- **Baseline:** `a8aa58a` (`Add drift-guard verification: VERDICT PASS (audit 20261018)`)
- **Source findings:** `AUDIT_REPORT_FINDINGS.md` (audit date 2026-10-18, package `1.0.10`)
- **Scope:** single-session OpenCode v2 in-process plugin ONLY (no WebUI / HTTP /
  fleet / worktree-manager / research-engine code — refused by charter).

## Summary

All five code-remediation findings are fixed, regression-pinned, and green
across every gate (`bun run check`, `bun test`, `make check`, `make accept`,
`bun run build`), plus a live host-test run against the pinned upstream
(`anomalyco/opencode@ed772f5`) proving the new built-in-`edit` leg with the
real upstream `Formatter.file`. Package bumped `1.0.10` → `1.0.11` in
`package.json` + `src/version.ts` (+ README title, coupled by test).
**No tags were pushed, nothing was published, no GitHub Release was created —
those are human-only steps listed verbatim in §7.**

## Deliverables per finding

### OH-6.5-find-exec-placeholder (P0) — `find <root> -exec rm -rf {} \;` bypass

- `src/guards/shell-parse.ts`
  - New `findPathOperands()` (leading path operands before the first
    expression primary) + `findHasWipeRoot()` (any operand is a root-wipe
    target: `/`, `/*`, `*`, `~`, `~/*`, `~/…`, `$HOME`, `${HOME}`, …).
  - New `findExecPayloadIsPlaceholderWipe()` (`-exec`/`-execdir`/`-ok`/`-okdir`
    payload running `rm` + recursive/force flags over the `{}` placeholder,
    including wrapper-stripped payloads and `$(…)`/backtick substitution).
  - `segmentIsDestructive()` `find` branch: wipe-root + placeholder-wipe
    payload → `destructive` (fail-closed). Scoped roots stay `write`;
    `find /tmp -name x -delete` and `find /tmp -exec rm -rf / \;` behavior
    preserved.
- `src/guards/taint-guard.ts`
  - `evaluateTaintGuard()` denies destructive shell while tainted
    (`TAINT-DESTRUCTIVE-1`) — the taint layer no longer reads `allow` for a
    wipe idiom (permission layer denies first for every role regardless).
- Tests (`test/audit-20261018-remediation.test.ts`, 6 new):
  `\;`/`+` × `-exec`/`-execdir`/`-ok`/`-okdir` destructive matrix; `/`/`~`/
  `$HOME`/`${HOME}`/`/*` roots; scoped-root write preservation; builder/
  architect/director/manager/qa verdicts all `rule-1-destructive`; tainted
  `allow`→`deny` at both layers + clean-session layering pins.

### OH-6.5-guard-root-unwired (P3) — `guardConfig.workspaceRoot` default

- `src/index.ts` (`resolveHarnessOptions`): custom `guardConfig` without
  `workspaceRoot` now defaults to `rootDir`
  (`{ workspaceRoot: rootDir, ...customGuardConfig }`); an explicit non-blank
  value wins; a blank value normalizes back to `rootDir` (fail-closed, never
  silently back to `process.cwd()`). No-`guardConfig` path unchanged.
- Tests (4 new): omitted→`rootDir`, explicit-wins, blank→`rootDir`,
  workspace-relative write allows under the defaulted root while
  `/etc/cron.d/evil` still denies `rule-0-shell-target-containment`.

### OH-6.7-lesson-per-read (P3) — one lesson per doom-loop

- `src/context/episodic-memory.ts` (`trackCircuitBreakerAndAutoProposeLesson`):
  a successful mandated re-read (`normalizeToolKind(toolName) === "other"`)
  while tripped returns `null` WITHOUT clearing trip state, so only the
  genuine recovering (non-read) success proposes exactly one lesson.
- Tests (1 new pipeline test): read-ok, edit-fail, read-ok, edit-fail,
  good-edit-ok through the real adapter `execute.after` →
  `getPendingLessonProposals() === 1`, attached to the `edit` recovery
  (`recoveryAction` starts with `edit`, never `via read`).

### OH-6.6-taint-fork-gap (P2) — fork-aware taint inheritance

- `src/interceptors/session-interceptors.ts`: new fork-link registry
  (`recordSessionForkLink` / `getSessionForkSource`), defensive
  `linkForkLineageFromEventMetadata()` (top-level/`input`/`metadata` keys:
  `parentSessionID`, `forkOf`, `fork_source`, …; self-links and non-strings
  ignored; never throws), `getSessionParent()` now falls back to the fork map,
  `clearSessionLineage()` clears both maps.
- `src/host/contract-adapter.ts`: `execute.after` resolves fork lineage from
  live event metadata on every tool completion, so `resolveTaintChain()` in
  `evaluateTaintGuard()` inherits taint into forked children (fail-closed).
- Tests (3 new): tainted-parent forked child `ssh evil.com` denies
  (`TAINT-NET-2`) while a clean fork allows; metadata-linked fork denies;
  self/empty/null metadata links nothing.

### OH-4.2-post-formatter-receipt (P2) — built-in `edit` post-format leg

- `test/audit-20261018-remediation.test.ts` (in-repo, runs under `bun test`):
  new built-in-`edit` stand-in driving the REAL adapter hooks in true
  upstream order (`execute.before` → raw-bytes disk write → on-disk format
  pass → re-read → `execute.after`), plus a formatting-sensitive test
  (unformatted TS → formatted TS) asserting receipt hashes equal the
  post-format disk bytes and NO stale pre-format hash leaks (ordering proof).
- `scripts/host-test/harness-host.upstream.ts` (live, runs under
  `make host-test`): new `itBuiltin` suite on an extended layer (fixture
  nodes + the REAL upstream `Formatter.node`) registering a deterministic
  external formatter (`bun` + script, `$FILE`) and a core-Effect built-in
  `edit` stand-in (write → real `Formatter.file` → re-read). Asserts receipt
  hashes equal formatted bytes on disk, stale hashes absent. Verified live:
  5/5 host tests pass at pinned `ed772f5`.
- Note: `bun` is resolved via `Bun.which("bun")` (fail-closed throw when
  absent) because `process.execPath` may point at an unspawnable npm-shim
  name in some installs (observed `…/bun/bin/bun.exe`).

### Release bump `1.0.10` → `1.0.11`

- `package.json`, `src/version.ts`, `README.md` title (coupled by tests).
- `test/audit-20261018-remediation.test.ts` OH-1.3 block updated to pin
  `1.0.11` past stale `1.0.9`/`1.0.10`; `test/bootstrap.test.ts` still green
  (pkg === src).

## Test results

- New regression tests: 15 (`6` find-exec + `4` guard-root + `1` lesson +
  `3` fork-gap + `1` OH-4.2 stand-in) in
  `test/audit-20261018-remediation.test.ts`, plus 1 live host test.
- `bun test`: **358 pass / 0 fail** (was 343 at baseline).
- Each new suite verified present by `-t` filtered runs (6 / 4 / 1 / 3 /
  OH-4.2 ×2 green in isolation).
- Host test (`OPENCODE_DIR=<scratch-copy>@ed772f5`): **5 pass / 0 fail**,
  including the new built-in-leg test (ran solo: 1 pass / 9 expects).

## Gate outputs (worktree root, all exit 0)

- `bun run check` → `tsc --noEmit`, exit 0.
- `bun test` → 358 pass / 0 fail, exit 0.
- `make check` → check + test, exit 0.
- `make accept` → waves 1–7 `ALL GATES GREEN` (incl. zero-stub, scope-refusal,
  KV-cache scans), exit 0.
- `bun run build` → `tsc -p tsconfig.build.json`, exit 0; `dist/version.js`
  carries `1.0.11`.
- `make host-test` (networked, pinned `ed772f5`): 5 pass / 0 fail.
  (Scratch upstream copy at `/dev/shm/ochost`, outside the repo.)

## Rework 1 — QA conditional ACCEPT: B1 pipeline gap (test-only fix)

- **Finding:** the shipped `OH-6.7-lesson-per-read` pipeline test performed its
  re-reads BEFORE the trip (`read-ok, edit-fail, read-ok, edit-fail,
  good-edit-ok`), so the `=== "other"` carve-out in
  `trackCircuitBreakerAndAutoProposeLesson` was never exercised — sabotage B1
  (neuter the carve-out) left `bun test` 358 green while the audit-style
  behavioral probe went RED (3 premature `via read` lessons vs pristine 1).
- **Fix (test-only, no production logic change):**
  `test/audit-20261018-remediation.test.ts` — extended the pipeline test to
  the audit 4-cycle shape with POST-TRIP re-reads (`read-ok -> edit-fail ->
  read-ok -> edit-fail -> read-ok -> read-ok -> good-edit-ok`), asserting
  zero pending proposals after each post-trip re-read and exactly 1 pending
  proposal attached to the good `edit` (`recoveryAction` starts with `edit`,
  contains no `via read`, and no pending item contains `via read`).
- **Verification (this session):**
  - Targeted `-t "OH-6.7-lesson-per-read"` pristine → 1 pass / 0 fail.
  - Sabotage (`"other"` → `"never-sabotaged"`) → 0 pass / 1 fail at the first
    post-trip re-read assertion (RED confirmed), `git checkout --` restore →
    1 pass / 0 fail.
  - `bun run check` → exit 0; `bun test` → 358 pass / 0 fail; `make check` →
    exit 0 (all post-change, pre-commit).
  - Environment caveat: the shared box `/tmp` later hit 0 free inodes
    (1048576/1048576 — other sessions' `agency-*` dirs plus completed-audit
    scratch; only ~20 dirs are from this worktree's runs), so temp-creating
    tests fail with `ENOSPC` on `mkdtemp` until space frees. Differential
    re-proof with `TMPDIR=/dev/shm/oh67-tmp` (removed after): 356 pass / 2
    fail where the ONLY failures are the two pre-existing tests that
    hard-couple `tmpdir() === /tmp` (literal `/tmp/...` ALLOW assertions —
    they pass under a normal `/tmp` and are unrelated to this change); the
    extended OH-6.7 test passes and the B1 sabotage goes RED there too.
    Full `make accept` exit 0 must be re-confirmed by QA/drift-guard once
    `/tmp` has free inodes — no production code changed since the last green
    `make accept`, only this test.

## Self-audit notes

- **Zero stubs:** `grep TODO src/ test/` → zero hits; no `test.skip`/
  `describe.skip`/`.only` (one `exit(` false positive inside a command
  string); no `|| true` in scripts (only the wave-8 guard that *fails* on
  it); the single `catch { return undefined; }` (fork-metadata linker) is a
  documented fail-closed total function (unparseable events link nothing),
  not a swallowed error.
- **KV-cache invariants:** untouched — no changes under `src/context/`
  except the episodic proposal gate (no tag-format, ordering, or
  `event.system` changes); `make accept` wave-2/5 KV checks green.
- **Scope refusal:** no WebUI/HTTP/fleet/worktree/research code in `src/`
  (`make accept` scope scan green).
- **Red-proof:** new suites assert exact rules/denials that fail if the
  corresponding production leg is neutered (find-branch removal,
  threshold sabotage, and Builder/Architect allow all go RED by
  construction); formal QA sabotage + drift `VERDICT` remain downstream.
- Previous-report files (`docs/reports/wave-audit-20261018-verification.md`,
  `audit-20261018-remediation-implementation.md`) intentionally left
  untouched as historical record.

## Human follow-ups (NOT executed — forbidden to agents)

Tag, publish, and release `1.0.11` from a green `main` after merge:

```bash
git tag v1.0.11
git push --tags
npm publish --provenance --access public
gh release create v1.0.11 --generate-notes
npm view @heretek-ai/opencode-harness dist-tags.latest  # expect 1.0.11
```

This closes OH-1.3-stale-npm-latest (P0) and OH-1.1-unreleased (P1) /
OH-1.1-no-gh-release (P3), which cannot be closed from inside the sandbox.

## Files changed

- `src/guards/shell-parse.ts` (+108): find-path operands, placeholder-wipe
  detector, `find`-branch destructive leg.
- `src/guards/taint-guard.ts` (+18/-): `TAINT-DESTRUCTIVE-1` taint-layer leg.
- `src/guards/permission-guard.ts`: untouched (Rule 1 ordering already denies
  first — verified by tests).
- `src/index.ts` (+31/-): `guardConfig.workspaceRoot` → `rootDir` default.
- `src/context/episodic-memory.ts` (+12): re-read-is-not-recovery gate.
- `src/interceptors/session-interceptors.ts` (+98/-): fork registry +
  metadata linker + fork-aware `getSessionParent`.
- `src/host/contract-adapter.ts` (+7): per-completion fork-link resolution.
- `test/audit-20261018-remediation.test.ts` (+416): 15 regression tests.
  Rework 1 extends the OH-6.7 pipeline test with post-trip re-reads (test-only;
  production code untouched).
- `scripts/host-test/harness-host.upstream.ts` (+271): live Formatter leg.
- `package.json`, `src/version.ts`, `README.md`: `1.0.11` bump.
- `docs/reports/audit-remediation-20261018.md`: this report (new).
