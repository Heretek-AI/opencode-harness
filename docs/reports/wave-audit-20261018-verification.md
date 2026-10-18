# Drift-Guard Verification Report — Audit Remediation 20261018

- **Stage:** `wave-audit-20261018` (branch `fix/audit-20261018-remediation-p0-p1-p2`, HEAD `a4ce2e7`)
- **Auditor:** `agency-drift-guard` (independent, adversarial; strictly read-only — no code edits, no sabotage, no subagents)
- **Sources read in full:** `AGENTS.md`; `docs/prompts/SPEC.md`; `AUDIT_REPORT_FINDINGS.md` (all 564 lines); `docs/reports/audit-20261018-remediation-implementation.md`; `test/audit-20261018-remediation.test.ts` (692 lines); `docs/evidence/wave-audit-20261018/red-proofs.log` (runs 1+2)
- **Code re-verified by direct read (nothing copied from QA):** `src/guards/shell-parse.ts` (full, 1641 lines); `src/guards/permission-guard.ts` (full, 743 lines); `src/guards/taint-guard.ts` (full, 360 lines); `src/guards/circuit-breaker.ts` (full, 228 lines); `src/host/contract-adapter.ts:960-1001,673,749-763`; `src/interceptors/tool-interceptors.ts:434-514`; `src/version.ts`; `package.json`; `README.md:1-77`; `scripts/check-loc.sh` (full); `scripts/host-test/harness-host.upstream.ts:360-413`; `scripts/host-test/run.sh`; `.github/workflows/ci.yml` (grep); `scripts/accept/wave-8.sh` (grep)
- **Working tree:** `git status --short` → only `?? AUDIT_REPORT_FINDINGS.md`; `git diff HEAD --stat` → empty. Remediation is committed; `dist/` untouched by hand.
- **QA baseline (not copied, independently spot-checked):** QA ACCEPT run 2, 343 pass, all sabotage reverts clean.

## P0 Findings

### OH-6.5-wrapper-laundering — CLOSED, no bypass
- `WRAPPER_BINARIES` (`shell-parse.ts:224-245`) contains all 14 audit-listed wrappers (`exec timeout setsid stdbuf ionice taskset chroot unshare nsenter runuser su doas sg busybox`) plus all 6 priors (`sudo env command nohup time nice`). Verified by reading the set literal.
- `stripWithChain` (`:532-568`) loops until the next token is not a wrapper/dispatcher (stacked prefixes like `sudo timeout 5 …`, `VAR1=x exec …` resolve), and a wrapper chain ending with no executable resolves to `[UNRESOLVED_NESTING_SENTINEL]` — destructive, fail-closed, never `read-only`.
- `scanTokensForRmWipe` anywhere-stream backstop (`:898-958`) makes any `rm` + recursive/force flags + root-wipe target ANYWHERE post-wrappers destructive, backstopping exotic flag spellings and even unlisted launchers. Unknown-verb default is `write`, never `read-only` (`:1322-1327`).
- `command -v`/`-V` carve-out is narrow and safe: `isCommandDisplayQuery` (`:616-636`) only matches bare display queries, and `segmentIsWrite` checks redirect/`tee` metacharacters FIRST (`:1219-1231`), so `command -v foo > /etc/x` is still `write`.
- `taskset`/`chroot` positional gates use `isKnownCommandWord` (`:592-601`): `chroot rm -rf /` / `taskset rm …` resolve the known word as the command (destructive); unknown positionals that vanish leave the sentinel (fail-closed over-block, documented). Director AND agency-qa denial follows from Rule-1-destructive firing before any role rule.
- No over-broad allow introduced.

### OH-6.5-sudo-attached-value — CLOSED, getopt logic holds on read
- Combined-cluster parsing (`:481-508`) implements exactly the prescribed semantics: FIRST value-taking letter takes the remainder as attached (`-uroot` → `-u`=`root`, consumes nothing past the token); only a value letter that is LAST with nothing attached consumes the next token, and only when it does not start with `-` (`-nu root` eats `root`; `-nuroot` eats nothing). `-uroot` can no longer eat `rm`; post-command `-rf` is payload, not flags.
- Empty-executable → `null` → sentinel → destructive (`:382-384`, `:560-562`).

### OH-1.3-stale-npm-latest — HONESTLY ADDRESSED, version consistent
- `package.json:3` (`"version": "1.0.10"`) == `src/version.ts:5` (`HARNESS_RELEASE_VERSION = "1.0.10"`) == `README.md:1` title (`v1.0.10`); all differ from stale `1.0.9`. No file claims 1.0.10 is published; the remediation report explicitly records no tag/push/publish and leaves them as the human gate — exactly the audit-prescribed split (machine bump now, human release step). The stale-`latest` risk is disclosed, not papered over.

## P1 Findings

