# audit-remediation-E — Programmer Stage Report

**Stage:** `audit-remediation-E` (follow-up to audit `2026-10-18`, baseline `9715874`)
**Branch:** `audit-remediation-E`
**Worktree:** `/home/john/Projects/Heretek-AI-Rebuild/opencode-harness/worktrees/audit-remediation-E`
**Role:** `agency-programmer` (implementation + tests only; no release operations performed)

## Summary

Implemented the primary P2 code fix **OH-4.8-unranked-modification-blindspot**
(full-set before-digests + fail-closed degraded receipts), the narrowed P2
follow-up **OH-6.6-taint-fork-gap** (adapter-level after-mirror end-to-end pins;
no new in-process hook surface exists beyond remediation-D), and the P3
hardening **OH-6.6-taint-name-squat** (MCP-provenance predicate + ingestion
wiring + documented residual). Kept **OH-scope-loc-budget** gated and net-small
(+43 raw / +38 stripped, cap unchanged 12100/10100), and verified **OH-1.3 /
OH-1.1 / OH-1.1-no-gh-release** (prepare-only, no bump/tag/publish) and
**OH-deps-caret** (no-op, verified clean) per the stage brief.

## Files changed

| File | Change |
|------|--------|
| `src/muse/muse-calibration.ts` | New `createDegradedMutationReceipt(sessionId, reason)` — fail-closed receipt (`changedFiles="0" status="degraded"` + sanitized reason comment) for scan errors / missing snapshots; pure string building, never throws. Reason sanitizer strips `<>`/`&`/quotes and collapses `--` runs (single hyphens preserved: `no-before-snapshot` stays readable). Doc comments on `diffNewWorkspaceFiles`/`listWorkspaceRelPaths` tightened (no behavior change). Auto-wired via existing `export *` in `src/index.ts`. |
| `src/host/contract-adapter.ts` | OH-4.8: before-snapshot now digests the FULL `listWorkspaceRelPaths` file set instead of top-500 ranked code files (500 cap stays on the RepoMap display only); `buildRepoMap` import dropped (still used by `architecture-advisor.ts`/`index.ts`). Redundant `preSubagentFileSetBySession` map removed — digest keys ARE the complete pre-execution set, so `diffNewWorkspaceFiles(new Set(beforeDigests.keys()))` is exactly equivalent (-6 lines). New `preSubagentDegradedBySession` marker: scan error or missing snapshot emits `status="degraded"` instead of a silently-empty receipt (also on failed tools, since scan failure is independent of tool outcome); normal receipts stay success-gated (unchanged behavior). OH-6.6-squat: ingestion arming is now `isUntrustedIngestionTool(toolName) \|\| isMcpProvenanceEvent(event)` — bare-name behavior unchanged, marked squats newly arm. |
| `src/guards/taint-guard.ts` | OH-6.6-squat: `KNOWN_SAFE_TOOL_NAMES` gains the documented residual note (bare-name-only matching; exact-match hostile id returns `taint=false` until upstream plumbs a marker). New `isMcpProvenanceEvent(event)` — exact-key MCP origin markers only (`mcpServer`/`mcpServerId`/`mcp_server`/`mcpToolId`/`mcp_tool` keys; `origin`/`source`/`provider`/`namespace` values exactly `mcp`); arg values and substrings never count; absent markers return `false`; never throws. Pre-existing verbose docs tightened (zero behavior change) to hold the LOC cap. |
| `test/audit-20261018-remediation.test.ts` | 3 new `describe` blocks, 11 tests: OH-4.8 (audit-proof repro through the real adapter path, isolated-modify `changedFiles="1"`, modify+delete `after="deleted"`, missing-snapshot degraded pin, sanitizer unit pin); OH-6.6-fork-gap E (after-only fork metadata links + denies `TAINT-NET-2`; clean fork allows); OH-6.6-squat E (bare-matrix pin, marker matrix pin, squat-composition residual pin, never-throws pin). One line initially tripped the wave-1 `grep '||' … grep 'true'` stub-scan; restructured to assert legs separately (scan now clean, coverage equivalent). |
| `scripts/check-loc.sh` | Budget-history comment only: `audit-remediation-E` entry (cap unchanged 12100/10100, +43/+38 rationale). No logic change; CI wiring byte-identical (`.github/workflows/ci.yml:23-24`). |
| `docs/reports/audit-remediation-E.md` | This report. |

NOT touched (per brief): `package.json`, `bun.lock` (OH-deps-caret no-op —
verified untouched via `git status`); version stays `1.0.11` (`package.json:3`
== `src/version.ts:5`, `test/bootstrap.test.ts` green); no tags, no publish,
no GitHub releases. `src/interceptors/session-interceptors.ts` untouched —
remediation-D linkage already maximal for the in-process surface (upstream
`SessionHooks` has no fork/revert event per the audit at head `214fb7f`).

Invariants preserved: junk/self/empty link nothing; forged-clean-parent
allows like no-link; direct child taint denies despite clean-parent link;
visited-set termination untouched; never-throw readers untouched; the 12/12
arm / 9/9 clean bare-name matrix untouched (`isUntrustedIngestionTool`
unmodified — wave8 matrix green); EXT-4.8 ranked-code + created-file coverage
untouched (wave8/ported tests green); all modules stay wired into
`src/index.ts` (`export *` picks up both new functions).

