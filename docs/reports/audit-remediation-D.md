# audit-remediation-D — Programmer Stage Report

**Stage:** `audit-remediation-D` (follow-up to audit `2026-10-18`, baseline `f56376a`)
**Branch:** `audit-remediation-D`
**Worktree:** `/home/john/Projects/Heretek-AI-Rebuild/opencode-harness/worktrees/audit-remediation-D`
**Role:** `agency-programmer` (implementation + tests only; no release operations performed)

## Summary

Implemented the primary P2 code fix **OH-6.6-taint-fork-gap** (evaluate-time fork-lineage
linkage + headerless `model.request` linkage fix + permission-hook live-event wiring),
kept **OH-scope-loc-budget** gated and net-small (+24 raw / +5 stripped, inside the
remediation-C cap), and verified **OH-1.3 / OH-1.1 / OH-1.1-no-gh-release** (prepare-only,
no bump/tag/publish) and **OH-deps-caret** (no-op, verified clean) per the stage brief.

## Files changed

| File | Change |
|------|--------|
| `src/guards/taint-guard.ts` | `evaluateTaintGuard` gains optional 4th param `eventContext?: unknown`; when provided, calls `linkForkLineageFromEventMetadata(sessionId, eventContext)` first (callee never throws; junk/self/empty link nothing) before `resolveTaintChain`. 3-arg callers unaffected. Doc comment records evaluate-time linkage + residual silent-fork gap + host MUST-call `recordSessionForkLink(child, parent)`. New import of `linkForkLineageFromEventMetadata` from `../interceptors/session-interceptors.js` (cycle-checked: that module imports only `muse-calibration.js`, so no cycle). |
| `src/host/contract-adapter.ts` | Permission-hook `evaluate` taint call (was line 598-602) now passes the live `event` as 4th arg. Only `evaluateTaintGuard` call site in `src/`; `execute.before` (:620) and `execute.after` (:697) mirroring kept as-is. |
| `src/interceptors/session-interceptors.ts` | `applyRootAffinityHeadersInPlace`: moved `linkForkLineageFromEventMetadata(event.sessionID, event)` ABOVE the `if (!event.headers) return undefined` early-return guard, so headerless `model.request` events carrying top-level/`input`/`metadata` fork ids still link. Header rewrites remain guarded. Comments updated with residual honesty. |
| `test/audit-20261018-remediation.test.ts` | `describe OH-6.6-taint-fork-gap` extended 7 → 10 tests (existing 7 untouched and green): (a) evaluate-time linkage — tainted parent, NO prior hook, `evaluateTaintGuard(child, "ssh evil.com", "shell", {metadata:{forkOf:parent}})` denies `TAINT-NET-2` (+ 3-arg sibling compatibility); (b) headerless `model.request` linkage — headerless event links without throwing and taint inherits; (c) silent child with no metadata → `allow` (documents the residual, does NOT claim closure). |
| `scripts/check-loc.sh` | Budget-history comment only: `audit-remediation-D` entry (cap unchanged 12100/10100, +24/+5 rationale, functionality-never-deleted restated). No logic change; CI wiring byte-identical (`.github/workflows/ci.yml:23-24`). |
| `docs/reports/audit-remediation-D.md` | This report. |

NOT touched (per brief): `package.json`, `bun.lock` (OH-deps-caret no-op — verified
untouched via `git status`); version stays `1.0.11` (`package.json:3` == `src/version.ts:5`,
`test/bootstrap.test.ts` green); no tags, no publish, no GitHub releases.

Invariants preserved: junk/self/empty link nothing; forged-clean-parent allows like
no-link; direct child taint denies despite clean-parent link (`TAINT-NET-2` wins);
visited-set cycle termination in `resolveTaintChain` untouched; never-throw reader
(`linkForkLineageFromEventMetadata` try/catch → `undefined`) untouched; all modules
stay wired into `src/index.ts` (re-exports unchanged).

## Gate outputs (all commands run in the worktree)

