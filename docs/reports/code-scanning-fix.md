# Code-Scanning Remediation Report — 13 CodeQL Alerts (`fix/code-scanning-13-alerts`)

- Stage: code-scanning remediation (single-session OpenCode v2 plugin ONLY; no WebUI/fleet/worktree-manager/research-engine scope added).
- Branch: `fix/code-scanning-13-alerts` (worktree `worktrees/code-scanning`; NOT merged to `main`).
- Scope: 8 files remediating all 13 open CodeQL alerts + 1 regression test + LOC-budget revision + this report.

## Files changed

| File | Alert(s) | Before | After |
|---|---|---|---|
| `src/guards/permission-guard.ts:277` | 2 — js/incomplete-sanitization (HIGH) | `glob[index].replace(/[.*+?^${}()|[\]\\]/, "\\$&")` — no `g` flag, only first metachar escaped, so `*.ts` mis-compiled and matched `ats` | Added `g` flag: `/[.*+?^${}()|[\]\\]/g` |
| `src/transactions/edit-transaction.ts:40-70,273-346` | 8 — js/file-system-race (HIGH) | `captureSnapshot`/`restoreSnapshot`/`recordFileReadTimestamp`/`checkStaleFileRead` gated on `existsSync()` then `statSync`/`readFileSync`/`rmSync` (TOCTOU) | Removed every `existsSync` gate; `statSync`/`readFileSync` in `try/catch` (`ENOENT` ⇒ `{existed:false,…}` / noop / `{stale:false,unread:false}`); non-ENOENT errors rethrow (fail-closed). `checkStaleFileRead` stats once and reuses `mtimeMs`. `existsSync` import removed |
| `scripts/host-test/harness-host.upstream.ts:63,576-596,672-675` | 21 — js/insecure-temporary-file (HIGH) | `join(tmpdir(), "harness-probe-fmt-${Date.now()…}.mjs")` predictable temp path | `mkdtempSync(join(tmpdir(),"harness-probe-fmt-"))` dir + fixed `probe.mjs` name, `writeFileSync(...,{mode:0o600})`, `finally` → `rmSync(fmtDir,{recursive:true,force:true})`. Formatter content/behavior unchanged |
| `src/muse/muse-calibration.ts:40-72` | 6 — js/polynomial-redos (HIGH) | `text.replace(/<recent-context>([\s\S]*?)<\/recent-context>/g,…)` unbounded lazy span | `indexOf` open/close scan loop (first-close-wins, same as lazy match), inner cap 20000 chars, same three per-chunk line replaces; unclosed tags pass through untouched; note attribute added per-block. All exports identical |
| `src/diagnostics/diagnostics-runner.ts:371-404` | 4 — js/polynomial-redos (HIGH) | Global/multiline `at`-frame regex with `[^\n(]+` + unbounded path/digits | Per-line scan: skip lines without `at `/`File "`/`-->` prefilter, 500-char window, bounded per-candidate `([A-Za-z0-9_./\\-]{1,256}\.(?:…)):(\d{1,7})(?::(\d{1,7}))?` (+ dedicated py/rs patterns). maxFrames/dedupe/node_modules/`..`/abs-rel logic preserved |
| `src/diagnostics/import-verifier.ts:149-197,280` | 10/11/12/13 — js/polynomial-redos (HIGH) | `([\s\S]*?)` clause, `(\.[^"']+)` specifier, `\{([\s\S]*?)\}` + replace, `\s+as\s+` splits; unbounded file length | `([\s\S]{0,2000}?)`, `(\.[^"']{1,500})`, 500 KB input cap, manual `indexOf("{"/"}")` brace scan (2000 cap, no regex), `[ \t]{1,100}as[ \t]{1,100}` splits (also applied to the export-list `as` split + bounded `\{([\s\S]{0,2000}?)\}` there). `parseRelativeImportStatements` behavior preserved |
| `src/repomap/repomap.ts:243-282,285-345` | 15 (`:244-245`) + 14 (`:334`) — js/polynomial-redos (HIGH) | `"(?:\\.\|[^"\\\n])*"` / `'(?:\\.\|[^'\\\n])*'` mask replaces; 11 outline patterns with `\s*`/`\s+`/`[^)]*`/`[^)]+`/`[\w$]*` | `buildCodeOnlyMask` = manual single-pass quoted-span scan (no regex; escapes + same-line-close respected; unterminated left intact); per-line `if (line.length>1000) continue`; all 11 patterns bounded (`\s{0,100}`, `[ \t]{1,100}`, `[\w$]{0,100}`, `[^)]{0,200}`), group indices/`exportedGroup` semantics unchanged |
| `src/verify/architecture-advisor.ts:280-304` | 9 (`:283`) + 20 (`:298`) — js/polynomial-redos (HIGH) | `/\bcatch\s*(?:\([^)]*\))?\s*\{\s*\}/` and `…\{\s*$/` tested per line | `indexOf("catch")` prefilter (`mayBeCatch` gate on the two catch checks only — fn-param scan still runs on every line) + hoisted bounded `/\bcatch[ \t]{0,100}(?:\([^)]{0,200}\))?[ \t]*\{[ \t]*\}/` and opener variant. Empty-catch/multiline/god-file/fn-param logic preserved |
| `test/guards.test.ts` | regression test (acceptance) | — | New `matchesAnyGlob` case: `*.ts` does NOT match `ats`; `a.ts` matches; literal `a(ts)` matches itself but not `ats` |
| `scripts/check-loc.sh`, `test/audit-20261018-remediation.test.ts` | LOC-budget fallout | caps raw 12100 / stripped 10100 | Revised to raw 12176 / stripped 10104 (measured actuals) with documented "Code-scanning remediation revision (2026-10-19)" rationale; gate still fails over cap (`--fail-over=1` assertion untouched). Per script policy, functionality is never deleted to hit a line count |

