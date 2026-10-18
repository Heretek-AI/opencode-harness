# Audit Remediation F — Stage Brief (follow-up to `AUDIT_REPORT_FINDINGS.md` @ `6d6a76b`)

**Stage ID:** `audit-remediation-F`
**Baseline:** `6d6a76b49a82ffb8e7280ed1c9c79367b0e6e0ad` ("Add drift-guard verification: VERDICT PASS + QA ACCEPT evidence (audit remediation E)")
**Branch:** `audit-remediation-F`
**Worktree:** `/home/john/Projects/Heretek-AI-Rebuild/opencode-harness/worktrees/audit-remediation-F`
**Date (UTC):** 2026-10-18
**Scope:** Single-session OpenCode v2 in-process plugin ONLY (`@heretek-ai/opencode-harness`). WebUIs, HTTP servers, multi-agent DAG schedulers, git worktree managers, epistemic research engines are FORBIDDEN — refuse immediately if requested. See `/home/john/Projects/Heretek-AI-Rebuild/opencode-harness/AGENTS.md` Hard Refusal Rule.

> Coordinator note: this brief lives at `/home/john/Projects/Heretek-AI-Rebuild/opencode-harness/docs/evidence/audit-remediation-F/stage-brief.md`
> (main checkout; the coordinator role cannot write to the locked `docs/prompts/` contract path, so the stage prompt is issued here on the
> writable report/evidence surface). It does NOT replace any contract file — read all mandatory files below IN FULL from disk.

## 0. MANDATORY READS (read every file below IN FULL from disk before acting — zero summarization)

1. `/home/john/Projects/Heretek-AI-Rebuild/opencode-harness/AGENTS.md` — operating contract (vanilla tool hygiene, zero stubs, triad gate, build commands, invariants).
2. `/home/john/Projects/Heretek-AI-Rebuild/opencode-harness/docs/prompts/SPEC.md` — full build specification.
3. `/home/john/Projects/Heretek-AI-Rebuild/opencode-harness/docs/prompts/verify-stage.md` — drift reviewer checklist (programmer: awareness only; you do NOT write the verification report).
4. `/home/john/Projects/Heretek-AI-Rebuild/opencode-harness/MASTER_BUILD_PROMPT.md` — master coordinator prompt, Sections 1–4.
5. `/home/john/Projects/Heretek-AI-Rebuild/opencode-harness/AUDIT_REPORT_FINDINGS.md` — the FULL audit to remediate (423 lines, 9 findings: 1xP0, 2xP1, 2xP2, 4xP3). Read every finding, every proof block, every raw-output block, every remediation diff, every verify-the-fix command, and the Not Audited / Unverifiable section in full. Do NOT act on a paraphrase.
6. `/home/john/Projects/Heretek-AI-Rebuild/opencode-harness/docs/reports/audit-remediation-E.md` — format precedent for your stage report (read in full).
7. This brief: `/home/john/Projects/Heretek-AI-Rebuild/opencode-harness/docs/evidence/audit-remediation-F/stage-brief.md`.

Note: there is NO `00-shared-context.md` in this repo; `AGENTS.md` is the shared context (as recorded in `docs/reports/audit-remediation-E-verification.md:8`).

## 1. FINDINGS TO REMEDIATE (verbatim source of truth = `AUDIT_REPORT_FINDINGS.md`)

### F1 (CODE FIX, P1): OH-6.5-tilde-user-target-escape — `~user/`/`~+`/`~-` shell targets escape workspace containment
- **Location:** `src/guards/permission-guard.ts:516` — `shellTargetEscapesWorkspace`, currently `if (trimmed === "~" || trimmed.startsWith("~/"))`.
- **Audit remediation diff (DO NOT reword — apply exactly, modulo surrounding context):**
  ```diff
  --- a/src/guards/permission-guard.ts
  +++ b/src/guards/permission-guard.ts
  @@
  -  if (trimmed === "~" || trimmed.startsWith("~/")) {
  +  if (trimmed.startsWith("~")) {
       return true;
     }
  ```
