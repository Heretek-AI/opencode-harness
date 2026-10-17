# Wave 8 Audit Remediation — Implementation Report

- **Stage ID:** wave-8-audit-remediation
- **Branch:** `wave-8-audit-remediation` (worktree `worktrees/wave-8`, NOT merged to `main`)
- **Baseline:** `db4a2c055f4f4f160d1328937c7f0da7d8f6031d` (audit date 2026-10-17)
- **Source of truth:** `AUDIT_REPORT_FINDINGS.md` — every finding remediated per its Remediation section verbatim.

## Summary of deliverables

All 5 P0, all 7 P1, and all 9 P2/P3 findings are remediated. The permission
guard is now consulted for every harness `execute` (G1 fix); the shell
classifier canonicalizes continuations, resolves wrapper chains and absolute
binary paths, and computes write-ness over unwrapped candidates; taint arms
for real `<server>_<tool>` MCP ids and inherits across forks; all writers are
contained by realpath; roles normalize with default-deny; loopback/LAN SSRF
is refused by default; the archived schema bridge is gone (zod 4 native);
rollback/retry gaps have sabotage-catching tests; CI is SHA-pinned; browser
weight moved to optional peers.

## Files created

- `test/wave8-audit.test.ts` — 62 tests covering every audit corpus.
- `scripts/accept/wave-8.sh` — executable gate (exit 0/1), all P0
  verifications + `bun run accept` + traversal + receipt + stub scan.
- `scripts/accept/run.sh` — `bun run accept` entrypoint (waves 1–7, mirroring
  `make accept`; wave-8 runs separately so the entrypoint never recurses).
- `docs/reports/wave-8.md` — this report.

## Files modified

- `src/guards/shell-parse.ts` — `canonicalizeShellCommand` (backslash-newline
  join); per-wrapper value flags (`sudo -u/-g`, combined shorts, `VAR=`,
  `--`); basename resolution (`/bin/rm`, `/sbin/mkfs.ext4`, `/bin/dd`
  always destructive); split-flag rm (`-r -f`), `~`/`$HOME` targets, `..`
  fail-closed static escape check, `git -C/--git-dir/--work-tree` skip plus
  `+`-refspec force; `ALWAYS_WRITE_VERBS`
  (eval/python/node/npx/bunx/curl/wget/ssh/xargs), `find -exec` write, bare
  shells write, write-ness over unwrapped candidates, unknown-verb metachar
  default write; `wrapperChain` on `ParsedSegment`; exports
  `canonicalizeShellCommand`, `stripLeadingWrapperTokens`, `commandBasename`.
- `src/guards/permission-guard.ts` — `normalizeRoleName` (NFKC+lower+trim);
  unknown roles fail closed to least privilege (reads only); `build` upstream
  agent recognized; harness read tools registered; `rename_symbol` /
  `checkpoint_rollback` workspace-wide edit-class (leadership+QA deny,
  path-required exempt); `resolveExecuteRole` (explore/plan→director) and
  `extractGuardTargetFromArgs` shared helpers.
- `src/index.ts` — `enforceHarnessToolGuard` wired into all 14 executes;
  `auditAllowedHosts` operator option (validated) passed to the live audit.
- `src/host/contract-adapter.ts` — `guardHarnessExecute` wraps every
  direct + Code Mode `execute` with explicit `evaluatePermission`
  (role/agent/path/command); agent normalization; zod 4 native
  `z.toJSONSchema(io:input, reused:inline)` (bridge removed); subagent
  after-hook rescans via full before-set + `diffNewWorkspaceFiles` and
  appends `before="none"` receipt entries.
- `src/guards/taint-guard.ts` — `<server>_<tool>` matching (known servers +
  hyphen heuristic; harness snake_case excluded); fork inheritance via
  `getSessionParent` chain walk; denylist broadened (`.ssh/`, `.aws/`,
  `.env`, `git push`, `curl|sh` pipe, `wget`, `ssh/scp`, `env`, credential
  reads via cat-family).
- `src/interceptors/session-interceptors.ts` — `getSessionParent` export;
  fatal retry regex also matches `invalid api key` / hyphen variants.
- `src/editors/hashline-tools.ts` — `resolveSafePath` now realpaths the
  nearest existing ancestor and requires containment; new
  `assertPathWithinRoot` / `isPathWithinRoot`.
- `src/editors/ast-codemod.ts` — contained via `resolveSafePath` (no change
  needed; verified by PoC test).
- `src/repomap/repomap.ts` — walker skips symlinks; rename inputs filtered
  by containment; `moveModuleAndRewriteImports` throws on escape.
- `src/transactions/edit-transaction.ts` — `beginEditTransaction` /
  `createCheckpoint` throw on out-of-root snapshots.
- `src/ui-auditor/dom-auditor.ts` — `resolveAuditTarget` SSRF gate
  (protocol/host/resolution/metadata/non-public-IP checks, opt-in
  `allowedHosts` + `OPENCODE_HARNESS_AUDIT_URL_ALLOWLIST`); per-request
  redirect guard; 8-viewport cap; missing peer deps fail closed with install
  guidance; exports `isNonPublicIpAddress`, `resolveAuditTarget`,
  `AuditUrlPolicy`, `MAX_AUDIT_VIEWPORTS`.
- `src/verify/verifier.ts` — `isContainedTestPath` (realpath) filters
  `computeScopedTestsForFiles`; `../outside.test.ts` rejected.
- `src/interceptors/tool-interceptors.ts` — header-less bare hunk returns
  explicit fail-closed `error` (path-required message).
