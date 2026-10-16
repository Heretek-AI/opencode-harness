import { parseCommandSegments } from "./shell-parse.js";

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

export function isUntrustedIngestionTool(toolName: string): boolean {
  const lower = toolName.toLowerCase();
  return (
    UNTRUSTED_INGESTION_TOOLS.has(lower) ||
    lower.startsWith("mcp_") ||
    lower.startsWith("mcp:")
  );
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
 * Evaluates whether a shell command or sensitive file mutation in a tainted session
 * attempts to exfiltrate credentials, pipe remote scripts to a shell, or mutate git hooks.
 */
export function evaluateTaintGuard(
  sessionId: string,
  commandOrPath: string,
  actionType: "shell" | "file" = "shell",
): TaintVerdict {
  const taints = SESSION_TAINT.get(sessionId);
  if (!taints || taints.length === 0) {
    return { action: "allow" };
  }

  const latestSource =
    taints[taints.length - 1]?.sourceTool ?? "untrusted-source";

  if (actionType === "file") {
    const norm = commandOrPath.replace(/\\/g, "/");
    if (
      norm.includes(".git/hooks") ||
      norm.includes(".git/config") ||
      norm.endsWith(".bashrc") ||
      norm.endsWith(".zshrc") ||
      norm.endsWith(".profile")
    ) {
      return {
        action: "deny",
        ruleId: "TAINT-FILE-1",
        reason: `Blocked mutation of sensitive execution hook "${commandOrPath}" while session is tainted by untrusted tool "${latestSource}".`,
      };
    }
    return { action: "allow" };
  }

  const segments = parseCommandSegments(commandOrPath);
  for (const seg of segments) {
    const exe = seg.executable.split("/").pop() ?? seg.executable;
    const joinedArgs = seg.args.join(" ");

    if (["curl", "wget", "nc", "ncat", "scp", "ssh"].includes(exe)) {
      if (
        /(-d|--data|--upload-file|-F|\bPOST\b|\bPUT\b|\$|\benv\b|\.env|id_rsa|token|secret|key)/i.test(
          joinedArgs,
        )
      ) {
        return {
          action: "deny",
          ruleId: "TAINT-NET-1",
          reason: `Blocked potential credential/data exfiltration via "${exe}" after ingesting untrusted content from "${latestSource}".`,
        };
      }
    }

    if (exe === "printenv" || (exe === "env" && seg.args.length === 0)) {
      return {
        action: "ask",
        ruleId: "TAINT-ENV-1",
        reason: `Dumping environment variables requires confirmation after ingesting untrusted content from "${latestSource}".`,
      };
    }
  }

  return { action: "allow" };
}