## Gate outputs (all commands run in the worktree)

| Gate | Command | Result |
|------|---------|--------|
| Typecheck | `bun run check` | exit 0 |
| Full suite (override tmp) | `TMPDIR=/dev/shm bun test` | **391 pass / 2 fail** across 16 files (2132 expects). The 2 failures are the two KNOWN `TMPDIR`-override artifacts (`OH-6.5-redirect-escape … workspace-relative and OS-temp targets`, `OH-6.5-cp-mv-argv-targets … absolute-source …`), identical to baseline/D — pre-existing, unrelated to this diff (neither touches receipt/taint/provenance paths). |
| New E tests | `TMPDIR=/dev/shm bun test test/audit-20261018-remediation.test.ts -t "audit-remediation-E"` | **11 pass / 0 fail** |
| Fork matrix | `TMPDIR=/dev/shm bun test … -t "taint-fork-gap"` | **12 pass / 0 fail** (10 D + 2 E) |
| Wave-1 accept | `TMPDIR=/dev/shm bash scripts/accept/wave-1.sh` | `WAVE 1 ACCEPT: ALL GATES GREEN` |
| Wave-2/3 accept | `TMPDIR=/dev/shm bash scripts/accept/wave-2.sh` (resp. `wave-3.sh`) | Full-suite step reports the same 2 known artifacts (baseline audit itself was 380/2, so this step cannot pass under TMPDIR override at baseline either); every other gate inside (typecheck, stub/scope/export scans, invariant coverage) passes. |
| LOC tracking | `bash scripts/check-loc.sh` | `files=22 raw=12089 (budget 12100) stripped=10024 (budget 10100)` — exit 0 |
| LOC hard gate | `bash scripts/check-loc.sh --fail-over=12100 --fail-over-stripped=10100` | within-cap on both, exit 0 |
| Build | `bun run build` | exit 0 (`tsc -p tsconfig.build.json`) |
| Audit proof (verify-the-fix) | `TMPDIR=/dev/shm bun -e` verbatim proof shape through `wireOpenCodeV2PromiseContext` | `changedFiles="3"` with `notes.txt before="5891b5b522d5df08" after="e258d248fda94c63"`; `code.ts`/`brand-new.txt` SHAs byte-identical to the audit raw (`037ecd1db38c230c`, `7aa7a5359173d05b`) |
| Isolated-modify variant | same harness, only `notes.txt` mutated | `changedFiles="1"` (was `"0"`) |
| Modify+delete variant | `config.json` modified + `notes.txt` deleted | `changedFiles="2"`, `notes.txt after="deleted"` |
| Registry (read-only) | `npm view @heretek-ai/opencode-harness dist-tags.latest` | `1.0.9` — confirms OH-1.3/OH-1.1 still open, pending HUMAN release |
| Deps | `bun audit` | `No vulnerabilities found (checked 40 packages)`; `package.json` carets + `bun.lock` untouched (no `deprecated` pins per D verification, unchanged since) |

## Sabotage-readiness notes (for QA)

- Programmer-run live sabotage (all on `src/host/contract-adapter.ts`,
  restored via reverse edits, green re-verified): reverted the before-block to
  ranked-only (`buildRepoMap(workspaceRoot, 500)` + ranked digests) →
  `TMPDIR=/dev/shm bun test … -t "unranked-modification-blindspot"` RED 3/5
  (receipt shows only `code.ts`, `changedFiles="1"`; `notes.txt` invisible;
  delete variant misses the deletion) — exactly the filed blind spot. The 2
  degraded-path tests stay green under this sabotage (correct: that path is
  untouched by it).
- Suggested further red-proofs: (1) delete the `isMcpProvenanceEvent(event)`
  disjunct → marked-squat test RED; (2) neuter `recordSessionForkLink` →
  all fork tests RED; (3) replace a degraded push with `appendBlocks.push("")`
  → missing-snapshot test RED (empty receipt). All restore via `git checkout --`
  on the single file.
- Residual-honesty pins assert `allow` for silent forks and bare squats — they
  pin documented limitations, not fixes; QA must NOT file them as regressions.

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
  only for build/test/accept/pack/view/audit + `git` ops; no file content was
  read or written through the shell (proof replications ran via `bun -e`
  against `src/`, writing only to `/dev/shm` scratch dirs).
- Zero stubs/vacuous tests: no `TODO`, no `|| true` (the one `||`+`true`
  same-line collision in a test was restructured, wave-1 stub-scan green), no
  `test.skip`, no empty `catch` (both new `catch` blocks push degraded
  receipts — functional fail-closed handling), no dummy passes.
- No forbidden surfaces added (no WebUI/HTTP/daemon/worktree/engine code);
  `ci.yml` gate wiring byte-identical; README LOC note (`~12.0k/~10.0k`)
  left as-is — 12089/10024 still within rounding.
- `git status` shows only the 5 intended stage files + this report (6 files total).
