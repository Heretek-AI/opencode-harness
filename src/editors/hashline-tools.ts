/**
 * `src/editors/hashline-tools.ts` — Deterministic hash-anchored file reader/editor.
 *
 * Wave 1 module per `docs/prompts/SPEC.md` Section 2.3 A. Integrates the
 * `pi-hashline-readmap` concept (line-hash-anchored reads/edits) with a local,
 * zero-network TypeScript implementation so `bun test` and `bun run check`
 * pass deterministically:
 *
 * - `computeLineHash` — deterministic 4-hex-char FNV-1a hash of the trimmed
 *   line content (16-bit `0000`–`ffff` range).
 * - `hashReadFile` — formats each line as `<lineNo>#<4-hex-hash>| <content>`.
 * - `hashEditFile` — validates `startHash`/`endHash` anchors before mutating,
 *   resolves shifted anchors across +/-25 lines, and fails closed (no disk
 *   write) on any anchor mismatch.
 */

import { join, normalize, sep } from "node:path";

export const HASH_SHIFT_WINDOW = 25;

export const HASH_HEX_PATTERN = /^[0-9a-f]{4}$/;

export interface HashEditHunk {
  startLine: number;
  startHash: string;
  endLine: number;
  endHash: string;
  replacement: string;
}

export interface HashReadResult {
  path: string;
  totalLines: number;
  content: string;
}

export interface HashEditResult {
  applied: boolean;
  shiftedLines: number;
  path: string;
  error?: string;
}

/**
 * Deterministic 4-hex-char FNV-1a hash of the trimmed line content.
 *
 * Uses the standard 32-bit FNV-1a accumulator (offset basis `0x811c9dc5`,
 * prime `0x01000193` over UTF-16 code units) narrowed to 16 bits, rendered
 * as zero-padded lowercase hex (`0000`–`ffff`). Trimming both sides matches
 * the hashline readmap convention so trailing-whitespace-only edits do not
 * move anchors.
 */
export function computeLineHash(line: string): string {
  const text = line.trim();
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  const narrowed = (hash >>> 0) & 0xffff;
  return narrowed.toString(16).padStart(4, "0");
}

/**
 * Resolve `relPath` under `rootDir`, failing closed on absolute paths,
 * `..` traversal, or NUL bytes. Returns the absolute target path.
 */
export function resolveSafePath(rootDir: string, relPath: string): string {
  if (typeof relPath !== "string" || relPath.length === 0) {
    throw new Error(
      "hashline-tools: refusing to operate on an empty relative path (fail-closed)",
    );
  }
  if (relPath.includes("\0")) {
    throw new Error(
      `hashline-tools: refusing path with NUL byte: ${JSON.stringify(relPath)} (fail-closed)`,
    );
  }
  const normalized = normalize(relPath);
  if (
    normalized === ".." ||
    normalized.startsWith(`..${sep}`) ||
    normalized.startsWith("..\\") ||
    normalized.startsWith("/") ||
    normalized.startsWith("\\") ||
    /^[A-Za-z]:[\\/]/.test(normalized)
  ) {
    throw new Error(
      `hashline-tools: refusing path outside rootDir: ${JSON.stringify(relPath)} (fail-closed)`,
    );
  }
  return join(rootDir, normalized);
}

/** Split raw file text into lines, dropping the phantom trailing element. */
export function splitLines(raw: string): string[] {
  if (raw === "") {
    return [];
  }
  const normalized = raw.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const parts = normalized.split("\n");
  if (parts.length > 0 && parts[parts.length - 1] === "" && normalized.endsWith("\n")) {
    parts.pop();
  }
  return parts;
}

/**
 * Read a file and render each line as `<lineNo>#<4-hex-hash>| <lineContent>`.
 *
 * `offset` is 1-based (defaults to 1); `limit` caps the rendered lines.
 * `totalLines` always reflects the full file. Throws (fail-closed) on
 * unreadable files or paths escaping `rootDir`.
 */
export async function hashReadFile(
  rootDir: string,
  relPath: string,
  offset?: number,
  limit?: number,
): Promise<HashReadResult> {
  const fullPath = resolveSafePath(rootDir, relPath);
  if (offset !== undefined && (!Number.isInteger(offset) || offset < 1)) {
    throw new Error(
      `hashReadFile: offset must be a 1-based integer >= 1, got ${String(offset)} (fail-closed)`,
    );
  }
  if (limit !== undefined && (!Number.isInteger(limit) || limit < 1)) {
    throw new Error(
      `hashReadFile: limit must be an integer >= 1, got ${String(limit)} (fail-closed)`,
    );
  }
  let raw: string;
  try {
    raw = await Bun.file(fullPath).text();
  } catch (readError) {
    throw new Error(
      `hashReadFile: cannot read ${JSON.stringify(relPath)}: ${(readError as Error).message} (fail-closed)`,
    );
  }
  const lines = splitLines(raw);
  const start = (offset ?? 1) - 1;
  const end = limit === undefined ? lines.length : Math.min(lines.length, start + limit);
  const rendered: string[] = [];
  for (let i = start; i < end; i++) {
    rendered.push(`${i + 1}#${computeLineHash(lines[i])}| ${lines[i]}`);
  }
  return {
    path: relPath,
    totalLines: lines.length,
    content: rendered.join("\n"),
  };
}

