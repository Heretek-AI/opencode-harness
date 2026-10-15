#!/usr/bin/env bash
# Wave 1 acceptance: deterministic editors + guards.
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

# Gate 2: Wave 1 unit suites.
if bun test test/editors.test.ts test/guards.test.ts test/circuit-breaker.test.ts test/bootstrap.test.ts; then
  pass "bun test (editors, guards, circuit-breaker, bootstrap)"
else
  fail "bun test (editors, guards, circuit-breaker, bootstrap)"
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

# Gate 4: required SPEC Section 2.3 exports exist.
for symbol in computeLineHash hashReadFile hashEditFile astSearch astRewriteFile classifyShellCommand evaluateBoardGuard recordToolAttempt sessionAttempts shouldEscalateModel "circuit-breaker-intervention severity"; do
  if grep -rq --include='*.ts' -F "$symbol" src; then
    pass "export present: $symbol"
  else
    fail "export missing: $symbol"
  fi
done

# Gate 5: scope refusal — no WebUI, HTTP server, DAG scheduler,
# worktree manager, or epistemic engine code in src or test.
if grep -rni --include='*.ts' -E 'http\.createServer|app\.listen|Server\.listen|multi-agent DAG|epistemic research|worktree manager' src test; then
  fail "scope refusal scan found forbidden constructs"
else
  pass "scope refusal scan (single-session plugin only)"
fi

if [ "$FAIL" -eq 0 ]; then
  printf 'WAVE 1 ACCEPT: ALL GATES GREEN\n'
  exit 0
else
  printf 'WAVE 1 ACCEPT: GATES FAILED\n'
  exit 1
fi
