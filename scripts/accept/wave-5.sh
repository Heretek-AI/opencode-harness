#!/usr/bin/env bash
# Wave 5 acceptance: zero-patch plugin interceptors + architecture advisor.
# Exits 0 when every gate passes, 1 otherwise.
#
# Runs Waves 1–4 as regressions plus Wave-5-specific checks:
# 3 new modules wired into src/index.ts, the plugin-interceptors suite,
# architecture_audit tool, dual-shape circuit-breaker mapping, canonical
# EpisodicLesson, and stub/scope scans.
set -euo pipefail

cd "$(dirname "$0")/../.."
FAIL=0

pass() { printf 'ok: %s\n' "$1"; }
fail() { printf 'FAIL: %s\n' "$1"; FAIL=1; }

# Gate 1: strict typecheck.
if bun run check; then
  pass "bun run check (tsc --noEmit)"
else
  fail "bun run check (tsc --noEmit)"
fi

# Gate 2: full unit suite (173 prior + 10 interceptors = 183).
if bun test; then
  pass "bun test (full suite incl. plugin-interceptors)"
else
  fail "bun test (full suite incl. plugin-interceptors)"
fi

# Gate 3: plugin-interceptors suite in isolation.
if bun test test/plugin-interceptors.test.ts; then
  pass "bun test test/plugin-interceptors.test.ts (10 interceptor tests)"
else
  fail "bun test test/plugin-interceptors.test.ts"
fi

# Gate 4: Waves 1–4 regressions intact.
for wave in 1 2 3 4; do
  if bash scripts/accept/wave-"$wave".sh > /tmp/wave5-wave"$wave".log 2>&1; then
    pass "wave-$wave regression"
  else
    fail "wave-$wave regression (see /tmp/wave5-wave$wave.log)"
  fi
done

# Gate 5: zero-stub scan over src/ and test/ (expected: zero hits).
STUB_HITS=""
if grep -rn --include='*.ts' -E 'TODO|test\.skip|describe\.skip|it\.skip|set \+e' src test; then
  STUB_HITS="yes"
fi
if grep -rn -F '||' src test --include='*.ts' | grep -F 'true' | grep -v -F 'metrics-true' ; then
  STUB_HITS="yes"
fi
if grep -rn --include='*.ts' -E 'catch[[:space:]]*(\([^)]*\))?[[:space:]]*\{\s*\}' src test; then
  STUB_HITS="yes"
fi
if [ -z "$STUB_HITS" ]; then
  pass "zero-stub scan (no TODO/skip/empty-catch in src, test)"
else
  fail "zero-stub scan found forbidden patterns above"
fi

# Gate 6: all Wave 5 new-module symbols present.
for symbol in repairEditToolInputInPlace buildEditNearMissContext resolveMissingReadPath hardenShellInvocation didToolExecutionFail extractToolOutputText appendBlocksToToolAfterEvent normalizePluginToolResult calibrateSystemPromptInPlace decontaminateCompactionEventInPlace recordSessionParentLink resolveRootSessionAffinity clearSessionLineage applyRootAffinityHeadersInPlace detectCircularDependencies evaluateContractChangeImpact scanFileEngineeringQuality runArchitectureAudit architecture_audit HARNESS_RELEASE_VERSION toTrippedDirective; do
  if grep -rq --include='*.ts' -F "$symbol" src; then
    pass "export present: $symbol"
  else
    fail "export missing: $symbol"
  fi
done

# Gate 7: every new module is wired into src/index.ts (no unwired modules).
for mod in interceptors/tool-interceptors interceptors/session-interceptors verify/architecture-advisor; do
  if grep -Fq "$mod" src/index.ts; then
    pass "wired into index: $mod"
  else
    fail "unwired module (not referenced from src/index.ts): $mod"
  fi
done

# Gate 8: core Wave 3 surface preserved exactly (5 tools, 3 hooks, MCP config, KV invariants).
for symbol in HARNESS_TOOL_NAMES file_hash_read file_hash_edit ast_structural_search ast_structural_rewrite ui_geometry_audit "permission.hook" "tool.execute.after" "session.hook" getRecommendedMcpConfig injectContextBudgetIntoMessages; do
  if grep -rq --include='*.ts' -F "$symbol" src/index.ts; then
    pass "core surface preserved: $symbol"
  else
    fail "core surface regression: $symbol"
  fi
