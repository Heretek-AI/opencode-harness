# MASTER COORDINATOR BUILD PROMPT: REPO 1 — `opencode-harness`
**Target Repository:** `/home/john/Projects/Heretek-AI-Rebuild/opencode-harness`  
**GitHub Remote:** `https://github.com/Heretek-AI/opencode-harness`  
**Package Name:** `@heretek-ai/opencode-harness`  
**Primary Session Agent:** `agency-coordinator` (`opencode-go/muse-spark-1.3-contributor`)  
**Required Triad Subagents:** `agency-programmer`, `agency-qa`, `agency-drift-guard`

---

## 0. CRITICAL MUSE 1.3 HARNESS SUPPLEMENT (READ FIRST — NON-NEGOTIABLE)

You are running on `opencode-go/muse-spark-1.3-contributor` inside the vanilla OpenCode v2 harness. To prevent the known failure modes of Muse 1.3 in the vanilla harness, you MUST obey these six rules on every turn:

1. **ZERO PROMPT SUMMARIZATION WHEN CALLING SUBAGENTS:**
   - Muse 1.3 has a tendency to summarize instructions when calling `subagent`, which causes `agency-programmer` to drop types, file paths, and edge cases.
   - **MANDATORY FIX:** In Wave 0 below, you (`agency-coordinator`) will write this entire specification into `docs/prompts/SPEC.md` and `AGENTS.md` on disk. When you invoke `subagent`, you MUST use the exact JSON payloads in Section 4, which instruct `agency-programmer`, `agency-qa`, and `agency-drift-guard` to `read` `AGENTS.md` and `docs/prompts/SPEC.md` directly from disk.
2. **EXPLICIT SUBAGENT ROLE NAMES (NEVER DEFAULT TO `general`):**
   - Every `subagent` tool call MUST explicitly set `"agent": "agency-programmer"`, `"agent": "agency-qa"`, or `"agent": "agency-drift-guard"`.
3. **VANILLA `read` / `edit` / `write` TOOL HYGIENE:**
   - Always use native `read`, `write`, `edit`, `glob`, and `grep` tools—never use `bash` (`cat`, `sed`, `awk`, `echo >`) to read or write source files.
   - When calling `edit`, NEVER copy line-number prefixes (e.g. `12: `) from `read` output into `oldString` or `newString`. Compare `oldString` and `newString` line-by-line before invoking `edit`.
   - Whenever `edit` or `write` returns a `<diagnostics>` block, fix all reported TypeScript/syntax errors immediately in your very next tool call.
4. **STRICT SCOPE & REFUSAL BOUNDARY FOR `opencode-harness`:**
   - This repository is **ONLY** the in-process single-session OpenCode v2 plugin (`@heretek-ai/opencode-harness`).
   - **FORBIDDEN IN THIS REPO:** Do NOT build any WebUI, HTTP server, multi-agent DAG scheduler, git worktree manager, or epistemic research engine here. Those live in the other 4 Heretek repositories.
5. **ZERO STUBS, ZERO MOCKS, ZERO VACUOUS TESTS:**
   - Never write `// TODO`, `cmd: "true"`, `|| true`, `test.skip`, or empty functions. Every module must be 100% implemented and wired into `src/index.ts`.
6. **BINDING TRIAD GATE (PROGRAMMER → QA RED-PROOF → DRIFT GUARD `VERDICT: PASS`):**
   - No wave is complete until `agency-qa` performs a **Red-Proof Sabotage Test** (proving `bun test` / `make accept` fails when code is broken, then restoring cleanly via `git checkout --`) AND `agency-drift-guard` writes `VERDICT: PASS` in `docs/reports/wave-<N>-verification.md`.

---

## 1. TARGET REPOSITORY ARCHITECTURE & FILE TREE

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

## 2. EXACT FILE-BY-FILE SPECIFICATIONS (WRITE TO `docs/prompts/SPEC.md` IN WAVE 0)

### 2.1 `package.json`
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

### 2.2 `Makefile`
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

### 2.3 Wave 1 Modules: Deterministic Editors & Guards (`src/editors/*` & `src/guards/*`)

#### A. `src/editors/hashline-tools.ts`
Must export:
- ` computeLineHash(line: string): string` — deterministic 4-hex-char FNV-1a hash of trimmed line content (upgraded from 2-hex-char to 16-bit 4-hex-char `0000`–`ffff` to eliminate birthday-paradox collisions on 40+ line files!).
- `hashReadFile(rootDir: string, relPath: string, offset?: number, limit?: number): Promise<{ path: string; totalLines: number; content: string }>` — formats each line as `<lineNo>#<4-hex-hash>| <lineContent>`.
- `hashEditFile(rootDir: string, relPath: string, hunks: Array<{ startLine: number; startHash: string; endLine: number; endHash: string; replacement: string }>): Promise<{ applied: boolean; shiftedLines: number; path: string; error?: string }>`:
  - Resolves shifted anchors across +/-25 lines when earlier hunks insert/delete lines.
  - Validates that `startHash` and `endHash` match the target lines before mutating.
  - Fails closed without writing to disk if any hunk anchor hash mismatches.

