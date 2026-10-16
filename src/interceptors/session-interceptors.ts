/**
 * `src/interceptors/session-interceptors.ts` — Plugin-over-patch session, prompt,
 * compaction, retry, and root-affinity interceptors for OpenCode V2 (`opencode-2`).
 *
 * Eliminates the need to patch `packages/core/src/plugin/optimize.ts`,
 * `packages/core/src/plugin/identity.ts`, `packages/core/src/tool/plugin/opencode.ts`,
 * `packages/core/src/plugin/system-prompt/meta.txt`,
 * `packages/core/src/session/compaction.ts`, `packages/core/src/session/affinity.ts`,
 * or `packages/core/src/session/runner/retry.ts` by running directly inside OpenCode V2's
 * plugin hooks after built-in plugins:
 *
 * 1. `calibrateSystemPromptInPlace`: Runs in `session.hook("context" | "generate")` after
 *    `OptimizePlugin.MetaPlugin`. Repairs the `meta.txt` subagent over-trigger in-place
 *    and appends static Muse 1.3 tool guidance to `event.system[0]` without disturbing
 *    KV-cache determinism.
 * 2. `decontaminateCompactionEventInPlace`: Runs in `session.hook("compaction")` after
 *    `OptimizePlugin`, `IdentityPlugin`, and `OpenCodeTools.Plugin` to strip coding-agent
 *    system prompt blocks, `# Your Model` identity blocks, and worktree instructions
 *    that were erroneously injected into the compaction request, and clears `event.tools`.
 * 3. `SessionLineageTracker`: Tracks `childSessionID -> parentSessionID` links across
 *    unlimited subagent/fork hops and rewrites `x-session-affinity` / `X-Session-Id`
 *    headers in `session.hook("model.request")` so nested subagents reuse the root
 *    session's `promptCacheKey`.
 * 4. `handleSessionRetryInPlace`: Runs in `session.hook("retry")` to recover from transient
 *    Muse 1.3 stream truncations (`incomplete-stream`), gateway 502/503/529 blips, and
 *    overloaded errors while immediately halting retries on non-recoverable auth/permission
 *    failures.
 */

import { buildMuseSystemOverlay } from "../muse/muse-calibration.js";

const META_SUBAGENT_OVERTRIGGER =
  "- Use the `subagent` tool to minimize context token usage whenever tool calls generate large outputs but only a small subset is useful for the task at hand. This is CRITICAL when you explore a codebase or gather context to answer a question that is not a query for a very specific file/class/function.";

/**
 * Fallback matcher for the same `meta.txt` bullet if upstream rewords it: any
 * single bullet line telling the model to use `subagent` to save context
 * tokens. Deliberately one line (`[^\n]*`) so nothing else is touched.
 */
/**
 * Fallback for a reworded upstream sentence: the bullet line that mentions both
 * the `subagent` tool and context token usage. A plain line scan (no regex) keeps
 * this linear on arbitrary prompt text.
 */
function replaceSubagentOvertriggerLine(text: string): string | undefined {
  const lines = text.split("\n");
  const index = lines.findIndex((line) => {
    if (!line.startsWith("- ")) return false;
    const toolAt = line.indexOf("`subagent` tool");
    return toolAt >= 0 && line.includes("context token usage", toolAt);
  });
  if (index === -1) return undefined;
  lines[index] = CALIBRATED_SUBAGENT_RULE;
  return lines.join("\n");
}

const CALIBRATED_SUBAGENT_RULE =
  "- Perform routine file reads (`read`, `file_hash_read`, `file_outline`), targeted searches (`grep`, `glob`, `ast_structural_search`, `symbol_references`), and dependency checks (`repo_map`, `blast_radius`) directly in the main context. Only spawn a `subagent` when broad exploration spans more than 8 files or when executing independent parallel workstreams.";

