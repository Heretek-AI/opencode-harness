#!/usr/bin/env bash
# Wave 6 acceptance: cross-file import/export contract verifier, lexer-aware
# symbol_references tool, PatchTool envelope & prefix auto-repair, head+tail
# anti-truncation output compactor, and Dual Direct + Code Mode (tools.harness.*)
# tool registration.
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

# Gate 2: full unit suite (183 prior + 6 wave6 = 189).
if bun test; then
  pass "bun test (full suite incl. wave6-engineering)"
else
  fail "bun test (full suite incl. wave6-engineering)"
fi

# Gate 3: wave6-engineering suite in isolation.
if bun test test/wave6-engineering.test.ts; then
  pass "bun test test/wave6-engineering.test.ts (6 wave6 tests)"
else
  fail "bun test test/wave6-engineering.test.ts"
fi

# Gate 4: Waves 1–5 regressions intact.
for wave in 1 2 3 4 5; do
  if bash scripts/accept/wave-"$wave".sh > /tmp/wave6-wave"$wave".log 2>&1; then
    pass "wave-$wave regression"
  else
    fail "wave-$wave regression (see /tmp/wave6-wave$wave.log)"
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

# Gate 6: all Wave 6 new symbols present.
for symbol in resolveRelativeModuleFile parseRelativeImportStatements collectExportedSymbolNames verifyModuleImportsAndExports findSymbolReferences formatSymbolReferencesBlock symbol_references repairPatchToolInputInPlace compactToolOutputHeadTail; do
  if grep -rq --include='*.ts' -F "$symbol" src; then
    pass "export present: $symbol"
  else
    fail "export missing: $symbol"
  fi
done

# Gate 7: import-verifier wired into src/index.ts and src/diagnostics/diagnostics-runner.ts.
if grep -Fq "diagnostics/import-verifier.js" src/index.ts; then
  pass "wired into index: diagnostics/import-verifier.js"
else
  fail "unwired module: diagnostics/import-verifier.js"
fi
if grep -Fq "verifyModuleImportsAndExports" src/diagnostics/diagnostics-runner.ts; then
  pass "wired into diagnostics-runner: verifyModuleImportsAndExports"
else
  fail "verifyModuleImportsAndExports not wired into diagnostics-runner"
fi

# Gate 8: all relative imports in src/ use .js extensions.
if grep -rn --include='*.ts' -E 'from "\.\.?/[^"]+"' src | grep -v '\.js"'; then
  fail "extensionless relative import found in src/ (must use .js)"
else
  pass "all relative imports in src/ use .js extensions"
fi

# Gate 9: scope refusal — no WebUI, HTTP server, DAG scheduler,
# worktree manager, or epistemic engine code in src, scripts, or test.
if grep -rni --include='*.ts' -E 'http\.createServer|app\.listen|Server\.listen|multi-agent DAG|epistemic research|worktree manager' src test; then
  fail "scope refusal scan found forbidden constructs"
else
  pass "scope refusal scan (single-session plugin only)"
fi

if [ "$FAIL" -eq 0 ]; then
  printf 'WAVE 6 ACCEPT: ALL GATES GREEN\n'
  exit 0
else
  printf 'WAVE 6 ACCEPT: GATES FAILED\n'
  exit 1
fi
