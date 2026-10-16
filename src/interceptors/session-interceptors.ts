/**
 * `src/interceptors/session-interceptors.ts` — Plugin-over-patch session, prompt,
 * compaction, and root-affinity interceptors for OpenCode V2 (`opencode-2`).
 *
 * Eliminates the need to patch `packages/core/src/plugin/optimize.ts`,
 * `packages/core/src/plugin/identity.ts`, `packages/core/src/plugin/system-prompt/meta.txt`,
 * `packages/core/src/session/compaction.ts`, or `packages/core/src/session/affinity.ts`
 * by running directly inside OpenCode V2's plugin hooks after built-in plugins:
 *
 * 1. `calibrateSystemPromptInPlace`: Runs in `session.hook("context" | "generate")` after
 *    `OptimizePlugin.MetaPlugin`. Repairs the `meta.txt` subagent over-trigger in-place
 *    and appends static Muse 1.3 tool guidance to `event.system[0]` without disturbing
 *    KV-cache determinism.
 * 2. `decontaminateCompactionEventInPlace`: Runs in `session.hook("compaction")` after
 *    `OptimizePlugin` and `IdentityPlugin` to strip coding-agent system prompt blocks
 *    and tool definitions that were erroneously injected into the compaction request.
 * 3. `SessionLineageTracker`: Tracks `childSessionID -> parentSessionID` links across
 *    unlimited subagent/fork hops and rewrites `x-session-affinity` / `X-Session-Id`
 *    headers in `session.hook("model.request")` so nested subagents reuse the root
 *    session's `promptCacheKey`.
 */

import { buildMuseSystemOverlay } from "../muse/muse-calibration.js";

const META_SUBAGENT_OVERTRIGGER =
  "- Use the `subagent` tool to minimize context token usage whenever tool calls generate large outputs but only a small subset is useful for the task at hand. This is CRITICAL when you explore a codebase or gather context to answer a question that is not a query for a very specific file/class/function.";

const CALIBRATED_SUBAGENT_RULE =
  "- Perform routine file reads (`read`, `file_hash_read`, `file_outline`), targeted searches (`grep`, `glob`, `ast_structural_search`), and dependency checks (`repo_map`, `blast_radius`) directly in the main context. Only spawn a `subagent` when broad exploration spans more than 8 files or when executing independent parallel workstreams.";

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
 * Strips coding-agent prompt contamination and `# Your Model` identity blocks
 * that `OptimizePlugin` and `IdentityPlugin` inject into `session.hook("compaction")`,
 * and clears `event.tools` so compaction summarization requests remain pure and
 * lightweight without patching `optimize.ts` or `identity.ts`.
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

  // Record parent link if OpenCode V2 populated x-opencode-parent-session-id
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
