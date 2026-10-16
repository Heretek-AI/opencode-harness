# Wave 6 Implementation Report — Cross-File Import/Export Contract Verifier, Symbol References, Patch Auto-Repair, Anti-Truncation Head+Tail Compactor & Dual Code Mode Bridge (`v1.0.5`)

- **Stage ID:** Wave 6 (`wave-6-engineering`)
- **Release Version:** `1.0.5` (`HARNESS_RELEASE_VERSION = "1.0.5"`)
- **Scope:** Extend the `v1.0.4` plugin-first baseline with five deeper in-process OpenCode V2 (`opencode-2` `v2.0.26`) interceptors and systems-engineering capabilities while keeping Waves 1–5 100% green:
  1. `src/diagnostics/import-verifier.ts` — zero-subprocess cross-file relative import & named-export contract verifier wired into `collectFileDiagnostics`.
  2. `findSymbolReferences` (`src/repomap/repomap.ts`) + `symbol_references` tool — lexer-aware whole-word symbol reference, definition, import, and call-site locator with 4-hex FNV-1a `lineHash` anchors.
  3. `repairPatchToolInputInPlace` (`src/interceptors/tool-interceptors.ts`) — in-place `PatchTool` envelope (`*** Begin Patch` / `*** End Patch`) and hunk line-prefix (`12: ` / `12#a3f2| `) auto-repair in `tool.hook("execute.before")`.
  4. `compactToolOutputHeadTail` (`src/interceptors/tool-interceptors.ts`) — head+tail smart output compaction in `appendBlocksToToolAfterEvent` so OpenCode V2's `ToolOutput.truncate` (`packages/core/src/tool-output.ts:62-112`, which runs *after* `execute.after` and drops everything past `2,000` lines / `50 KiB`) never slices off the error tail or appended `<diagnostics>`, `<fault-context>`, `<contract-impact>`, `<mutation-receipt>`, and `<circuit-breaker>` blocks.
  5. Dual Direct + Code Mode (`tools.harness.*`) registration (`src/host/contract-adapter.ts`) + `OpenCodeTools.Plugin` worktree compaction decontamination (`src/interceptors/session-interceptors.ts`).

## 1. Summary of Deliverables

1. **Cross-File Relative Import & Named-Export Contract Verifier (`src/diagnostics/import-verifier.ts`, wired into `src/diagnostics/diagnostics-runner.ts`):**
   - Resolves relative module specifiers (`./foo.js`, `./foo`, `../bar`) using TypeScript/Node ESM rules (`.js` -> `.ts`/`.tsx`/`.d.ts`, extensionless `.ts`/`.tsx`/`.js`, `/index.ts`).
   - Emits an immediate `import-resolver` `FileDiagnostic` with a sibling filename suggestion when a relative import target does not exist on disk.
   - Recursively collects exported symbol names from the target module (including `export function/class/interface/type/enum/const`, `export { a as b }`, and transitive `export * from "./sub"` up to depth 4) and emits an `export-contract` `FileDiagnostic` listing the target module's available exports whenever a named import is missing.
2. **Lexer-Aware Cross-File Symbol Reference Finder (`findSymbolReferences` in `src/repomap/repomap.ts` & `symbol_references` tool in `src/index.ts`):**
   - Strips comments and string literals (`stripCommentsAndStringsPreserveLines`) before matching whole-word occurrences of a symbol across the workspace.
   - Classifies every match as `"definition"`, `"import"`, `"export"`, or `"reference"` and attaches its 1-based line number and 4-hex FNV-1a `lineHash` (`<line>#<hash>| <content>`) so Muse 1.3 can immediately apply parallel `file_hash_edit` hunks across call sites.
3. **`PatchTool` Envelope & Hunk Line-Prefix Auto-Repair (`repairPatchToolInputInPlace` in `src/interceptors/tool-interceptors.ts`):**
   - Wraps bare `*** (Update|Add|Delete) File:` hunks in `*** Begin Patch` / `*** End Patch` markers before `Patch.parse(input.patchText)` (`packages/core/src/tool/plugin/patch.ts:88`) runs.
   - Strips accidental `ReadTool` (`12: `) and `file_hash_read` (`12#a3f2| `) prefixes inside `+`, `-`, and ` ` hunk lines.
4. **Head+Tail Anti-Truncation Output Compactor (`compactToolOutputHeadTail` in `src/interceptors/tool-interceptors.ts`):**
   - Keeps the first 35% and last 65% of lines/bytes when primary tool output exceeds `1,400` lines or `38 KiB`, ensuring the total output plus appended `<diagnostics>`, `<fault-context>`, `<contract-impact>`, `<mutation-receipt>`, and `<circuit-breaker>` blocks stays safely below `ToolOutput.truncate`'s `2,000`-line / `50 KiB` cliff.
5. **Dual Direct + Code Mode (`tools.harness.*`) Namespace Registration (`src/host/contract-adapter.ts`) & Worktree Compaction Cleanup (`src/interceptors/session-interceptors.ts`):**
   - Registers all 12 tools with `options: { codemode: false }` for top-level direct calls AND, when `typeof editor.namespace === "function"` on OpenCode V2's `ToolEditor`, registers the `"harness"` namespace (`tools.harness.*` with `options: { namespace: "harness", codemode: true, pinned: true }`) so Code Mode (`execute({ code })`) scripts can invoke `tools.harness.repo_map`, `tools.harness.blast_radius`, `tools.harness.symbol_references`, `tools.harness.file_outline`, `tools.harness.file_hash_read`, `tools.harness.ast_structural_search`, and `tools.harness.architecture_audit`.
   - Strips `OpenCodeTools.Plugin`'s `"When you create a worktree outside the current working directory..."` (`packages/core/src/tool/plugin/opencode.ts:102`) from `event.system` during `session.hook("compaction")`.

## 2. Test & Acceptance Results

- Unit & Integration Suites: **189 pass, 0 fail** across 11 test files (183 prior tests from Waves 1–5 + 6 new Wave 6 tests in `test/wave6-engineering.test.ts`).
- Zero-Stub, `.js`-Import & Scope-Refusal Gates (`scripts/accept/wave-1.sh` through `wave-6.sh`): All green.
