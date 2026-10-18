import { getSessionParent, linkForkLineageFromEventMetadata } from "../interceptors/session-interceptors.js";
import { shellNamedFileTargets } from "./permission-guard.js";
import {
  commandBasename,
  isDestructiveShellCommand,
  parseCommandSegments,
  shellArgvFileTargets,
  stripLeadingWrapperTokens,
  UNRESOLVED_NESTING_SENTINEL,
} from "./shell-parse.js";

export interface TaintRecord {
  sessionId: string;
  sourceTool: string;
  sourceLabel: string;
  taintedAt: number;
}

export interface TaintVerdict {
  action: "allow" | "ask" | "deny";
  ruleId?: string;
  reason?: string;
}

const SESSION_TAINT = new Map<string, TaintRecord[]>();

const UNTRUSTED_INGESTION_TOOLS = new Set([
  "webfetch",
  "websearch",
  "codesearch",
  "browser",
  "fetch",
]);

/**
 * MCP server ids whose `<server>_<tool>` discovery names must arm taint
 * (upstream MCP tools are `server_tool` with no `mcp_` prefix, so the
 * historic `mcp_`-prefix check never fired for the recommended servers).
 */
const KNOWN_MCP_SERVER_IDS = ["fallow-mcp", "lsp-mcp-server"];

/**
 * Tool names the harness itself (or the host's built-in toolset) is known to
 * produce. Anything else containing `_` is treated as an MCP discovery id
 * (`<server>_<tool>` — upstream never emits an `mcp_` prefix, and single-word
 * servers like `tavily`/`fetch` yield `tavily_search`/`fetch_search`) and arms
 * taint fail-closed (OH-6.6-single-word-mcp-server).
 *
 * OH-6.6-taint-name-squat (documented residual): allowlist matches the BARE
 * discovery name only — the event path carries no MCP namespace marker, so
 * an exact-match hostile id (server `file_hash` + tool `read`) returns
 * `taint=false`. Hardening is `isMcpProvenanceEvent`, armed alongside this
 * check at ingestion: marked squats arm taint, bare built-ins keep allow.
 */
const KNOWN_SAFE_TOOL_NAMES = new Set([
  // Harness tools (`HARNESS_TOOL_NAMES` + `EXTENDED_HARNESS_TOOL_NAMES`).
  "file_hash_read",
  "file_hash_edit",
  "ast_structural_search",
  "ast_structural_rewrite",
  "ui_geometry_audit",
  "repo_map",
  "blast_radius",
  "file_outline",
  "symbol_references",
  "rename_symbol",
  "verify_scoped",
  "architecture_audit",
  "checkpoint_create",
  "checkpoint_rollback",
  // Host built-in tools (read-only and mutating; none ingest third-party
  // web/MCP content, so none arm taint).
  "read",
  "edit",
  "write",
  "patch",
  "multiedit",
  "apply_patch",
  "create",
  "delete",
  "shell",
  "bash",
  "exec",
  "run",
  "run_command",
  "terminal",
  "glob",
  "grep",
  "ls",
  "list",
  "task",
  "subagent",
  "todo",
  "todowrite",
  "todoread",
  "todo_write",
  "todo_read",
]);

export function isUntrustedIngestionTool(toolName: string): boolean {
  const lower = (toolName ?? "").toLowerCase();
  if (lower === "") {
    return false;
  }
  if (UNTRUSTED_INGESTION_TOOLS.has(lower)) {
    return true;
  }
  if (lower.startsWith("mcp_") || lower.startsWith("mcp:")) {
    return true;
  }
  for (const server of KNOWN_MCP_SERVER_IDS) {
    if (
      lower === server ||
      lower.startsWith(`${server}_`) ||
      lower.startsWith(`${server}-`) ||
      lower.startsWith(`${server}:`)
    ) {
      return true;
    }
  }
  if (KNOWN_SAFE_TOOL_NAMES.has(lower)) {
    return false;
  }
  // Hyphenated server segment before the first `_` (`my-server_tool`) vs
  // harness `snake_case` tools (allowlisted above).
  const underscore = lower.indexOf("_");
  if (underscore > 0 && lower.slice(0, underscore).includes("-")) {
    return true;
  }
  // Fail-closed: any other unknown `_`-containing tool name is an MCP
  // discovery id from a single-word server (`tavily_search`,
  // `fetch_search`, `fallow_search`) — arm taint rather than miss it.
  if (lower.includes("_")) {
    return true;
  }
  return false;
}

/**
 * OH-6.6-taint-name-squat: `true` when a tool event carries an explicit MCP
 * origin marker, so a squat id equal to a safe-list entry still arms taint.
 * Only exact-key markers count (never substrings/arg values); no marker
 * returns `false`. Never throws.
 */
const MCP_PROVENANCE_KEYS = ["mcpServer", "mcpServerId", "mcp_server", "mcpToolId", "mcp_tool"];