- **Audit rationale (verbatim intent):** fail-closed widening; over-block cost is a literal workspace file named `~foo` (vanishingly rare, same accepted direction as the documented single-quoted-`$` over-block); mid-path `docs/~notes.txt` unaffected since only a leading `~` expands.
- **Audit verify-the-fix (run verbatim after fix):** re-run the proof — all five shapes deny with `rule-0-shell-target-containment`; `bun test test/guards.test.ts test/audit-20261018-remediation.test.ts` stays at baseline; legit `~`-free relative + `/tmp` + `/dev/null` allows unchanged.
- **Proof shapes (must all deny post-fix):** `echo x > ~root/evil`, `echo x | tee ~root/evil`, `cp a.txt ~root/evil`, `mv a.txt ~other/evil`, `echo x > ~+/evil` (plus a `~-` variant). Contrast control: `echo x > ~/evil` already denies `rule-0-shell-target-containment` at baseline.
- **Regression tests (new, in `test/` — test files do NOT count toward the `src/` LOC cap, which measures only `git ls-files src`):** add a `describe` block (in `test/audit-20261018-remediation.test.ts` or `test/guards.test.ts` — one place only) pinning: all five `~user/`/`~+`/`~-` shapes deny `rule-0-shell-target-containment` for role `builder` tool `shell`; `~` and `~/` still deny; legit controls still allow (relative `notes.txt`, `/tmp/x`, `/dev/null`). Tests must be non-vacuous (fail on the pre-fix predicate, pass post-fix — QA will red-proof this).
- **LOC constraint:** this change is net-zero in `src/` (one predicate line shortened). Do NOT add net-new `src/` lines for this fix. Confirm `bash scripts/check-loc.sh` and `bash scripts/check-loc.sh --fail-over=12100 --fail-over-stripped=10100` both exit 0.

### F2 (CODE FIX, P3): OH-2.6-stale-metapath-comment — calibration comment cites a moved upstream path
- **Location:** `src/muse/muse-calibration.ts:9` (comment), currently `` `packages/core/src/system-prompt/meta.txt` ``.
- **Audit remediation diff (apply exactly):**
  ```diff
  --- a/src/muse/muse-calibration.ts
  +++ b/src/muse/muse-calibration.ts
  @@
  -   * three failure modes in OpenCode V2's default `packages/core/src/system-prompt/meta.txt`:
  +   * three failure modes in OpenCode V2's default `packages/core/src/plugin/system-prompt/meta.txt`:
  ```
- **Audit verify-the-fix:** `rg 'plugin/system-prompt/meta.txt' src/muse/muse-calibration.ts` hits.
- **Constraint:** comment-only change; zero behavior change; LOC-neutral by construction.

