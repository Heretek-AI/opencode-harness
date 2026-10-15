# SPEC.md — `opencode-harness` Full Build Specification

**Source:** `MASTER_BUILD_PROMPT.md` Sections 1–2 (verbatim).
**Package:** `@heretek-ai/opencode-harness` — lean OpenCode v2 in-process harness plugin.
**Scope:** Single-session OpenCode v2 plugin ONLY. WebUIs, fleet daemons, and
worktree managers are FORBIDDEN in this repo (see `AGENTS.md` Hard Refusal Rule).

---

## Section 1 TARGET REPOSITORY ARCHITECTURE & FILE TREE

`opencode-harness` replaces the bloated 6,000-line `SwarmOS` repo with a lean, ~450-line TypeScript/Bun OpenCode v2 plugin that integrates the active 2026 OSS winners (`pi-hashline-readmap`, `@ast-grep/napi`, `lsp-mcp-server`, `fallow-mcp`, `@axe-core/playwright`) with our salvaged permission guard, doom-loop circuit breaker, and KV-cache-preserving context budget hook.

```text
/home/john/Projects/Heretek-AI-Rebuild/opencode-harness/
├── AGENTS.md
├── Makefile
├── package.json
├── tsconfig.json
├── docs/
│   ├── prompts/
│   │   ├── SPEC.md
│   │   └── verify-stage.md
│   ├── reports/
│   └── evidence/
├── scripts/
│   └── accept/
│       ├── wave-1.sh
│       ├── wave-2.sh
│       └── wave-3.sh
├── src/
│   ├── index.ts                    # Main OpenCode v2 plugin entrypoint
│   ├── editors/
│   │   ├── hashline-tools.ts       # Wraps pi-hashline-readmap (file_hash_read, file_hash_edit)
│   │   └── ast-codemod.ts          # Wraps @ast-grep/napi (ast_structural_search, ast_structural_rewrite)
│   ├── guards/
│   │   ├── shell-parse.ts          # Salvaged AST/token shell command classifier (read-only vs write vs destructive)
│   │   ├── permission-guard.ts     # Salvaged permission.hook("evaluate") role/path/contract guard
│   │   └── circuit-breaker.ts      # Patched tool doom-loop circuit breaker (edit >= 2 or shell >= 3 consecutive failures)
│   ├── context/
│   │   └── context-budget.ts       # KV-Cache-Safe context packer (NEVER mutates event.system; appends to last user msg)
│   └── ui-auditor/
│       ├── dom-auditor.ts          # Headless Playwright + @axe-core/playwright WCAG 2.2 + sibling collision & descender clip
│       └── mcp-defaults.ts         # Helper generating recommended mcpServers block (lsp-mcp-server + fallow-mcp)
└── test/
    ├── editors.test.ts             # Tests file_hash_read, file_hash_edit, and ast_structural_search/rewrite
    ├── guards.test.ts              # Tests permission-guard (blocks qa-adversary on src/**, blocks rm -rf, blocks director writes)
    ├── circuit-breaker.test.ts     # Tests doom-loop intervention after 2 failed edits or 3 failed shell runs
    ├── context-budget.test.ts      # Asserts event.system is 100% UNCHANGED and float relevance scores are stripped
    └── dom-auditor.test.ts         # Tests DOM geometry math (overflow, contrast, tiny targets, sibling collision)
```

---

## Section 2.1 `package.json`

```json
{
  "name": "@heretek-ai/opencode-harness",
  "version": "1.0.0",
  "description": "Lean OpenCode v2 in-process harness plugin: Hashline edits, AST codemods, KV-cache-safe context budgeting, permission guards, and DOM geometry auditing.",
  "type": "module",
  "main": "./src/index.ts",
  "exports": {
    ".": "./src/index.ts"
  },
  "scripts": {
    "check": "tsc --noEmit",
    "test": "bun test",
    "accept": "bash scripts/accept/run.sh"
  },
  "dependencies": {
    "@ast-grep/napi": "^0.51.0",
    "@axe-core/playwright": "^4.14.0",
    "pi-hashline-readmap": "^0.16.1",
    "playwright": "^1.64.1",
    "zod": "^3.24.0"
  },
  "devDependencies": {
    "@types/bun": "latest",
    "typescript": "^5.7.0"
  }
}
```

