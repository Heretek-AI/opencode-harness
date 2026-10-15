/**
 * `src/guards/permission-guard.ts` — Role/path/contract permission guard.
 *
 * Wave 1 module per `docs/prompts/SPEC.md` Section 2.3 C, salvaged from the
 * `SwarmOS` shell-parse/guard pair and decoupled from `OrgBoard`: policy
 * arrives as a lightweight `GuardPolicyConfig` with `lockedContractGlobs`
 * and optional `taskOwnedPaths`.
 *
 * Rule order (first match wins, all denials fail closed):
 * - Rule 0 (Path safety): absolute paths and `..` traversal are denied.
 * - Rule 1 (Destructive Command Block): `rm -rf /`, `rm -rf *`,
 *   `git reset --hard`, `git push --force`, `mkfs`, `dd if=` denied for
 *   ALL roles.
 * - Rule 2 (Leadership Read-Only): `director`, `manager`,
 *   `agency-coordinator`, `agency-drift-guard` denied `edit`/`write`/`patch`
 *   and file-mutating shell.
 * - Rule 3 (QA Red-Team Source Lock): `qa-adversary`, `agency-qa` denied
 *   `edit`/`write`/`patch` on `src/**` and permitted only on test, spec,
 *   accept-script, and docs paths.
 * - Rule 4 (Architect Contract Lock): `lockedContractGlobs` (defaulting to
 *   the contracts and schema globs from SPEC Section 2.3 C) modifiable only
 *   by `architect`.
 */

import {
  classifyShellCommand,
  isDestructiveShellCommand,
} from "./shell-parse";

export const DEFAULT_LOCKED_CONTRACT_GLOBS: string[] = [
  "**/contracts/**",
  "**/schemas/*.schema.json",
];

export interface GuardPolicyConfig {
  lockedContractGlobs: string[];
  taskOwnedPaths?: Record<string, string[]>;
}

export interface GuardRequest {
  role: string;
  tool: string;
  path?: string;
  command?: string;
}

export interface GuardVerdict {
  allowed: boolean;
  reason: string;
  rule?: string;
}

const LEADERSHIP_READ_ONLY_ROLES = new Set([
  "director",
  "manager",
  "agency-coordinator",
  "agency-drift-guard",
]);

const QA_RED_TEAM_ROLES = new Set(["qa-adversary", "agency-qa"]);

const QA_WRITABLE_GLOBS = [
  "**/*.test.*",
  "**/*.spec.*",
  "test/**",
  "tests/**",
  "scripts/accept/**",
  "docs/**",
];

const EDIT_TOOL_NAMES = new Set([
  "edit",
  "write",
  "patch",
  "create",
  "delete",
  "apply_patch",
  "file_hash_edit",
  "ast_structural_rewrite",
]);

const SHELL_TOOL_NAMES = new Set([
  "shell",
  "bash",
  "exec",
  "run",
  "run_command",
  "terminal",
]);

const READ_TOOL_NAMES = new Set([
  "read",
  "file_hash_read",
  "ast_structural_search",
  "glob",
  "grep",
  "ls",
  "list",
]);

export function defaultGuardConfig(): GuardPolicyConfig {
  return { lockedContractGlobs: [...DEFAULT_LOCKED_CONTRACT_GLOBS] };
}

export function isEditTool(tool: string): boolean {
  return EDIT_TOOL_NAMES.has(tool);
}

export function isShellTool(tool: string): boolean {
  return SHELL_TOOL_NAMES.has(tool);
}

