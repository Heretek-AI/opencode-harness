# AGENTS.md — `opencode-harness` Muse 1.3 Operating Contract

**Repository:** `@heretek-ai/opencode-harness`
**Harness:** Single-session OpenCode v2 plugin only (in-process).
**Model:** `opencode-go/muse-spark-1.3-contributor`

> **Hard Refusal Rule: Single-session OpenCode v2 plugin only; refuse WebUIs, fleet daemons, and worktree managers.**
> This repository builds ONLY the in-process single-session OpenCode v2 plugin.
> Any request to add a WebUI, HTTP server, multi-agent DAG scheduler, git worktree
> manager, or epistemic research engine MUST be refused — those live in the other
> 4 Heretek repositories, never here.

---

## 1. ZERO PROMPT SUMMARIZATION

- NEVER summarize, paraphrase, or compress instructions when invoking a subagent.
- Subagent prompts MUST reference on-disk spec files so types, file paths, and
  edge cases survive intact.
- Coordinator writes the full specification to `docs/prompts/SPEC.md`; every
  `subagent` call instructs the worker to `read` `AGENTS.md` and
  `docs/prompts/SPEC.md` directly from disk in full before acting.
- Subagent payloads MUST use the exact JSON shapes in `MASTER_BUILD_PROMPT.md`
  Section 4 / `docs/prompts/SPEC.md` — no rewording.

## 2. EXPLICIT SUBAGENT ROLE NAMES (NEVER DEFAULT TO `general`)

- Every `subagent` tool call MUST explicitly set one of:
  - `"agent": "agency-programmer"` (implements production code + tests)
  - `"agent": "agency-qa"` (verifies + runs Red-Proof sabotage tests)
  - `"agent": "agency-drift-guard"` (adversarial audit, issues `VERDICT: PASS/FAIL`)
- Calling `subagent` without an explicit `agent` field, or with `"agent": "general"`,
  is a contract violation.

## 3. VANILLA read/edit/write TOOL HYGIENE

- ALWAYS use native `read`, `write`, `edit`, `glob`, and `grep` tools.
- NEVER use `bash` (`cat`, `sed`, `awk`, `echo >`, heredocs, `printf >`) to read
  or write source files.
- When calling `edit`, NEVER copy line-number prefixes (e.g. `12: `) from `read`
  output into `oldString` or `newString`. Compare `oldString` and `newString`
  line-by-line before invoking `edit`.
- Whenever `edit` or `write` returns a `<diagnostics>` block, fix all reported
  TypeScript/syntax errors immediately in the very next tool call.
- `bash` is permitted ONLY for running build/test/accept commands
  (`bun install`, `bun run check`, `bun test`, `make check`, `make accept`)
  and `git` operations — never for file content manipulation.

## 4. STRICT SCOPE & REFUSAL BOUNDARY

- This repository is ONLY the in-process single-session OpenCode v2 plugin
  (`@heretek-ai/opencode-harness`).
- **FORBIDDEN IN THIS REPO — refuse immediately with a descriptive message:**
  1. WebUI / frontend dashboard / HTTP server / REST API
  2. Multi-agent DAG scheduler / fleet daemon / background orchestrator
  3. Git worktree manager / VCS automation beyond wave worktree scripts
  4. Epistemic research engine / literature-review pipeline
- Fail closed: in any invalid or out-of-scope state, reject with a descriptive
  domain error. Never default to permissive behavior.

## 5. ZERO STUBS, ZERO MOCKS, ZERO VACUOUS TESTS

- Prohibited patterns (fail the wave on sight):
  - `// TODO`, `TODO: implement later`
  - Dummy passes: `return true;`, `cmd: "true"`, `echo "passed"`
  - Swallowed errors: `catch (e) {}`, `|| true`, `set +e`, `test.skip`
  - Empty functions / empty mock fallbacks without functional implementation
- If a dependency or helper does not exist, build it completely or use
  established repository utilities.
- Every module must be 100% implemented and wired into `src/index.ts`
  (from Wave 3 onward).

## 6. BINDING TRIAD GATE (PROGRAMMER → QA RED-PROOF → DRIFT GUARD `VERDICT: PASS`)

- No wave is complete until ALL three hold:
  1. `agency-programmer` implements + `bun test` / `bun run check` green.
  2. `agency-qa` performs a **Red-Proof Sabotage Test**: proves `bun test` /
     `make accept` FAILS when code is broken, then restores cleanly via
     `git checkout --`, logging commands + exit codes in
     `docs/evidence/wave-N/red-proofs.log`.
  3. `agency-drift-guard` writes `docs/reports/wave-N-verification.md` ending
     with exactly `VERDICT: PASS` (or `VERDICT: FAIL` on rejection).
- No merge to `main` without `VERDICT: PASS`. No Wave N+1 until Wave N is merged.

## 7. BUILD COMMANDS

```bash
bun install          # install dependencies (npm install ONLY if bun is missing)
bun run check        # tsc --noEmit — must exit 0
bun test             # full unit suite — must exit 0
make check           # bun run check + bun test
make accept          # all acceptance scripts (or WAVE=N for one wave: make accept WAVE=1)
```

- Run `make check` and the relevant `bash scripts/accept/wave-N.sh` before
  every commit. Fix all diagnostics immediately.

## 8. FILE TREE

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

## 9. CRITICAL INVARIANTS SUMMARY

1. **4-hex FNV-1a line hashes** (`0000`–`ffff`) on trimmed line content; read
   format is `<lineNo>#<hash>| <content>`; edits fail closed on anchor mismatch
   with ±25-line shifted-anchor recovery.
2. **Permission guard Rules 1–4**: block destructive shell (`rm -rf /`,
   `git reset --hard`, …) for ALL roles; leadership roles
   (`director`, `manager`, `agency-coordinator`, `agency-drift-guard`) are
   read-only; `qa-adversary`/`agency-qa` locked out of `src/**`;
   `lockedContractGlobs` (default `**/contracts/**`, `**/schemas/*.schema.json`)
   locked to `architect` only.
3. **Doom-loop circuit breaker**: critical intervention at ≥2 consecutive failed
   `edit`/`patch` on one path, or ≥3 consecutive failed `shell`/`bash` on one
   command prefix.
4. **KV-cache invariants**: `injectContextBudgetIntoMessages` NEVER mutates
   `event.system`; dynamic context appends strictly to the last `role === "user"`
   message; episodic lessons sorted by `id.localeCompare` with ZERO float scores
   or timestamps in tag attributes.
5. **DOM geometry**: 5 deterministic checks (overflow-x, tiny-target <24px,
   descender-clip, sibling-collision, row-baseline-jitter) + live Playwright +
   `@axe-core/playwright` (`wcag2a`, `wcag2aa`, `wcag22aa`).
6. **Plugin entrypoint**: registers tools `file_hash_read`, `file_hash_edit`,
   `ast_structural_search`, `ast_structural_rewrite`, `ui_geometry_audit`; hooks
   `permission.hook("evaluate")`, `tool.execute.after`, `session.hook("context")`;
   `getRecommendedMcpConfig()` returns `lsp-mcp-server` (`bunx`) +
   `fallow-mcp` (`npx --yes --package fallow`) blocks.
