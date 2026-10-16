import { createHash } from "node:crypto"
import { existsSync, readFileSync } from "node:fs"
import { isAbsolute, relative, resolve } from "node:path"

export const MUSE_MODEL_IDENTIFIER = "opencode-go/muse-spark-1.3-contributor"

/**
 * Returns the static, deterministic Muse 1.3 system prompt overlay designed to fix
 * three failure modes in OpenCode V2's default `packages/core/src/system-prompt/meta.txt`:
 * 1. `meta.txt` omits `${OPENCODE_TOOL_GUIDANCE}` and encourages subagent spawning for routine reads.
 * 2. Muse 1.3 benefits from 4-hex FNV-1a hash-anchored edits (`file_hash_read` / `file_hash_edit`)
 *    and AST rewrites (`ast_structural_rewrite`) over fragile whitespace-sensitive string replacement.
 * 3. Pre-edit blast-radius awareness (`blast_radius`) and post-mutation `<diagnostics>` verification.
 *
 * NOTE: This string is 100% static (zero timestamps or per-turn state) so it can be
 * registered once at prompt setup time without invalidating provider KV-cache prefixes.
 */
export function buildMuseSystemOverlay(): string {
  return [
    "<muse-1.3-harness-calibration>",
    "- Direct Tool Preference: Perform routine file reads, symbol outlines (`file_outline`), repo mapping (`repo_map`), and searches directly in-session. Only spawn a subagent when isolating high-volume exploratory output across >8 files or running independent workstreams.",
    "- Anchored & Structural Mutations: Prefer `file_hash_read` + `file_hash_edit` (4-hex FNV-1a anchors) or `ast_structural_rewrite` when modifying complex indentation or repetitive blocks.",
    "- Pre-Edit Impact & Post-Edit Diagnostics: Check `blast_radius` before changing exported signatures. Every file mutation automatically appends `<diagnostics>` and protects target files with all-or-nothing atomic rollback; fix reported syntax/type errors immediately before running full test suites.",
    "</muse-1.3-harness-calibration>",
  ].join("\n")
}

export function isCompactionAgent(agentName?: string): boolean {
  if (!agentName) return false
  const norm = agentName.trim().toLowerCase()
  return norm === "compaction" || norm === "summary" || norm === "title"
}

/**
 * Sanitizes stringified `<recent-context>` pseudo-transcript blocks produced by
 * OpenCode V2's `compaction.ts` (`[Assistant tool call]: ...`) so that Muse 1.3
 * does not mimic plain-text `[Assistant tool call]:` strings instead of emitting
 * native structured tool calls after compaction.
 */
export function sanitizeCompactionPseudoTranscript(text: string): string {
  if (!text.includes("<recent-context>")) return text
  return text.replace(
    /<recent-context>([\s\S]*?)<\/recent-context>/g,
    (_full, inner: string) => {
      const cleaned = inner
        .replace(/^\[Assistant tool call\]:\s*([A-Za-z0-9_:-]+)\((.*)\)$/gm, "  - Invoked tool `$1` with args `$2`")
        .replace(/^\[Tool result\]:\s*/gm, "  - Tool output: ")
        .replace(/^\[Tool error\]:\s*/gm, "  - Tool failure: ")
      return `<recent-context note="historical-summary-only-use-native-tool-calls">${cleaned}</recent-context>`
    },
  )
}

export interface FileMutationDigest {
  relPath: string
  existedBefore: boolean
  existsAfter: boolean
  beforeSha256: string | null
  afterSha256: string | null
  changed: boolean
}

export interface MutationReceipt {
  sessionId: string
  verifiedAt: string
  totalChanged: number
  files: FileMutationDigest[]
  formattedBlock: string
}

function sha256File(absPath: string): string | null {
  if (!existsSync(absPath)) return null
  try {
    const buf = readFileSync(absPath)
    return createHash("sha256").update(buf).digest("hex").slice(0, 16)
  } catch (err) {
    if (err) return null
    return null
  }
}

export function captureWorkspaceDigests(
  filePaths: string[],
  rootDir: string = process.cwd(),
): Map<string, string | null> {
  const absRoot = resolve(rootDir)
  const map = new Map<string, string | null>()
  for (const p of filePaths) {
    const abs = isAbsolute(p) ? p : resolve(absRoot, p)
    const rel = relative(absRoot, abs).replace(/\\/g, "/")
    map.set(rel, sha256File(abs))
  }
  return map
}

export function createMutationReceipt(
  sessionId: string,
  beforeDigests: Map<string, string | null>,
  rootDir: string = process.cwd(),
): MutationReceipt {
  const absRoot = resolve(rootDir)
  const files: FileMutationDigest[] = []

  for (const [rel, beforeSha] of beforeDigests.entries()) {
    const abs = resolve(absRoot, rel)
    const afterSha = sha256File(abs)
    const changed = beforeSha !== afterSha
    files.push({
      relPath: rel,
      existedBefore: beforeSha !== null,
      existsAfter: afterSha !== null,
      beforeSha256: beforeSha,
      afterSha256: afterSha,
      changed,
    })
  }

  files.sort((a, b) => a.relPath.localeCompare(b.relPath))
  const changedFiles = files.filter((f) => f.changed)
  const lines = changedFiles.map(
    (f) =>
      `  <file path="${f.relPath}" before="${f.beforeSha256 ?? "none"}" after="${f.afterSha256 ?? "deleted"}" />`,
  )
  const formattedBlock = [
    `<mutation-receipt session="${sessionId}" changedFiles="${changedFiles.length}">`,
    ...lines,
    `</mutation-receipt>`,
  ].join("\n")

  return {
    sessionId,
    verifiedAt: "deterministic",
    totalChanged: changedFiles.length,
    files,
    formattedBlock,
  }
}