#### B. `src/editors/ast-codemod.ts`
Must export:
- `astSearch(code: string, pattern: string, language?: "typescript" | "tsx" | "javascript" | "python" | "rust" | "go"): Array<{ text: string; startLine: number; endLine: number }>`:
  - Uses `@ast-grep/napi` (`parse(lang, code).root().findAll({ rule: { pattern } })`) with a deterministic structural metavariable (`$VAR`, `$$$ARGS`) fallback if native bindings are unavailable for a target language.
- `astRewriteFile(rootDir: string, relPath: string, pattern: string, rewrite: string, language?: string): Promise<{ modified: boolean; matchCount: number; output: string }>`.

#### C. `src/guards/shell-parse.ts` & `src/guards/permission-guard.ts`
Salvage from `/home/john/Projects/SwarmOS/src/agents/shell-parse.ts` and `guard.ts` (decoupled from `OrgBoard` so it takes a lightweight `GuardPolicyConfig` with `lockedContractGlobs: string[]`, `taskOwnedPaths?: Record<string, string[]>`):
- **Rule 1 (Destructive Command Block):** Any shell command containing `rm -rf /`, `rm -rf *`, `git reset --hard`, `git push --force`, `mkfs`, or `dd if=` is denied across ALL roles (`allowed: false`).
- **Rule 2 (Leadership Read-Only Separation):** Roles `director`, `manager`, `agency-coordinator`, and `agency-drift-guard` are denied `edit`, `write`, `patch`, and file-mutating shell commands (`allowed: false`).
- **Rule 3 (QA Red-Team Source Lock):** Roles `qa-adversary` and `agency-qa` are denied `edit`/`write`/`patch` on `src/**` (`allowed: false`), and permitted only on `**/*.test.*`, `**/*.spec.*`, `test/**`, `tests/**`, `scripts/accept/**`, and `docs/**`.
- **Rule 4 (Architect Contract Lock):** Files matching `lockedContractGlobs` (default `["**/contracts/**", "**/schemas/*.schema.json"]`) cannot be modified by any role except `architect`.

#### D. `src/guards/circuit-breaker.ts`
Implement the exact upgraded Doom-Loop Circuit Breaker from Report `01b` §9.2:
- Tracks per-session tool attempts (`sessionAttempts: Map<string, ToolAttemptRecord[]>`).
- Triggers critical intervention (`shouldEscalateModel: true`, `<circuit-breaker-intervention severity="critical">`) when:
  - `edit` or `patch` fails `>= 2` consecutive times on the same file path, OR
  - `shell` / `bash` fails `>= 3` consecutive times on the same command prefix.

---

### 2.4 Wave 2 Modules: KV-Cache-Safe Context Budget & DOM Geometry Auditor (`src/context/*` & `src/ui-auditor/*`)

#### A. `src/context/context-budget.ts` (CRITICAL KV-CACHE INVARIANT FROM REPORT `01b` §9.3)
- Must export:
  - `estimateTokens(text: string): number`
  - `packBlocks(blocks: ContextBlock[], budgetTokens: number): { text: string; usedTokens: number }`
  - `buildDynamicContextBlocks(rootDir: string, artifacts: { taskMd?: string; planMd?: string; lessons?: Array<{ id: string; trigger: string; lesson: string; needsReview?: boolean }> }): ContextBlock[]`
  - `injectContextBudgetIntoMessages(event: { agent?: string; kind?: string; system?: Array<{ text: string }>; messages?: Array<{ role: string; content: any }> }, packedText: string): void`
- **NON-NEGOTIABLE KV-CACHE INVARIANTS (Tested by `test/context-budget.test.ts`):**
  1. `injectContextBudgetIntoMessages` MUST **NEVER** mutate `event.system`! `event.system` must remain bit-for-bit identical before and after the hook runs so DeepSeek, Anthropic, and OpenCode Go KV prefix caches stay at >90% hit rate.
  2. Dynamic context (`<opencode-harness-context>...</opencode-harness-context>`) MUST be appended strictly to the **last message where `role === "user"`** in `event.messages`.
  3. Episodic lessons MUST be sorted deterministically by `a.id.localeCompare(b.id)` and formatted as `<episodic-repository-memory id="${l.id}">\n- (${l.trigger}): ${l.lesson}\n</episodic-repository-memory>` with **ZERO floating-point relevance scores or timestamps** in the tag attributes.

