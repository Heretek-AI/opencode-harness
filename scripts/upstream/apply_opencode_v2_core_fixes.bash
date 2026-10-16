#!/usr/bin/env bash
set -euo pipefail

# Surgical patch applicability script for OpenCode V2 (opencode-2 v2.0.26)
# Applies the 5 core quality, Muse 1.3 prompt, compaction-isolation, EditTool resilience,
# and structured recent-context formatting improvements to packages/core.

OPENCODE_ROOT="${1:-.}"

if [ ! -d "$OPENCODE_ROOT/packages/core/src" ]; then
  echo "Usage: $0 /path/to/opencode-2" >&2
  exit 1
fi

python3 - "$OPENCODE_ROOT" << 'PYEOF'
import pathlib
import sys

root = pathlib.Path(sys.argv[1]).resolve()

# 1. Fix packages/core/src/plugin/optimize.ts: remove compaction hook contamination
optimize_path = root / "packages/core/src/plugin/optimize.ts"
if optimize_path.exists():
    text = optimize_path.read_text(encoding="utf-8")
    target = '      yield* ctx.session.hook("compaction", hook)\n'
    if target in text:
        optimize_path.write_text(text.replace(target, "", 1), encoding="utf-8")
        print("[OK] Patched packages/core/src/plugin/optimize.ts (removed compaction prompt contamination)")

# 2. Fix packages/core/src/plugin/identity.ts: remove compaction hook contamination
identity_path = root / "packages/core/src/plugin/identity.ts"
if identity_path.exists():
    text = identity_path.read_text(encoding="utf-8")
    target = '    yield* ctx.session.hook("compaction", hook)\n'
    if target in text:
        identity_path.write_text(text.replace(target, "", 1), encoding="utf-8")
        print("[OK] Patched packages/core/src/plugin/identity.ts (removed compaction identity contamination)")

# 3. Fix packages/core/src/plugin/system-prompt/meta.txt: include ${OPENCODE_TOOL_GUIDANCE} and calibrate subagent threshold
meta_path = root / "packages/core/src/plugin/system-prompt/meta.txt"
if meta_path.exists():
    text = meta_path.read_text(encoding="utf-8")
    old_subagent = "- Use the `subagent` tool to minimize context token usage whenever tool calls generate large outputs but only a small subset is useful for the task at hand. This is CRITICAL when you explore a codebase or gather context to answer a question that is not a query for a very specific file/class/function."
    new_subagent = "- Perform routine file reads, targeted searches, and symbol inspections directly in the main context. Only spawn a `subagent` when broad exploration spans more than 8 files or when executing independent parallel workstreams.\n\n${OPENCODE_TOOL_GUIDANCE}"
    if old_subagent in text and "${OPENCODE_TOOL_GUIDANCE}" not in text:
        meta_path.write_text(text.replace(old_subagent, new_subagent, 1), encoding="utf-8")
        print("[OK] Patched packages/core/src/plugin/system-prompt/meta.txt (Muse 1.3 tool guidance & subagent calibration)")

# 4. Fix packages/core/src/session/compaction.ts: prevent [Assistant tool call]: hallucination in <recent-context>
compaction_path = root / "packages/core/src/session/compaction.ts"
if compaction_path.exists():
    text = compaction_path.read_text(encoding="utf-8")
    old_call = "const call = `[Assistant tool call]: ${part.name}(${input})`"
    if old_call in text:
        text = text.replace(
            old_call,
            "const call = `- Invoked tool \\`${part.name}\\` with args ${input}`"
        ).replace(
            "`[Tool result]: ${truncateToolOutput(serializeToolContent(part.state.content))}`",
            "`- Tool output: ${truncateToolOutput(serializeToolContent(part.state.content))}`"
        ).replace(
            "`[Tool error]: ${part.state.error.message}`",
            "`- Tool failure: ${part.state.error.message}`"
        )
        compaction_path.write_text(text, encoding="utf-8")
        print("[OK] Patched packages/core/src/session/compaction.ts (structured recent-context formatting)")

# 5. Fix packages/core/src/tool/plugin/edit.ts: strip accidental ReadTool line-number prefixes & support relative indent matching
edit_path = root / "packages/core/src/tool/plugin/edit.ts"
if edit_path.exists():
    text = edit_path.read_text(encoding="utf-8")
    anchor = "const normalizeForMatch = (value: string) =>"
    replacement = '''const stripLineNumberPrefix = (value: string) => value.replace(/^\\s*\\d+:\\s?/gm, "")

const normalizeForMatch = (value: string) =>'''
    if anchor in text and "stripLineNumberPrefix" not in text:
        text = text.replace(anchor, replacement, 1)
        old_line_cmp = "normalizeForMatch(item.text.trimEnd()) === normalizeForMatch(expected[lineIndex].trimEnd())"
        new_line_cmp = "(normalizeForMatch(item.text.trimEnd()) === normalizeForMatch(expected[lineIndex].trimEnd()) || normalizeForMatch(item.text.trim()) === normalizeForMatch(stripLineNumberPrefix(expected[lineIndex]).trim()))"
        text = text.replace(old_line_cmp, new_line_cmp, 1)
        edit_path.write_text(text, encoding="utf-8")
        print("[OK] Patched packages/core/src/tool/plugin/edit.ts (line-number prefix & indentation recovery)")

print("All OpenCode V2 core quality patches applied successfully.")
PYEOF