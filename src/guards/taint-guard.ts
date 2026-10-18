import { getSessionParent } from "../interceptors/session-interceptors.js";
import { commandBasename, parseCommandSegments } from "./shell-parse.js";

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
 * MCP server ids whose `<server>_<tool>` discovery names must arm taint.
 * Upstream names MCP tools `server_tool` with no `mcp_` prefix, so the
 * historic `mcp_`-prefix check never fired for the recommended servers.
 */
const KNOWN_MCP_SERVER_IDS = ["fallow-mcp", "lsp-mcp-server"];

/**
 * Tool names the harness itself (or the host's built-in toolset) is known to
 * produce. Anything else containing `_` is treated as an MCP discovery id
 * (`<server>_<tool>` — upstream never emits an `mcp_` prefix, and single-word
 * servers like `tavily`/`fetch` yield `tavily_search`/`fetch_search`) and arms
 * taint fail-closed (OH-6.6-single-word-mcp-server).
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
  // Generic MCP discovery id `<server>_<tool>`: a hyphenated server segment
  // before the first `_` distinguishes MCP ids (`my-server_tool`) from
  // harness `snake_case` tools (`file_hash_read`, already allowlisted above).
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
 * Resolve the nearest taint records for `sessionId`, walking up the
 * `recordSessionParentLink` fork/subagent/compaction chain so child sessions
 * inherit their parent's taint (fail-closed: a fork of a tainted session is
 * tainted).
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
 * Evaluates whether a shell command or sensitive file mutation in a tainted session
 * attempts to exfiltrate credentials, pipe remote scripts to a shell, or mutate git hooks.
 */
export function evaluateTaintGuard(
  sessionId: string,
  commandOrPath: string,
  actionType: "shell" | "file" = "shell",
): TaintVerdict {
  const taints = resolveTaintChain(sessionId);
  if (taints.length === 0) {
    return { action: "allow" };
  }

  const latestSource =
    taints[taints.length - 1]?.sourceTool ?? "untrusted-source";

  if (actionType === "file") {
    const norm = commandOrPath.replace(/\\/g, "/");
    const lower = norm.toLowerCase();
    if (
      norm.includes(".git/hooks") ||
      norm.includes(".git/config") ||
      /(^|\/)\.ssh(\/|$)/.test(norm) ||
      norm.includes(".aws/") ||
      /(^|\/)\.env(\.[^/]*)?$/.test(lower) ||
      norm.endsWith(".bashrc") ||
      norm.endsWith(".zshrc") ||
      norm.endsWith(".profile")
    ) {
      return denyTaint(
        "TAINT-FILE-1",
        `Blocked mutation of sensitive credential/hook path "${commandOrPath}" while session is tainted by untrusted tool "${latestSource}".`,
      );
    }
    return { action: "allow" };
  }

  const segments = parseCommandSegments(commandOrPath);
  const effectiveExes = segments.map((seg) => {
    const direct = commandBasename(seg.executable);
    if (direct !== "") {
      return direct;
    }
    const chain = seg.wrapperChain ?? [];
    return chain.length > 0 ? commandBasename(chain[chain.length - 1] ?? "") : "";
  });
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
    const exe = commandBasename(seg.executable) !== ""
      ? commandBasename(seg.executable)
      : commandBasename((seg.wrapperChain ?? [])[(seg.wrapperChain ?? []).length - 1] ?? "");
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
