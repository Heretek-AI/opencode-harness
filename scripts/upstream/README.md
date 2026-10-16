# Upstream reference scripts (NOT applied to this repo)

This directory vendors reference-only patch scripts that target the
**upstream `opencode-2` repository** (`packages/core`, v2.0.26). They are
**never executed against this harness repo** and **never applied here**.

## `apply_opencode_v2_core_fixes.bash`

- **Scope: upstream-only.** Applies 5 surgical core-quality patches to a
  checkout of `opencode-2` v2.0.26 under `packages/core`:
  1. `src/plugin/optimize.ts` — remove compaction hook contamination.
  2. `src/plugin/identity.ts` — remove compaction hook contamination.
  3. `src/plugin/system-prompt/meta.txt` — include
     `${OPENCODE_TOOL_GUIDANCE}` and calibrate the subagent threshold.
  4. `src/session/compaction.ts` — structured `<recent-context>` formatting
     (no `[Assistant tool call]:` hallucination).
  5. `src/tool/plugin/edit.ts` — strip accidental ReadTool line-number
     prefixes and support relative indent matching.
- **NOT applied to this repo.** `src/` in `opencode-harness` is untouched by
  this script. Do not run it without an explicit upstream target path.
- **Reference:** carried over from the Gemini Argon review.
- **Byte-identical vendored copy** of the reviewed source artifact
  (shebang + `set -euo pipefail` + `PYEOF` heredoc preserved).

### Usage

```bash
bash scripts/upstream/apply_opencode_v2_core_fixes.bash /path/to/opencode-2
```

The script exits non-zero unless `/path/to/opencode-2/packages/core/src`
exists, so running it bare inside this repo fails closed without changing
anything.