export function isMcpProvenanceEvent(event: unknown): boolean {
  try {
    if (event === null || typeof event !== "object") return false;
    const record = event as Record<string, unknown>;
    const result = record.result as Record<string, unknown> | undefined;
    const holders = [record, record.input, record.metadata, record.headers, result, result?.metadata];
    for (const holder of holders) {
      if (holder === null || typeof holder !== "object") continue;
      const h = holder as Record<string, unknown>;
      for (const key of MCP_PROVENANCE_KEYS) {
        if (typeof h[key] === "string" && h[key] !== "") return true;
      }
      for (const key of ["origin", "source", "provider", "namespace"]) {
        if (typeof h[key] === "string" && (h[key] as string).toLowerCase() === "mcp") {
          return true;
        }
      }
    }
    return false;
  } catch {
    return false;
  }
}

export function recordUntrustedContentTaint(
  sessionId: string,
  toolName: string,
  sourceLabel: string = "external-content",
): void {
  const list = SESSION_TAINT.get(sessionId) ?? [];
  list.push({
    sessionId,
    sourceTool: toolName,
    sourceLabel,
    taintedAt: Date.now(),
  });
  SESSION_TAINT.set(sessionId, list);
}

export function getTaintSnapshot(sessionId: string): TaintRecord[] {
  return [...(SESSION_TAINT.get(sessionId) ?? [])];
}

export function clearTaintState(sessionId?: string): void {
  if (sessionId) {
    SESSION_TAINT.delete(sessionId);
  } else {
    SESSION_TAINT.clear();
  }
}

/**
 * Walk the parent/fork chain so children inherit parent taint (fail-closed:
 * a fork of a tainted session is tainted; a forged clean-parent link allows
 * like no link). Residual: silent host-level forks link nothing — hosts MUST
 * call exported `recordSessionForkLink(child, parent)` at fork time.
 */
function resolveTaintChain(sessionId: string): TaintRecord[] {
  const visited = new Set<string>();
  let current: string | undefined = sessionId;
  while (current !== undefined && !visited.has(current)) {
    visited.add(current);
    const list = SESSION_TAINT.get(current);
    if (list !== undefined && list.length > 0) {
      return list;
    }
    current = getSessionParent(current);
  }
  return [];
}

function denyTaint(ruleId: string, reason: string): TaintVerdict {
  return { action: "deny", ruleId, reason };
}

/**
 * OH-6.6-redirect-taint-blindspot: `true` when a path names a credential or
 * hook location the tainted session must not touch. Shared by the `file`
 * and shell branches so the two layers cannot diverge.
 */
export function matchesTaintSensitivePath(commandOrPath: string): boolean {
  const norm = (commandOrPath ?? "").replace(/\\/g, "/");
  const lower = norm.toLowerCase();
  return (
    norm.includes(".git/hooks") ||
    norm.includes(".git/config") ||
    /(^|\/)\.ssh(\/|$)/.test(norm) ||
    norm.includes(".aws/") ||
    /(^|\/)(\.env)(\.[^/]*)?$/.test(lower) ||
    norm.endsWith(".bashrc") ||
    norm.endsWith(".zshrc") ||
    norm.endsWith(".profile")
  );
}

/**
 * OH-6.6-exec-taint-evasion: effective executable after stripping
 * privilege/env wrappers with the shared G-01 wrapper set; falls back to
 * the raw executable, then the wrapper chain tail.
 */
export function taintEffectiveExecutable(seg: {
  tokens: string[];
  executable: string;
  wrapperChain?: string[];
}): string {
  const stripped = stripLeadingWrapperTokens(seg.tokens ?? []);
  const head = (stripped.filter((t) => t !== UNRESOLVED_NESTING_SENTINEL))[0] ?? "";
  if (head !== "") {
    return commandBasename(head);
  }
  // Bare wrapper with no payload (`env` alone prints the environment):
  // the raw command word still identifies the taint-relevant behavior.
  const direct = commandBasename(seg.executable ?? "");
  if (direct !== "") {
    return direct;
  }
  const chain = seg.wrapperChain ?? [];
  return chain.length > 0 ? commandBasename(chain[chain.length - 1] ?? "") : "";
}

/**
 * Deny exfil/wipe/credential-touching shell or sensitive file mutations in a
 * tainted session.
 *
 * OH-6.6-taint-fork-gap (remediation-D): optional 4th param `eventContext`
 * carries the live host event; when provided, fork lineage links FIRST
 * (never throws; junk/self/empty link nothing) so a forked child whose
 * first observable event is the guarded action still inherits taint in the
 * same call. Residual: a silent fork whose event carries NO fork id links
 * nothing — hosts MUST call `recordSessionForkLink(child, parent)`.
 */