| Gate | Command | Result |
|------|---------|--------|
| Typecheck | `bun run check` | exit 0 |
| Full suite (override tmp) | `TMPDIR=/dev/shm bun test` | **380 pass / 2 fail** across 16 files (2079 expects). The 2 failures are the two KNOWN `TMPDIR`-override artifacts in `permission-guard.ts` `tmpdir()` allowlist (`/tmp/...` allow-rows deny when `TMPDIR=/dev/shm`): `OH-6.5-redirect-escape … workspace-relative and OS-temp targets` and `OH-6.5-cp-mv-argv-targets … absolute-source …`. Both are pre-existing, unrelated to this diff (neither touches taint/fork paths), and match the audit report's own both-directions note. |
| Stock TMPDIR | `bun test` (no override) | 71 pass / 10 fail — UNVERIFIABLE as predicted: `/tmp` inode exhaustion breaks `mkdtemp`-based tests. Documented, not a product signal. |
| Targeted file | `TMPDIR=/dev/shm bun test test/audit-20261018-remediation.test.ts` | 79 pass / 2 fail (same 2 known artifacts above) |
| OH-6.6 only | `TMPDIR=/dev/shm bun test … -t "taint-fork-gap"` | **10 pass / 0 fail** (7 pre-existing + 3 new) |
| Wave-1 accept | `TMPDIR=/dev/shm bash scripts/accept/wave-1.sh` | `WAVE 1 ACCEPT: ALL GATES GREEN` |
| LOC tracking | `bash scripts/check-loc.sh` | `files=22 raw=12046 (budget 12100) stripped=9986 (budget 10100)` — exit 0 |
| LOC hard gate | `bash scripts/check-loc.sh --fail-over=12100 --fail-over-stripped=10100` | within-cap, exit 0 |
| Build | `bun run build` | exit 0 |
| Fresh pack | `npm pack --pack-destination /dev/shm/pack-D` | `heretek-ai-opencode-harness-1.0.11.tgz` 280232 B (delta vs audit's 279354 B = remediation-D diff, expected) |
| Sentinel | `grep -c UNRESOLVED_NESTING_SENTINEL dist/guards/shell-parse.js` | **11** (matches audit fresh-build count) |
| Publish-gate sabotage | tag-mismatch snippet (`GITHUB_REF_NAME=v9.9.9-sabotage` vs pkg `1.0.11`) | exit 1 (RED as expected) |
| Publish-gate control | tag-match snippet (`v1.0.11`) | `GATE_PASS`, exit 0 |
| Registry (read-only) | `npm view @heretek-ai/opencode-harness dist-tags.latest` | `1.0.9` — confirms OH-1.3/OH-1.1 still open, pending HUMAN release |
| Deps | `bun audit` | `No vulnerabilities found (checked 40 packages)`; `npm view` shows no `deprecated` on `@ast-grep/napi 0.51.0`, `zod 4.6.7`, `playwright 1.64.1`, `@axe-core/playwright 4.14.0`, `typescript 7.0.2` |

## Sabotage-readiness notes (for QA)

- Suggested red-proofs on this diff: (1) remove the 4th arg at the permission-hook call → evaluate-time test (a) RED (`allow` instead of `deny`); (2) move `linkForkLineageFromEventMetadata` back below the headers guard → headerless test (b) RED (no link); (3) neuter `recordSessionForkLink` → all fork tests RED. All restore via `git checkout --`.
- Residual-gap honesty test (c) asserts `allow` for a silent child — it pins the documented limitation, not a fix; QA must NOT file it as a regression.

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

- Vanilla `read`/`edit`/`write`/`glob`/`grep` used for all file content; `bash` only for build/test/accept/pack/view/audit + `git` ops (one `rm -rf` attempt was permission-denied by the sandbox; retried without it — no repo content touched).
- Zero stubs/vacuous tests: no `TODO`, no `|| true`, no `test.skip`, no empty `catch` (the never-throw guarantee lives in the callee's existing try/catch; the new call site adds no swallow).
- No forbidden surfaces added (no WebUI/HTTP/daemon/worktree/engine code); `ci.yml` gate wiring byte-identical; README LOC note (`~12.0k/~10.0k`) left as-is — 12046/9986 still within rounding.
- `git status` shows only the 5 intended stage files + this report (6 files total).
