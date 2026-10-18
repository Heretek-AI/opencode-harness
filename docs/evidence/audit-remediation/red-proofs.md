# QA Red-Proof Evidence — audit remediation branch `fix/audit-findings-remediation-p0-p1-p2`

Date (UTC): 2026-10-18. Auditor role: agency-qa. Base commit: 2a9f758.

## 1. Acceptance gates (pre-sabotage, intact remediation)

| Command | Result |
|---|---|
| `bun run check` (tsc --noEmit) | exit 0 |
| `bun test` | 292 pass, 0 fail, 1252 expects, 15 files — exit 0 |
| `make check` | exit 0 |
| `make accept` (= `bash scripts/accept/run.sh`, waves 1–7) | ALL GATES GREEN — exit 0 |
| `bash scripts/accept/wave-8.sh` | all audit-remediation gates passed — exit 0 |

## 2. Direct fix probes (bun probe script, 23 assertions — ALL PASS, exit 0)

- OH-6.3-qa-shell-bypass: `qa-adversary`+bash `rm src/index.ts`, `echo evil > src/evil.ts`,
  `sed -i s/a/b/ src/x.ts`, `git checkout -- src/x.ts` → all denied `rule-3-qa-source-lock`.
- OH-6.4-contract-shell-bypass: `programmer`+bash `echo x > contracts/v1.json` → denied
  `rule-4-contract-lock`; `architect` → allowed.
- OH-6.5-xargs-rf-strip: `xargs -0 rm -rf /`, `xargs rm -rf / < /dev/null`,
  `echo x | xargs rm -rf /` → all `class=destructive`.
- OH-6.5-backtick-substitution: ``rm -rf `echo /` `` and `rm -rf $(echo /)` → both destructive.
- OH-6.5-deep-nesting-depth: n=4,5,6 `bash -c` nests of `rm -rf /` → all destructive.
- OH-6.5-find-exec-unwrapped: `find . -exec rm -rf / \;` → destructive.
- OH-6.6-single-word-mcp-server: `tavily_search`/`fetch_search` → true (tainted);
  `file_hash_read`/`bash` → false.
- OH-6.4-task-owned-shell-bypass: `worker`+bash redirect outside `src/a/**` → denied
  `rule-5-task-owned-paths` (with owning config).
- OH-6.3-src-prefix-untested: QA edit `src/a.test.ts` → denied `rule-3a-qa-src-lock`
  (distinct rule id from `rule-3b-qa-allowlist`).
- OH-8.3-staff-roles: `staff-backend` edit `src/x.ts` → allowed.
- Docs spot checks: `head -1 README.md` → `# "@heretek-ai/opencode-harness" (v1.0.9)`;
  README documents `{ "package": ..., "options" }` object form + tuple-drop warning;
  `file_hash_edit.execute` throws on `applied===false` (src/index.ts:679);
  bare-auth never-retry test at test/wave7-systems.test.ts:180.

## 3. Red-proof sabotage log

Protocol deviation: the remediation is UNCOMMITTED, so `git checkout -- <file>`
restores HEAD (destroys the fix) instead of restoring the fix. After incident S1
below, all further sabotage used edit-sabotage → test-RED → reverse-edit-restore →
test-GREEN with `git diff --numstat` comparison. No `git checkout --` was used again.

- S1 (OH-6.3 shell leg): `src/guards/permission-guard.ts` Rule-3 shell leg
  `isShellTool(tool)` → `isEditTool(tool)`.
  `bun test test/guards.test.ts` → **31 pass, 1 fail, EXIT 1 (RED as required)**.
  ***INCIDENT***: restore via `git checkout -- src/guards/permission-guard.ts`
  reverted the programmer's entire remediation for that file to HEAD (2a9f758).
  `git fsck --lost-found` / reflog show no recoverable copy. The file must be
  re-applied by agency-programmer. Subsequent `bun test test/guards.test.ts` →
  import error (`shellNamedFileTargets` missing); `bun test test/plugin.test.ts` →
  60 pass + 1 fail (`denies qa-adversary edits under src`); `bun test
  test/wave8-audit.test.ts` → 61 pass + 1 fail (`case-variant QA roles`) — both
  failures are the expected consequence of the revert, confirming suite
  sensitivity to this file.
