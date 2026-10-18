# Audit Remediation Verification Report

**Role:** `agency-drift-guard` (independent adversarial auditor; changed NO code).
**Branch:** `fix/audit-findings-remediation-p0-p1-p2` @ `e8acb05` (remediation committed; working tree clean except pre-existing untracked `AUDIT_REPORT_FINDINGS.md` + QA evidence).
**Source:** `AUDIT_REPORT_FINDINGS.md` (baseline `2a9f758`, package `1.0.9`) + `docs/reports/audit-remediation.md` (programmer report, incl. rework-1 addendum).
**Date (UTC):** 2026-10-18.

## 1. Contract

`AGENTS.md` scope read in full: single-session OpenCode v2 plugin ONLY. No WebUI/HTTP/fleet/DAG/worktree-manager/epistemic code found in `src/` (see §5). Scope refusal holds.

## 2. Gates (exact commands + exit codes)

| Command | Result |
|---|---|
| `make check` (`bun run check` tsc --noEmit + `bun test`) | exit 0 — 292 pass, 0 fail, 1252 expects, 15 files |
| `make accept` (`bash scripts/accept/run.sh`, waves 1–7) | exit 0 — ALL GATES GREEN (waves 1–7) |
| `bash scripts/accept/wave-8.sh` | exit 0 — "wave-8: all audit-remediation gates passed" (292 pass included) |
| `bun test test/context-budget.test.ts` | exit 0 — 23 pass, 0 fail |
| `bash scripts/check-loc.sh` | exit 0 — raw=10844 (budget 12000), stripped=9158 (budget 10000) |

## 3. Stub / shortcut scan (src + test)

Patterns grepped (ripgrep): `TODO`, `\|\| true`, `set +e`, `cmd: "true"`, `echo "passed"`, `test.skip`/`describe.skip`/`it.skip`/`xit(`/`xdescribe(` (precise, word-boundary — the one naive `xit(` hit is `process.exit(` inside a fixture string, not a skipped test), empty `catch {}`, vacuous `return true`, empty functions, unwired `src/**/*.ts` exports.
- `TODO` / `|| true` / `cmd:"true"` / `echo "passed"`: hits ONLY inside `scripts/accept/*.sh` lines that quote the forbidden pattern as the scan's own grep argument — self-referential documentation of the scan itself, justified, no source stub.
- `set +e`: zero hits. Precise skip-patterns: zero hits. Empty `catch {}`: zero hits.
- `return true` (~20 hits in `src/`): every instance guarded by real logic (path-containment probe, destructive-classifier branches, taint allowlist, sentinel handling) — sampled `hashline-tools.ts:156` (try/assert wrapper) and `shell-parse.ts:560` (sentinel branch); none vacuous.
- Unwired exports: none — `src/index.ts` re-exports every module via `export *` (lines 76–94) plus explicit `computeLineHash` / `getRecommendedMcpConfig` re-exports; accept scripts independently assert wiring green.
- Result: **zero unjustified hits.**

## 4. KV-cache invariants

- `injectContextBudgetIntoMessages` (`src/context/context-budget.ts:340+`): never reads, mutates, reorders, or reassigns `event.system` (only `event.messages[targetIndex]` touched; no-`user`-message case throws fail-closed instead of falling back to `system`). `grep "event.system\|\.system *="` in the file returns only doc comments.
- Dynamic context appends strictly to the LAST `role === "user"` message (reverse scan `length-1 → 0`, `break` on first match).
- Episodic lessons sorted by `a.id.localeCompare(b.id)` (also in `episodic-memory.ts` ×3); tag format carries no `relevance=` floats or timestamps (test asserts `not.toContain("relevance")`).
- `test/context-budget.test.ts`: 23 pass, 0 fail, exit 0.

## 5. Scope refusal check

- `grep -rniE "listen\(|createServer|WebUI|DAG|epistemic|fleet|scheduler"` over `src/ scripts/ test/`: only benign hits — scope-refusal comments, upstream `OpenCodeV2PromiseContext.worktree`/`location.worktree` passthrough fields (host context shape, not a worktree manager), and accept-script scan patterns. No HTTP server, no DAG scheduler, no worktree manager, no epistemic engine.
- `getRecommendedMcpConfig()` (`src/ui-auditor/mcp-defaults.ts:30-43`) returns EXACTLY two blocks: `lsp-mcp-server` (`bunx`) + `fallow-mcp` (`npx --yes --package fallow fallow-mcp`). No extra servers.

## 6. Independent sabotage test (DISTINCT from QA's S-3a / S-4.6 / S-xargs)

QA's red-proofs (see `docs/evidence/audit-remediation/red-proofs.md` + `red-proofs-reverify.md`): S-3a src-prefix → 2 fail RED; S-4.6 auth-regex → 1 fail RED; S-xargs flag-strip → 1 fail RED. All restored.
Mine (destructive-parser `rm` branch — the P0 security boundary itself):
- `sed -i 's/if (exe === "rm") {/if (exe === "rm-NEVER") {/' src/guards/shell-parse.ts` (line 563; one-line sabotage, temp file ops in `/tmp/opencode` only)
- `bun test test/guards.test.ts` → **24 pass, 8 fail, exit 1** (RED as required; fail-closed proven — `rm -rf /` family no longer destructive without that branch)
- `git checkout -- src/guards/shell-parse.ts` → RESTORED (line 563 back to `if (exe === "rm") {`)
- `git status --short` → clean (only pre-existing `?? AUDIT_REPORT_FINDINGS.md`, `?? docs/evidence/audit-remediation/red-proofs-reverify.md`); `git diff --stat` empty
- Post-restore `bun test` → 292 pass, 0 fail (green confirmed after restore)

