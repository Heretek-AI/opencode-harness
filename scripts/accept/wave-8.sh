#!/usr/bin/env bash
# Wave 8 audit-remediation acceptance gate (`AUDIT_REPORT_FINDINGS.md`).
# Covers every P0 verification plus the P1/P2/P3 executable checks.
# Exits 0 on pass, 1 on fail. Safe to run repeatedly; creates nothing outside
# OS temp dirs (all PoC workspaces live under `mkdtemp` and are removed by
# the test harness).
set -euo pipefail

HARNESS_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$HARNESS_ROOT"

step() {
  echo "--- wave-8: $1 ---"
}

fail() {
  echo "wave-8 FAIL: $1" >&2
  exit 1
}

step "typecheck (bun run check)"
bun run check || fail "bun run check"

step "P0 OH-6.5-destructive-shell-evasions corpus"
bun test test/wave8-audit.test.ts -t "OH-6.5-destructive-shell-evasions" || fail "destructive-shell-evasions corpus"

step "P0 OH-6.5-mutating-shells-readonly corpus"
bun test test/wave8-audit.test.ts -t "OH-6.5-mutating-shells-readonly" || fail "mutating-shells corpus"

step "P1 OH-6.1 sudo/tilde sabotage-gap corpus"
bun test test/wave8-audit.test.ts -t "sabotage-gap" || fail "sudo/tilde corpus"

step "P0+P1 OH-6.1 role normalization + OH-6.2 harness-tools-bypass-guard"
bun test test/wave8-audit.test.ts -t "OH-6.1-role-normalization-default-allow" || fail "role normalization"
bun test test/wave8-audit.test.ts -t "OH-6.2-harness-tools-bypass-guard" || fail "harness-tools-bypass-guard"
bun test test/wave8-audit.test.ts -t "taskOwnedPaths" || fail "taskOwnedPaths execute guard"

step "P0 OH-6.6-taint-dead-for-mcp (ids, pipe-deny, fork inheritance, denylist)"
bun test test/wave8-audit.test.ts -t "OH-6.6-taint-dead-for-mcp" || fail "taint guard"

step "P0 OH-6.3-symlink-escape PoC (outside file must stay unchanged)"
bun test test/wave8-audit.test.ts -t "OH-6.3-symlink-escape" || fail "symlink escape"

step "P1 OH-7.4 SSRF loopback refusal"
bun test test/wave8-audit.test.ts -t "OH-7.4-ssrf-loopback-fetch" || fail "ssrf loopback"

step "P1 OH-3.4 rename rollback byte-identical restore"
bun test test/wave8-audit.test.ts -t "OH-3.4-rename-rollback-untested" || fail "rename rollback"

step "P1 OH-4.6 pure invalid_api_key never retries"
bun test test/wave8-audit.test.ts -t "OH-4.6-invalid-apikey-retry-untested" || fail "invalid_api_key retry"

step "P2 OH-4.8 receipt created-files (before=none) + OH-7.3 traversal + P3 OH-4.3 bare hunk"
bun test test/wave8-audit.test.ts -t "OH-4.8-mutation-receipt-misses-created" || fail "mutation receipt"
bun test test/wave8-audit.test.ts -t "OH-7.3-scopedtests-traversal" || fail "scoped-test traversal"
bun test test/wave8-audit.test.ts -t "OH-4.3-bare-hunk-no-header" || fail "bare hunk error"

step "P1 OH-2.1 archived bridge fully removed"
if grep -rn "zod-to-json-schema" package.json src/ test/ scripts/ --exclude=wave-8.sh 2>/dev/null; then
  fail "zod-to-json-schema still referenced"
fi
echo "zod-to-json-schema: zero references"

step "P2 OH-1.4 bun run accept entrypoint"
test -x scripts/accept/run.sh || fail "scripts/accept/run.sh missing or not executable"
bun run accept || fail "bun run accept"

step "audit-remediation regression suite (AUDIT_REPORT_FINDINGS.md OH-1.3..OH-4.2)"
bun test test/audit-20261018-remediation.test.ts || fail "audit-20261018-remediation suite"

step "full unit suite"
bun test || fail "bun test"

step "zero-stub scan (src + test)"
if grep -rn "TODO" src/ test/ 2>/dev/null; then
  fail "TODO markers present"
fi
if grep -rn "test\.skip\|describe\.skip\|it\.skip" test/ 2>/dev/null; then
  fail "skipped tests present"
fi
if grep -rn "|| true" src/ scripts/ --exclude=wave-8.sh 2>/dev/null; then
  fail "|| true present"
fi
if grep -rn 'cmd: "true"\|echo "passed"' src/ test/ scripts/ --exclude=wave-8.sh 2>/dev/null; then
  fail "dummy passes present"
fi
echo "stub scan: zero hits"

echo "wave-8: all audit-remediation gates passed"