- S3 (OH-6.5-xargs): `src/guards/shell-parse.ts`
  `xargsPayloadArgs(seg.args)` → `seg.args.filter((a) => !a.startsWith("-"))`.
  Tmp probe (4 tests) → **3 pass, 1 fail, EXIT 1 (RED)**. Reverse-edit restored;
  probe → 4 pass, EXIT 0; numstat `180 4` matches baseline.
- S4 (OH-6.5-backtick): regex `` /`[^`]*`|\$\(/ `` → `/\$\(/`.
  Probe → **3 pass, 1 fail, EXIT 1 (RED)**. Restored; probe green; numstat matches.
- S5 (OH-6.5-nesting): `MAX_SHELL_UNWRAP_DEPTH = 10` → `= 4`.
  Probe → **3 pass, 1 fail, EXIT 1 (RED)**. Restored; probe green; numstat matches.
- S-find (OH-6.5-find-exec): `for (const payload of findExecPayloads(seg.args))` →
  `for (const payload of [] as string[])`. Probe → **3 pass, 1 fail, EXIT 1 (RED)**.
  Restored; probe → 4 pass green; numstat `180 4` matches.
- S6 (OH-3.2 throw): `src/index.ts` `if (!result.applied)` → `if (false)`.
  `bun test test/plugin.test.ts`: 60 pass/1 fail → **59 pass/2 fail, EXIT 1 (RED,
  delta +1 = mismatch-throw test)**. Restored (numstat `19 2` matches).
- S7 (OH-6.6 taint): `src/guards/taint-guard.ts` fail-closed `if (lower.includes("_"))`
  → `if (lower.includes("_") && lower.slice(0, underscore).includes("-"))`.
  `bun test test/wave8-audit.test.ts`: 61 pass/1 fail → **60 pass/2 fail, EXIT 1
  (RED, delta +1 = single-word MCP test)**. Restored (numstat `62 1` matches).
- S8 (OH-4.6 bare-auth): `src/interceptors/session-interceptors.ts` fatal regex minus
  `auth\|`. `bun test test/wave7-systems.test.ts`: 6 pass/0 fail → **5 pass/1 fail,
  EXIT 1 (RED)**. Restored → 6 pass green, file absent from diff (unmodified, as baseline).
- S9 (OH-7.2 empty-catch): `src/verify/architecture-advisor.ts` multi-line branch
  `if (/…/.test(line))` → `if (false && /…/.test(line))`.
  `bun test test/plugin-interceptors.test.ts`: 11 pass/0 fail → **10 pass/1 fail,
  EXIT 1 (RED)**. Restored → 11 pass green (numstat `36 0` matches).
- S10 (OH-6.4 contract/task-owned shell legs, OH-6.3 rule ids): NOT independently
  red-proven — vectors live in `src/guards/permission-guard.ts`, reverted by the S1
  incident. Partial evidence: S1 RED pre-incident; current plugin.test + wave8-audit
  failures prove the suite is sensitive to this file's remediation.

## 4. Final state (after all restores)

- `bun run check` → EXIT 1: `test/guards.test.ts(15,3): error TS2305 ...
  has no exported member 'shellTeeTargets'` (consequence of S1 incident).
- `bun test` → 262 pass, 3 fail, 1 error, 16 files (16th = tmp probe files,
  removed after logging), EXIT 1 — all red confined to permission-guard revert.
- `git diff --numstat` for every sabotaged-then-restored file matches the
  pre-sabotage baseline exactly (shell-parse 180/4, taint 62/1, index 19/2,
  advisor 36/0, interceptors unmodified). No sabotage residue.
- `git status --short`: programmer remediation intact EXCEPT
  `src/guards/permission-guard.ts` (reverted to HEAD, no longer listed as modified).

## 5. Verdict

REMEDIATION **NOT ACCEPTED** in current worktree state — blocked solely by the
QA-caused S1 incident: `src/guards/permission-guard.ts` (P0 fixes OH-6.3-qa-shell-
bypass, OH-6.4-contract-shell-bypass, OH-6.4-task-owned-shell-bypass, P1 OH-6.3-
src-prefix-untested, P2 OH-8.3-staff-roles) must be re-applied by agency-programmer,
after which `bun run check`, `bun test`, `make accept` must be re-run green.
All other findings verified: every intact fix passes direct probes AND red-proof
sabotage (suite goes RED when broken, GREEN when restored).
