import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { dirname, isAbsolute, resolve } from "node:path"
import { isPathWithinRoot } from "../editors/hashline-tools.js"

export interface FileSnapshot {
  absPath: string
  existed: boolean
  content: Buffer | null
  mtimeMs: number | null
}

export interface EditTransaction {
  id: string
  sessionId: string
  toolName: string
  startedAt: number
  snapshots: Map<string, FileSnapshot>
}

export interface TransactionRollbackReport {
  transactionId: string
  rolledBackFiles: string[]
  removedCreatedFiles: string[]
  formattedTag: string
}

export interface CheckpointEntry {
  id: string
  label: string
  createdAt: number
  snapshots: FileSnapshot[]
}

const ACTIVE_TRANSACTIONS = new Map<string, EditTransaction>()
const SESSION_CHECKPOINTS = new Map<string, CheckpointEntry[]>()
const SESSION_READ_TIMESTAMPS = new Map<string, Map<string, number>>()

let txCounter = 0

function captureSnapshot(absPath: string): FileSnapshot {
  try {
    const st = statSync(absPath)
    const content = readFileSync(absPath)
    return {
      absPath,
      existed: true,
      content,
      mtimeMs: st.mtimeMs,
    }
  } catch (err) {
    const code = (err as NodeJS.ErrnoException | null)?.code
    if (code !== undefined && code !== "ENOENT") {
      throw err
    }
    return {
      absPath,
      existed: false,
      content: null,
      mtimeMs: null,
    }
  }
}

function restoreSnapshot(snap: FileSnapshot): "restored" | "removed" | "noop" {
  if (snap.existed && snap.content !== null) {
    mkdirSync(dirname(snap.absPath), { recursive: true })
    writeFileSync(snap.absPath, snap.content)
    return "restored"
  }
  if (!snap.existed) {
    try {
      rmSync(snap.absPath, { force: true })
    } catch (err) {
      const code = (err as NodeJS.ErrnoException | null)?.code
      if (code !== undefined && code !== "ENOENT") {
        throw err
      }
      return "noop"
    }
    return "removed"
  }
  return "noop"
}

export function extractTargetPathsFromToolInput(
  input: Record<string, unknown> | undefined,
  workspaceRoot: string = process.cwd(),
): string[] {
  if (!input || typeof input !== "object") return []
  const rawCandidates: string[] = []

  const directKeys = ["filePath", "path", "file", "targetFile"]
  for (const key of directKeys) {
    const val = input[key]
    if (typeof val === "string" && val.trim().length > 0) {
      rawCandidates.push(val.trim())
    }
  }

  if (Array.isArray(input.files)) {
    for (const item of input.files) {
      if (typeof item === "string" && item.trim().length > 0) {
        rawCandidates.push(item.trim())
      } else if (item && typeof item === "object") {
        const fileObj = item as Record<string, unknown>
        const p = fileObj.filePath ?? fileObj.path
        if (typeof p === "string" && p.trim().length > 0) {
          rawCandidates.push(p.trim())
        }
      }
    }
  }

  if (typeof input.patchText === "string") {
    const patchRegex = /\*\*\*\s+(?:Update|Add|Delete)\s+File:\s+([^\r\n]+)/g
    let m: RegExpExecArray | null
    while ((m = patchRegex.exec(input.patchText)) !== null) {
      if (m[1]) rawCandidates.push(m[1].trim())
    }
  }

  const resolved = new Set<string>()
  for (const raw of rawCandidates) {
    resolved.add(isAbsolute(raw) ? raw : resolve(workspaceRoot, raw))
  }
  return [...resolved]
}

export function beginEditTransaction(
  sessionId: string,
  toolName: string,
  targetPaths: string[],
  workspaceRoot: string = process.cwd(),
): EditTransaction {
  txCounter += 1
  const id = `tx_${Date.now()}_${txCounter}`
  const absRoot = resolve(workspaceRoot)
  const snapshots = new Map<string, FileSnapshot>()
  for (const p of targetPaths) {
    const absPath = isAbsolute(p) ? p : resolve(workspaceRoot, p)
    if (!isPathWithinRoot(absPath, absRoot)) {
      throw new Error(
        `beginEditTransaction: refusing snapshot outside the workspace root (fail-closed): ${JSON.stringify(p)}`,
      )
    }
    if (!snapshots.has(absPath)) {
      snapshots.set(absPath, captureSnapshot(absPath))
    }
  }
  const tx: EditTransaction = {
    id,
    sessionId,
    toolName,
    startedAt: Date.now(),
    snapshots,
  }
  ACTIVE_TRANSACTIONS.set(sessionId, tx)
  return tx
}

export function finalizeEditTransaction(
  sessionId: string,
  succeeded: boolean,
): TransactionRollbackReport | null {
  const tx = ACTIVE_TRANSACTIONS.get(sessionId)
  if (!tx) return null
  ACTIVE_TRANSACTIONS.delete(sessionId)

  if (succeeded) {
    for (const absPath of tx.snapshots.keys()) {
      recordFileReadTimestamp(sessionId, absPath)
    }
    return null
  }

  const rolledBackFiles: string[] = []
  const removedCreatedFiles: string[] = []

  for (const snap of tx.snapshots.values()) {
    const action = restoreSnapshot(snap)
    if (action === "restored") {
      rolledBackFiles.push(snap.absPath)
    } else if (action === "removed") {
      removedCreatedFiles.push(snap.absPath)
    }
  }

  const allReverted = [...rolledBackFiles, ...removedCreatedFiles]
  const formattedTag =
    allReverted.length > 0
      ? `<harness-transaction id="${tx.id}" status="rolled-back" files="${allReverted.length}">Reverted partial mutations on ${allReverted.join(", ")}</harness-transaction>`
      : ""

  return {
    transactionId: tx.id,
    rolledBackFiles,
    removedCreatedFiles,
    formattedTag,
  }
}

