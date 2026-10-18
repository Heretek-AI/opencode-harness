# Drift-Guard Verification — stage `audit-remediation-E`

**Role:** `agency-drift-guard` (independent adversarial audit; no code changed, no commits made)
**Worktree:** `/home/john/Projects/Heretek-AI-Rebuild/opencode-harness/worktrees/audit-remediation-E`
**Branch:** `audit-remediation-E` · **HEAD:** `88bdfe0` (programmer commit on baseline `9715874`)
**Diff audited:** `9715874..88bdfe0`, 6 files (`src/guards/taint-guard.ts`, `src/host/contract-adapter.ts`, `src/muse/muse-calibration.ts`, `test/audit-20261018-remediation.test.ts`, `scripts/check-loc.sh`, `docs/reports/audit-remediation-E.md`)
**Date (UTC):** 2026-10-18
**Read in full before acting:** `AGENTS.md`, `docs/prompts/SPEC.md`, `docs/prompts/verify-stage.md`, `MASTER_BUILD_PROMPT.md`, `AUDIT_REPORT_FINDINGS.md`, `docs/reports/audit-remediation-E.md`, `docs/evidence/audit-remediation-E/audit-remediation-E-qa.md`, `docs/evidence/audit-remediation-E/red-proofs.log`. (No `00-shared-context.md` exists in this repo; `AGENTS.md` is the shared context. QA report read at its actual `docs/evidence/` path per the permission-hook note.)

## 1. Gates run (exact commands + exit codes, all in the worktree)

| Gate | Command | Result |
|------|---------|--------|
| Typecheck | `bun run check` | exit 0 (`tsc --noEmit` clean) |
| Full suite | `TMPDIR=/dev/shm bun test` | **391 pass / 2 fail** (2132 expects, 393 tests, 16 files). The 2 failures are the 2 KNOWN `TMPDIR`-override artifacts (`OH-6.5-redirect-escape workspace-relative and OS-temp targets`, `OH-6.5-cp-mv-argv-targets absolute-source`), identical to baseline/D per the audit (baseline itself was 380/2; failure is `os.tmpdir()` allowlist expecting `/tmp`, product-correct under `/dev/shm`). `bun` itself exits 1 on this step — solely due to those 2 pre-existing artifacts, NOT this diff (neither touches redirect/cp-mv paths). |
| Wave-1 accept | `TMPDIR=/dev/shm bash scripts/accept/wave-1.sh` | `WAVE 1 ACCEPT: ALL GATES GREEN`, exit 0 |
| LOC tracked | `bash scripts/check-loc.sh` | `files=22 raw=12089 (budget 12100) stripped=10024 (budget 10100)`, exit 0 |
| LOC hard gate | `bash scripts/check-loc.sh --fail-over=12100 --fail-over-stripped=10100` | within-cap both, exit 0 |
| Build | `bun run build` | exit 0 (`tsc -p tsconfig.build.json`) |
| Targeted E tests | `TMPDIR=/dev/shm bun test test/audit-20261018-remediation.test.ts -t "audit-remediation-E"` | 11 pass / 0 fail |
| Fork matrix | `... -t "taint-fork-gap"` | 12 pass / 0 fail (10 D + 2 E) |
| Squat | `... -t "squat"` | 4 pass / 0 fail |
| KV-cache | `TMPDIR=/dev/shm bun test test/context-budget.test.ts` | 23 pass / 0 fail |
| Bootstrap/version | `TMPDIR=/dev/shm bun test test/bootstrap.test.ts` | 1 pass / 0 fail |

Wave-2/3 accept scripts were NOT required to exit 0 by the stage brief (their full-suite step inherits the same 2 TMPDIR artifacts that fail at baseline too); QA already documented this honestly. Wave-1 — the gate relevant to guards/shell-parse — is fully green.

## 2. Stub / shortcut scan (zero-stubs enforcement)

Grep patterns run over `src/` + `test/` (+ `scripts/` where noted):