#### B. `src/ui-auditor/dom-auditor.ts`
- Must export:
  1. `evaluateDomGeometryInPage(elements: Array<{ tag: string; id?: string; rect: { x: number; y: number; width: number; height: number }; scrollWidth?: number; clientWidth?: number; fontSize?: number; lineHeight?: number; overflow?: string; interactive?: boolean; parentId?: string }>): GeometryDefect[]` — Pure deterministic geometry verifier checking:
     - `element-overflow-x`: `scrollWidth > clientWidth + 2`
     - `tiny-interactive-target`: `interactive === true && (rect.width < 24 || rect.height < 24)` (WCAG 2.2 Target Size)
     - `descender-clip-risk`: `lineHeight / fontSize < 1.15 && overflow === "hidden"`
     - `sibling-collision`: two siblings with same `parentId` whose bounding boxes intersect by `overlapX > 2 && overlapY > 2`
     - `row-baseline-jitter`: two siblings in the same horizontal row whose `rect.y` differs by `0.5 <= Math.abs(y1 - y2) <= 3.5`
  2. `auditLivePageWithPlaywright(url: string, viewports?: Array<{ name: string; width: number; height: number }>): Promise<DOMAuditReport>` — Launches headless Chromium via `playwright`, runs `@axe-core/playwright` (`withTags(["wcag2a", "wcag2aa", "wcag22aa"])`) + the in-page DOM geometry collector, and returns structured defects.

---

### 2.5 Wave 3 Module: Unified OpenCode v2 Plugin Entrypoint (`src/index.ts`)
- Must export `activate(context: PluginContext)` and `createHarnessPlugin(options?: HarnessPluginOptions)`:
  - Registers tools: `file_hash_read`, `file_hash_edit`, `ast_structural_search`, `ast_structural_rewrite`, `ui_geometry_audit`.
  - Registers hooks:
    - `permission.hook("evaluate", ...)` $\rightarrow$ `evaluateBoardGuard`
    - `tool.execute.after` $\rightarrow$ `recordAndEvaluateCircuitBreaker`
    - `session.hook("context", ...)` $\rightarrow$ `registerContextBudgetHook`
  - Exports `getRecommendedMcpConfig()` returning the exact `lsp-mcp-server` (`bunx lsp-mcp-server`) and `fallow-mcp` (`npx --yes --package fallow fallow-mcp`) blocks from Report `01a`.

---

## 3. WAVE-BY-WAVE TRIAD EXECUTION PLAN FOR `agency-coordinator`

Execute this repository build in **3 Sequential Waves**. Do NOT start Wave $N+1$ until Wave $N$ has received `VERDICT: PASS` from `agency-drift-guard` and is merged to `main`.

### Step 0 (Coordinator Bootstrap on `main`)
1. Write `AGENTS.md` with the Muse 1.3 Operating Contract and the Hard Refusal Rule (*"Single-session OpenCode v2 plugin only; refuse WebUIs, fleet daemons, and worktree managers"*).
2. Write this full specification to `docs/prompts/SPEC.md` and write the Drift Reviewer checklist to `docs/prompts/verify-stage.md`.
3. Write `Makefile`, `package.json`, and `tsconfig.json`.
4. Commit baseline scaffolding to `main`.

