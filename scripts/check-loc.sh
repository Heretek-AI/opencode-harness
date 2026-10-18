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
# - Audit-remediation-C revision (2026-10-18): raw <= 12,100,
#   stripped <= 10,100. Rationale: audit-mandated security remediation
#   (OH-6.5-env-var-target-escape P1 containment, OH-6.5-command-display
#   doc-drift P3, OH-6.6-taint-fork-gap P2 plumbing + residual-gap docs)
#   cannot stay net-zero against a 99.9%-full cap, and functionality must
#   never be deleted to hit a line count — so the cap moves, with the
#   over-cap hard gate still failing the build over the new budget.
#
# OH-scope-loc-budget: by default this script is a tracking signal (exit 0).
# Pass `--fail-over=<n>` (and/or `--fail-over-stripped=<n>`) to turn the
# corresponding budget into a hard gate that exits non-zero over cap — CI
# wires the gate form so unchecked growth fails the build.
set -euo pipefail

FAIL_OVER_RAW=""
FAIL_OVER_STRIPPED=""
for arg in "$@"; do
  case "$arg" in
    --fail-over=*)
      FAIL_OVER_RAW="${arg#--fail-over=}"
      ;;
    --fail-over-stripped=*)
      FAIL_OVER_STRIPPED="${arg#--fail-over-stripped=}"
      ;;
    --fail-over)
      echo "loc-budget: --fail-over requires =<n> (fail-closed)" >&2
      exit 2
      ;;
    *)
      echo "loc-budget: unknown argument ${arg} (fail-closed)" >&2
      exit 2
      ;;
  esac
done

HARNESS_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$HARNESS_ROOT"

RAW_BUDGET=12100
STRIPPED_BUDGET=10100

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

# Hard-cap gate form (OH-scope-loc-budget): exits non-zero over cap.
if [[ -n "$FAIL_OVER_RAW" ]]; then
  if ! [[ "$FAIL_OVER_RAW" =~ ^[0-9]+$ ]]; then
    echo "loc-budget: --fail-over cap must be a non-negative integer, got ${FAIL_OVER_RAW} (fail-closed)" >&2
    exit 2
  fi
  if [[ "$raw" -gt "$FAIL_OVER_RAW" ]]; then
    echo "loc-budget FAIL: raw LOC $raw exceeds hard cap $FAIL_OVER_RAW" >&2
    status=1
  else
    echo "loc-budget: raw LOC $raw within hard cap $FAIL_OVER_RAW"
  fi
fi
if [[ -n "$FAIL_OVER_STRIPPED" ]]; then
  if ! [[ "$FAIL_OVER_STRIPPED" =~ ^[0-9]+$ ]]; then
    echo "loc-budget: --fail-over-stripped cap must be a non-negative integer, got ${FAIL_OVER_STRIPPED} (fail-closed)" >&2
    exit 2
  fi
  if [[ "$stripped" -gt "$FAIL_OVER_STRIPPED" ]]; then
    echo "loc-budget FAIL: stripped LOC $stripped exceeds hard cap $FAIL_OVER_STRIPPED" >&2
    status=1
  else
    echo "loc-budget: stripped LOC $stripped within hard cap $FAIL_OVER_STRIPPED"
  fi
fi

echo "loc-budget: tracked (exit $status)"
exit "$status"