- `TODO` → **zero hits** in `src/` `test/`.
- `test.skip|describe.skip|it.skip|xit(|xdescribe(` → single hit `test/wave8-audit.test.ts:121` inside a `"node -e \"process.exit(0)\""` fixture string (a child-process payload under test, not a skipped test). **Not a stub.**
- `\|\| true|set \+e` → only hits are the wave-8 accept scanner's own pattern strings (`scripts/accept/wave-8.sh:81-82`, self-referencing scanner documentation). **Not a stub.**
- `cmd: "true"|echo "passed"` → only the wave-8 scanner's own pattern string (`wave-8.sh:84`). **Not a stub.**
- Empty `catch {}` / `catch (e) {}` (PCRE `catch\s*\([^)]*\)\s*\{\s*\}`) → **zero hits**. Both new `catch` blocks in the receipt path push degraded receipts (functional fail-closed handling, verified by reading the diff).
- Hardcoded vacuous `return true` → ~70 hits, ALL conditional guard/classifier logic returns (shell-parse flag checks, permission-guard allows, SSG/loopback classifiers, taint-guard matcher legs). Spot-checked `src/guards/taint-guard.ts:106,109,118,128,134,157,161` — each is inside a predicate with real branching; none is an unconditional dummy pass.
- Empty function bodies → none found; new exports `isMcpProvenanceEvent` (pure marker matcher, ~25 lines) and `createDegradedMutationReceipt` (string builder with sanitizer) are fully implemented and unit-pinned (never-throws + sanitizer tests).

**Result: zero production stubs. Scan PASS.**

Wiring check: every `src/**/*.ts` export touched by this diff stays wired — both new functions are picked up via existing `export *` in `src/index.ts` (`export * from "./guards/taint-guard.js"` line 81, `export * from "./muse/muse-calibration.js"` line 91, `export * from "./host/contract-adapter.js"` line 94). `buildRepoMap` import dropped from `contract-adapter.ts` but still used by `architecture-advisor.ts`/`index.ts` — no orphan, no unwired module.

## 3. KV-cache invariants spot-check

- `test/context-budget.test.ts` green (23/0).
- Diff does not touch `src/context/context-budget.ts`; `injectContextBudgetIntoMessages` semantics unchanged (event.system untouched, append to last `role === "user"`, lessons sorted by `id.localeCompare`, zero float scores/timestamps). **PASS.**

## 4. Scope refusal check

- Grep for `listen(|createServer|express(|fleet|daemon|worktree-manager|epistemic|fastify|koa(` over `src/ scripts/ test/` → hits ONLY in accept-script scanner patterns (the scanners themselves) and doc comments stating out-of-scope. **Zero forbidden surfaces. PASS.**
- `getRecommendedMcpConfig()` (`src/ui-auditor/mcp-defaults.ts:30-43`) returns EXACTLY `lsp-mcp-server` (`bunx`) + `fallow-mcp` (`npx --yes --package fallow`) — no extra servers. File untouched by this diff. **PASS.**

## 5. Independent sabotage test (DISTINCT from QA's four)

QA's sabotages: (1) `.ts`-only before-filter, (2) `SESSION_FORK_MAP` self-link, (3) `isMcpProvenanceEvent → return false`, (4) version `9.9.9-sabotage`. Mine is a fifth, line-precise one-guards break on a file QA did not sabotage:

- **Sabotage:** `src/guards/permission-guard.ts:660` `if (path === "src" || path.startsWith("src/")) {` → `if (path === "src-internal/" || path.startsWith("src-internal/")) {` (QA red-team `src/**` lock neutered; allows `qa-adversary` to edit `src/index.ts`).
- **Result:** `TMPDIR=/dev/shm bun test test/guards.test.ts` → **39 pass / 2 fail, exit 1** — RED confirmed (`permission-guard Rule 3 ... denies QA edits on allowlisted-under-src paths` fails, plus one cascade leg naming the src rule).
- **Restore:** `git checkout -- src/guards/permission-guard.ts` → byte-identical to pre-sabotage backup (`diff -q` clean); `git status --short` shows only untracked `docs/evidence/audit-remediation-E/` (QA outputs), zero tracked modifications.
- **Re-green:** `TMPDIR=/dev/shm bun test test/guards.test.ts` → **41 pass / 0 fail**.

