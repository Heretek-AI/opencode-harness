#!/usr/bin/env bash
# Wave 3 acceptance: unified OpenCode v2 plugin entrypoint.
# Exits 0 when every gate passes, 1 otherwise.
#
# This script IS the Wave 3 gate (invoking it from inside itself would
# recurse), so it runs the Wave 1 and Wave 2 scripts as regressions plus
# the Wave-3-specific checks. `make accept` (no WAVE) runs all three
# scripts in sequence.
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

# Gate 2: full unit suite (Wave 3 plugin suite plus Wave 1 + Wave 2 floor).
if bun test; then
  pass "bun test (full suite incl. plugin entrypoint)"
else
  fail "bun test (full suite incl. plugin entrypoint)"
fi

# Gate 3: Wave 1 regression intact.
if bash scripts/accept/wave-1.sh > /tmp/wave3-wave1.log 2>&1; then
  pass "wave-1 regression (editors + guards)"
else
  fail "wave-1 regression (see /tmp/wave3-wave1.log)"
fi

# Gate 4: Wave 2 regression intact.
if bash scripts/accept/wave-2.sh > /tmp/wave3-wave2.log 2>&1; then
  pass "wave-2 regression (context budget + DOM auditor)"
else
  fail "wave-2 regression (see /tmp/wave3-wave2.log)"
fi

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

# Gate 6: required SPEC Section 2.5 exports exist in src/.
for symbol in activate createHarnessPlugin getRecommendedMcpConfig file_hash_read file_hash_edit ast_structural_search ast_structural_rewrite ui_geometry_audit "permission.hook" "tool.execute.after" "session.hook" evaluateBoardGuard recordAndEvaluateCircuitBreaker registerContextBudgetHook injectContextBudgetIntoMessages packBlocks buildDynamicContextBlocks resolveHarnessOptions buildHarnessTools; do
  if grep -rq --include='*.ts' -F "$symbol" src; then
    pass "export present: $symbol"
  else
    fail "export missing: $symbol"
  fi
done

# Gate 7: every Wave 1 + Wave 2 module is wired into src/index.ts.
for mod in editors/hashline-tools editors/ast-codemod guards/shell-parse guards/permission-guard guards/circuit-breaker context/context-budget ui-auditor/dom-auditor ui-auditor/mcp-defaults; do
  if grep -Fq "$mod" src/index.ts; then
    pass "wired into index: $mod"
  else
    fail "unwired module (not referenced from src/index.ts): $mod"
  fi
done

# Gate 8: plugin suite present and covering the entrypoint surface.
if [ -f test/plugin.test.ts ]; then
  pass "test/plugin.test.ts present"
else
  fail "test/plugin.test.ts missing"
fi
for symbol in activate createHarnessPlugin getRecommendedMcpConfig recordAndEvaluateCircuitBreaker registerContextBudgetHook; do
  if grep -Fq "$symbol" test/plugin.test.ts; then
    pass "plugin test covers: $symbol"
  else
    fail "plugin test missing coverage: $symbol"
  fi
done

# Gate 9: MCP config exactness (two servers, exact launch blocks).
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

# Gate 10: scope refusal — no WebUI, HTTP server, DAG scheduler,
# VCS-automation, or literature-review code in src or test.
if grep -rni --include='*.ts' -E 'http\.createServer|app\.listen|Server\.listen|multi-agent DAG|epistemic research|worktree manager' src test; then
  fail "scope refusal scan found forbidden constructs"
else
  pass "scope refusal scan (single-session plugin only)"
fi

if [ "$FAIL" -eq 0 ]; then
  printf 'WAVE 3 ACCEPT: ALL GATES GREEN\n'
  exit 0
else
  printf 'WAVE 3 ACCEPT: GATES FAILED\n'
  exit 1
fi