*(Note for `agency-programmer`: If offline or if a specific version tag in npm registry differs slightly on the host, install with `bun install` or provide a clean local TypeScript fallback wrapper with identical exports and full FNV-1a shifted-anchor / regex-AST / Playwright evaluation so `bun test` and `bun run check` pass 100% deterministically with zero network flakiness.)*

---

## Section 2.2 `Makefile`

```makefile
.PHONY: check test accept

check:
	bun run check
	bun test

test:
	bun test

accept:
	@if [ -z "$(WAVE)" ]; then \
		bash scripts/accept/wave-1.sh && \
		bash scripts/accept/wave-2.sh && \
		bash scripts/accept/wave-3.sh; \
	else \
		bash scripts/accept/wave-$(WAVE).sh; \
	fi
```

---

## Section 2.3 Wave 1 Modules: Deterministic Editors & Guards (`src/editors/*` & `src/guards/*`)

### A. `src/editors/hashline-tools.ts`

Must export:

- ` computeLineHash(line: string): string` — deterministic 4-hex-char FNV-1a hash of trimmed line content (upgraded from 2-hex-char to 16-bit 4-hex-char `0000`–`ffff` to eliminate birthday-paradox collisions on 40+ line files!).
- `hashReadFile(rootDir: string, relPath: string, offset?: number, limit?: number): Promise<{ path: string; totalLines: number; content: string }>` — formats each line as `<lineNo>#<4-hex-hash>| <lineContent>`.
- `hashEditFile(rootDir: string, relPath: string, hunks: Array<{ startLine: number; startHash: string; endLine: number; endHash: string; replacement: string }>): Promise<{ applied: boolean; shiftedLines: number; path: string; error?: string }>`:
  - Resolves shifted anchors across +/-25 lines when earlier hunks insert/delete lines.
  - Validates that `startHash` and `endHash` match the target lines before mutating.
  - Fails closed without writing to disk if any hunk anchor hash mismatches.

### B. `src/editors/ast-codemod.ts`

Must export:

- `astSearch(code: string, pattern: string, language?: "typescript" | "tsx" | "javascript" | "python" | "rust" | "go"): Array<{ text: string; startLine: number; endLine: number }>`:
  - Uses `@ast-grep/napi` (`parse(lang, code).root().findAll({ rule: { pattern } })`) with a deterministic structural metavariable (`$VAR`, `$$$ARGS`) fallback if native bindings are unavailable for a target language.
- `astRewriteFile(rootDir: string, relPath: string, pattern: string, rewrite: string, language?: string): Promise<{ modified: boolean; matchCount: number; output: string }>`.

### C. `src/guards/shell-parse.ts` & `src/guards/permission-guard.ts`

Salvage from `/home/john/Projects/SwarmOS/src/agents/shell-parse.ts` and `guard.ts` (decoupled from `OrgBoard` so it takes a lightweight `GuardPolicyConfig` with `lockedContractGlobs: string[]`, `taskOwnedPaths?: Record<string, string[]>`):

- **Rule 1 (Destructive Command Block):** Any shell command containing `rm -rf /`, `rm -rf *`, `git reset --hard`, `git push --force`, `mkfs`, or `dd if=` is denied across ALL roles (`allowed: false`).
- **Rule 2 (Leadership Read-Only Separation):** Roles `director`, `manager`, `agency-coordinator`, and `agency-drift-guard` are denied `edit`, `write`, `patch`, and file-mutating shell commands (`allowed: false`).
- **Rule 3 (QA Red-Team Source Lock):** Roles `qa-adversary` and `agency-qa` are denied `edit`/`write`/`patch` on `src/**` (`allowed: false`), and permitted only on `**/*.test.*`, `**/*.spec.*`, `test/**`, `tests/**`, `scripts/accept/**`, and `docs/**`.
- **Rule 4 (Architect Contract Lock):** Files matching `lockedContractGlobs` (default `["**/contracts/**", "**/schemas/*.schema.json"]`) cannot be modified by any role except `architect`.

### D. `src/guards/circuit-breaker.ts`

Implement the exact upgraded Doom-Loop Circuit Breaker from Report `01b` §9.2:

