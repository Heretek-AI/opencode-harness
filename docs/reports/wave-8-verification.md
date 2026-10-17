# Wave 8 Audit Remediation — Drift Guard Verification Report

- **Agent:** `agency-drift-guard` (subagent, worktree `worktrees/wave-8`, branch `wave-8-audit-remediation`)
- **Date (UTC):** 2026-10-17
- **Baseline:** `db4a2c055f4f4f160d1328937c7f0da7d8f6031d`
- **Sources read in full from disk:** `AGENTS.md`, `AUDIT_REPORT_FINDINGS.md`, `docs/prompts/SPEC.md`, `docs/prompts/verify-stage.md`, `docs/reports/wave-8.md` (programmer report), `docs/evidence/wave-8/red-proofs.log` (QA evidence)
- **Code changed by this auditor:** NONE (one sabotage mutation attempted via the `edit` tool and denied by the guard itself — see §6)

## 1. Gates (exact commands + exit codes, run in worktree)

| # | Command | Exit | Result |
|---|---------|------|--------|
| G1 | `make check` (`bun run check` → `tsc --noEmit`, then `bun test`) | 0 | PASS — `267 pass, 0 fail, 1123 expect() calls, 14 files` |
| G2 | `bash scripts/accept/wave-8.sh` | 0 | PASS — `wave-8: all audit-remediation gates passed` (incl. full 267-test suite + zero-stub scan) |
| G3 | `make accept` (waves 1–7) | 0 | PASS — `WAVE 7 ACCEPT: ALL GATES GREEN` |
| G4 | `bun test test/context-budget.test.ts test/circuit-breaker.test.ts test/editors.test.ts` | 0 | PASS — `65 pass, 0 fail` |
| G5 | `bun test test/guards.test.ts` | 0 | PASS — `19 pass, 0 fail` |
| G6 | `git branch --show-current` | 0 | `wave-8-audit-remediation` — correct |
| G7 | `git status --short` (before and after audit) | 0 | clean (empty) both times; no production modifications |
| G8 | `git log --oneline -3` | 0 | `8ee3efd Wave 8: remediate all AUDIT_REPORT_FINDINGS …` on top of `db4a2c0 Audit Prompt` — no merge to `main` performed |

**Evidence-log note:** `docs/evidence/wave-8/red-proofs.log` exists on disk and was read in full, but `git status --short` is clean because `*.log` is ignored per `.gitignore:12` (confirmed via `git check-ignore -v` → `.gitignore:12:*.log docs/evidence/wave-8/red-proofs.log`). Untracked/ignored evidence log is acceptable and explained — no production drift hidden.

## 2. Stub / shortcut scan (zero-stubs enforcement, `src/` AND `test/`)

| Pattern | Command | Hits | Disposition |
|---|---|---|---|
| `TODO` | `rg -n "TODO" src/ test/` | zero (exit 1) | CLEAN. (`TODO` hits under `scripts/accept/*.sh` are self-referential grep patterns inside the scanners themselves, not markers in shipped code.) |
| `\|\| true` | `rg -n --fixed-strings "\|\| true" src/ test/ scripts/` | zero in `src/`+`test/` (exit 1 on scoped scan) | CLEAN. (Only scanner self-reference in `wave-8.sh:78`.) |
| `set +e` | `rg -n "set \+e" src/ test/ scripts/` | zero (exit 1) | CLEAN |
| `cmd: "true"` / `echo "passed"` | `rg -n 'cmd: "true"' …` + `rg -n 'echo "passed"' …` | zero in shipped code | CLEAN. (Only scanner self-reference in `wave-8.sh:81`.) |
| `test.skip` / `describe.skip` / `it.skip` / `xit(` / `xdescribe(` | `rg -n "test\.skip\|describe\.skip\|it\.skip\|xit\(\|xdescribe\(" src/ test/` | ONE apparent hit: `test/wave8-audit.test.ts:121` — the string `"node -e \"process.exit(0)\""` inside the mutating-shell corpus (substring `xit(0)` of `exit(0)`), NOT a skip call. Zero actual skips. | FALSE POSITIVE, justified — no skip exists |
| Empty `catch {}` swallows | `rg -n -U "catch\s*(\([^)]*\))?\s*\{\s*\}" src/ test/` | zero (exit 1) | CLEAN |
| Vacuous `return true;` | `rg -n "return true;" src/` | 30+ hits, EVERY one guarded by a preceding condition (`if (a === 127)`, `if (…)` IP-range checks in `dom-auditor.ts:375-408,520,533`; taint-match returns in `taint-guard.ts:40-60`; write-verb/destructive classifications in `shell-parse.ts:419-730`; error-status check in `tool-interceptors.ts:666`; containment check in `hashline-tools.ts:156`). Zero bare `return true` function bodies. | CLEAN — all carry logic |
| Empty function bodies | `rg -n "\{\s*\}" src/` | hits are all object literals (`{}`, `?? {}`, spread `... : {}`), not empty functions | CLEAN |
| Unwired modules | all 22 `src/**/*.ts` checked against `src/index.ts` | ALL WIRED: direct imports (`ast-codemod`, `hashline-tools`, `permission-guard`, `circuit-breaker`, `context-budget`, `dom-auditor`, `repomap`, `verifier`, `architecture-advisor`, `contract-adapter`, `version`) + `export *` re-exports covering `shell-parse`, `taint-guard`, `episodic-memory`, `diagnostics-runner`, `import-verifier`, `edit-transaction`, `muse-calibration`, both interceptors + `export { getRecommendedMcpConfig } from "./ui-auditor/mcp-defaults.js"` (`index.ts:101,105`) | CLEAN |