## 7. Per-finding assessment (all 19 + 2 decisions)

**P0 (all 5 FIXED — each independently re-probed live via `bun -e`, all as expected):**
- OH-6.3-qa-shell-bypass: FIXED. `qa-adversary`+bash `rm src/index.ts` / `echo evil > src/evil.ts` / `sed -i … src/x.ts` → all `allowed:false rule-3-qa-source-lock`. Rule 3 shell leg present.
- OH-6.4-contract-shell-bypass: FIXED. `programmer`+bash `echo x > contracts/v1.json` → denied `rule-4-contract-lock`; `architect` → allowed. `shellRedirectTargets`/`shellTeeTargets`/`shellNamedFileTargets` exported and enforced.
- OH-6.5-xargs-rf-strip: FIXED. `xargs rm -rf /` → `class=destructive`, builder denied `rule-1-destructive`. `xargsPayloadArgs` preserves payload flags.
- OH-6.5-backtick-substitution: FIXED. Both ``rm -rf `echo /` `` and `rm -rf $(echo /)` → destructive, denied.
- OH-6.5-deep-nesting-depth: FIXED. 5-deep `bash -c` nest of `rm -rf /` → destructive, denied (`MAX_SHELL_UNWRAP_DEPTH=10` + fail-closed sentinel).

**P1 (all 5 FIXED):**
- OH-3.2-anchor-mismatch-reports-success: FIXED. `file_hash_edit.execute` throws on `applied===false` (`src/index.ts:679`); `ast_structural_rewrite` same pattern; library `failResult`/`modified:false` return shapes preserved for direct API use. Pinned by `test/plugin.test.ts` mismatch-throw tests.
- OH-6.4-task-owned-shell-bypass: FIXED. Rule 5 shell leg enforces `taskOwnedPaths` against redirect/tee targets (`rule-5-task-owned-paths`).
- OH-6.5-find-exec-unwrapped: FIXED. `find . -exec rm -rf / \;` → destructive via `findExecPayloads` unwrap (live-probed); `find / -delete` handled.
- OH-6.6-single-word-mcp-server: FIXED. Fail-closed `KNOWN_SAFE_TOOL_NAMES` allowlist; `tavily_search`→true (tainted), `file_hash_read`/`bash`→false. Live-probed.
- OH-6.3-src-prefix-untested: FIXED. Split ids `rule-3a-qa-src-lock` (src/**) vs `rule-3b-qa-allowlist`; QA edit `src/a.test.ts` pinned to the src rule — the old sabotage now goes RED (QA S-3a: 2 fail).

**P2 (all 7 FIXED):**
- OH-2.4-prompt-hook-reads-absent-system: FIXED via allowed repurpose option — hook sanitizes upstream prompt text (`sanitizeCompactionPseudoTranscript`, handles string + parts-array shapes), skips compaction agents, keeps `system` calibration only when the host provides it. Pinned by `test/host-contract.test.ts` upstream-shaped (system-less) test.
- OH-4.6-bare-auth-retry-untested: FIXED. Bare-`auth` type-only AND message-only pins added (`test/wave7-systems.test.ts:180-197`); QA S-4.6 re-run goes RED.
- OH-7.2-multiline-empty-catch-missed: FIXED. Brace-depth tracking after `catch … {` opener (≤50 lines); single-line + split-brace fixtures both detected (2 smells, exact lines per `test/plugin-interceptors.test.ts`).
- OH-2.1-shipped-host-test-too-thin: FIXED. Host test extended to all-tool execution, Code Mode companion, all hooks firing, determinism/compaction/affinity, scope-close unload (0 tools/hooks) + reload (14, exactly once); README paragraph rewritten to match.
- OH-8.2-readme-tuple: FIXED. README shows `{package, options}` object form under `plugins` with explicit tuple-drop warning.
- OH-8.3-staff-roles: FIXED. `staff-backend` + `staff-ui` in known roles (`permission-guard.ts:89-90`) with builder policy; probed green in suite.
- OH-scope-loc-budget: FIXED as report-only. `scripts/check-loc.sh` + CI step; revised budget raw ≤12000 / stripped ≤10000 with rationale; current 10844/9158 within budget, exit 0, never fails the build.

**P3 (2 trivial FIXED, 2 informational DECISIONED — all acceptable):**
- OH-1.1-readme-version: FIXED — title now `v1.0.9`.
- OH-1.1-no-gh-release / OH-deps-caret: no code change per report's own remediation (no violated requirement; npm + tag is the install path; `^` ranges idiomatic with `bun.lock` pin + clean OSV). Decision rationale recorded in programmer report. Accepted.

No regressions: full suite 292/292 green, all 7 accept waves + wave-8 green, post-sabotage restore verified green.

VERDICT: PASS
