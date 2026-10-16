# Wave 7 Implementation Report — Atomic Multi-File `rename_symbol`, Post-Formatter `<post-edit-anchors>` Resync, Adaptive `session.hook("retry")`, Dead-Code Architecture Audit & Circuit-Breaker Lesson Synthesis (`v1.0.6`)

- **Stage ID:** Wave 7 (`wave-7-systems`)
- **Release Version:** `1.0.6` (`HARNESS_RELEASE_VERSION = "1.0.6"`)
- **Scope:** Extend the published `v1.0.5` plugin-first baseline with five new in-process OpenCode V2 (`opencode-2` `v2.0.26`) plugin interceptors and systems-engineering tools while keeping Waves 1–6 100% green:
  1. `renameSymbolAcrossWorkspace` (`src/repomap/repomap.ts`) + `rename_symbol` tool — lexer-safe atomic multi-file symbol rename across definitions, imports, exports, and call sites with automatic `collectFileDiagnostics` verification and transactional rollback.
  2. `buildPostMutationAnchorReceipt` (`src/interceptors/tool-interceptors.ts`) — post-mutation & post-formatter (`Formatter.file`) 4-hex FNV-1a `<post-edit-anchors>` resync receipt in `tool.hook("execute.after")`.
  3. `handleSessionRetryInPlace` (`src/interceptors/session-interceptors.ts`) — adaptive `ctx.session.hook("retry")` interceptor (`packages/core/src/session/runner/retry.ts:62-80`) recovering from transient Muse 1.3 `incomplete-stream` drops and gateway overloads while halting on fatal auth/context-overflow errors.
  4. `detectUnusedExportsAndOrphanModules` (`src/verify/architecture-advisor.ts`) — repository-wide unused export and orphan module dead-code detector wired into `runArchitectureAudit` (`architecture_audit` tool and `/audit` slash command).
  5. `trackCircuitBreakerAndAutoProposeLesson` (`src/context/episodic-memory.ts`) — automatic scope-tagged `<episodic-recovery-lesson>` synthesis when a session recovers from a doom-loop circuit-breaker trip.

## 1. Summary of Deliverables

1. **Lexer-Safe Atomic Multi-File Symbol Rename (`renameSymbolAcrossWorkspace` in `src/repomap/repomap.ts` & `rename_symbol` tool in `src/index.ts`):**
   - Uses `buildCodeOnlyMask` to build a byte-accurate mask of live code vs. comments (`//`, `/* */`, `#`) and string/template literals (`'...'`, `"..."`, `` `...` ``), replacing whole-word identifier occurrences only in live code across all workspace files.
   - Wraps multi-file writes in `beginEditTransaction` / `finalizeEditTransaction` and runs `collectFileDiagnostics` (including cross-file import/export verification) on every modified file, automatically rolling back the entire workspace rename if any syntax or export-contract error is introduced.
2. **Post-Mutation & Post-Formatter FNV-1a Anchor Resync Receipt (`buildPostMutationAnchorReceipt` in `src/interceptors/tool-interceptors.ts`):**
   - OpenCode V2 (`packages/core/src/formatter.ts:45-80`, `edit.ts:159`, `write.ts:78`, `patch.ts:218`) automatically formats files on disk after every mutation without returning updated line numbers to the model.
   - `buildPostMutationAnchorReceipt` diffs `beforeContent` vs. the post-formatter on-disk `afterContent` in `tool.hook("execute.after")`, refreshes `recordFileReadTimestamp` so the stale-read guard stays synchronized, and emits a compact `<post-edit-anchors file="..." lines="start-end">` block with fresh 4-hex FNV-1a `<lineNo>#<hash>| <content>` anchors around the changed lines.
3. **Adaptive `session.hook("retry")` Stream & Overload Recovery (`handleSessionRetryInPlace` in `src/interceptors/session-interceptors.ts`):**
   - Hooks `ctx.session.hook("retry")` (`packages/core/src/session/runner/retry.ts:62-80`) to recover from transient Muse 1.3 stream drops (`incomplete-stream`), `502`/`503`/`504`/`529` gateway overloads, and `ECONNRESET`/`ETIMEDOUT` (`attempt <= 3`) with bounded jittered exponential backoff, while immediately stopping doomed retries on fatal `auth`/`invalid_api_key`/`permission`/`not-found`/`context-overflow` errors or `attempt > 6`.
4. **Unused Export & Orphan Module Dead-Code Detector (`detectUnusedExportsAndOrphanModules` in `src/verify/architecture-advisor.ts`):**
   - Cross-references exported symbols across all non-entrypoint workspace modules against live-code references (`stripCommentsAndStringsPreserveLines`) in all other files, reporting `<unused-exports>` and `<orphan-modules>` inside `runArchitectureAudit()`.
5. **Automatic Circuit-Breaker Recovery Lesson Synthesis (`trackCircuitBreakerAndAutoProposeLesson` in `src/context/episodic-memory.ts`):**
   - Tracks when a session trips the doom-loop circuit breaker and automatically synthesizes a scope-tagged `EpisodicLessonProposal` (`<episodic-recovery-lesson>`) on the first subsequent successful recovery action.

## 2. Test & Acceptance Results

- Unit & Integration Suites: **194 pass, 0 fail** across 12 test files (189 prior tests from Waves 1–6 + 5 new Wave 7 tests in `test/wave7-systems.test.ts`).
- Zero-Stub, `.js`-Import & Scope-Refusal Gates (`scripts/accept/wave-1.sh` through `wave-7.sh`): All green.
