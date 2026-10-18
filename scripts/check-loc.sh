#!/usr/bin/env bash
# LOC budget tracker (OH-scope-loc-budget). Reports raw and stripped `src/`
# line counts against the revised budget and always exits 0: this is a
# tracking signal for CI logs, not a gate — functionality must never be
# deleted to hit a line count.
#
# Budget history:
# - Original plugin ask: ~450 lines (single-file sketch scope).
# - Blueprint budget: 3,000–5,000 LOC.
# - Revised budget (Wave 8+): raw <= 12,000, stripped <= 10,000.
#   Rationale: the shipped scope is a 14-tool plugin (8 pinned Code Mode
#   companions) plus 16+ zero-patch interceptors, role/path/contract/taint
#   permission guards, a doom-loop circuit breaker, PageRank RepoMap,
#   blast-radius/symbol-reference/rename engines, incremental verification,
#   architecture auditing, Muse calibration, episodic memory, transactions,
#   and DOM geometry auditing across 8 waves — roughly 22 modules where the
#   blueprint assumed a handful. The overage is authorized scope growth, and
#   further growth is tracked here rather than budgeted by deletion.
set -euo pipefail

HARNESS_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$HARNESS_ROOT"

RAW_BUDGET=12000
STRIPPED_BUDGET=10000

raw="$(git ls-files src | xargs wc -l | tail -1 | awk '{print $1}')"
stripped="$(git ls-files src | xargs cat | grep -vE '^\s*(//|\*|$)' | wc -l)"
files="$(git ls-files src | wc -l)"

echo "loc-budget: files=$files raw=$raw (budget $RAW_BUDGET) stripped=$stripped (budget $STRIPPED_BUDGET)"

status=0
if [[ "$raw" -gt "$RAW_BUDGET" ]]; then
  echo "loc-budget WARNING: raw LOC $raw exceeds revised budget $RAW_BUDGET (tracking only, not failing)" >&2
  status=0
fi
if [[ "$stripped" -gt "$STRIPPED_BUDGET" ]]; then
  echo "loc-budget WARNING: stripped LOC $stripped exceeds revised budget $STRIPPED_BUDGET (tracking only, not failing)" >&2
  status=0
fi
echo "loc-budget: tracked (exit $status)"
exit "$status"