- `src/muse/muse-calibration.ts` — `createMutationReceipt` accepts
  `additionalRelPaths`; new `listWorkspaceRelPaths` /
  `diffNewWorkspaceFiles` (symlinks skipped).
- `package.json` — `zod ^4.6.7`, `zod-to-json-schema` removed, `@types/bun`
  pinned `1.4.3`, `typescript ^7.0.2`, `playwright` + `@axe-core/playwright`
  → optional `peerDependencies` (kept in `devDependencies` for local dev).
- `test/guards.test.ts` — `sudo rm -rf /tmp/../` now asserts destructive
  (was blessing the escape; flagged by the audit).
- `.github/workflows/publish.yml`, `ci.yml` — actions SHA-pinned
  (checkout `11d5960a…`, setup-node `49933ea5…`); npm pinned `11.19.1`.
- `scripts/host-test/run.sh` — fails closed unless `rev-parse HEAD`
  equals the pinned `OPENCODE_REF`.

## Dependency decisions

- **zod 3.25.76 → 4.6.7:** `z.toJSONSchema(..., { io: "input", reused:
  "inline" })` verified to inline shared subschemas (no `$ref`) and keep
  `type: "object"`; host-contract tests green; `grep -r zod-to-json-schema`
  empty.
- **typescript 5.9.3 → 7.0.2:** `bun run check`, `bun test`, and `bun run
  build` all green — kept the upgrade, no pin-reason doc needed.
- **@types/bun:** pinned exact `1.4.3` (was `latest`).
- **playwright + @axe-core/playwright:** optional peers; live audit throws a
  fail-closed install message when absent. Consumer weight drops by ~19M
  (playwright 5M + playwright-core 14M + axe-core); `@ast-grep/napi` + `zod`
  remain (load-bearing, ~14M).

## Scope / LOC budget note (OH-8.1-scope-loc-9176)

`src/` is ~9.5k LOC vs the 3–5k budget. No dead code was found (every module
is wired into `src/index.ts`; wave-7 accept asserts the wiring). Split plan
for a future wave (no code moved in this wave, per instructions): core
(`editors`, `guards`, `context`, `index`, `host`) vs optional systems
(`repomap` ≈1k, `interceptors` ≈1.1k, `diagnostics`, `verify`,
`ui-auditor`, `muse`) loadable as a second plugin entrypoint. No dead code
was added to satisfy the budget.

## Test results (commands + exit codes)

- `bun run check` → exit 0 (`tsc --noEmit`, TS 7.0.2 clean).
- `bun test` → exit 0 (267 pass, 0 fail, 1123 expects; baseline was 205 —
  62 new Wave 8 tests, all in `test/wave8-audit.test.ts`).
- `make check` → exit 0.
- `make accept` (waves 1–7) → exit 0, `WAVE 7 ACCEPT: ALL GATES GREEN`.
- `bash scripts/accept/wave-8.sh` → exit 0
  (`wave-8: all audit-remediation gates passed`).
- `bun run accept` → exit 0 (`accept: 7 wave script(s) passed`).
- `bun run build` (`tsc -p tsconfig.build.json`) → exit 0.
- `grep -r zod-to-json-schema package.json src/` → empty (exit 1, no hits).
- Loopback PoC: `resolveAuditTarget("http://127.0.0.1:…")` rejects with
  `refusing loopback audit URL … (fail-closed; opt in with allowedHosts)`.
- Symlink PoC: `link/victim.txt` edit rejects with `symlink escape …
  (fail-closed)`; outside file byte-identical.

## Self red-proof sabotage log (all restored, suite green after)

1. Removed the `..` traversal check in `segmentIsDestructive`
   (`src/guards/shell-parse.ts`): `bun test
   test/wave8-audit.test.ts -t "OH-6.5-destructive-shell-evasions"` →
   20 pass / **1 fail** (`rm -rf /tmp/../`). Restored → green.
2. `finalizeEditTransaction(sessionId, false)` → `true` in
   `src/repomap/repomap.ts:896` (exact audit sabotage): `-t
   "OH-3.4-rename-rollback-untested"` → 0 pass / **1 fail**.
   Restored → green.
3. Dropped `invalid_api_key` from the fatal retry list
   (`src/interceptors/session-interceptors.ts`, exact audit sabotage): `-t
   "OH-4.6-invalid-apikey-retry-untested"` → 1 pass / **2 fail**.
   Restored → green.
4. Incidental: removing wrapper flag-skipping alone stays green because
   `parseCommandSegments` unwrapping independently yields the destructive
   candidate — defense in depth, documented here.

## Self-audit notes

- Zero stubs/mocks/vacuous tests: `TODO`, `test.skip`, `|| true`, `cmd:
  "true"`, `echo "passed"`, empty catches all scan clean (wave-8.sh
  enforces). New tests assert real behavior (file bytes, verdicts, receipts).
- Fail-closed posture: unknown roles, unknown verbs with metachars,
  header-less hunks, unresolvable audit hosts, out-of-root snapshots, and
  missing browser peers all deny/throw with descriptive domain errors.
- Known limitations (documented, not filed as new findings): static `..`
  rejection in rm targets is a strict superset of a realpath check (may flag
  a `--` -separated literal `..` arg — acceptable fail-closed); `make`/`tsc`
  stay read-only by design (existing suite pins `make check` read-only);
  uppercase `RM`/`GIT` stay read-only (non-executable on Linux, per audit);
  live browser + upstream host-test paths were code-reviewed, not executed
  here (browsers installed; host test needs network fetch of upstream).
- `git status` before commit: 18 modified + 3 new files, all intended; no
  merge to `main` performed (branch `wave-8-audit-remediation` left for
  QA / drift-guard triad).