done
for symbol in "lsp-mcp-server" "fallow-mcp"; do
  if grep -rq --include='*.ts' -F "$symbol" src; then
    pass "core surface preserved: $symbol"
  else
    fail "core surface regression: $symbol"
  fi
done
if bun -e '
import { getRecommendedMcpConfig } from "./src/index.ts";
const config = getRecommendedMcpConfig();
const keys = Object.keys(config.mcpServers).sort().join(",");
if (keys !== "fallow-mcp,lsp-mcp-server") { throw new Error("mcp server keys mismatch: " + keys); }
const lsp = config.mcpServers["lsp-mcp-server"];
if (lsp.command !== "bunx" || lsp.args.join(" ") !== "lsp-mcp-server") { throw new Error("lsp block mismatch"); }
const fallow = config.mcpServers["fallow-mcp"];
if (fallow.command !== "npx" || fallow.args.join(" ") !== "--yes --package fallow fallow-mcp") { throw new Error("fallow block mismatch"); }
console.log("mcp config exact: lsp-mcp-server + fallow-mcp");
'; then
  pass "getRecommendedMcpConfig exact shape (bunx + npx fallow)"
else
  fail "getRecommendedMcpConfig shape mismatch"
fi

# Gate 9: extended surface present (Wave 4 tools + architecture_audit) and
# Wave-4 fixes preserved (triggered/intervention mapping, fail-closed string
# checks, .js extension imports, canonical EpisodicLesson).
for symbol in EXTENDED_HARNESS_TOOL_NAMES repo_map blast_radius file_outline verify_scoped architecture_audit checkpoint_create checkpoint_rollback; do
  if grep -rq --include='*.ts' -F "$symbol" src/index.ts; then
    pass "extended surface present: $symbol"
  else
    fail "extended surface missing: $symbol"
  fi
done
for symbol in "verdict.triggered" "verdict.intervention" "non-string user content (fail-closed)" "context-budget.js" "repomap.js" "interface EpisodicLesson"; do
  if grep -rq --include='*.ts' -F "$symbol" src; then
    pass "wave-4 fix preserved: $symbol"
  else
    fail "wave-4 fix regression: $symbol"
  fi
done
if grep -rn --include='*.ts' -E 'from "\.\.?/[^"]*(repomap|context-budget|contract-adapter|verifier|episodic-memory)"' src | grep -v '\.js"'; then
  fail "extensionless relative import found (must use .js)"
else
  pass "all relative imports use .js extensions"
fi
EPISODIC_DEFS=$(grep -rn --include='*.ts' -E 'interface EpisodicLesson \{' src | wc -l | tr -d ' ')
if [ "$EPISODIC_DEFS" = "1" ]; then
  pass "canonical EpisodicLesson defined exactly once (context-budget)"
else
  fail "EpisodicLesson defined $EPISODIC_DEFS times (expected exactly 1)"
fi

# Gate 10: scope refusal — no WebUI, HTTP server, DAG scheduler,
# worktree manager, or epistemic engine code in src, scripts, or test.
if grep -rni --include='*.ts' -E 'http\.createServer|app\.listen|Server\.listen|multi-agent DAG|epistemic research|worktree manager' src test; then
  fail "scope refusal scan found forbidden constructs"
else
  pass "scope refusal scan (single-session plugin only)"
fi
if grep -v '^[[:space:]]*#' scripts/accept/wave-5.sh | grep -v 'grep ' | grep -ni -E 'http\.createServer|app\.listen|Server\.listen|multi-agent DAG|epistemic research|worktree manager'; then
  fail "scope refusal scan found forbidden constructs in wave-5.sh"
else
  pass "scope refusal scan (wave-5.sh clean)"
fi

# Gate 11: upstream scripts remain reference-only (never executed here).
if grep -q -i 'reference-only\|NOT applied' scripts/upstream/README.md; then
  pass "upstream scripts documented reference-only"
else
  fail "upstream reference-only documentation missing"
fi

if [ "$FAIL" -eq 0 ]; then
  printf 'WAVE 5 ACCEPT: ALL GATES GREEN\n'
  exit 0
else
  printf 'WAVE 5 ACCEPT: GATES FAILED\n'
  exit 1
fi
