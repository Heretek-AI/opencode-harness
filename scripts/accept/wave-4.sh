#!/usr/bin/env bash
# Wave 4 acceptance: Argon-upgrade ported harness modules.
# Exits 0 when every gate passes, 1 otherwise.
#
# Runs Waves 1–3 as regressions plus Wave-4-specific checks:
# 8 new modules wired into src/index.ts, the ported harness suite,
# extended tool table, hardened shell classifier, and stub/scope scans.
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

# Gate 2: full unit suite (161 prior + 12 ported = 173).
if bun test; then
  pass "bun test (full suite incl. ported-harness)"
else
  fail "bun test (full suite incl. ported-harness)"
fi

# Gate 3: ported harness suite in isolation.
if bun test test/ported-harness.test.ts; then
  pass "bun test test/ported-harness.test.ts (12 ported tests)"
else
  fail "bun test test/ported-harness.test.ts"
fi

# Gate 4: Waves 1–3 regressions intact.
for wave in 1 2 3; do
  if bash scripts/accept/wave-"$wave".sh > /tmp/wave4-wave"$wave".log 2>&1; then
    pass "wave-$wave regression"
  else
    fail "wave-$wave regression (see /tmp/wave4-wave$wave.log)"
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

# Gate 6: all 8 new Wave 4 modules export their SPEC symbols.
for symbol in selectRelevantLessons proposeEpisodicLesson evaluateTaintGuard recordUntrustedContentTaint isUntrustedIngestionTool collectFileDiagnostics localizeFaultContext formatDiagnosticsTag beginEditTransaction finalizeEditTransaction createCheckpoint rollbackCheckpoint checkStaleFileRead buildRepoMap analyzeBlastRadius moveModuleAndRewriteImports extractOutline runIncrementalVerification auditDiffCoverageAndTautology assertTaskInvariants buildMuseSystemOverlay sanitizeCompactionPseudoTranscript captureWorkspaceDigests createMutationReceipt wireOpenCodeV2PromiseContext inspectHostContract buildExtendedHarnessTools parseCommandSegments splitShellPipeline tokenizeSegment OpenCodeV2Plugin; do
  if grep -rq --include='*.ts' -F "$symbol" src; then
    pass "export present: $symbol"
  else
    fail "export missing: $symbol"
  fi
done

# Gate 7: every new module is wired into src/index.ts (no unwired modules).
for mod in context/episodic-memory guards/taint-guard diagnostics/diagnostics-runner transactions/edit-transaction repomap/repomap verify/verifier muse/muse-calibration host/contract-adapter; do
  if grep -Fq "$mod" src/index.ts; then
    pass "wired into index: $mod"
  else
    fail "unwired module (not referenced from src/index.ts): $mod"
  fi
done

# Gate 8: core Wave 3 surface preserved exactly (5 tools, 3 hooks, MCP config).
for symbol in HARNESS_TOOL_NAMES file_hash_read file_hash_edit ast_structural_search ast_structural_rewrite ui_geometry_audit "permission.hook" "tool.execute.after" "session.hook" getRecommendedMcpConfig; do
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

# Gate 9: hardening markers — subshell unwrapping + extended tool table.
for symbol in EXTENDED_HARNESS_TOOL_NAMES repo_map blast_radius file_outline verify_scoped checkpoint_create checkpoint_rollback; do
  if grep -rq --include='*.ts' -F "$symbol" src/index.ts; then
    pass "extended surface present: $symbol"
  else
    fail "extended surface missing: $symbol"
  fi
done

# Gate 10: scope refusal — no WebUI, HTTP server, DAG scheduler,
# worktree manager, or epistemic engine code in src, scripts, or test.
if grep -rni --include='*.ts' -E 'http\.createServer|app\.listen|Server\.listen|multi-agent DAG|epistemic research|worktree manager' src test; then
  fail "scope refusal scan found forbidden constructs"
else
  pass "scope refusal scan (single-session plugin only)"
fi
if grep -v '^[[:space:]]*#' scripts/accept/wave-4.sh | grep -v 'grep ' | grep -ni -E 'http\.createServer|app\.listen|Server\.listen|multi-agent DAG|epistemic research|worktree manager'; then
  fail "scope refusal scan found forbidden constructs in wave-4.sh"
else
  pass "scope refusal scan (wave-4.sh clean)"
fi

if [ "$FAIL" -eq 0 ]; then
  printf 'WAVE 4 ACCEPT: ALL GATES GREEN\n'
  exit 0
else
  printf 'WAVE 4 ACCEPT: GATES FAILED\n'
  exit 1
fi