function normalizeGuardPath(path: string): string {
  return path.replace(/\\/g, "/").replace(/^\.\//, "");
}

function isUnsafeGuardPath(path: string): boolean {
  const normalized = normalizeGuardPath(path);
  return (
    normalized.length === 0 ||
    normalized.includes("\0") ||
    normalized.startsWith("/") ||
    /^[A-Za-z]:[\\/]/.test(normalized) ||
    normalized === ".." ||
    normalized.startsWith("../") ||
    normalized.split("/").includes("..")
  );
}

function globToRegExp(glob: string): RegExp {
  let source = "";
  let index = 0;
  while (index < glob.length) {
    if (glob.startsWith("**/", index)) {
      source += "(?:.*/)?";
      index += 3;
    } else if (glob.startsWith("**", index)) {
      source += ".*";
      index += 2;
    } else if (glob[index] === "*") {
      source += "[^/]*";
      index++;
    } else if (glob[index] === "?") {
      source += "[^/]";
      index++;
    } else {
      source += glob[index].replace(/[.*+?^${}()|[\]\\]/, "\\$&");
      index++;
    }
  }
  return new RegExp(`^(?:${source})$`);
}

/** Match a normalized relative path against glob patterns (`**`, `*`, `?`). */
export function matchesAnyGlob(path: string, globs: string[]): boolean {
  const normalized = normalizeGuardPath(path);
  return globs.some((glob) => globToRegExp(glob).test(normalized));
}

function deny(reason: string, rule: string): GuardVerdict {
  return { allowed: false, reason, rule };
}

/**
 * Evaluate a tool/permission request against Rules 0–4 plus optional
 * per-role `taskOwnedPaths`. Unknown tool names are denied (fail-closed);
 * anything not denied by an explicit rule is allowed.
 */
export function evaluateBoardGuard(
  request: GuardRequest,
  config?: GuardPolicyConfig,
): GuardVerdict {
  const policy: GuardPolicyConfig = config ?? defaultGuardConfig();
  const role = (request.role ?? "").trim();
  const tool = (request.tool ?? "").trim();
  const path = request.path !== undefined ? normalizeGuardPath(request.path) : undefined;
  const command = request.command ?? "";

  if (role === "") {
    return deny("guard: empty role is rejected (fail-closed)", "rule-0-path-safety");
  }
  if (tool === "") {
    return deny("guard: empty tool name is rejected (fail-closed)", "rule-0-path-safety");
  }
  if (!isEditTool(tool) && !isShellTool(tool) && !READ_TOOL_NAMES.has(tool)) {
    return deny(
      `guard: unknown tool ${JSON.stringify(tool)} is rejected for role ${JSON.stringify(role)} (fail-closed)`,
      "rule-0-path-safety",
    );
  }
  if (path !== undefined && isUnsafeGuardPath(path)) {
    return deny(
      `guard: refusing path outside the workspace: ${JSON.stringify(request.path)} (fail-closed)`,
      "rule-0-path-safety",
    );
  }
  if (isEditTool(tool) && (path === undefined || path === "")) {
    return deny(
      `guard: ${tool} without a target path is rejected for role ${JSON.stringify(role)} (fail-closed)`,
      "rule-0-path-safety",
    );
  }

  if (isShellTool(tool)) {
    if (command.trim() === "") {
      return deny(
        `guard: empty shell command is rejected for role ${JSON.stringify(role)} (fail-closed)`,
        "rule-0-path-safety",
      );
    }
    if (isDestructiveShellCommand(command)) {
      return deny(
        `guard: destructive shell command denied for role ${JSON.stringify(role)}: ${JSON.stringify(command)}`,
        "rule-1-destructive",
      );
    }
  }

  if (LEADERSHIP_READ_ONLY_ROLES.has(role)) {
    if (isEditTool(tool)) {
      return deny(
        `guard: leadership role ${JSON.stringify(role)} is read-only; ${tool} on ${JSON.stringify(path)} denied`,
        "rule-2-leadership-read-only",
      );
    }
    if (isShellTool(tool) && classifyShellCommand(command).class !== "read-only") {
      return deny(
        `guard: leadership role ${JSON.stringify(role)} is read-only; file-mutating shell denied: ${JSON.stringify(command)}`,
        "rule-2-leadership-read-only",
      );
    }
  }

  if (QA_RED_TEAM_ROLES.has(role) && isEditTool(tool) && path !== undefined) {
    if (path === "src" || path.startsWith("src/")) {
      return deny(
        `guard: red-team role ${JSON.stringify(role)} may not modify src/**: ${JSON.stringify(path)}`,
        "rule-3-qa-source-lock",
      );
    }
    if (!matchesAnyGlob(path, QA_WRITABLE_GLOBS)) {
      return deny(
        `guard: red-team role ${JSON.stringify(role)} may only modify test/spec/accept/docs paths: ${JSON.stringify(path)}`,
        "rule-3-qa-source-lock",
      );
    }
  }

  const lockedGlobs =
    policy.lockedContractGlobs.length > 0 ? policy.lockedContractGlobs : [...DEFAULT_LOCKED_CONTRACT_GLOBS];
  if (path !== undefined && matchesAnyGlob(path, lockedGlobs) && role !== "architect") {
    const modifies =
      isEditTool(tool) ||
      (isShellTool(tool) && classifyShellCommand(command).class !== "read-only");
    if (modifies) {
      return deny(
        `guard: contract path ${JSON.stringify(path)} is locked to the architect role; ${JSON.stringify(role)} denied`,
        "rule-4-contract-lock",
      );
    }
  }

  const owned = policy.taskOwnedPaths?.[role];
  if (owned !== undefined && isEditTool(tool) && path !== undefined) {
    if (!matchesAnyGlob(path, owned)) {
      return deny(
        `guard: role ${JSON.stringify(role)} owns [${owned.join(", ")}]; ${JSON.stringify(path)} is outside its task paths`,
        "rule-5-task-owned-paths",
      );
    }
  }

  return { allowed: true, reason: "guard: allowed (no rule denied the request)" };
}