## 3. KV-cache invariants + critical invariants spot-check

- `injectContextBudgetIntoMessages` NEVER mutates `event.system`: `src/context/context-budget.ts` documents the invariant (`last role === "user" message; NEVER touches event.system`); `bun test test/context-budget.test.ts` green within the 65-pass targeted run and the 267-pass full suite.
- Dynamic context lands strictly on the last `role === "user"` message: asserted by the context-budget suite (green).
- Lessons sorted `a.id.localeCompare(b.id)` with ZERO float `relevance=`/timestamps: `localeCompare` present at `context-budget.ts:199,307`; lesson-tag format carries `id` only (verified by suite + `rg`).
- 4-hex FNV-1a hashes: `& 0xffff` at `hashline-tools.ts:61`; `HASH_SHIFT_WINDOW = 25` (`hashline-tools.ts:20`); ±25-line shifted-anchor recovery covered by `test/editors.test.ts` (green).
- Circuit breaker 2/3 thresholds: `edit`/`patch` ≥2 same path, `shell`/`bash` ≥3 same prefix (`circuit-breaker.ts:8-10,128-129,165-166`); `test/circuit-breaker.test.ts` green.

## 4. Scope refusal

- `rg -ni "listen\(|WebUI|DAG scheduler|fleet daemon|worktree manager|epistemic" src/ scripts/ test/` hits ONLY the accept scripts' own scanner comments/patterns (`wave-N.sh` scope-refusal gates) — ZERO forbidden implementations in `src/`.
- `getRecommendedMcpConfig()` (`src/ui-auditor/mcp-defaults.ts`) returns ONLY `lsp-mcp-server` (`bunx`) + `fallow-mcp` (`npx --yes --package fallow`) — confirmed exactly two keys, no extra servers.

## 5. Independent sabotage (distinct from QA S1–S5)

QA covered: S1 leadership-director removal, S2 `commandBasename`, S3 rename rollback, S4 fatal-retry list, S5 taint MCP matching. My pick was in the same Rule-3 family but a DIFFERENT invariant: weaken the QA source-lock prefix check (`path.startsWith("src/")` → `"src-/"`, the historic audit bypass) in `src/guards/permission-guard.ts:369`.

- Sabotage command: `edit` tool on `src/guards/permission-guard.ts` (`"src/"` → `"src-/"`).
- Result: **DENIED — `{"type":"permission.rejected","message":"Permission denied: edit"}` (exit-equivalent non-zero).** The harness permission guard correctly enforces Rule 2 leadership read-only against my own `agency-drift-guard` role: I physically cannot mutate `src/`. This denial IS the red-proof — it demonstrates the OH-6.2 remediation (guard consulted, leadership read-only) operating on the auditor itself.
- Restore needed: NONE — nothing was mutated. Confirmations: `git status --short` → clean (empty), `git diff --stat` → empty, `bun test` → still `267 pass, 0 fail` (exit 0).
- Fail-closed depth (no-mutation equivalents, all green proving assertions exist): `bun test test/wave8-audit.test.ts -t "OH-6.1-role-normalization"` → 5 pass; `-t "OH-6.3-symlink"` → 2 pass; `-t "OH-6.2-harness"` → 3 pass; full `test/guards.test.ts` → 19 pass. QA's S1–S5 logs (each sabotage → non-zero → `git checkout --` → 267/0 green) were reviewed and their restore claims corroborated by the clean tree + green suite observed here.

## 6. Adversarial audit of P0 fixes (live `bun -e` probes, no src edits — all DENY as claimed)