/**
 * Repairs `event.system[0]` in-place during `session.hook("context")` and
 * `session.hook("generate")` after `OptimizePlugin.MetaPlugin` has run.
 *
 * Strictly deterministic: produces the exact same string on every turn so
 * provider prompt-cache prefixes never invalidate.
 */
export function calibrateSystemPromptInPlace(
  systemParts: Array<{ text: string; [k: string]: unknown }> | undefined,
): boolean {
  if (!Array.isArray(systemParts) || systemParts.length === 0) {
    return false;
  }

  let modified = false;
  const first = systemParts[0];
  if (first && typeof first.text === "string") {
    let text = first.text;
    if (text.includes(META_SUBAGENT_OVERTRIGGER)) {
      text = text.replace(META_SUBAGENT_OVERTRIGGER, CALIBRATED_SUBAGENT_RULE);
      modified = true;
    } else {
      // Upstream reworded the sentence: still replace the whole bullet line so
      // the calibration does not silently become a no-op.
      const replaced = replaceSubagentOvertriggerLine(text);
      if (replaced !== undefined) {
        text = replaced;
        modified = true;
      }
    }
    const overlay = buildMuseSystemOverlay();
    if (!text.includes("<muse-1.3-harness-calibration>")) {
      text = `${text}\n\n${overlay}`;
      modified = true;
    }
    if (modified) {
      first.text = text;
    }
  }

  return modified;
}

/**
 * Strips coding-agent prompt contamination, `# Your Model` identity blocks, and
 * `OpenCodeTools.Plugin` worktree instructions that built-in plugins inject into
 * `session.hook("compaction")`, and clears `event.tools` so compaction summarization
 * requests remain pure and lightweight without patching upstream `opencode-2`.
 */
export function decontaminateCompactionEventInPlace(event: {
  system?: Array<{ text: string; [k: string]: unknown }>;
  tools?: Record<string, unknown>;
}): { strippedSystemParts: number; clearedTools: number } {
  let strippedSystemParts = 0;
  let clearedTools = 0;

  if (Array.isArray(event.system) && event.system.length > 0) {
    const beforeLen = event.system.length;
    const filtered = event.system.filter((part) => {
      const t = typeof part?.text === "string" ? part.text : "";
      const isCodingPrompt =
        t.includes("You are OpenCode, a coding agent") ||
        t.includes("You are OpenCode, an interactive CLI") ||
        t.includes("<muse-1.3-harness-calibration>") ||
        t.includes(
          "When you create a worktree outside the current working directory",
        ) ||
        t.startsWith("# Your Model\n");
      return !isCodingPrompt;
    });
    strippedSystemParts = beforeLen - filtered.length;
    event.system.splice(0, event.system.length, ...filtered);
  }

  if (event.tools && typeof event.tools === "object") {
    const keys = Object.keys(event.tools);
    clearedTools = keys.length;
    for (const k of keys) {
      delete event.tools[k];
    }
  }

  return { strippedSystemParts, clearedTools };
}

const SESSION_PARENT_MAP = new Map<string, string>();

export function recordSessionParentLink(
  childSessionID: string,
  parentSessionID: string,
): void {
  if (
    !childSessionID ||
    !parentSessionID ||
    childSessionID === parentSessionID
  ) {
    return;
  }
  SESSION_PARENT_MAP.set(childSessionID, parentSessionID);
}

export function resolveRootSessionAffinity(sessionID: string): string {
  let current = sessionID;
  const visited = new Set<string>();
  while (SESSION_PARENT_MAP.has(current) && !visited.has(current)) {
    visited.add(current);
    const parent = SESSION_PARENT_MAP.get(current);
    if (!parent) break;
    current = parent;
  }
  return current;
}

export function clearSessionLineage(): void {
  SESSION_PARENT_MAP.clear();
}

/**
 * Rewrites `x-session-affinity`, `X-Session-Id`, and `x-opencode-session` headers
 * in `session.hook("model.request")` so depth >= 2 subagents and forked child
 * sessions inherit the true root session ID without patching `affinity.ts`.
 */
