#!/usr/bin/env bash
# `bun run accept` entrypoint (SPEC §2.1 / MASTER_BUILD_PROMPT §2.1): runs the
# wave acceptance scripts in numeric order, mirroring `make accept`.
# Wave 8 (`wave-8.sh`, the audit-remediation gate) runs separately via
# `bash scripts/accept/wave-8.sh` so this entrypoint never recurses into
# itself: wave-8.sh invokes `bun run accept` as one of its checks.
# Exits 0 only when every wave script passes; exits 1 on the first failure.
set -euo pipefail

ACCEPT_DIR="$(cd "$(dirname "$0")" && pwd)"

passed=0
for n in 1 2 3 4 5 6 7; do
  script="$ACCEPT_DIR/wave-$n.sh"
  if [[ ! -f "$script" ]]; then
    echo "accept: missing $script (fail-closed)" >&2
    exit 1
  fi
  echo "--- accept: wave-$n.sh ---"
  bash "$script"
  passed=$((passed + 1))
done

echo "accept: $passed wave script(s) passed"
