import { createHash } from "node:crypto"
import { existsSync, readdirSync, readFileSync } from "node:fs"
import { isAbsolute, join, relative, resolve } from "node:path"

export const MUSE_MODEL_IDENTIFIER = "opencode-go/muse-spark-1.3-contributor"

/**
 * Returns the static, deterministic Muse 1.3 system prompt overlay designed to fix
 * three failure modes in OpenCode V2's default `packages/core/src/plugin/system-prompt/meta.txt`:
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
  const OPEN_TAG = "<recent-context>"
  const CLOSE_TAG = "</recent-context>"
  const MAX_INNER_CHARS = 20000
  let out = ""
  let cursor = 0
  while (true) {
    const openIdx = text.indexOf(OPEN_TAG, cursor)
    if (openIdx === -1) {
      out += text.slice(cursor)
      break
    }
    const closeIdx = text.indexOf(CLOSE_TAG, openIdx + OPEN_TAG.length)
    if (closeIdx === -1) {
      out += text.slice(cursor)
      break
    }
    const innerStart = openIdx + OPEN_TAG.length
    const innerEnd = Math.min(closeIdx, innerStart + MAX_INNER_CHARS)
    const inner = text.slice(innerStart, innerEnd)
    const cleaned = inner
      .replace(/^\[Assistant tool call\]:\s*([A-Za-z0-9_:-]+)\((.*)\)$/gm, "  - Invoked tool `$1` with args `$2`")
      .replace(/^\[Tool result\]:\s*/gm, "  - Tool output: ")
      .replace(/^\[Tool error\]:\s*/gm, "  - Tool failure: ")
    out += text.slice(cursor, openIdx)
    out += `<recent-context note="historical-summary-only-use-native-tool-calls">${cleaned}`
    if (closeIdx > innerEnd) {
      out += text.slice(innerEnd, closeIdx)
    }
    out += CLOSE_TAG
    cursor = closeIdx + CLOSE_TAG.length
  }
  return out
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

const RECEIPT_SCAN_IGNORED_DIRS = new Set([
  ".git",
  "node_modules",
  "dist",
  "build",
  "coverage",
  ".next",
  "target",
])

/**
 * Repo-relative file paths under `rootDir` (symlinks skipped, heavy
 * directories ignored), sorted, capped at `maxFiles`.
 */
export function listWorkspaceRelPaths(
  rootDir: string = process.cwd(),
  maxFiles: number = 5000,
): string[] {
  const absRoot = resolve(rootDir)
  const rels: string[] = []
  const queue: string[] = [absRoot]
  let visited = 0
  while (queue.length > 0 && rels.length < maxFiles && visited < 10000) {
    const dir = queue.shift()!
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch (err) {
      if (err) continue
      continue
    }
    for (const entry of entries) {
      visited += 1
      if (visited >= 10000 || rels.length >= maxFiles) break
      if (entry.isSymbolicLink()) continue
      const abs = join(dir, entry.name)
      if (entry.isDirectory()) {
        if (!RECEIPT_SCAN_IGNORED_DIRS.has(entry.name)) queue.push(abs)
      } else if (entry.isFile()) {
        rels.push(relative(absRoot, abs).replace(/\\/g, "/"))
      }
    }
  }
  rels.sort()
  return rels
}

/**
 * Files absent from the pre-execution path set (created files are invisible
 * to a before-only receipt). Pass the COMPLETE set — `beforeDigests.keys()`
 * post-fix; a ranked-only subset would misreport every other pre-existing
 * file. Returns at most `maxNewFiles` sorted repo-relative paths.
 */
export function diffNewWorkspaceFiles(
  knownRelPaths: ReadonlySet<string> | ReadonlyMap<string, unknown>,
  rootDir: string = process.cwd(),
  maxNewFiles: number = 200,
): string[] {
  const known = knownRelPaths instanceof Set ? knownRelPaths : new Set(knownRelPaths.keys())
  return listWorkspaceRelPaths(rootDir)
    .filter((rel) => !known.has(rel))
    .slice(0, maxNewFiles)
}

/**
 * Fail-closed receipt for scan errors / missing snapshots: marks the gap
 * (`status="degraded"`) instead of a silently-empty receipt (OH-4.8).
 */
export function createDegradedMutationReceipt(sessionId: string, reason: string): MutationReceipt {
  const safeReason = (reason || "workspace-scan-failed").replace(/[<>&"']+/g, "").replace(/-{2,}/g, "-").slice(0, 120) || "workspace-scan-failed"
  const formattedBlock = [
    `<mutation-receipt session="${sessionId}" changedFiles="0" status="degraded">`,
    `  <!-- receipt incomplete: ${safeReason} -->`,
    `</mutation-receipt>`,
  ].join("\n")
  return { sessionId, verifiedAt: "deterministic", totalChanged: 0, files: [], formattedBlock }
}

export function createMutationReceipt(
  sessionId: string,
  beforeDigests: Map<string, string | null>,
  rootDir: string = process.cwd(),
  additionalRelPaths: string[] = [],
): MutationReceipt {
  const absRoot = resolve(rootDir)
  const merged = new Map<string, string | null>(beforeDigests)
  for (const rel of additionalRelPaths) {
    if (typeof rel === "string" && rel !== "" && !merged.has(rel)) {
      merged.set(rel, null)
    }
  }
  const files: FileMutationDigest[] = []

  for (const [rel, beforeSha] of merged.entries()) {
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