export function applyRootAffinityHeadersInPlace(event: {
  sessionID?: string;
  headers?: Record<string, string>;
}): string | undefined {
  if (!event || typeof event.sessionID !== "string" || !event.sessionID) {
    return undefined;
  }
  if (!event.headers || typeof event.headers !== "object") {
    return undefined;
  }

  const headerParent =
    event.headers["x-opencode-parent-session-id"] ??
    event.headers["x-parent-session-id"];
  if (headerParent) {
    recordSessionParentLink(event.sessionID, headerParent);
  }

  const rootAffinity = resolveRootSessionAffinity(event.sessionID);
  event.headers["x-session-affinity"] = rootAffinity;
  event.headers["X-Session-Id"] = rootAffinity;
  event.headers["x-opencode-session"] = rootAffinity;
  return rootAffinity;
}

export interface SessionRetryEvent {
  sessionID?: string;
  agent?: string;
  model?: { providerID?: string; id?: string };
  error?: { type?: string; message?: string; code?: string };
  attempt: number;
  decision: { retry: false } | { retry: true; delay: number };
}

/**
 * Refines `event.decision` in `session.hook("retry")` (`packages/core/src/session/runner/retry.ts`):
 * - Halts retries immediately (`{ retry: false }`) on deterministic non-recoverable errors
 *   (`auth`, `invalid_api_key`, `permission`, `model.not-found`, `aborted`) or when `attempt > 6`.
 * - Enables bounded exponential recovery (`retry: true`, `1000ms * attempt` capped at `5000ms`)
 *   for transient Muse 1.3 stream drops (`incomplete-stream`), `overloaded`, `rate_limit`,
 *   `502`/`503`/`504`/`529`, or `ECONNRESET`/`ETIMEDOUT` on `attempt <= 3`.
 */
export function handleSessionRetryInPlace(
  event: SessionRetryEvent,
): { retry: false } | { retry: true; delay: number } {
  if (!event || typeof event !== "object") {
    return { retry: false };
  }

  const attempt =
    typeof event.attempt === "number" && Number.isFinite(event.attempt)
      ? event.attempt
      : 1;
  const errType = (event.error?.type ?? "").toLowerCase();
  const errMsg = (event.error?.message ?? "").toLowerCase();
  const errCode = (event.error?.code ?? "").toLowerCase();
  const combined = `${errType} ${errCode} ${errMsg}`;

  // 1. Hard stop on non-recoverable errors or excessive attempts
  if (
    attempt > 6 ||
    /\b(?:auth|unauthorized|invalid_api_key|forbidden|permission|aborted|cancelled|not-found|not_found|context-overflow|context_overflow)\b/.test(
      combined,
    )
  ) {
    event.decision = { retry: false };
    return event.decision;
  }

  // 2. Recover from transient stream drops / gateway blips on attempts 1..3
  if (
    attempt <= 3 &&
    /\b(?:incomplete-stream|incomplete_stream|unknown finish reason|overloaded|rate_limit|ratelimit|502|503|504|529|econnreset|etimedout|socket hang up|temporarily unavailable)\b/.test(
      combined,
    )
  ) {
    const existingDelay =
      event.decision?.retry === true &&
      typeof event.decision.delay === "number" &&
      event.decision.delay > 0
        ? event.decision.delay
        : attempt * 1200;
    const boundedDelay = Math.min(Math.max(500, existingDelay), 5000);
    event.decision = { retry: true, delay: boundedDelay };
    return event.decision;
  }

  // 3. Cap excessive delays on normal retries so sessions stay responsive
  if (event.decision?.retry === true) {
    const capped = Math.min(Math.max(250, event.decision.delay), 10_000);
    event.decision = { retry: true, delay: capped };
  }

  return event.decision;
}