### OH-6.5-redirect-escape + OH-6.5-cp-mv-argv-targets — CLOSED, one shared gate
- Rule-0 gate (`permission-guard.ts:587-607`) runs over `shellAllFileTargets` (redirects ∪ tee ∪ `shellArgvFileTargets`) for ALL roles BEFORE any other shell rule, returning `rule-0-shell-target-containment`.
- Builder is confined (absolute/`..`/NUL/drive-letter/`~` escape); workspace-relative targets allow (`echo hi > out.txt`); absolute OS-tmp targets allow as legitimate scratch — and ONLY absolute targets earn the tmp allowance (`:516-528`), while relative `..` escapes landing in tmp are still denied. Sane, no over-broad allow.
- `shellArgvFileTargets` (`shell-parse.ts:1592-1641`) covers `cp`/`mv`/`ln`/`install` operands plus `-t`/`--target-directory`; mode/owner-style values (`-m`/`-o`/`-g`/`--mode`/`--owner`/`--group`/`--suffix`) are consumed, never targeted; `cp /tmp/artifact ./out` allowlisted. Director/QA rows remain denied (leadership read-only + QA shell lock).
- Contract-lock shell leg (`:703-714`) still reports `rule-4` for in-workspace targets (test-pinned).

### OH-6.6-exec-taint-evasion + OH-6.6-redirect-taint-blindspot — CLOSED
- `taintEffectiveExecutable` (`taint-guard.ts:211-229`) reuses `stripLeadingWrapperTokens` + the G-01 set for segment heads; the pipe rule (`:275-284`) maps segments through the same function, covering pipe targets (`curl … | exec sh`). Bare-wrapper fallback preserves `env`-alone denial.
- Shell branch (`:263-273`) runs redirect+argv targets through the shared `matchesTaintSensitivePath` (`:190-203`, also used by the file branch — no divergence) and denies `TAINT-FILE-1` when tainted.

### OH-6.7-edit-breaker-unreachable — CLOSED, no over-suppression
- The carve-out (`circuit-breaker.ts:158-167`) skips ONLY successful `other`-kind re-reads; any edit success, any failed read, any shell-family attempt, or any path change still breaks the streak. Shell evaluation is structurally untouched (kind-mismatch `break` at `:168-170`). Intervention threshold/semantics unchanged.
- Pipeline regression test targets the real adapter `execute.after` path (4× read+bad-edit trips on the 2nd failure); shell side still trips at 3.

### OH-5.3-copyback-blindspot — CLOSED, adapter-level test
- Production loop untouched: `contract-adapter.ts:978` is the correct reverse scan (`length-1 … 0`).
- The new test (remediation suite `:439-471`) drives the REAL `wireOpenCodeV2PromiseContext` `session`/`context` handler with a multi-turn transcript and asserts `PROBE-TASK` lands on the LAST user message while the first is untouched — it pins the adapter loop, not just the `src/context/` helper.

## P2 Findings — honestly addressed
- **OH-8.2-install-story:** `README.md:7-36` pins minimum host `anomalyco/opencode@ed772f5`, gives one clone+checkout+install command, adds the pin-advance matrix note, and explicitly refuses unproven stock-`latest` compat. `run.sh:13` cross-links the README Requirements section.
- **OH-scope-loc-budget:** `scripts/check-loc.sh --fail-over=<n>` / `--fail-over-stripped=<n>` exit non-zero over cap (exit 2 on misuse/non-integer), wired into `.github/workflows/ci.yml:23-24` alongside the tracking form. Default remains tracking-only by documented design; functionality is never deleted for counts.
- **OH-4.2-post-formatter-receipt:** ordering genuinely proven — `execute.after` reads `afterText` from disk (`contract-adapter.ts:749`) and feeds it to the receipt builder (`:750-763`), so the receipt always reflects post-write bytes. The adapter test mutates disk between `before`/`after` hooks and asserts receipt hashes equal formatted bytes; the live host-test case (`harness-host.upstream.ts:360-413`) asserts receipt-vs-disk equality through the real host pipeline with formatting-sensitive content. The one unrun leg (upstream `Formatter.file` physically reflowing inside the built-in edit path) is honestly scoped in code comments, not claimed.

## Cross-cutting
- **Zero stubs/mocks/TODOs:** grep over `src/` for `TODO|FIXME|XXX|HACK|cmd: "true"`-class patterns → no matches. Test-quoted `echo` strings are functional assertions, not dummy passes.
- **Scope holds:** grep hits for HTTP/WebUI/fleet/worktree/epistemic are only host-context field passthroughs (`index.ts:1076-1078`, `contract-adapter.ts:204-205`), compaction-prompt text, and refusal comments — no implementation. No new surfaces.
- **No `dist/` hand-edits; version bump complete; no over-broad allows** (tmp allowance, `command -v` carve-out, chroot/taskset gates all verified fail-closed above).

## QA red-proof anomaly (S6.5-sudo-A GREEN) — ACCEPTABLE defense-in-depth
- The forced attached-consume-next sabotage stays GREEN because the trajectory double-fires (`-uroot` eats `rm`, then `-rf`'s `r`+attached-`f` eats `/`), draining the stream to empty → `consumeWrapper` returns `null` → sentinel → still destructive/denied. The security property (deny for every role) holds under the sabotage; the exact historical bug trajectory is converted into a deny by design.
- Non-vacuity is proven by companion S6.5-sudo-B (`sudo` dropped from the wrapper set → 2 fail RED). All other families RED as required (S5.3, S6.5-wrapper, S6.7 unit+pipeline, S-taint, S-redirect). The GREEN weakens nothing: no finding closure depends on that parse line alone.

## Binding verdict
Every P0 is closed with no bypass on read; every P1 has a real mechanism fix plus a regression test pinning it; P2s are honestly addressed with no false claims; no new drift or scope violation was introduced.

VERDICT: PASS