export function evaluateTaintGuard(
  sessionId: string,
  commandOrPath: string,
  actionType: "shell" | "file" = "shell",
  eventContext?: unknown,
): TaintVerdict {
  if (eventContext !== undefined && eventContext !== null) {
    linkForkLineageFromEventMetadata(sessionId, eventContext);
  }
  const taints = resolveTaintChain(sessionId);
  if (taints.length === 0) {
    return { action: "allow" };
  }

  const latestSource =
    taints[taints.length - 1]?.sourceTool ?? "untrusted-source";

  // OH-6.5-find-exec-placeholder: while tainted, a destructive shell command
  // denies fail-closed at the taint layer too (never `allow` a wipe idiom).
  if (actionType === "shell" && isDestructiveShellCommand(commandOrPath)) {
    return denyTaint(
      "TAINT-DESTRUCTIVE-1",
      `Blocked destructive shell command "${commandOrPath}" while session is tainted by untrusted tool "${latestSource}".`,
    );
  }

  if (actionType === "file") {
    if (matchesTaintSensitivePath(commandOrPath)) {
      return denyTaint(
        "TAINT-FILE-1",
        `Blocked mutation of sensitive credential/hook path "${commandOrPath}" while session is tainted by untrusted tool "${latestSource}".`,
      );
    }
    return { action: "allow" };
  }

  // OH-6.6-redirect-taint-blindspot: while tainted, a redirect/`tee`/argv
  // target naming a sensitive path denies with TAINT-FILE-1 (privileged
  // roles pass the permission guard by design, so this layer must catch it).
  for (const target of [
    ...shellNamedFileTargets(commandOrPath),
    ...shellArgvFileTargets(commandOrPath),
  ]) {
    if (matchesTaintSensitivePath(target)) {
      return denyTaint(
        "TAINT-FILE-1",
        `Blocked shell redirect target "${target}" (sensitive credential/hook path) while session is tainted by untrusted tool "${latestSource}".`,
      );
    }
  }

  const segments = parseCommandSegments(commandOrPath);
  const effectiveExes = segments.map((seg) => taintEffectiveExecutable(seg));
  const exeSet = new Set(effectiveExes);
  const hasFetcher = exeSet.has("curl") || exeSet.has("wget");
  const hasShellTarget =
    exeSet.has("sh") ||
    exeSet.has("bash") ||
    exeSet.has("zsh") ||
    exeSet.has("dash") ||
    exeSet.has("ksh");

  // Remote script piped straight into a shell (`curl URL | sh`): deny.
  if (hasFetcher && hasShellTarget && segments.length > 1) {
    return denyTaint(
      "TAINT-PIPE-1",
      `Blocked piping a remote download into a shell ("${commandOrPath}") while session is tainted by untrusted tool "${latestSource}".`,
    );
  }

  for (const seg of segments) {
    const exe = taintEffectiveExecutable(seg);
    const joinedArgs = seg.args.join(" ");

    // `wget` writes remote content to disk silently: deny when tainted.
    if (exe === "wget") {
      return denyTaint(
        "TAINT-NET-2",
        `Blocked remote download via "wget" after ingesting untrusted content from "${latestSource}".`,
      );
    }

    if (["curl", "nc", "ncat", "scp", "sftp", "ssh"].includes(exe)) {
      if (exe !== "curl") {
        return denyTaint(
          "TAINT-NET-2",
          `Blocked remote execution/transfer via "${exe}" after ingesting untrusted content from "${latestSource}".`,
        );
      }
      if (
        /(-d|--data|--upload-file|-F|\bPOST\b|\bPUT\b|\$|\benv\b|\.env|id_rsa|token|secret|key|\.ssh|\.aws)/i.test(
          joinedArgs,
        ) ||
        /(^|\s)(-o\b|--output\b|-O\b|--remote-name\b)/.test(` ${joinedArgs} `)
      ) {
        return denyTaint(
          "TAINT-NET-1",
          `Blocked potential credential/data exfiltration via "${exe}" after ingesting untrusted content from "${latestSource}".`,
        );
      }
    }

    // `git push` from a tainted session can exfiltrate or rewrite remotes.
    if (exe === "git" && seg.args.some((a) => a.toLowerCase() === "push")) {
      return denyTaint(
        "TAINT-GIT-1",
        `Blocked "git push" while session is tainted by untrusted tool "${latestSource}".`,
      );
    }

    // `env`/`printenv` dump secrets or launder commands (`env rm ...`).
    if (exe === "printenv" || exe === "env") {
      return denyTaint(
        "TAINT-ENV-1",
        `Blocked environment dump/laundering via "${exe}" after ingesting untrusted content from "${latestSource}".`,
      );
    }

    // Pager/readers aimed at credential paths (`cat ~/.ssh/id_rsa`).
    if (["cat", "less", "more", "head", "tail"].includes(exe)) {
      const target = joinedArgs.replace(/\\/g, "/");
      if (
        /(^|\/)\.ssh(\/|$)/.test(target) ||
        target.includes(".aws/") ||
        /(^|\/)(\.env)(\.[^/]*)?(\s|$)/i.test(target) ||
        /id_rsa|\.pem\b/i.test(target)
      ) {
        return denyTaint(
          "TAINT-FILE-2",
          `Blocked reading credential path via "${exe}" while session is tainted by untrusted tool "${latestSource}".`,
        );
      }
    }
  }

  return { action: "allow" };
}
