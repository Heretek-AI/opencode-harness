import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import type { EpisodicLesson } from "./context-budget.js";

export interface EpisodicLessonProposal {
  id: string;
  sessionId: string;
  failedCategory: "edit" | "shell";
  failedTargets: string[];
  recoveryAction: string;
  proposedSummary: string;
  scopePrefix?: string;
  createdAt: number;
}

export interface StoredEpisodicLesson extends EpisodicLesson {
  scopePrefix?: string;
  tags?: string[];
  createdAt?: number;
}

const PENDING_PROPOSALS = new Map<string, EpisodicLessonProposal[]>();
const ACTIVE_TRIPPED_STATE = new Map<
  string,
  { failedCategory: "edit" | "shell"; failedTargets: string[] }
>();

let proposalSeq = 0;

/**
 * Selects up to `maxLessons` relevant lessons based on the session's `touchedFiles`
 * while strictly returning lessons sorted by `id.localeCompare` so `packBlocks()`
 * preserves byte-identical KV-cache ordering across turns.
 */
export function selectRelevantLessons(
  allLessons: StoredEpisodicLesson[],
  touchedFiles: string[] = [],
  maxLessons: number = 5,
  workspaceRoot: string = process.cwd(),
): EpisodicLesson[] {
  if (allLessons.length <= maxLessons) {
    return [...allLessons]
      .sort((a, b) => a.id.localeCompare(b.id))
      .map(({ id, summary }) => ({ id, summary }));
  }

  const normalizedTouched = touchedFiles.map((f) =>
    (isAbsolute(f) ? relative(workspaceRoot, f) : f).replace(/\\/g, "/"),
  );

  const scored = allLessons.map((lesson) => {
    let score = 0;
    if (lesson.scopePrefix) {
      const prefix = lesson.scopePrefix.replace(/\\/g, "/");
      for (const touched of normalizedTouched) {
        if (touched.startsWith(prefix) || prefix.startsWith(dirname(touched))) {
          score += 10;
        }
      }
    }
    if (Array.isArray(lesson.tags)) {
      for (const tag of lesson.tags) {
        for (const touched of normalizedTouched) {
          if (touched.toLowerCase().includes(tag.toLowerCase())) {
            score += 4;
          }
        }
      }
    }
    return { lesson, score };
  });

  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return a.lesson.id.localeCompare(b.lesson.id);
  });

  return scored
    .slice(0, maxLessons)
    .map((s) => ({ id: s.lesson.id, summary: s.lesson.summary }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

/**
 * Drafts a candidate episodic lesson when a session recovers from a circuit-breaker trip.
 */
export function proposeEpisodicLesson(params: {
  sessionId: string;
  failedCategory: "edit" | "shell";
  failedTargets: string[];
  recoveryTool: string;
  recoverySummary: string;
  workspaceRoot?: string;
}): EpisodicLessonProposal {
  proposalSeq += 1;
  const id = `lesson-${Date.now()}-${proposalSeq}`;
  const root = params.workspaceRoot ?? process.cwd();
  const firstTarget = params.failedTargets[0];
  const scopePrefix = firstTarget
    ? dirname(
        (isAbsolute(firstTarget)
          ? relative(root, firstTarget)
          : firstTarget
        ).replace(/\\/g, "/"),
      )
    : undefined;

  const proposedSummary =
    params.failedCategory === "edit"
      ? `When editing ${scopePrefix && scopePrefix !== "." ? `${scopePrefix}/*` : "files"}, avoid repeated line-matching failures by reading current 4-hex line anchors via file_hash_read or using ast_structural_rewrite (${params.recoverySummary}).`
      : `When running verification commands in ${scopePrefix && scopePrefix !== "." ? scopePrefix : "workspace"}, inspect localized fault frames before retrying (${params.recoverySummary}).`;

  const proposal: EpisodicLessonProposal = {
    id,
    sessionId: params.sessionId,
    failedCategory: params.failedCategory,
    failedTargets: params.failedTargets,
    recoveryAction: `${params.recoveryTool}: ${params.recoverySummary}`,
    proposedSummary,
    scopePrefix: scopePrefix === "." ? undefined : scopePrefix,
    createdAt: Date.now(),
  };

  const list = PENDING_PROPOSALS.get(params.sessionId) ?? [];
  list.push(proposal);
  PENDING_PROPOSALS.set(params.sessionId, list);
  return proposal;
}

/**
 * Tracks when a session enters a circuit-breaker trip state and automatically
 * drafts an `EpisodicLessonProposal` on the first subsequent recovery execution.
 */
export function trackCircuitBreakerAndAutoProposeLesson(params: {
  sessionId: string;
  toolName: string;
  ok: boolean;
  tripped: boolean;
  targetPathOrCommand?: string;
  workspaceRoot?: string;
}): EpisodicLessonProposal | null {
  const { sessionId, toolName, ok, tripped, targetPathOrCommand, workspaceRoot } =
    params;

  if (tripped && !ok) {
    const isShell = toolName === "shell" || toolName === "bash";
    const prev = ACTIVE_TRIPPED_STATE.get(sessionId);
    const targets = prev ? [...prev.failedTargets] : [];
    if (targetPathOrCommand && !targets.includes(targetPathOrCommand)) {
      targets.push(targetPathOrCommand);
    }
    ACTIVE_TRIPPED_STATE.set(sessionId, {
      failedCategory: isShell ? "shell" : "edit",
      failedTargets: targets,
    });
    return null;
  }

  if (ok && ACTIVE_TRIPPED_STATE.has(sessionId)) {
    const tripState = ACTIVE_TRIPPED_STATE.get(sessionId)!;
    ACTIVE_TRIPPED_STATE.delete(sessionId);
    return proposeEpisodicLesson({
      sessionId,
      failedCategory: tripState.failedCategory,
      failedTargets: tripState.failedTargets,
      recoveryTool: toolName,
      recoverySummary: `Recovered via ${toolName}${targetPathOrCommand ? ` on ${targetPathOrCommand}` : ""}`,
      workspaceRoot,
    });
  }

  return null;
}

export function getPendingLessonProposals(
  sessionId: string,
): EpisodicLessonProposal[] {
  return [...(PENDING_PROPOSALS.get(sessionId) ?? [])];
}

export function clearPendingLessonProposals(sessionId?: string): void {
  if (sessionId) {
    PENDING_PROPOSALS.delete(sessionId);
    ACTIVE_TRIPPED_STATE.delete(sessionId);
  } else {
    PENDING_PROPOSALS.clear();
    ACTIVE_TRIPPED_STATE.clear();
  }
}

export function loadStoredLessons(storePath: string): StoredEpisodicLesson[] {
  if (!existsSync(storePath)) return [];
  try {
    const raw = JSON.parse(readFileSync(storePath, "utf8")) as unknown;
    if (!Array.isArray(raw)) return [];
    return raw.filter(
      (item): item is StoredEpisodicLesson =>
        Boolean(
          item &&
            typeof item === "object" &&
            typeof (item as StoredEpisodicLesson).id === "string" &&
            typeof (item as StoredEpisodicLesson).summary === "string",
        ),
    );
  } catch (err) {
    if (err) return [];
    return [];
  }
}

export function commitEpisodicLesson(
  storePath: string,
  lesson: StoredEpisodicLesson,
  maxStored: number = 50,
): StoredEpisodicLesson[] {
  const existing = loadStoredLessons(storePath).filter(
    (l) => l.id !== lesson.id,
  );
  existing.push({
    ...lesson,
    createdAt: lesson.createdAt ?? Date.now(),
  });
  existing.sort((a, b) => a.id.localeCompare(b.id));
  const bounded = existing.slice(0, maxStored);
  mkdirSync(dirname(storePath), { recursive: true });
  writeFileSync(storePath, JSON.stringify(bounded, null, 2), "utf8");
  return bounded;
}