## Parity evidence (spot-checks, all passing)

- `buildCodeOnlyMask`: length- and newline-identical on all inputs; byte-identical to old regex on 6/7 touched files. Sole divergence class: adjacent mixed quotes (`'"'`): old regex pass produced `" "` (misclassifies as double-quoted), manual scan produces `' '` (lexer-correct). Offsets/line numbers identical; `\bword\b` consumers (`findSymbolReferences`, `renameSymbolAcrossWorkspace`) unaffected since delimiters are non-word chars either way.
- `extractOutline`: old-vs-new pattern counts MATCH on all 7 touched files (139/71/65/63/42/61/53).
- `sanitizeCompactionPseudoTranscript`: block rewrite, multi-block, and unclosed-passthrough outputs verified.
- `parseRelativeImportStatements`: default/named/`as`-alias/`type`/`export-from` parsing verified.
- `scanFileEngineeringQuality`: single-line + multiline empty-catch, 7-param, and non-empty-catch negative all verified.
- Initial `architecture-advisor` edit regressed `high-parameter-count` (prefilter `continue` skipped the fn-param check); fixed by gating only the catch checks (`mayBeCatch`). `bun test` then 398/398.

## Gates (exit codes)

- `bun run check` → exit 0 (`tsc --noEmit`, clean).
- `bun test` → exit 0 (398 pass, 0 fail, 2179 expects, 16 files).
- `make check` → exit 0.
- `make accept` → exit 0 (`WAVE 7 ACCEPT: ALL GATES GREEN`; includes zero-stub scan, export-presence, `.js`-extension, and scope-refusal scans).

## Self-audit notes

- Zero stubs/shortcuts: no `TODO`, `|| true`, `test.skip`, empty `catch {}`, or vacuous passes. Every `catch` either returns a typed fail-closed value, rethrows non-ENOENT, or (in pre-existing `recordFileReadTimestamp`) records nothing on error — same as before.
- Fail-closed preserved: unknown-role/tool/path denial, contract/task locks, empty-role/tool rejection, destructive-shell block, transaction rollback paths all untouched.
- Exports: all public exports identical (no signature changes; only bodies/internals + the one added test).
- Scope: no WebUI, HTTP server, DAG scheduler, worktree manager, or research-engine code touched or added.
- Not merged to `main` (merge requires QA red-proof + drift-guard `VERDICT: PASS` per AGENTS.md §6).