### Wave 1: Editors (`hashline-tools.ts`, `ast-codemod.ts`) & Guards (`shell-parse.ts`, `permission-guard.ts`, `circuit-breaker.ts`)
1. Create worktree: `git worktree add -b wave-1-editors-guards worktrees/wave-1 main`
2. Dispatch **Programmer (`agency-programmer`)**:
```json
{
  "agent": "agency-programmer",
  "description": "Wave 1 Programmer: Implement editors and guards in worktrees/wave-1",
  "prompt": "You are the Programmer Agent for Wave 1 in `/home/john/Projects/Heretek-AI-Rebuild/opencode-harness/worktrees/wave-1` on branch `wave-1-editors-guards`.\n\nFIRST: Read `AGENTS.md` and `docs/prompts/SPEC.md` in full.\nSECOND: Implement:\n1. `src/editors/hashline-tools.ts` (4-hex FNV-1a line hash, `hashReadFile`, `hashEditFile` with +/-25 line shifted-anchor recovery and fail-closed hash check).\n2. `src/editors/ast-codemod.ts` (`astSearch`, `astRewriteFile`).\n3. `src/guards/shell-parse.ts` and `src/guards/permission-guard.ts` (blocking destructive commands, blocking leadership writes, blocking `qa-adversary`/`agency-qa` edits on `src/**`, blocking non-architect edits on `**/contracts/**`).\n4. `src/guards/circuit-breaker.ts` (doom-loop detector triggering at >=2 failed edits or >=3 failed shell commands).\n5. Write comprehensive unit tests in `test/editors.test.ts`, `test/guards.test.ts`, and `test/circuit-breaker.test.ts`.\n6. Write executable acceptance script `scripts/accept/wave-1.sh` (must exit 0 on pass, exit 1 on fail) and report `docs/reports/wave-1.md`.\n7. Run `bun test` and `bun run check` until 100% green, then commit your work on `wave-1-editors-guards`."
}
```
3. Dispatch **QA (`agency-qa`)**:
```json
{
  "agent": "agency-qa",
  "description": "Wave 1 QA: Verify and red-proof Wave 1 in worktrees/wave-1",
  "prompt": "You are the QA Agent for Wave 1 in `/home/john/Projects/Heretek-AI-Rebuild/opencode-harness/worktrees/wave-1`.\n\n1. Run `make check` and `bash scripts/accept/wave-1.sh`. Assert both exit 0.\n2. Perform Red-Proof Sabotage: temporarily break `computeLineHash` in `src/editors/hashline-tools.ts` and confirm `bun test` exits non-zero; restore with `git checkout --`. Temporarily allow `qa-adversary` to edit `src/index.ts` in `src/guards/permission-guard.ts` and confirm `bun test` exits non-zero; restore with `git checkout --`.\n3. Record sabotage commands and exit codes in `docs/evidence/wave-1/red-proofs.log` and confirm `git status` is clean."
}
```
4. Dispatch **Drift Guard (`agency-drift-guard`)**:
```json
{
  "agent": "agency-drift-guard",
  "description": "Wave 1 Drift Reviewer: Adversarial audit of Wave 1",
  "prompt": "You are the Drift Reviewer Agent (`agency-drift-guard`) for Wave 1 in `/home/john/Projects/Heretek-AI-Rebuild/opencode-harness/worktrees/wave-1`. You change NO code.\n\n1. Read `AGENTS.md`, `docs/prompts/SPEC.md`, and `docs/reports/wave-1.md`.\n2. Run `make check` and `bash scripts/accept/wave-1.sh`.\n3. Scan `src/` and `test/` for stubs, `// TODO`, `|| true`, `test.skip`, or hardcoded pass returns.\n4. Perform your own independent sabotage test on one guard rule, verify failure, and restore cleanly.\n5. Write `docs/reports/wave-1-verification.md` ending with `VERDICT: PASS` or `VERDICT: FAIL`."
}
```
5. Once `VERDICT: PASS`, merge `wave-1-editors-guards` into `main` (`git merge --no-ff wave-1-editors-guards`) and remove the worktree.

### Wave 2: KV-Cache-Safe Context Budget (`src/context/context-budget.ts`) & DOM Geometry Auditor (`src/ui-auditor/*`)
1. Create worktree: `git worktree add -b wave-2-context-dom worktrees/wave-2 main`
2. Dispatch `agency-programmer` to implement `src/context/context-budget.ts`, `src/ui-auditor/dom-auditor.ts`, `src/ui-auditor/mcp-defaults.ts`, `test/context-budget.test.ts`, `test/dom-auditor.test.ts`, `scripts/accept/wave-2.sh`, and `docs/reports/wave-2.md`.
3. Dispatch `agency-qa` to run `make check`, `bash scripts/accept/wave-2.sh`, and red-proof sabotage (specifically testing that mutating `event.system` or injecting a float `relevance=` attribute causes `test/context-budget.test.ts` to fail!).
4. Dispatch `agency-drift-guard` to audit Wave 2 and issue `VERDICT: PASS` in `docs/reports/wave-2-verification.md`.
5. Merge `wave-2-context-dom` into `main` and remove the worktree.

### Wave 3: Plugin Entrypoint (`src/index.ts`) & Full End-to-End Acceptance
1. Create worktree: `git worktree add -b wave-3-plugin-entry worktrees/wave-3 main`
2. Dispatch `agency-programmer` to wire all tools and hooks into `src/index.ts`, write `test/plugin.test.ts`, `scripts/accept/wave-3.sh`, `README.md`, and `docs/reports/wave-3.md`.
3. Dispatch `agency-qa` to run `make check` and `make accept` across all 3 waves with red-proof sabotage.
4. Dispatch `agency-drift-guard` for final verification (`docs/reports/wave-3-verification.md` $\rightarrow$ `VERDICT: PASS`).
5. Merge `wave-3-plugin-entry` into `main`, remove worktree, and verify `make check && make accept` exits 0 on `main`.