function failResult(path: string, error: string): HashEditResult {
  return { applied: false, shiftedLines: 0, path, error };
}

/**
 * Apply hash-anchored hunks to a file.
 *
 * Each hunk's `startHash`/`endHash` must match the 4-hex FNV-1a hashes of the
 * resolved anchor lines. Because earlier hunks insert/delete lines, the anchor
 * search starts at `startLine + netShift` and probes outward
 * (`0, +1, -1, +2, -2, ...`) up to +/-25 lines. Any hunk that cannot be
 * resolved — bad line numbers, malformed hashes, or anchor mismatch — aborts
 * the whole edit WITHOUT writing to disk (fail-closed).
 *
 * `shiftedLines` reports the net line-count delta after a successful edit.
 */
export async function hashEditFile(
  rootDir: string,
  relPath: string,
  hunks: Array<HashEditHunk>,
): Promise<HashEditResult> {
  const fullPath = resolveSafePath(rootDir, relPath);
  if (!Array.isArray(hunks) || hunks.length === 0) {
    return failResult(relPath, "hashEditFile: hunks must be a non-empty array (fail-closed)");
  }
  let raw: string;
  try {
    raw = await Bun.file(fullPath).text();
  } catch (readError) {
    return failResult(
      relPath,
      `hashEditFile: cannot read ${JSON.stringify(relPath)}: ${(readError as Error).message} (fail-closed)`,
    );
  }
  const hadTrailingNewline = raw.endsWith("\n") || raw.endsWith("\r");
  const original = splitLines(raw);
  const lines = [...original];
  let netShift = 0;

  for (let hunkIndex = 0; hunkIndex < hunks.length; hunkIndex++) {
    const hunk = hunks[hunkIndex];
    if (
      !hunk ||
      !Number.isInteger(hunk.startLine) ||
      !Number.isInteger(hunk.endLine) ||
      hunk.startLine < 1 ||
      hunk.endLine < hunk.startLine ||
      typeof hunk.startHash !== "string" ||
      typeof hunk.endHash !== "string" ||
      typeof hunk.replacement !== "string"
    ) {
      return failResult(
        relPath,
        `hashEditFile: hunk ${hunkIndex} has invalid line numbers or fields (fail-closed)`,
      );
    }
    if (!HASH_HEX_PATTERN.test(hunk.startHash) || !HASH_HEX_PATTERN.test(hunk.endHash)) {
      return failResult(
        relPath,
        `hashEditFile: hunk ${hunkIndex} has malformed anchor hashes (expected 4 lowercase hex chars) (fail-closed)`,
      );
    }
    const span = hunk.endLine - hunk.startLine + 1;
    const base = hunk.startLine + netShift;
    let found = -1;
    for (let distance = 0; distance <= HASH_SHIFT_WINDOW && found === -1; distance++) {
      const candidates = distance === 0 ? [base] : [base + distance, base - distance];
      for (const candidate of candidates) {
        const index = candidate - 1;
        if (index < 0 || index + span > lines.length) {
          continue;
        }
        const startMatches = computeLineHash(lines[index]) === hunk.startHash;
        const endMatches = computeLineHash(lines[index + span - 1]) === hunk.endHash;
        if (startMatches && endMatches) {
          found = index;
          break;
        }
      }
    }
    if (found === -1) {
      return failResult(
        relPath,
        `hashEditFile: hunk ${hunkIndex} anchor mismatch near line ${hunk.startLine} (searched +/-${HASH_SHIFT_WINDOW} lines, no write performed) (fail-closed)`,
      );
    }
    const normalizedReplacement = hunk.replacement.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
    const newLines = normalizedReplacement === "" ? [] : normalizedReplacement.split("\n");
    lines.splice(found, span, ...newLines);
    netShift += newLines.length - span;
  }

  let output = lines.join("\n");
  if (lines.length > 0 && hadTrailingNewline) {
    output += "\n";
  }
  await Bun.write(fullPath, output);
  return { applied: true, shiftedLines: lines.length - original.length, path: relPath };
}
