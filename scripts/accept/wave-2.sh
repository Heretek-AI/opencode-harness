#!/usr/bin/env bash
# Wave 2 acceptance: KV-cache-safe context budget + DOM geometry auditor.
# Exits 0 when every gate passes, 1 otherwise.
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

# Gate 2: full unit suite (Wave 2 suites plus the Wave 1 regression floor).
if bun test; then
  pass "bun test (full suite incl. context-budget, dom-auditor, mcp-defaults)"
else
  fail "bun test (full suite incl. context-budget, dom-auditor, mcp-defaults)"
fi

# Gate 3: zero-stub scan over src/ and test/ (expected: zero hits).
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

# Gate 4: required SPEC Section 2.4 exports and invariants exist.
for symbol in estimateTokens packBlocks buildDynamicContextBlocks injectContextBudgetIntoMessages opencode-harness-context episodic-repository-memory evaluateDomGeometryInPage auditLivePageWithPlaywright element-overflow-x tiny-interactive-target descender-clip-risk sibling-collision row-baseline-jitter getRecommendedMcpConfig lsp-mcp-server fallow-mcp wcag2a wcag2aa wcag22aa; do
  if grep -rq --include='*.ts' -F "$symbol" src; then
    pass "export present: $symbol"
  else
    fail "export missing: $symbol"
  fi
done

# Gate 5: KV-cache invariant spot checks inside the committed tests.
for invariant in "event.system" 'role === "user"' localeCompare; do
  if grep -rq --include='*.ts' -F "$invariant" test/context-budget.test.ts; then
    pass "invariant covered: $invariant"
  else
    fail "invariant missing from context-budget tests: $invariant"
  fi
done

# Gate 6: scope refusal — no WebUI, HTTP server, DAG scheduler,
# worktree manager, or epistemic engine code in src or test.
if grep -rni --include='*.ts' -E 'http\.createServer|app\.listen|Server\.listen|multi-agent DAG|epistemic research|worktree manager' src test; then
  fail "scope refusal scan found forbidden constructs"
else
  pass "scope refusal scan (single-session plugin only)"
fi

if [ "$FAIL" -eq 0 ]; then
  printf 'WAVE 2 ACCEPT: ALL GATES GREEN\n'
  exit 0
else
  printf 'WAVE 2 ACCEPT: GATES FAILED\n'
  exit 1
fi
