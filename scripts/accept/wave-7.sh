#!/usr/bin/env bash
# Wave 7 acceptance: lexer-safe atomic multi-file rename_symbol tool,
# post-mutation & post-formatter FNV-1a anchor resync receipt, adaptive
# session.hook("retry") stream/overload recovery, unused export & orphan
# module dead-code detector, and automatic circuit-breaker recovery lesson
# synthesis.
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

# Gate 2: full unit suite (189 prior + 5 wave7 = 194).
if bun test; then
  pass "bun test (full suite incl. wave7-systems)"
else
  fail "bun test (full suite incl. wave7-systems)"
fi

# Gate 3: wave7-systems suite in isolation.
if bun test test/wave7-systems.test.ts; then
  pass "bun test test/wave7-systems.test.ts (5 wave7 tests)"
else
  fail "bun test test/wave7-systems.test.ts"
fi

# Gate 4: Waves 1–6 regressions intact.
for wave in 1 2 3 4 5 6; do
  if bash scripts/accept/wave-"$wave".sh > /tmp/wave7-wave"$wave".log 2>&1; then
    pass "wave-$wave regression"
  else
    fail "wave-$wave regression (see /tmp/wave7-wave$wave.log)"
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

# Gate 6: all Wave 7 new symbols present.
for symbol in renameSymbolAcrossWorkspace rename_symbol buildPostMutationAnchorReceipt handleSessionRetryInPlace detectUnusedExportsAndOrphanModules trackCircuitBreakerAndAutoProposeLesson; do
  if grep -rq --include='*.ts' -F "$symbol" src; then
    pass "export present: $symbol"
  else
    fail "export missing: $symbol"
  fi
done

# Gate 7: all relative imports in src/ use .js extensions.
if grep -rn --include='*.ts' -E 'from "\.\.?/[^"]+"' src | grep -v '\.js"'; then
  fail "extensionless relative import found in src/ (must use .js)"
else
  pass "all relative imports in src/ use .js extensions"
fi

# Gate 8: scope refusal — no WebUI, HTTP server, DAG scheduler,
# worktree manager, or epistemic engine code in src, scripts, or test.
if grep -rni --include='*.ts' -E 'http\.createServer|app\.listen|Server\.listen|multi-agent DAG|epistemic research|worktree manager' src test; then
  fail "scope refusal scan found forbidden constructs"
else
  pass "scope refusal scan (single-session plugin only)"
fi

if [ "$FAIL" -eq 0 ]; then
  printf 'WAVE 7 ACCEPT: ALL GATES GREEN\n'
  exit 0
else
  printf 'WAVE 7 ACCEPT: GATES FAILED\n'
  exit 1
fi
