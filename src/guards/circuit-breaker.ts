/**
 * `src/guards/circuit-breaker.ts` — Doom-loop circuit breaker.
 *
 * Wave 1 module per `docs/prompts/SPEC.md` Section 2.3 D (Report `01b`
 * Section 9.2): tracks per-session tool attempts and triggers a critical
 * intervention (`shouldEscalateModel: true`,
 * `<circuit-breaker-intervention severity="critical">`) when:
 * - `edit`/`patch`-family tools fail `>= 2` consecutive times on the same
 *   file path, OR
 * - `shell`/`bash`-family tools fail `>= 3` consecutive times on the same
 *   command prefix (first two whitespace-separated tokens).
 *
 * "Consecutive" is a strict trailing run: any success, any different tool
 * family, or any different key (path/prefix) breaks the streak.
 */

export const EDIT_FAILURE_THRESHOLD = 2;
export const SHELL_FAILURE_THRESHOLD = 3;
export const MAX_ATTEMPTS_PER_SESSION = 200;

export type CircuitToolKind = "edit" | "shell" | "other";

export interface ToolAttemptRecord {
  tool: string;
  ok: boolean;
  path?: string;
  command?: string;
  commandPrefix?: string;
  error?: string;
}

export interface CircuitBreakerVerdict {
  triggered: boolean;
  shouldEscalateModel: boolean;
  severity?: "critical";
  consecutiveFailures: number;
  message: string;
  intervention?: string;
}

export const sessionAttempts: Map<string, ToolAttemptRecord[]> = new Map();

const EDIT_TOOL_FAMILY = new Set([
  "edit",
  "patch",
  "write",
  "create",
  "delete",
  "apply_patch",
  "file_hash_edit",
  "ast_structural_rewrite",
]);

const SHELL_TOOL_FAMILY = new Set([
  "shell",
  "bash",
  "exec",
  "run",
  "run_command",
  "terminal",
]);

/** Classify a tool name into the edit, shell, or other family. */
export function normalizeToolKind(tool: string): CircuitToolKind {
  const name = (tool ?? "").trim();
  if (EDIT_TOOL_FAMILY.has(name)) {
    return "edit";
  }
  if (SHELL_TOOL_FAMILY.has(name)) {
    return "shell";
  }
  return "other";
}

/**
 * Derive the command prefix used for shell streak grouping: the first two
 * whitespace-separated tokens with internal whitespace collapsed
 * (for example `git push --force origin main` groups under `git push`).
 */
export function commandPrefixOf(command: string): string {
  return (command ?? "")
    .replace(/\s+/g, " ")
    .trim()
    .split(" ")
    .slice(0, 2)
    .join(" ");
}

function editKeyOf(attempt: ToolAttemptRecord): string {
  return (attempt.path ?? "").trim();
}

function shellKeyOf(attempt: ToolAttemptRecord): string {
  if (attempt.commandPrefix !== undefined && attempt.commandPrefix.trim() !== "") {
    return attempt.commandPrefix.replace(/\s+/g, " ").trim();
  }
  return commandPrefixOf(attempt.command ?? "");
}

function buildIntervention(
  sessionId: string,
  kind: CircuitToolKind,
  key: string,
  consecutiveFailures: number,
): string {
  const subject = kind === "edit" ? `file path ${JSON.stringify(key)}` : `command prefix ${JSON.stringify(key)}`;
  return (
    `<circuit-breaker-intervention severity="critical">` +
    `Doom-loop detected in session ${JSON.stringify(sessionId)}: ` +
    `${consecutiveFailures} consecutive failed ${kind} attempts on ${subject}. ` +
    `Stop retrying the same operation. Summarize the repeated error, re-read the target state, ` +
    `and escalate to a different strategy before attempting again.` +
    `</circuit-breaker-intervention>`
  );
}

function quietVerdict(): CircuitBreakerVerdict {
  return {
    triggered: false,
    shouldEscalateModel: false,
    consecutiveFailures: 0,
    message: "circuit-breaker: no doom-loop streak detected",
  };
}

/**
 * Evaluate the trailing attempt streak for `sessionId` without recording
 * anything. Returns a critical verdict once the edit threshold (>= 2 same
 * path) or shell threshold (>= 3 same prefix) is reached.
 */
export function evaluateSession(sessionId: string): CircuitBreakerVerdict {
  const attempts = sessionAttempts.get(sessionId) ?? [];
  if (attempts.length === 0) {
    return quietVerdict();
  }
  const latest = attempts[attempts.length - 1];
  if (latest.ok) {
    return quietVerdict();
  }
  const kind = normalizeToolKind(latest.tool);
  if (kind === "other") {
    return quietVerdict();
  }
  const key = kind === "edit" ? editKeyOf(latest) : shellKeyOf(latest);
  if (key === "") {
    return quietVerdict();
  }
  const threshold = kind === "edit" ? EDIT_FAILURE_THRESHOLD : SHELL_FAILURE_THRESHOLD;
  let streak = 0;
  for (let index = attempts.length - 1; index >= 0; index--) {
    const attempt = attempts[index];
    if (attempt.ok || normalizeToolKind(attempt.tool) !== kind) {
      break;
    }
    const candidateKey = kind === "edit" ? editKeyOf(attempt) : shellKeyOf(attempt);
    if (candidateKey !== key) {
      break;
    }
    streak++;
  }
  if (streak < threshold) {
    return {
      triggered: false,
      shouldEscalateModel: false,
      consecutiveFailures: streak,
      message: `circuit-breaker: ${streak} consecutive failed ${kind} attempt(s) on ${JSON.stringify(key)} (threshold ${threshold})`,
    };
  }
  return {
    triggered: true,
    shouldEscalateModel: true,
    severity: "critical",
    consecutiveFailures: streak,
    message:
      `circuit-breaker: ${streak} consecutive failed ${kind} attempts on ` +
      `${JSON.stringify(key)} meets the critical threshold (${threshold})`,
    intervention: buildIntervention(sessionId, kind, key, streak),
  };
}

/**
 * Record one tool attempt for `sessionId` (bounded at
 * `MAX_ATTEMPTS_PER_SESSION` entries) and return the fresh evaluation.
 */
export function recordToolAttempt(
  sessionId: string,
  attempt: ToolAttemptRecord,
): CircuitBreakerVerdict {
  if (typeof sessionId !== "string" || sessionId === "") {
    throw new Error("circuit-breaker: sessionId must be a non-empty string (fail-closed)");
  }
  if (!attempt || typeof attempt.tool !== "string" || attempt.tool === "") {
    throw new Error("circuit-breaker: attempt.tool must be a non-empty string (fail-closed)");
  }
  const history = sessionAttempts.get(sessionId) ?? [];
  history.push({ ...attempt });
  while (history.length > MAX_ATTEMPTS_PER_SESSION) {
    history.shift();
  }
  sessionAttempts.set(sessionId, history);
  return evaluateSession(sessionId);
}

/** Drop all recorded attempts for one session. */
export function resetSessionAttempts(sessionId: string): void {
  sessionAttempts.delete(sessionId);
}

/** Drop all recorded attempts for every session (test isolation helper). */
export function clearAllSessionAttempts(): void {
  sessionAttempts.clear();
}
