/**
 * `src/interceptors/tool-interceptors.ts` — Plugin-over-patch built-in tool
 * interceptors for OpenCode V2 (`edit`, `read`, `write`, `patch`, `shell`, `subagent`).
 *
 * Operates 100% through OpenCode V2's plugin hooks (`tool.hook("execute.before" | "execute.after")`
 * and `shell.hook("create.before")`) so upstream `opencode-2` does NOT need to be patched:
 *
 * 1. `repairEditToolInputInPlace`: Fixes `EditTool` failures before they happen by:
 *    - Stripping accidental `ReadTool` (`12: `) or `file_hash_read` (`12#a3f2| `) line prefixes
 *      from `oldString`/`newString` when absent in the target file.
 *    - Resolving uniform leading indentation drift and trailing whitespace differences by
 *      snapping `oldString` to the exact verbatim slice in the file and re-indenting `newString`.
 * 2. `repairPatchToolInputInPlace`: Fixes `PatchTool` failures before they happen by wrapping
 *    bare `*** Update/Add/Delete File:` hunks in `*** Begin Patch` / `*** End Patch` and
 *    stripping accidental `12: ` / `12#a3f2| ` line prefixes inside hunk lines.
 * 3. `buildEditNearMissContext`: When `edit` still fails, locates the closest matching lines
 *    in the target file and returns a 4-hex FNV-1a hash-anchored `<near-miss-anchor>` slice so
 *    Muse 1.3 can immediately apply `file_hash_edit` without an extra `read` turn.
 * 4. `buildPostMutationAnchorReceipt`: After a successful file mutation (and after OpenCode V2's
 *    `Formatter.file` may have reflowed lines on disk), computes the modified line window and
 *    returns fresh 4-hex FNV-1a `<post-edit-anchors>` lines so follow-up edits never drift.
 * 5. `resolveMissingReadPath`: When `read` targets a non-existent directory/path, searches the
 *    workspace file graph for matching basenames/suffixes and either auto-resolves a unique match
 *    in `execute.before` or appends exact repo-relative path suggestions to the error.
 * 6. `hardenShellInvocation`: Injects non-interactive environment variables (`CI=1`,
 *    `GIT_TERMINAL_PROMPT=0`, `PAGER=cat`) in `shell.hook("create.before")` so commands never
 *    hang waiting for TTY input.
 * 7. `didToolExecutionFail` & `extractToolOutputText`: Correctly detects non-zero exit codes in
 *    OpenCode V2's `ShellTool` (`status === "completed"` with `result.output.exit !== 0`).
 * 8. `compactToolOutputHeadTail`: Prevents `ToolOutput.truncate` (`packages/core/src/tool-output.ts`,
 *    which runs AFTER `execute.after` and blindly drops lines past `2,000` / `50 KiB`) from slicing
 *    off the error tail and appended `<diagnostics>` / `<fault-context>` / `<circuit-breaker>` blocks.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, isAbsolute, join, relative, resolve } from "node:path";
import { computeLineHash, hashReadFile } from "../editors/hashline-tools.js";

export interface EditRepairOutcome {
  repaired: boolean;
  strategy?: "line-prefix-stripped" | "indentation-aligned";
  oldString: string;
  newString: string;
}

export interface PatchRepairOutcome {
  repaired: boolean;
  addedEnvelope: boolean;
  strippedLinePrefixes: boolean;
  patchText: string;
  /**
   * Fail-closed explanation when the input cannot become a valid patch: a
   * header-less bare hunk carries no target path, so neither this repair nor
   * upstream `Patch.parse` can accept it.
   */
  error?: string;
}

const READ_TOOL_PREFIX_RE = /^\s*\d+:\s?/gm;
const HASH_READ_PREFIX_RE = /^\s*\d+#[0-9a-f]{4}\|\s?/gm;

