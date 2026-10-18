# Audit Remediation Implementation Report — `AUDIT_REPORT_FINDINGS.md` (2026-10-18)

- **Stage ID:** `audit-remediation-20261018` (branch `fix/audit-20261018-remediation-p0-p1-p2`)
- **Source findings:** `AUDIT_REPORT_FINDINGS.md` (12 findings, §§ OH-1.3 – OH-4.2)
- **Implementer:** `agency-programmer` (no subagents; vanilla read/edit/write only; bash for build/test/accept + git status only)
- **Constraint posture:** zero stubs/mocks/vacuous tests; fail-closed throughout; no WebUI/HTTP/fleet/worktree/epistemic additions; no `git push`, `git tag`, or `npm publish` executed; `dist/` untouched by hand.

## Summary of deliverables

All 12 findings remediated per their verbatim Remediation sections:

| Finding | Priority | Change |
|---|---|---|
| OH-6.5-wrapper-laundering (P0) | P0 | `src/guards/shell-parse.ts`: `WRAPPER_BINARIES` extended with `exec setsid timeout stdbuf ionice taskset chroot unshare nsenter runuser su doas sg busybox`; per-wrapper value flags + `timeout`-duration positional skip; `su`/`runuser`/`sg -c` payload inline expansion; loop-unwrap with fail-closed sentinel on empty executable; anywhere-in-stream `rm`+wipe scan; unknown-verb default → `write` |
| OH-6.5-sudo-attached-value (P0) | P0 | Same file: combined-cluster parsing follows getopt (FIRST value letter takes the rest as attached; only a trailing value letter consumes the next token); `-uroot` no longer eats `rm` |
| OH-6.5-redirect-escape (P1) | P1 | `src/guards/permission-guard.ts`: `Rule-0-shell-target-containment` gate over `shellAllFileTargets` for ALL roles before any other shell rule; `shellTargetEscapesWorkspace` (relative resolves under `workspaceRoot`, absolute must be in-root or in-OS-tmp, `..`/NUL/drive-letter/`~` escape); `builder > out.txt` and `> /tmp/…` still allow |
| OH-6.6-exec-taint-evasion (P1) | P1 | `src/guards/taint-guard.ts`: `taintEffectiveExecutable` reuses `stripLeadingWrapperTokens` + G-01 set (segment-head and pipe-target); bare-wrapper fallback preserves `env`-alone denial |
| OH-6.6-redirect-taint-blindspot (P1) | P1 | Same file: shared `matchesTaintSensitivePath`; shell branch runs redirect+argv targets through `TAINT-FILE-1` when tainted |
| OH-6.5-cp-mv-argv-targets (P2) | P2 | `shellArgvFileTargets` (`cp`/`mv`/`ln`/`install` operands + `-t` dir + `sed -i` files; mode/owner values consumed, not targeted); same Rule-0 gate; `cp /tmp/artifact ./out` allowlisted |
| OH-5.3-copyback-blindspot (P1) | P1 | Production loop untouched (already correct reverse scan); new adapter-level multi-turn regression test through real `wireOpenCodeV2PromiseContext` `session/context` handler (helper/adapter dedup declined — test suffices, zero-risk rule) |
| OH-6.7-edit-breaker-unreachable (P1) | P1 | `src/guards/circuit-breaker.ts`: edit streak skips successful `other`-kind re-reads; any edit success, failed read, shell attempt, or path change still breaks it; pipeline regression test (4× read+bad-edit via real adapter `execute.after` trips on 2nd failure; shell side still trips) |
| OH-8.2-install-story (P2) | P2 | `README.md` Requirements section (min host `anomalyco/opencode@ed772f5`, one clone+checkout+install command, pin-advance matrix note, explicit stock-`latest`-unproven refusal); `run.sh` pin comment cross-links the README |
| OH-scope-loc-budget (P2) | P2 | `scripts/check-loc.sh` `--fail-over=<n>` / `--fail-over-stripped=<n>` hard-cap flags (exit non-zero over cap, exit 2 on misuse); wired into `.github/workflows/ci.yml`; README documents both forms |
| OH-4.2-post-formatter-receipt (P2) | P2 | Adapter-level built-in-`edit` test (simulated `Formatter.file` reflow → receipt hashes equal formatted disk bytes) + upstream host-test formatting-sensitive live case asserting receipt-vs-disk ordering through the real host pipeline |
| OH-1.3-stale-npm-latest (P0) | P0 | `package.json` + `src/version.ts` + README title bumped `1.0.9` → `1.0.10`; no tag/push/publish performed (human gate) |

## Files created / modified

- Modified: `src/guards/shell-parse.ts`, `src/guards/permission-guard.ts`, `src/guards/taint-guard.ts`, `src/guards/circuit-breaker.ts`, `src/version.ts`, `package.json`, `README.md`, `scripts/check-loc.sh`, `scripts/accept/wave-8.sh`, `scripts/host-test/run.sh`, `scripts/host-test/harness-host.upstream.ts`, `.github/workflows/ci.yml`
- Created: `test/audit-20261018-remediation.test.ts` (51 tests, 359 expects, one `describe` per finding ID)
- Untouched: `dist/` (no hand edits, no rebuild committed), git tags, npm registry

## Test results (all exit 0; changes left UNCOMMITTED for QA)

- `bun run check` → exit 0 (`tsc --noEmit`)
- `bun test` → exit 0 (**343 pass, 0 fail**, 1611 expects, 16 files)
- `make check` → exit 0
- `make accept` → exit 0 (waves 1–7, incl. `WAVE 7 ACCEPT: ALL GATES GREEN`)
- `bash scripts/accept/wave-8.sh` → exit 0 (all prior gates + new `audit-20261018-remediation` suite: 51 pass)
- `bash scripts/check-loc.sh` → exit 0 (raw 11453 / stripped 9599, tracking)
- `bash scripts/check-loc.sh --fail-over=12000 --fail-over-stripped=10000` → exit 0
- `bash scripts/check-loc.sh --fail-over=1` → exit 1 (`loc-budget FAIL`)
- Upstream script syntax: bundled clean via `bun build` with externalized host imports (host-test itself not run here — needs network clone; new live case follows existing `call`/`textOf` patterns)
- Not run (hard limits / env): `make host-test`, `npm publish`, `git tag`/`git push`

## Self-audit notes

- Fail-closed codes added: `UNRESOLVED_NESTING_SENTINEL` on wrapper-only input, `rule-0-shell-target-containment`, unknown-verb `write`, `TAINT-FILE-1` on tainted shell targets, `--fail-over`/`--bogus` exit 2 misuse handling.
- Deliberately accepted over-blocks (documented in code/tests): unquoted `echo rm -rf /` classifies destructive (verbatim audit prescription); bare `su`/`chroot` spawns and `timeout 5`-style positionals outside the duration regex resolve `write`/sentinel; `command -v`-style display stays `read-only` via the `bun`-style branch logic.
- Relative `..` escapes landing inside the OS tmp dir are DENIED (tmp allowance applies to absolute targets only — verified by unit test with a tmpdir-rooted workspace).
- `install -m/-o/-g` and `--mode/--owner/--group/--backup/--suffix` values are consumed but NOT treated as file targets (mode specs are not paths); `-t`/`--target-directory` values ARE targets.
- Version bump is source-only; the publish gate (`npm version`-equivalent already applied by hand to the three version sites, tag+push+publish) remains a human step.
- No `git checkout --` was run on any file (remediation must survive for QA red-proof); no commits made.