export function createCheckpoint(
  sessionId: string,
  label: string,
  filePaths: string[],
  workspaceRoot: string = process.cwd(),
): CheckpointEntry {
  txCounter += 1
  const id = `chk_${txCounter}`
  const absRoot = resolve(workspaceRoot)
  const snapshots = filePaths.map((p) => {
    const absPath = isAbsolute(p) ? p : resolve(workspaceRoot, p)
    if (!isPathWithinRoot(absPath, absRoot)) {
      throw new Error(
        `createCheckpoint: refusing snapshot outside the workspace root (fail-closed): ${JSON.stringify(p)}`,
      )
    }
    return captureSnapshot(absPath)
  })
  const entry: CheckpointEntry = {
    id,
    label,
    createdAt: Date.now(),
    snapshots,
  }
  const list = SESSION_CHECKPOINTS.get(sessionId) ?? []
  list.push(entry)
  SESSION_CHECKPOINTS.set(sessionId, list)
  return entry
}

export function rollbackCheckpoint(
  sessionId: string,
  checkpointId?: string,
): { restored: string[]; removed: string[]; checkpointId: string } | null {
  const list = SESSION_CHECKPOINTS.get(sessionId)
  if (!list || list.length === 0) return null

  const idx = checkpointId
    ? list.findIndex((c) => c.id === checkpointId)
    : list.length - 1
  if (idx < 0) return null

  const target = list[idx]
  const restored: string[] = []
  const removed: string[] = []

  for (const snap of target.snapshots) {
    const outcome = restoreSnapshot(snap)
    if (outcome === "restored") restored.push(snap.absPath)
    if (outcome === "removed") removed.push(snap.absPath)
    recordFileReadTimestamp(sessionId, snap.absPath)
  }

  list.splice(idx, 1)
  return {
    checkpointId: target.id,
    restored,
    removed,
  }
}

export function listCheckpoints(sessionId: string): Array<{ id: string; label: string; createdAt: number; fileCount: number }> {
  const list = SESSION_CHECKPOINTS.get(sessionId) ?? []
  return list.map((c) => ({
    id: c.id,
    label: c.label,
    createdAt: c.createdAt,
    fileCount: c.snapshots.length,
  }))
}

export function recordFileReadTimestamp(
  sessionId: string,
  filePath: string,
  workspaceRoot: string = process.cwd(),
): void {
  const absPath = isAbsolute(filePath) ? filePath : resolve(workspaceRoot, filePath)
  try {
    const st = statSync(absPath)
    let map = SESSION_READ_TIMESTAMPS.get(sessionId)
    if (!map) {
      map = new Map<string, number>()
      SESSION_READ_TIMESTAMPS.set(sessionId, map)
    }
    map.set(absPath, st.mtimeMs)
  } catch (err) {
    if (err) return
  }
}

export interface StaleReadCheckResult {
  stale: boolean
  unread: boolean
  filePath: string
  reason?: string
}

export function checkStaleFileRead(
  sessionId: string,
  filePath: string,
  workspaceRoot: string = process.cwd(),
  requirePriorRead: boolean = false,
): StaleReadCheckResult {
  const absPath = isAbsolute(filePath) ? filePath : resolve(workspaceRoot, filePath)
  let diskMtimeMs: number | null = null
  try {
    diskMtimeMs = statSync(absPath).mtimeMs
  } catch (err) {
    const code = (err as NodeJS.ErrnoException | null)?.code
    if (code === "ENOENT" || code === undefined) {
      return { stale: false, unread: false, filePath: absPath }
    }
    throw err
  }

  const map = SESSION_READ_TIMESTAMPS.get(sessionId)
  const lastReadMtime = map?.get(absPath)

  if (lastReadMtime === undefined) {
    if (requirePriorRead) {
      return {
        stale: true,
        unread: true,
        filePath: absPath,
        reason: `File "${absPath}" has not been read in this session prior to mutation. Read it first with file_hash_read or read.`,
      }
    }
    return { stale: false, unread: true, filePath: absPath }
  }

  // Allow 2ms tolerance for filesystem timestamp quantization
  if (diskMtimeMs > lastReadMtime + 2) {
    return {
      stale: true,
      unread: false,
      filePath: absPath,
      reason: `File "${absPath}" was modified on disk since your last read (lastRead=${Math.round(lastReadMtime)}, current=${Math.round(diskMtimeMs)}). Re-read the file before editing to prevent clobbering concurrent changes.`,
    }
  }

  return { stale: false, unread: false, filePath: absPath }
}

export function clearStaleReadRegistry(sessionId?: string): void {
  if (sessionId) {
    SESSION_READ_TIMESTAMPS.delete(sessionId)
    ACTIVE_TRANSACTIONS.delete(sessionId)
    SESSION_CHECKPOINTS.delete(sessionId)
  } else {
    SESSION_READ_TIMESTAMPS.clear()
    ACTIVE_TRANSACTIONS.clear()
    SESSION_CHECKPOINTS.clear()
  }
}