function stripKnownLinePrefixes(text: string): {
  stripped: string;
  wasStripped: boolean;
} {
  const lines = text.split("\n");
  const nonEmpty = lines.filter((l) => l.trim().length > 0);
  if (nonEmpty.length === 0) return { stripped: text, wasStripped: false };

  const allHaveHashPrefix = nonEmpty.every((l) =>
    /^\s*\d+#[0-9a-f]{4}\|(?: |$)/.test(l),
  );
  if (allHaveHashPrefix) {
    return {
      stripped: lines
        .map((l) => l.replace(/^\s*\d+#[0-9a-f]{4}\|\s?/, ""))
        .join("\n"),
      wasStripped: true,
    };
  }

  const allHaveColonPrefix = nonEmpty.every((l) => /^\s*\d+:(?: |$)/.test(l));
  if (allHaveColonPrefix) {
    return {
      stripped: lines.map((l) => l.replace(/^\s*\d+:\s?/, "")).join("\n"),
      wasStripped: true,
    };
  }

  return { stripped: text, wasStripped: false };
}

function countOccurrences(haystack: string, needle: string): number {
  if (!needle) return 0;
  let count = 0;
  let pos = 0;
  while (true) {
    const idx = haystack.indexOf(needle, pos);
    if (idx === -1) break;
    count += 1;
    pos = idx + needle.length;
  }
  return count;
}

function leadingWhitespace(line: string): string {
  const m = /^[ \t]*/.exec(line);
  return m ? m[0] : "";
}

/**
 * Repairs `event.input` (`{ path, oldString, newString, replaceAll }`) in-place
 * before OpenCode V2's built-in `EditTool` executes.
 */
export function repairEditToolInputInPlace(
  input: Record<string, unknown> | undefined,
  workspaceRoot: string = process.cwd(),
): EditRepairOutcome | null {
  if (!input || typeof input !== "object") return null;
  const rawPath =
    typeof input.path === "string"
      ? input.path
      : typeof input.filePath === "string"
        ? input.filePath
        : undefined;
  const oldString =
    typeof input.oldString === "string" ? input.oldString : undefined;
  const newString =
    typeof input.newString === "string" ? input.newString : undefined;
  const replaceAll = input.replaceAll === true;

  if (!rawPath || oldString === undefined || newString === undefined) {
    return null;
  }

  const absPath = isAbsolute(rawPath)
    ? rawPath
    : resolve(workspaceRoot, rawPath);
  if (!existsSync(absPath)) return null;

  let content: string;
  try {
    content = readFileSync(absPath, "utf8");
  } catch (err) {
    if (err) return null;
    return null;
  }

  const directMatches = countOccurrences(content, oldString);
  if (directMatches === 1 || (replaceAll && directMatches >= 1)) {
    return { repaired: false, oldString, newString };
  }

  // Pass 1: Strip accidental ReadTool ("12: ") or file_hash_read ("12#a3f2| ") prefixes
  const oldStripped = stripKnownLinePrefixes(oldString);
  if (
    oldStripped.wasStripped &&
    !READ_TOOL_PREFIX_RE.test(content) &&
    !HASH_READ_PREFIX_RE.test(content)
  ) {
    const strippedNew = stripKnownLinePrefixes(newString);
    const candidateOld = oldStripped.stripped;
    const candidateNew = strippedNew.wasStripped
      ? strippedNew.stripped
      : newString;
    const matches = countOccurrences(content, candidateOld);
    if (matches === 1 || (replaceAll && matches >= 1)) {
      input.oldString = candidateOld;
      input.newString = candidateNew;
      return {
        repaired: true,
        strategy: "line-prefix-stripped",
        oldString: candidateOld,
        newString: candidateNew,
      };
    }
  }

  // Pass 2: Relative indentation & trailing-whitespace alignment
  const searchSource = oldStripped.wasStripped
    ? oldStripped.stripped
    : oldString;
  const replacementSource = oldStripped.wasStripped
    ? stripKnownLinePrefixes(newString).stripped
    : newString;

  const normalizedContent = content.replace(/\r\n/g, "\n");
  const fileLines = normalizedContent.split("\n");
  const searchLines = searchSource.replace(/\r\n/g, "\n").split("\n");
  if (searchLines.length > 0 && searchLines[searchLines.length - 1] === "") {
    searchLines.pop();
  }

  if (searchLines.length === 0 || searchLines.length > fileLines.length) {
    return { repaired: false, oldString, newString };
  }

  const candidateStarts: number[] = [];
  for (let i = 0; i <= fileLines.length - searchLines.length; i++) {
    let allMatch = true;
    for (let j = 0; j < searchLines.length; j++) {
      if ((fileLines[i + j] ?? "").trim() !== (searchLines[j] ?? "").trim()) {
        allMatch = false;
        break;
      }
    }
    if (allMatch) {
      candidateStarts.push(i);
    }
  }

  if (
    candidateStarts.length === 1 ||
    (replaceAll && candidateStarts.length >= 1)
  ) {
    const startIdx = candidateStarts[0]!;
    const matchedFileSlice = fileLines
      .slice(startIdx, startIdx + searchLines.length)
      .join("\n");

    let indentDelta = "";
    let stripPrefixLen = 0;
    for (let j = 0; j < searchLines.length; j++) {
      if ((searchLines[j] ?? "").trim().length > 0) {
        const fileIndent = leadingWhitespace(fileLines[startIdx + j] ?? "");
        const searchIndent = leadingWhitespace(searchLines[j] ?? "");
        if (fileIndent.length >= searchIndent.length) {
          indentDelta = fileIndent.slice(searchIndent.length);
        } else {
          stripPrefixLen = searchIndent.length - fileIndent.length;
        }
        break;
      }
    }

    const repLines = replacementSource.replace(/\r\n/g, "\n").split("\n");
    const hadTrailingNewline = searchSource.endsWith("\n");
    if (
      !hadTrailingNewline &&
      repLines.length > 1 &&
      repLines[repLines.length - 1] === ""
    ) {
      repLines.pop();
    }

    const adjustedNew = repLines
      .map((line) => {
        if (line.trim().length === 0) return "";
        if (indentDelta) return `${indentDelta}${line}`;
        if (stripPrefixLen > 0) {
          const lead = leadingWhitespace(line);
          const removeCount = Math.min(lead.length, stripPrefixLen);
          return line.slice(removeCount);
        }
        return line;
      })
      .join("\n");

    const usesCrlf = content.includes("\r\n");
    const finalOld = usesCrlf
      ? matchedFileSlice.replace(/\n/g, "\r\n")
      : matchedFileSlice;
    const finalNew = usesCrlf
      ? adjustedNew.replace(/\n/g, "\r\n")
      : adjustedNew;

    if (finalOld !== finalNew && content.includes(finalOld)) {
      input.oldString = finalOld;
      input.newString = finalNew;
      return {
        repaired: true,
        strategy: "indentation-aligned",
        oldString: finalOld,
        newString: finalNew,
      };
    }
  }

  return { repaired: false, oldString, newString };
}

/**
 * Repairs `event.input.patchText` in-place before OpenCode V2's `PatchTool` runs:
 * 1. Adds missing `*** Begin Patch` / `*** End Patch` wrapper markers when `patchText`
 *    contains `*** (Update|Add|Delete) File:` headers.
 * 2. Strips accidental `12: ` (`ReadTool`) or `12#a3f2| ` (`file_hash_read`) line
 *    prefixes inside hunk body lines (`+`, `-`, ` `).
 */
export function repairPatchToolInputInPlace(
  input: Record<string, unknown> | undefined,
): PatchRepairOutcome | null {
  if (
    !input ||
    typeof input !== "object" ||
    typeof input.patchText !== "string"
  ) {
    return null;
  }

  let text = input.patchText.trim();
  if (!text) return null;

  let addedEnvelope = false;
  let strippedLinePrefixes = false;

  const hasFileHeader =
    /^\*\*\*\s+(?:Update|Add|Delete)\s+File:\s+/m.test(text);
  if (!hasFileHeader) {
    // Header-less bare hunks carry no target path: neither this repair nor
    // upstream `Patch.parse` can accept them. Fail closed with an explicit
    // path-required message instead of a silent no-op passthrough.
    return {
      repaired: false,
      addedEnvelope: false,
      strippedLinePrefixes: false,
      patchText: text,
      error:
        "repairPatchToolInputInPlace: patch text has no `*** Update/Add/Delete File:` header, so the target path is unknown and the hunk cannot be repaired (fail-closed)",
    };
  }
  if (!text.startsWith("*** Begin Patch")) {
    text = `*** Begin Patch\n${text}`;
    addedEnvelope = true;
  }
  if (!text.endsWith("*** End Patch")) {
    text = `${text}\n*** End Patch`;
    addedEnvelope = true;
  }

  const lines = text.split("\n");
  const repairedLines = lines.map((line) => {
    if (
      line.startsWith("*** ") ||
      line.startsWith("@@") ||
      line.length === 0
    ) {
      return line;
    }
    const prefixChar = line[0];
    if (prefixChar === "+" || prefixChar === "-" || prefixChar === " ") {
      const rest = line.slice(1);
      const hashMatch = /^\s*\d+#[0-9a-f]{4}\|\s?(.*)$/.exec(rest);
      if (hashMatch && hashMatch[1] !== undefined) {
        strippedLinePrefixes = true;
        return `${prefixChar}${hashMatch[1]}`;
      }
      const colonMatch = /^\d+:\s(.*)$/.exec(rest);
      if (colonMatch && colonMatch[1] !== undefined) {
        strippedLinePrefixes = true;
        return `${prefixChar}${colonMatch[1]}`;
      }
    }
    return line;
  });

  const finalPatch = repairedLines.join("\n");
  const repaired = addedEnvelope || strippedLinePrefixes;
  if (repaired) {
    input.patchText = finalPatch;
  }

  return {
    repaired,
    addedEnvelope,
    strippedLinePrefixes,
    patchText: finalPatch,
  };
}

/**
 * When `edit` fails with a non-matching `oldString`, finds the closest line in
 * the target file and returns a 4-hex FNV-1a hash-anchored `<near-miss-anchor>`
 * block so the model can immediately issue `file_hash_edit` without calling `read`.
 */
export async function buildEditNearMissContext(
  input: Record<string, unknown> | undefined,
  workspaceRoot: string = process.cwd(),
): Promise<string> {
  if (!input || typeof input !== "object") return "";
  const rawPath =
    typeof input.path === "string"
      ? input.path
      : typeof input.filePath === "string"
        ? input.filePath
        : undefined;
  const oldString =
    typeof input.oldString === "string" ? input.oldString : undefined;
  if (!rawPath || !oldString) return "";

  const absRoot = resolve(workspaceRoot);
  const absPath = isAbsolute(rawPath) ? rawPath : resolve(absRoot, rawPath);
  if (!existsSync(absPath)) return "";

  const relPath = relative(absRoot, absPath).replace(/\\/g, "/");
  if (relPath.startsWith("..")) return "";

  const searchLines = stripKnownLinePrefixes(oldString)
    .stripped.split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length >= 3);
  if (searchLines.length === 0) return "";

  const firstProbe = searchLines[0]!;
  const fileLines = readFileSync(absPath, "utf8").split("\n");
  let bestLine = -1;

  for (let i = 0; i < fileLines.length; i++) {
    const trimmed = (fileLines[i] ?? "").trim();
    if (
      trimmed === firstProbe ||
      (firstProbe.length >= 6 && trimmed.includes(firstProbe))
    ) {
      bestLine = i + 1;
      break;
    }
  }

  if (bestLine === -1) return "";

  try {
    const startLine = Math.max(1, bestLine - 5);
    const slice = await hashReadFile(absRoot, relPath, startLine, 12);
    return [
      `<near-miss-anchor file="${relPath}" nearLine="${bestLine}" hint="Use file_hash_edit with these 4-hex anchors or copy exact lines">`,
      slice.content,
      `</near-miss-anchor>`,
    ].join("\n");
  } catch (err) {
    if (err) return "";
    return "";
  }
}

/**
 * Computes the mutated line window after `edit`, `write`, `patch`, `file_hash_edit`,
 * or `ast_structural_rewrite` (including any silent reflows by OpenCode V2's
 * `Formatter.file`) and returns a `<post-edit-anchors>` block with fresh 4-hex
 * FNV-1a line hashes (`<lineNo>#<hash>| <content>`) so follow-up edits never drift.
 */
export function buildPostMutationAnchorReceipt(params: {
  filePath: string;
  beforeContent?: string;
  afterContent: string;
  workspaceRoot?: string;
  contextRadius?: number;
  maxLines?: number;
}): string {
  const rootDir = resolve(params.workspaceRoot ?? process.cwd());
  const absPath = isAbsolute(params.filePath)
    ? params.filePath
    : resolve(rootDir, params.filePath);
  const relPath = relative(rootDir, absPath).replace(/\\/g, "/");

  const afterLines = params.afterContent.replace(/\r\n/g, "\n").split("\n");
  if (
    afterLines.length > 0 &&
    afterLines[afterLines.length - 1] === "" &&
    params.afterContent.endsWith("\n")
  ) {
    afterLines.pop();
  }
  if (afterLines.length === 0) return "";

  const radius = params.contextRadius ?? 2;
  const maxLines = params.maxLines ?? 20;

  let startDiffIdx = 0;
  let endDiffIdx = Math.min(afterLines.length - 1, maxLines - 1);

  if (params.beforeContent !== undefined) {
    const beforeLines = params.beforeContent.replace(/\r\n/g, "\n").split("\n");
    if (
      beforeLines.length > 0 &&
      beforeLines[beforeLines.length - 1] === "" &&
      params.beforeContent.endsWith("\n")
    ) {
      beforeLines.pop();
    }

    let prefix = 0;
    const minLen = Math.min(beforeLines.length, afterLines.length);
    while (prefix < minLen && beforeLines[prefix] === afterLines[prefix]) {
      prefix += 1;
    }

    let suffix = 0;
    while (
      suffix < minLen - prefix &&
      beforeLines[beforeLines.length - 1 - suffix] ===
        afterLines[afterLines.length - 1 - suffix]
    ) {
      suffix += 1;
    }

    startDiffIdx = Math.max(0, prefix - radius);
    const rawEnd = Math.max(prefix, afterLines.length - 1 - suffix) + radius;
    endDiffIdx = Math.min(
      afterLines.length - 1,
      Math.min(rawEnd, startDiffIdx + maxLines - 1),
    );
  }

  const anchored: string[] = [];
  for (let i = startDiffIdx; i <= endDiffIdx; i++) {
    const lineText = afterLines[i] ?? "";
    anchored.push(`${i + 1}#${computeLineHash(lineText)}| ${lineText}`);
  }

  return [
    `<post-edit-anchors file="${relPath}" lines="${startDiffIdx + 1}-${endDiffIdx + 1}" totalLines="${afterLines.length}">`,
    ...anchored,
    `</post-edit-anchors>`,
  ].join("\n");
}

const IGNORED_SEARCH_DIRS = new Set([
  ".git",
  "node_modules",
  "dist",
  "build",
  "coverage",
  ".next",
  "target",
]);

function findWorkspaceFilesMatching(
  rootDir: string,
  requestedPath: string,
  maxVisited: number = 1200,
): string[] {
  const normReq = requestedPath.replace(/\\/g, "/").replace(/^\.\//, "");
  const targetBase = basename(normReq).toLowerCase();
  if (!targetBase) return [];

  const matches: Array<{ rel: string; score: number }> = [];
  let visited = 0;

  function walk(dir: string): void {
    if (visited >= maxVisited) return;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch (err) {
      if (err) return;
      return;
    }
    for (const entry of entries) {
      if (visited >= maxVisited) break;
      if (entry.isDirectory()) {
        if (IGNORED_SEARCH_DIRS.has(entry.name)) continue;
        walk(join(dir, entry.name));
      } else if (entry.isFile()) {
        visited += 1;
        const abs = join(dir, entry.name);
        const rel = relative(rootDir, abs).replace(/\\/g, "/");
        const lowerBase = entry.name.toLowerCase();
        if (lowerBase === targetBase) {
          const suffixScore = rel.toLowerCase().endsWith(normReq.toLowerCase())
            ? 100
            : 50;
          matches.push({ rel, score: suffixScore });
        } else if (
          lowerBase.includes(targetBase) ||
          targetBase.includes(lowerBase)
        ) {
          matches.push({ rel, score: 10 });
        }
      }
    }
  }

  walk(rootDir);
  matches.sort((a, b) => b.score - a.score || a.rel.localeCompare(b.rel));
  return matches.slice(0, 5).map((m) => m.rel);
}

/**
 * Inspects `read` tool inputs in `execute.before`. If the requested path does not
 * exist, searches the workspace for matching files. When `autoRewriteUnique` is true
 * and there is a single exact-basename match inside the workspace, rewrites `input.path`
 * in-place so `ReadTool` succeeds without throwing a missing-file error.
 */
export function resolveMissingReadPath(
  input: Record<string, unknown> | undefined,
  workspaceRoot: string = process.cwd(),
  autoRewriteUnique: boolean = true,
): {
  existed: boolean;
  rewrittenTo?: string;
  suggestions: string[];
} {
  if (!input || typeof input !== "object" || typeof input.path !== "string") {
    return { existed: true, suggestions: [] };
  }

  const absRoot = resolve(workspaceRoot);
  const rawPath = input.path.trim();
  if (!rawPath) return { existed: true, suggestions: [] };

  const absTarget = isAbsolute(rawPath) ? rawPath : resolve(absRoot, rawPath);
  if (existsSync(absTarget)) {
    return { existed: true, suggestions: [] };
  }

  const suggestions = findWorkspaceFilesMatching(absRoot, rawPath);
  const reqBase = basename(rawPath).toLowerCase();
  const exactBaseMatches = suggestions.filter(
    (s) => basename(s).toLowerCase() === reqBase,
  );

  if (autoRewriteUnique && exactBaseMatches.length === 1) {
    const resolvedRel = exactBaseMatches[0]!;
    input.path = isAbsolute(rawPath)
      ? resolve(absRoot, resolvedRel)
      : resolvedRel;
    return {
      existed: false,
      rewrittenTo: resolvedRel,
      suggestions: exactBaseMatches,
    };
  }

  return {
    existed: false,
    suggestions,
  };
}

/**
 * Hardens `shell.hook("create.before")` invocations with non-interactive environment
 * variables so git/npm/test runners never hang waiting for TTY pagers or prompts.
 */
export function hardenShellInvocation(invocation: {
  command: string;
  cwd?: string;
  timeout?: number;
  shell?: string;
  env?: Record<string, string | undefined>;
}): void {
  if (!invocation || typeof invocation !== "object") return;
  if (!invocation.env || typeof invocation.env !== "object") {
    invocation.env = {};
  }
  if (invocation.env.CI === undefined) invocation.env.CI = "1";
  if (invocation.env.GIT_TERMINAL_PROMPT === undefined) {
    invocation.env.GIT_TERMINAL_PROMPT = "0";
  }
  if (invocation.env.PAGER === undefined) invocation.env.PAGER = "cat";
  if (invocation.env.GIT_PAGER === undefined) invocation.env.GIT_PAGER = "cat";
}

/**
 * Accurately determines whether a tool call failed in real OpenCode V2, including
 * `ShellTool` executions which return `status: "completed"` with `result.output.exit !== 0`.
 */
export function didToolExecutionFail(event: {
  tool?: string;
  status?: "completed" | "error";
  result?: {
    output?: unknown;
    content?: ReadonlyArray<{ type: string; text?: string }>;
    metadata?: Record<string, unknown>;
  };
  error?: unknown;
}): boolean {
  if (event.status === "error") return true;
  const toolName = (event.tool ?? "").toLowerCase();
  if (toolName === "shell" || toolName === "bash") {
    const out = event.result?.output;
    if (out && typeof out === "object" && "exit" in out) {
      const exitCode = (out as { exit?: unknown }).exit;
      if (typeof exitCode === "number" && exitCode !== 0) {
        return true;
      }
    }
    const metaExit = event.result?.metadata?.exit;
    if (typeof metaExit === "number" && metaExit !== 0) {
      return true;
    }
  }
  return false;
}

/**
 * Extracts the textual output from an OpenCode V2 `ToolHooks["execute.after"]` event
 * across both `result.content` (`Array<{ type: "text", text }>`) and `result.output`.
 */
export function extractToolOutputText(event: {
  result?: {
    output?: unknown;
    content?: ReadonlyArray<{ type: string; text?: string }>;
  };
  error?: { message?: string } | string;
}): string {
  const parts: string[] = [];
  if (Array.isArray(event.result?.content)) {
    for (const item of event.result!.content) {
      if (item && item.type === "text" && typeof item.text === "string") {
        parts.push(item.text);
      }
    }
  }
  const out = event.result?.output;
  if (typeof out === "string") {
    parts.push(out);
  } else if (out && typeof out === "object" && "output" in out) {
    const nested = (out as { output?: unknown }).output;
    if (typeof nested === "string") parts.push(nested);
  }
  if (typeof event.error === "string") {
    parts.push(event.error);
  } else if (
    event.error &&
    typeof event.error === "object" &&
    typeof event.error.message === "string"
  ) {
    parts.push(event.error.message);
  }
  return parts.join("\n");
}

/**
 * Compacts oversized tool output using a head+tail window (keeping the first 35%
 * and last 65% of lines/bytes) BEFORE OpenCode V2's `ToolOutput.truncate`
 * (`packages/core/src/tool-output.ts`, 2,000 lines / 50 KiB) runs after `execute.after`.
 */
export function compactToolOutputHeadTail(
  text: string,
  maxLines: number = 1400,
  maxBytes: number = 38_000,
): { text: string; compacted: boolean; omittedLines: number } {
  if (!text) return { text: "", compacted: false, omittedLines: 0 };

  const byteLen = Buffer.byteLength(text, "utf8");
  const lines = text.split("\n");
  if (lines.length <= maxLines && byteLen <= maxBytes) {
    return { text, compacted: false, omittedLines: 0 };
  }

  const headLineCount = Math.max(10, Math.floor(maxLines * 0.35));
  const tailLineCount = Math.max(20, maxLines - headLineCount);

  let headLines = lines.slice(0, headLineCount);
  let tailLines = lines.slice(
    Math.max(headLineCount, lines.length - tailLineCount),
  );
  let omittedLines = Math.max(
    0,
    lines.length - headLines.length - tailLines.length,
  );

  const headBudget = Math.floor(maxBytes * 0.35);
  const tailBudget = maxBytes - headBudget;

  while (
    headLines.length > 5 &&
    Buffer.byteLength(headLines.join("\n"), "utf8") > headBudget
  ) {
    headLines.pop();
    omittedLines += 1;
  }

  while (
    tailLines.length > 5 &&
    Buffer.byteLength(tailLines.join("\n"), "utf8") > tailBudget
  ) {
    tailLines.shift();
    omittedLines += 1;
  }

  const marker = `[... ${omittedLines} middle lines compacted by opencode-harness to preserve error tail and diagnostics ...]`;
  return {
    text: [...headLines, marker, ...tailLines].join("\n"),
    compacted: true,
    omittedLines,
  };
}

/**
 * Appends text blocks to an OpenCode V2 `ToolHooks["execute.after"]` event in-place,
 * applying head+tail compaction to oversized primary output so `ToolOutput.truncate`
 * never slices off appended `<diagnostics>`, `<fault-context>`, or `<circuit-breaker>` tags.
 */
export function appendBlocksToToolAfterEvent(
  event: {
    status: "completed" | "error";
    result?: {
      output?: unknown;
      content?: Array<{ type: string; text?: string }>;
      metadata?: Record<string, unknown>;
    };
    error?: { message?: string } | string;
  },
  blocks: string[],
): void {
  const filtered = blocks.filter((b) => b && b.trim().length > 0);
  const suffix = filtered.join("\n");

  if (event.status === "error") {
    if (!suffix) return;
    if (typeof event.error === "string") {
      event.error = `${event.error}\n\n${suffix}`;
    } else if (event.error && typeof event.error === "object") {
      const prevMsg = event.error.message ?? "Tool error";
      event.error.message = `${prevMsg}\n\n${suffix}`;
    }
    if (event.result && typeof event.result.output === "string") {
      event.result.output = event.result.output
        ? `${event.result.output}\n\n${suffix}`
        : suffix;
    }
    return;
  }

  if (!event.result) return;

  if (Array.isArray(event.result.content)) {
    const compactedContent = event.result.content.map((item) => {
      if (item && item.type === "text" && typeof item.text === "string") {
        const comp = compactToolOutputHeadTail(item.text);
        return comp.compacted ? { ...item, text: comp.text } : item;
      }
      return item;
    });
    event.result.content = suffix
      ? [...compactedContent, { type: "text", text: suffix }]
      : compactedContent;
  }

  if (typeof event.result.output === "string") {
    const comp = compactToolOutputHeadTail(event.result.output);
    const baseOut = comp.text;
    event.result.output = suffix
      ? baseOut
        ? `${baseOut}\n\n${suffix}`
        : suffix
      : baseOut;
  }
}

/**
 * Wraps a raw tool execution result into OpenCode V2's `Tool.Result` contract
 * (`{ content: [{ type: "text", text }], metadata }`) so `packages/core/src/tool/runtime.ts`
 * never calls `Effect.die("Tool result declared output without an output schema")`.
 */
export function normalizePluginToolResult(raw: unknown): {
  content: Array<{ type: "text"; text: string }>;
  metadata?: Record<string, unknown>;
  [k: string]: unknown;
} {
  if (raw === null || raw === undefined) {
    return { content: [{ type: "text", text: "" }] };
  }
  if (typeof raw === "string") {
    return { content: [{ type: "text", text: raw }] };
  }
  if (typeof raw === "object") {
    const rec = raw as Record<string, unknown>;
    if (
      Array.isArray(rec.content) &&
      rec.content.every(
        (item) => item && typeof item === "object" && "type" in item,
      ) &&
      !("output" in rec)
    ) {
      return rec as {
        content: Array<{ type: "text"; text: string }>;
        metadata?: Record<string, unknown>;
      };
    }
    const { output: rawOutput, content: rawContent, ...rest } = rec;
    const textBody =
      typeof rawContent === "string"
        ? rawContent
        : typeof rec.formatted === "string"
          ? rec.formatted
          : typeof rec.formattedBlock === "string"
            ? rec.formattedBlock
            : typeof rec.formattedReport === "string"
              ? rec.formattedReport
              : JSON.stringify(raw, null, 2);
    return {
      ...rest,
      ...(rawOutput !== undefined ? { rawOutput } : {}),
      content: [{ type: "text", text: textBody }],
    };
  }
  return { content: [{ type: "text", text: String(raw) }] };
}

export { computeLineHash };
