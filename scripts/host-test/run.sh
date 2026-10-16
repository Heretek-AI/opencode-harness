#!/usr/bin/env bash
# Load the harness into a real OpenCode V2 host (anomalyco/opencode) and run
# scripts/host-test/harness-host.upstream.ts against the upstream plugin fixture.
#
#   bash scripts/host-test/run.sh            # uses the pinned upstream commit
#   OPENCODE_REF=<sha> bash scripts/host-test/run.sh
#   OPENCODE_DIR=/path/to/checkout bash scripts/host-test/run.sh   # reuse a checkout
set -euo pipefail

HARNESS_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
# Pinned upstream dev commit the host contract was verified against.
OPENCODE_REF="${OPENCODE_REF:-ed772f5009755b5262805a7ba07e66e1417f140a}"
OPENCODE_REPO="${OPENCODE_REPO:-https://github.com/anomalyco/opencode.git}"

cleanup_dir=""
if [[ -z "${OPENCODE_DIR:-}" ]]; then
  OPENCODE_DIR="$(mktemp -d)"
  cleanup_dir="$OPENCODE_DIR"
fi
trap '[[ -n "$cleanup_dir" ]] && rm -rf "$cleanup_dir"' EXIT

if [[ ! -d "$OPENCODE_DIR/.git" ]]; then
  git -C "$OPENCODE_DIR" init -q
  git -C "$OPENCODE_DIR" remote add origin "$OPENCODE_REPO"
fi
git -C "$OPENCODE_DIR" fetch -q --depth 1 origin "$OPENCODE_REF"
git -C "$OPENCODE_DIR" checkout -q --force FETCH_HEAD

# Unrelated workspace packages pull optional git/pkg.pr.new tarballs that some
# networks block; packages/core does not need them. A genuinely missing core
# dependency still fails the host test below.
if ! (cd "$OPENCODE_DIR" && bun install --ignore-scripts >/dev/null); then
  echo "warning: bun install in the OpenCode checkout reported failures; continuing" >&2
fi
(cd "$HARNESS_ROOT" && bun install --ignore-scripts >/dev/null)

target="$OPENCODE_DIR/packages/core/test/plugin/zz-opencode-harness-host.test.ts"
cp "$HARNESS_ROOT/scripts/host-test/harness-host.upstream.ts" "$target"
cd "$OPENCODE_DIR/packages/core"
HARNESS_ROOT="$HARNESS_ROOT" bun test "test/plugin/zz-opencode-harness-host.test.ts"