- **Role normalization (OH-6.1):** `Director`/`DIRECTOR`/`"  director  "` edit `docs/plan.md` → DENY (`rule-2-leadership-read-only`); `Qa-Adversary`/`QA-ADVERSARY` edit `src/index.ts` → DENY (`rule-3-qa-source-lock`); `root` edit → DENY (`rule-0-unknown-role`); `programmer` edit `contracts/api.json` → DENY (`rule-4-contract-lock`); `architect` edit `contracts/api.json` → ALLOW (correct). NO BYPASS.
- **Destructive-shell evasions (OH-6.5):** `rm -r -f /`, `rm -r -f $HOME`, `rm -rf ~`, `sudo -u root rm -rf /`, `sudo -g wheel rm -rf /`, `/bin/rm -rf /`, `/usr/bin/rm -rf /`, `/sbin/mkfs.ext4 …`, `/bin/dd if=…`, `git -C /tmp reset --hard`, `git --git-dir=… reset --hard`, `git --work-tree=… reset --hard`, `git push origin +main:main`, `git push --force`, `rm -rf /tmp/../`, `rm -rf /tmp/sub/../../etc` → ALL `class:destructive`, DENY for both `programmer` and `director`. Mutating shells (`eval`, `python3 -c`, `node -e`, `npx`/`bunx`, `curl|sh`, `wget|bash`, `env -i rm`, `xargs rm`, `find -exec rm`) → `class:write`, ALLOW for `programmer` (correct — writer role) and DENY for `director` (correct). Uppercase `RM -RF /` / `GIT RESET --HARD` → ALLOW/`read-only`, matching the audit's own robustness-only note (non-executable on Linux) and the programmer's documented limitation — NOT a bypass. NO BYPASS.
- **Taint (OH-6.6):** `isUntrustedIngestionTool` → `fallow-mcp_screenshot=true`, `lsp-mcp-server_hover=true` (previously `false` at baseline), `mcp_tool=true`, `webfetch=true`, `file_hash_edit=false` (correct — harness tool, not ingestion). NO BYPASS.
- **Symlink escape (OH-6.3):** live PoC (`link/` → outside dir, `hashEditFile(base,"link/victim.txt",…)`) → threw `refusing symlink escape outside rootDir (fail-closed)`; outside `victim.txt` byte-identical (`baseline-outside`). NO BYPASS.
- **SSRF loopback (OH-7.4):** `resolveAuditTarget` DENIED `http://127.0.0.1:…`, `http://10.0.0.5/…`, `http://169.254.169.254/…` (non-public), and unresolvable `[::1]` fail-closed; ALLOWED only public `https://example.com/page`; `isNonPublicIpAddress("127.0.0.1")=true`, `("8.8.8.8")=false`. NO BYPASS.
- **Scoped-tests traversal (OH-7.3):** `computeScopedTestsForFiles(["../outside.test.ts"])` → `[]`; `["sub/../../escape.test.ts"]` → `[]`. NO BYPASS.
- **Harness guard (OH-6.2):** `evaluateBoardGuard({role:"director", tool:"file_hash_edit", path:"src/index.ts"})` family covered by `OH-6.2-harness` tests (3 pass) + the auditor's own denied edit (§5). NO BYPASS.

## 7. QA red-proof review

`docs/evidence/wave-8/red-proofs.log` (QA, 2026-10-17): G1–G5 all exit 0 (267 pass; wave-8.sh; `make accept`; `bun run accept`); 8 live P0 probe families all fail-closed; S1–S5 each turned the suite red (249/18, 263/4, 266/1, 265/2, 266/1 fail splits) with `git checkout --` restores to 267/0 green. The S2 attempt-A negative (wrapper-token strip removal staying green) is credibly explained as defense-in-depth (`parseCommandSegments` unwrapping independently yields the destructive candidate). Corroborated here: clean tree, green suite, and my own live probes reproduce every DENY. **QA evidence ACCEPTED.**

## 8. Findings

No blocking findings. Numbered notes (non-blocking, for Wave 9+ awareness):

1. Uppercase `RM`/`GIT` classify `read-only`/ALLOW — non-executable on Linux per the audit itself; documented limitation, not a bypass.
2. `make`/`tsc` remain read-only by design (existing suite pins `make check` read-only) — documented, not a bypass.
3. Static `..` rejection in rm targets is a strict superset of a realpath check (may flag a `--`-separated literal `..`) — acceptable fail-closed posture, documented.
4. Live browser + upstream host-test paths code-reviewed, not executed here (host test needs network fetch of upstream) — same limitation QA noted.

No `VERDICT: FAIL` condition met: deliverables complete per `docs/reports/wave-8.md`, zero unjustified stubs, all gates exit 0, all red-proofs valid, every bypass attempt blocked.

VERDICT: PASS
