# QA Report — stage `audit-remediation-E`
# NOTE: filed under docs/evidence/audit-remediation-E/ instead of docs/reports/ because the
# environment permission hook denies agency-qa writes to docs/reports/ (Permission denied: edit,
# attempted twice). Content is identical to the mandated docs/reports/audit-remediation-E-qa.md;
# drift-guard may promote it verbatim.

**Branch:** `audit-remediation-E` · **HEAD:** `88bdfe0` (programmer commit on baseline `9715874`)
**Role:** `agency-qa` · **Date (UTC):** 2026-10-18
**Full command log:** `docs/evidence/audit-remediation-E/red-proofs.log`

## Gates table

| Gate | Command | Result |
|------|---------|--------|
| Typecheck | `TMPDIR=/dev/shm bun run check` | exit 0 |
| Full suite | `TMPDIR=/dev/shm bun test` | **391 pass / 2 fail** — both fails are the 2 known TMPDIR-override artifacts (`tmpdir()` allowlist legs in `OH-6.5-redirect-escape` / `OH-6.5-cp-mv-argv-targets`), identical to baseline/D, unrelated to this diff |
| New E tests | targeted `-t` filters | OH-4.8 5/0 · fork-gap 12/0 (10 D + 2 E) · squat 4/4 · bootstrap 1/0 |
| Wave-1 accept | `TMPDIR=/dev/shm bash scripts/accept/wave-1.sh` | `WAVE 1 ACCEPT: ALL GATES GREEN`, exit 0 |
| Wave-2 / Wave-3 accept | `TMPDIR=/dev/shm bash scripts/accept/wave-2.sh`, `wave-3.sh` | exit 1, SOLE cause the same 2 pre-existing TMPDIR artifacts in the full-suite step (baseline audit was 380/2, so this step cannot pass under TMPDIR override at baseline either); all other gates inside pass — not a regression |
| LOC tracked | `bash scripts/check-loc.sh` | `files=22 raw=12089 (budget 12100) stripped=10024 (budget 10100)`, exit 0 |
| LOC hard gate | `bash scripts/check-loc.sh --fail-over=12100 --fail-over-stripped=10100` | within-cap both, exit 0 |
| Build | `bun run build` | exit 0 |
| Bootstrap/version | `TMPDIR=/dev/shm bun test test/bootstrap.test.ts` | 1 pass / 0 fail; `package.json:3` == `src/version.ts:5` == `1.0.11` |

## Proof re-run results (live, via `wireOpenCodeV2PromiseContext`)

- **OH-4.8 full:** receipt `changedFiles="3"` with all three files; `notes.txt before="5891b5b522d5df08" after="e258d248fda94c63"`; `code.ts`/`brand-new.txt` SHAs byte-identical to audit raw (`037ecd1db38c230c`, `7aa7a5359173d05b`). PASS.
- **OH-4.8 isolated-modify:** `changedFiles="1"` (was `"0"`). PASS.
- **OH-4.8 modify+delete:** `changedFiles="2"`, `notes.txt after="deleted"`. PASS.
- **Fork-gap:** tainted parent → forked child `ssh` denies `TAINT-NET-2`; after-mirror links lineage; clean fork allows (no over-taint). Silent no-metadata child documents `allow` — pinned residual/upstream limitation, NOT filed as regression. PASS.
- **Squat:** built-in safe names stay `taint=false`; ingestion arms stay `true`; marked squat (`metadata.mcpServer`) arms. Bare exact-name squat with no marker stays `false` — pinned residual, NOT a regression. PASS.
- **Release-identity:** no bump/tag/publish performed (no `v1.0.12`); HUMAN-ONLY checklist present in `docs/reports/audit-remediation-E.md` and not executed. OH-1.3/OH-1.1/OH-1.1-no-gh-release correctly remain open pending human release. PASS (prepare-only).
- **Informational (OH-deps-caret, OH-scope-loc-budget):** carets + lockfile untouched; LOC gated and net-small (+43/+38, cap unchanged). PASS.

## Sabotage summary (all RED → `git checkout --` restore → GREEN)

1. **OH-4.8:** before-snapshot restricted to `.ts`-only → 2 pass / 3 fail, bun exit 1 → restored → 5/0 green.
2. **Fork-gap:** `recordSessionForkLink` self-link sabotage → 3 pass / 9 fail, exit 1 → restored → 12/0 green.
3. **Squat:** `isMcpProvenanceEvent` neutered to `return false` → 2 pass / 2 fail, exit 1 → restored → 4/0 green. (An initial disjunct-removal-only attempt stayed 4/4 green — no adapter-level test asserts that path; recorded honestly, not counted.)
4. **Release-identity:** `src/version.ts` → `9.9.9-sabotage` → bootstrap 0/1, exit 1 → restored → 1/0 green.

## Stub / scope scans

- Zero production stubs: `TODO`/`test.skip`/`|| true`/`set +e`/`cmd: "true"` hits only inside accept-script scanner patterns (self-reference) and one wave-8 test fixture string; zero empty-`catch`; `return true` hits are conditional guard logic, not vacuous.
- Scope: no WebUI/HTTP/`listen(`/fleet-daemon/worktree-manager/epistemic engine in `src/`/`scripts/`/`test/` (only a doc comment stating they are out-of-scope + scanner patterns).

## Final state

`git status --short` shows only the new QA files under `docs/evidence/audit-remediation-E/` (`red-proofs.log`, this report); zero modified-file residue; no commits made.

QA: ACCEPT