- Tracks per-session tool attempts (`sessionAttempts: Map<string, ToolAttemptRecord[]>`).
- Triggers critical intervention (`shouldEscalateModel: true`, `<circuit-breaker-intervention severity="critical">`) when:
  - `edit` or `patch` fails `>= 2` consecutive times on the same file path, OR
  - `shell` / `bash` fails `>= 3` consecutive times on the same command prefix.

---

## Section 2.4 Wave 2 Modules: KV-Cache-Safe Context Budget & DOM Geometry Auditor (`src/context/*` & `src/ui-auditor/*`)

### A. `src/context/context-budget.ts` (CRITICAL KV-CACHE INVARIANT FROM REPORT `01b` §9.3)

- Must export:
  - `estimateTokens(text: string): number`
  - `packBlocks(blocks: ContextBlock[], budgetTokens: number): { text: string; usedTokens: number }`
  - `buildDynamicContextBlocks(rootDir: string, artifacts: { taskMd?: string; planMd?: string; lessons?: Array<{ id: string; trigger: string; lesson: string; needsReview?: boolean }> }): ContextBlock[]`
  - `injectContextBudgetIntoMessages(event: { agent?: string; kind?: string; system?: Array<{ text: string }>; messages?: Array<{ role: string; content: any }> }, packedText: string): void`
- **NON-NEGOTIABLE KV-CACHE INVARIANTS (Tested by `test/context-budget.test.ts`):**
  1. `injectContextBudgetIntoMessages` MUST **NEVER** mutate `event.system`! `event.system` must remain bit-for-bit identical before and after the hook runs so DeepSeek, Anthropic, and OpenCode Go KV prefix caches stay at >90% hit rate.
  2. Dynamic context (`<opencode-harness-context>...</opencode-harness-context>`) MUST be appended strictly to the **last message where `role === "user"`** in `event.messages`.
  3. Episodic lessons MUST be sorted deterministically by `a.id.localeCompare(b.id)` and formatted as `<episodic-repository-memory id="${l.id}">\n- (${l.trigger}): ${l.lesson}\n</episodic-repository-memory>` with **ZERO floating-point relevance scores or timestamps** in the tag attributes.

### B. `src/ui-auditor/dom-auditor.ts`

- Must export:
  1. `evaluateDomGeometryInPage(elements: Array<{ tag: string; id?: string; rect: { x: number; y: number; width: number; height: number }; scrollWidth?: number; clientWidth?: number; fontSize?: number; lineHeight?: number; overflow?: string; interactive?: boolean; parentId?: string }>): GeometryDefect[]` — Pure deterministic geometry verifier checking:
     - `element-overflow-x`: `scrollWidth > clientWidth + 2`
     - `tiny-interactive-target`: `interactive === true && (rect.width < 24 || rect.height < 24)` (WCAG 2.2 Target Size)
     - `descender-clip-risk`: `lineHeight / fontSize < 1.15 && overflow === "hidden"`
     - `sibling-collision`: two siblings with same `parentId` whose bounding boxes intersect by `overlapX > 2 && overlapY > 2`
     - `row-baseline-jitter`: two siblings in the same horizontal row whose `rect.y` differs by `0.5 <= Math.abs(y1 - y2) <= 3.5`
  2. `auditLivePageWithPlaywright(url: string, viewports?: Array<{ name: string; width: number; height: number }>): Promise<DOMAuditReport>` — Launches headless Chromium via `playwright`, runs `@axe-core/playwright` (`withTags(["wcag2a", "wcag2aa", "wcag22aa"])`) + the in-page DOM geometry collector, and returns structured defects.

---

## Section 2.5 Wave 3 Module: Unified OpenCode v2 Plugin Entrypoint (`src/index.ts`)

- Must export `activate(context: PluginContext)` and `createHarnessPlugin(options?: HarnessPluginOptions)`:
  - Registers tools: `file_hash_read`, `file_hash_edit`, `ast_structural_search`, `ast_structural_rewrite`, `ui_geometry_audit`.
  - Registers hooks:
    - `permission.hook("evaluate", ...)` → `evaluateBoardGuard`
    - `tool.execute.after` → `recordAndEvaluateCircuitBreaker`
    - `session.hook("context", ...)` → `registerContextBudgetHook`
  - Exports `getRecommendedMcpConfig()` returning the exact `lsp-mcp-server` (`bunx lsp-mcp-server`) and `fallow-mcp` (`npx --yes --package fallow fallow-mcp`) blocks from Report `01a`.