Fail-closed behavior proven on an independent axis. **PASS.**

## 6. Adversarial review, finding by finding

- **OH-4.8 (P2 primary).** Fix verified live through the real adapter path (`wireOpenCodeV2PromiseContext`): full 3-file variant → `changedFiles="3"` with `notes.txt before="5891b5b522d5df08" after="e258d248fda94c63"` and `code.ts`/`brand-new.txt` SHAs byte-identical to the audit raw (`037ecd1db38c230c`, `7aa7a5359173d05b`); isolated-modify → `changedFiles="1"` (was `"0"`); modify+delete → `changedFiles="2"`, `notes.txt after="deleted"`. Degraded path (missing snapshot / scan error → `status="degraded"` instead of silent-empty) is unit-pinned and the sanitizer pin holds. 12/12 arm + 9/9 clean + EXT-4.8 ranked/created coverage untouched per programmer report; targeted `-t "OH-4.8"` 5/0 observed via QA log and the full-E filter 11/0 re-run here. No over-claim of silent-fork closure in this finding's scope. **FIX CONFIRMED.**
- **OH-6.6-taint-fork-gap (P2 narrowed).** After-mirror E2E pins re-run here: 12/0 fork matrix; live function-level check: tainted parent → linked child `ssh evil.com` → `deny`; clean unlinked child → `allow` (no over-taint); silent no-metadata child `getSessionParent → undefined` → `allow` — the residual stays **documented and pinned as `allow`, not closed**, exactly as the audit demands (upstream `SessionHooks` still has no fork/revert event). The report does not claim silent-fork closure — had it done so, this would be FAIL; it does not. **NARROWED FIX + HONEST RESIDUAL CONFIRMED.**
- **OH-6.6-taint-name-squat (P3).** Live: built-ins `file_hash_read`/`read`/`shell` → `taint=false` (unchanged bare-name behavior, wave8 matrix green per report); marked event (`metadata.mcpServer`) → `isMcpProvenanceEvent true` → arms; bare exact-name squat with no marker → `false` — pinned residual, explicitly documented next to `KNOWN_SAFE_TOOL_NAMES`, NOT filed as regression by anyone. `isUntrustedIngestionTool` itself unmodified, so no regression surface. **HARDENING + HONEST RESIDUAL CONFIRMED.**
- **Release identity (OH-1.3 P0 / OH-1.1 P1 / OH-1.1-no-gh-release P3).** `package.json:3` == `src/version.ts:5` == `1.0.11`; `git tag --list` max `v1.0.9`; `git rev-parse v1.0.12` fatal (no tag); `git diff 9715874..HEAD -- package.json bun.lock src/version.ts` empty (untouched); `git log v1.0.9..HEAD` = 15 (14 baseline + 1 E). No bump/tag/publish performed — prepare-only held, HUMAN-ONLY checklist present and unexecuted. OH-1.3/OH-1.1/no-gh-release correctly remain OPEN pending human release. **HARD LIMIT RESPECTED — PASS.**
- **Informational (OH-deps-caret, OH-scope-loc-budget).** `package.json` carets + `bun.lock` untouched; LOC `12089/10024` vs caps `12100/10100` — tracked exit 0 AND `--fail-over` exit 0, delta +43/+38 net-small with cap unchanged, CI wiring byte-identical. 99.6%→~99.9% full is noted but the gate the repo set for itself passes; no LOC-cap breach. **PASS.**

No dropped matrix, no over-claim found, no release operation performed, no LOC breach.

## 7. Final state

`git status --short` shows only untracked `docs/evidence/audit-remediation-E/` (QA's files); zero tracked modifications outside the 6-file programmer diff + this report; no commits made by this auditor. Write permission exercised solely for this file under `docs/reports/`.

VERDICT: PASS