### F3 (PREPARE-ONLY, P0+P1+P3 release identity): OH-1.3-stale-npm-latest + OH-1.1-unreleased-1.0.11 + OH-1.1-no-gh-release
- **Status:** OPEN pending HUMAN release — programmer performs NO release operations (hard limit carried over from every prior remediation wave and from the audit's Not Audited publish-gate entry).
- **Forbidden in this stage (fail closed):** `npm publish`, `npm version`, `git tag`, `git push`, `git push --tags`, `gh release create`, or any GitHub write. Version stays `1.0.11` (`package.json:3` == `src/version.ts:5`, `test/bootstrap.test.ts` green).
- **Required:** read-only verification only — `npm view @heretek-ai/opencode-harness dist-tags.latest` (expect `1.0.9`, confirming still-open), `git tag --list 'v*'`, `git rev-parse v1.0.11` (expect fatal), `git log --oneline v1.0.9..HEAD | wc -l`.
- **Required:** HUMAN-ONLY release checklist in the stage report (exact commands, unexecuted): `make check && make accept && make host-test && bun run build`, `npm version patch` (1.0.11 → 1.0.12), `git tag v1.0.12 && git push --tags`, `npm publish --provenance --access public`, `npm view … dist-tags.latest` (expect 1.0.12), `gh release create v1.0.12 --generate-notes`, plus post-publish verify (`grep -c UNRESOLVED_NESTING_SENTINEL package/dist/guards/shell-parse.js` non-zero).

### F4 (DOCUMENT-ONLY, P2): OH-6.6-taint-fork-gap — no parent-link hook for host-level session fork/revert
- **Status:** narrowed by remediation D+E, residual silent-fork gap stays OPEN by upstream design (no fork/revert event in `SessionHooks` at either pin `ed772f5` or head `da9d436`; fork is a DB-level `SessionEvent.Forked → projectFork` projection invisible to the promise-plugin hook surface).
- **Action:** NO new in-process workaround in this wave (LOC cap is 99.9% full — 11 lines headroom — and further workarounds risk overreach past the upstream boundary). Verify the remediation-E plumbing is intact and green (evaluate-time 4th-param + headers holder + headerless `model.request` link, fork-matrix tests). Document the residual honestly in the stage report with the host MUST-call note (`recordSessionForkLink(child, parent)` at fork time). Do NOT claim silent-fork closure.

### F5 (DOCUMENT-ONLY, P3): OH-6.6-taint-name-squat — MCP discovery id squatting a safe tool name
- **Status:** OPEN hardening item (17/17 bare squat variants bypass; marked-provenance arms via remediation-E `isMcpProvenanceEvent`; fix needs registry lookup or upstream marker plumbing, not a one-liner).
- **Action:** NO logic change in this wave. Verify remediation-E hardening intact (`isMcpProvenanceEvent` + ingestion wiring + residual note next to `KNOWN_SAFE_TOOL_NAMES`). Document residual honestly. Do NOT claim closure.

### F6 (NO-OP VERIFY, P3): OH-deps-caret — caret ranges float minors (lockfile-pinned, informational)
- **Action:** none required. Verify `package.json`/`bun.lock` untouched (`git diff -- package.json bun.lock` empty), `bun audit` clean, no `deprecated` pins. Report as informational.

### F7 (GATE, P2): OH-scope-loc-budget — 12089 total vs 3–5k blueprint, self-cap 99.9% full
- **Baseline:** `files=22 raw=12089 (budget 12100) stripped=10024 (budget 10100)` (`bash scripts/check-loc.sh` exit 0).
- **Constraint:** net-zero-or-negative `src/` delta for this wave (F1 shortens one line, F2 rewrites one comment line, zero new `src/` lines). Record `bash scripts/check-loc.sh` and `bash scripts/check-loc.sh --fail-over=12100 --fail-over-stripped=10100` outputs (both must exit 0). Do NOT revise the budget, do NOT split scope, do NOT touch `scripts/check-loc.sh` logic or `.github/workflows/ci.yml:23-24` wiring in this wave.

## 2. TARGET FILES (absolute paths, all under the worktree `/home/john/Projects/Heretek-AI-Rebuild/opencode-harness/worktrees/audit-remediation-F/`)

- `src/guards/permission-guard.ts` (F1 fix)
- `src/muse/muse-calibration.ts` (F2 fix)
- `test/audit-20261018-remediation.test.ts` (F1 regression tests; or `test/guards.test.ts` — one place only)
- `docs/reports/audit-remediation-F.md` (stage report — this stage's primary output, written inside the worktree so it commits on the branch)
- All other `src/` files: READ-ONLY unless a gate forces a touch (justify any extra touch line-by-line in the report).

## 3. ACCEPTANCE CRITERIA (all must hold)

1. `bun run check` exits 0 (`tsc --noEmit` clean).
2. `bun test` full suite: all previously-green tests stay green. Known-environment caveat: if `/tmp` is degraded the 2 known TMPDIR-allowlist rows may fail — run stock first; if stock is red for environment reasons, re-run with `TMPDIR=/dev/shm` and report BOTH numbers honestly plus a `git stash` baseline control (per remediation-E precedent). Zero NEW failures vs baseline either way.
3. Targeted: `bun test test/guards.test.ts` green; new F1 regression block green (and RED on pre-fix predicate — self-prove by temporarily reverting the one-line predicate, observing RED, restoring, re-greening, logging it).
4. `bash scripts/accept/wave-1.sh` exits 0 (guards/shell-parse lane). Waves 2–8 / `make accept`: run and report honestly (TMPDIR-artifact caveat applies identically at baseline).
5. `bash scripts/check-loc.sh` exits 0 AND `bash scripts/check-loc.sh --fail-over=12100 --fail-over-stripped=10100` exits 0 (raw ≤ 12100, stripped ≤ 10100).
6. `bun run build` exits 0.
7. F1 audit proof re-run: all five tilde shapes deny `rule-0-shell-target-containment`; `~`/`~/` still deny; legit relative + `/tmp` + `/dev/null` allow.
8. F2 `rg` check hits the corrected `plugin/` path.
9. Stub/scope scans clean: `TODO` zero hits in `src/`+`test/`; `test.skip|describe.skip|it.skip|xit(|xdescribe(` zero real hits; empty-`catch {}` zero hits; `|| true` / `set +e` / `cmd: "true"` / `echo "passed"` zero hits outside scanner self-patterns (justify any hit); no WebUI/HTTP/daemon/scheduler/worktree-manager/research-engine strings in `src/` outside scanner/comment documentation (justify any hit); every touched `src/` export stays wired into `src/index.ts`.
10. `git status --short` in the worktree shows ONLY intended files (2 `src/` fixes + test file + stage report). `package.json`, `bun.lock`, `src/version.ts`, `scripts/check-loc.sh`, `.github/workflows/ci.yml` untouched (prove with `git diff --` on each).
11. NO release operations performed (prove: `git tag --list 'v*'` max still `v1.0.9`; no `npm publish`/`npm version` in history; version still `1.0.11`).

## 4. TOOL HYGIENE & PROHIBITED PATTERNS (from `AGENTS.md`, binding)

- Vanilla `read`/`write`/`edit`/`glob`/`grep` for ALL file content. NEVER `bash` (`cat`/`sed`/`awk`/`echo >`/heredocs/`printf >`) to read or write source files. `bash` ONLY for build/test/accept commands (`bun install`, `bun run check`, `bun test`, `make check`, `make accept`, `bash scripts/accept/wave-N.sh`, `bash scripts/check-loc.sh`, `bun run build`, `npm view` read-only, `rg`/`grep` scans) and `git` ops (`git status`, `git diff`, `git log`, `git checkout --`).
- When calling `edit`, NEVER copy line-number prefixes from `read` output into `oldString`/`newString`. Compare line-by-line before invoking.
- Zero stubs: no `TODO`, no `|| true`, no `test.skip`, no empty `catch {}`, no dummy `return true`, no swallowed errors. Every module 100% implemented and wired into `src/index.ts`.
- Programmer spawns NO subagents (implement directly).

## 5. STAGE REPORT (write inside the worktree to `docs/reports/audit-remediation-F.md`)

Include: summary, per-finding files-changed table, gate outputs table (command + exit code + numbers), audit-proof re-runs (commands + outputs), sabotage-readiness notes for QA (exact revert → RED predictions), HUMAN-ONLY release checklist (unexecuted), self-audit (tool hygiene, zero stubs, scope refusal, git status). Follow `docs/reports/audit-remediation-E.md` structure as the format precedent.

## 6. HARD LIMITS (fail closed)

- Single-session plugin ONLY. Refuse WebUI/HTTP/daemon/scheduler/worktree-manager/research-engine work with a descriptive message.
- No `npm publish`, `npm version`, `git push`, `git tag`, `gh release create`. No tags, no GitHub writes, no registry writes.
- No merge to `main`. Commit on the `audit-remediation-F` branch in the worktree only.
