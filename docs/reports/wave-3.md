# Wave 3 Implementation Report — Unified OpenCode v2 Plugin Entrypoint

- **Stage ID:** Wave 3 (`wave-3-plugin-entry`)
- **Scope:** `docs/prompts/SPEC.md` Section 2.5 — `src/index.ts`,
  `test/plugin.test.ts`, `scripts/accept/wave-3.sh`, `README.md`
- **Branch:** `wave-3-plugin-entry`
- **Date:** 2026-10-15

## 1. Summary of deliverables

Implemented the unified OpenCode v2 plugin entrypoint with zero stubs and
fail-closed semantics throughout:

1. **`src/index.ts`** — plugin entrypoint (~700 lines):
   - Minimal, fully typed OpenCode v2 host surface (`PluginContext` with
     callable `tool(name, def)` carrying `tool.execute.after`,
     `permission.hook("evaluate")`, `session.hook("context")`; no `any`
     anywhere — `unknown`/`Record<string, unknown>` plus generic
     `z.ZodType<T>` schemas).
   - `activate(context)` (strictly one parameter per SPEC) registers the
     five tools and three hooks with default settings;
     `createHarnessPlugin(options?)` resolves options fail-closed
     (`resolveHarnessOptions`: non-empty `rootDir`, finite `>= 0` budget,
     validated `guardConfig`/`taskMd`/`planMd`/`lessons`) and returns
     `{ name, version, toolNames, hookNames, options, activate }`.
   - Tools `file_hash_read`, `file_hash_edit`, `ast_structural_search`,
     `ast_structural_rewrite`, `ui_geometry_audit` — every executor
     zod-validates args first, then delegates to the Wave 1/2
     implementation bound to the resolved `rootDir`. The geometry tool
     serves `elements` purely via `evaluateDomGeometryInPage` (returning a
     `{ url: null, defects, axeViolations: [], viewports: [] }` envelope)
     or `url` via `auditLivePageWithPlaywright`, and throws fail-closed
     when given neither.
   - Hooks: permission evaluate delegates to `evaluateBoardGuard` with the
     resolved guard config; `tool.execute.after` runs
     `recordAndEvaluateCircuitBreaker` (validates the observation, derives
     the shell prefix with `commandPrefixOf`, delegates to
     `recordToolAttempt`); session context runs
     `registerContextBudgetHook`, which chains `buildDynamicContextBlocks`
     → `packBlocks` → `injectContextBudgetIntoMessages`, is a strict no-op
     on an empty pack, and never touches `event.system`.
   - `getRecommendedMcpConfig()` re-exported from
     `./ui-auditor/mcp-defaults` (exact `bunx lsp-mcp-server` +
     `npx --yes --package fallow fallow-mcp` blocks); all seven other
     modules re-exported via `export *`, so no Wave 1/2 module is unwired.
2. **`test/plugin.test.ts`** (61 tests) — fake `PluginContext` host
   capturing tools and all three hook namespaces; covers registration
   identity, per-tool zod validation, end-to-end read/edit/search/rewrite
   against temp dirs, five geometry defect families, guard Rules 1–4
   through the registered handler (including a verdict-equality check
   against direct `evaluateBoardGuard` and a custom `taskOwnedPaths`
   config), breaker thresholds through both the direct function and the
   captured `after` handler, KV invariants through both the direct hook
   and the captured session handler (system snapshot equality, no-user
   throw path, no-op path, lesson ordering with exact bare-tag shape,
   tiny-budget priority behavior), MCP exactness/freshness, and
   re-export wiring with functional spot checks.
3. **`scripts/accept/wave-3.sh`** (executable; exits 0/1) — typecheck,
   full suite, Wave 1 + Wave 2 regressions (via their scripts, not via
   `make accept`, avoiding self-recursion), zero-stub scan, 18 SPEC 2.5
   export checks, 8-module wiring checks, plugin-suite coverage checks, a
   live `bun -e` MCP exactness assertion, and the scope-refusal scan.
4. **`README.md`** — plugin usage (`activate` / `createHarnessPlugin`),
   tool and hook tables, MCP config block, KV invariants, build commands,
   project structure.

## 2. Files created / modified

Created:

- `test/plugin.test.ts` (61 tests)
- `scripts/accept/wave-3.sh` (executable; exits 0/1)
- `README.md`
- `docs/reports/wave-3.md` (this report)

Modified:

- `src/index.ts` (replaced the Step 0 placeholder with the full
  entrypoint; `HARNESS_NAME`/`HARNESS_VERSION` preserved so
  `test/bootstrap.test.ts` still passes)

Unmodified: all Wave 1 (`src/editors/*`, `src/guards/*`) and Wave 2
(`src/context/*`, `src/ui-auditor/*`) modules and their suites.

## 3. Test results

- `bun run check` (`tsc --noEmit`): exit 0, zero diagnostics.
- `bun test`: **161 pass, 0 fail, 543 expect() calls** across 8 files —
  Wave 1 + Wave 2 floor of 100 intact plus 61 new plugin tests.
- `bash scripts/accept/wave-3.sh`: exit 0 — typecheck, full suite, both
  regression scripts, zero-stub scan, 18 export checks, 8 wiring checks,
  6 coverage checks, MCP exactness assertion, and scope-refusal scan all
  green.
- `make accept` (all three scripts): exit 0.

## 4. Self-audit notes

- **Zero stubs:** no `TODO`, no `test.skip`/`describe.skip`/`it.skip`, no
  empty `catch` blocks (index.ts has no `try/catch` at all — errors
  propagate fail-closed; zod parsing throws), no `|| true` / `set +e` /
  `cmd: "true"` in `src/` or `test/` (new code uses `??` exclusively so
  no line contains both `||` and `true`), no bare `return true;` in new
  code (verdicts are returned as objects; boolean assertions live only in
  tests as `toBe(...)` matchers without `||` on the line).
- **Fail-closed:** `resolveHarnessOptions` rejects non-object options,
  empty `rootDir`, malformed `guardConfig`, and non-finite/negative
  budgets; `assertValidPluginContext` rejects null contexts and contexts
  missing any of the four required surface points with a named list;
  every tool executor parses args with zod before touching disk; the
  geometry executor throws when given neither `url` nor `elements`, and
  invalid URLs are rejected before any browser launches (no live-browser
  tests — network/binary dependent); the context hook throws when a
  non-empty pack has no user message and never falls back to `system`.
- **KV-cache invariants:** covered through the registered session hook,
  not just the direct function — system JSON-identical before/after,
  earlier messages untouched by reference equality, lessons ordered
  `m-1, m-10, m-2` with opening tags exactly
  `<episodic-repository-memory id="...">` (asserted by reconstructing
  each tag), tiny-budget run keeps priority-1 episodic content while
  dropping the 100-token task block.
- **Wiring:** `src/index.ts` references all eight module paths
  (`export *` for seven, explicit named re-export for `mcp-defaults`;
  `grep -F` wiring gate in `wave-3.sh` checks each path string), and
  every re-exported value used by the plugin is additionally imported
  directly for its implementation.
- **Deviations from SPEC:** none. `activate` takes exactly
  `(context: PluginContext)`; configuration flows through
  `createHarnessPlugin(options?)`. `wave-3.sh` runs the Wave 1/2 scripts
  directly rather than via `make accept` to avoid self-recursion — the
  full `make accept` chain is verified separately and green.
- **Scope:** no WebUI, HTTP server, scheduler, VCS-automation, or
  literature-review code added; scope-refusal grep green.
