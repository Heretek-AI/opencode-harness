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
 *   Shell named-file targets (redirects, `tee`, `cp`/`mv`/`ln`/`install`
 *   operands, `sed -i` files) are confined to the workspace root (or the OS
 *   temp-dir scratch space) for every role
 *   (`rule-0-shell-target-containment`, OH-6.5-redirect-escape).
 * - Rule 1 (Destructive Command Block): `rm -rf /`, `rm -rf *`,
 *   `git reset --hard`, `git push --force`, `mkfs`, `dd if=` denied for
 *   ALL roles.
 * - Rule 2 (Leadership Read-Only): `director`, `manager`,
 *   `agency-coordinator`, `agency-drift-guard` denied `edit`/`write`/`patch`
 *   and file-mutating shell.
 * - Rule 3 (QA Red-Team Source Lock): `qa-adversary`, `agency-qa` denied
 *   `edit`/`write`/`patch` on `src/**` (`rule-3a-qa-src-lock`) and permitted
 *   only on test, spec, accept-script, and docs paths (`rule-3b-qa-allowlist`
 *   otherwise); every file-mutating shell command is denied for QA roles
 *   (`rule-3-qa-source-lock`, OH-6.3-qa-shell-bypass).
 * - Rule 4 (Architect Contract Lock): `lockedContractGlobs` (defaulting to
 *   the contracts and schema globs from SPEC Section 2.3 C) modifiable only
 *   by `architect` — enforced for edit paths and for shell redirect/tee
 *   targets (OH-6.4-contract-shell-bypass).
 * - Rule 5 (Task-Owned Paths): per-role `taskOwnedPaths` confinement,
 *   enforced for edit paths and for shell redirect/tee targets
 *   (OH-6.4-task-owned-shell-bypass).
 */

import {
  classifyShellCommand,
  isDestructiveShellCommand,
  shellArgvFileTargets,
} from "./shell-parse.js";
import { tmpdir } from "node:os";
import { isAbsolute, resolve, sep } from "node:path";

export const DEFAULT_LOCKED_CONTRACT_GLOBS: string[] = [
  "**/contracts/**",
  "**/schemas/*.schema.json",
];

export interface GuardPolicyConfig {
  lockedContractGlobs: string[];
  taskOwnedPaths?: Record<string, string[]>;
  /**
   * OH-6.5-redirect-escape: workspace root shell redirect/argv targets are
   * confined to. Relative targets resolve under it; absolute targets must
   * land inside it (or inside the OS temp dir, the legitimate builder
   * scratch space for `> /tmp/…/artifact.txt`). Defaults to
   * `process.cwd()` when absent so programmatic callers keep working.
   */
  workspaceRoot?: string;
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

/**
 * Roles the guard recognizes. Anything else is an unknown role and is held
 * to least privilege (reads and read-only shell only); every mutating
 * operation from an unknown role is denied fail-closed. Roles listed in
 * `taskOwnedPaths` are additionally recognized for the configured policy.
 */
const KNOWN_STANDARD_ROLES = new Set([
  "director",
  "manager",
  "agency-coordinator",
  "agency-drift-guard",
  "qa-adversary",
  "agency-qa",
  "architect",
  "programmer",
  "developer",
  "builder",
  "build",
  "explore",
  "plan",
  // Router staff roles (OH-8.3-staff-roles): documented builder-policy roles.
  "staff-backend",
  "staff-ui",
]);

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
  // Harness read-only tools (never mutate files; `verify_scoped` only runs
  // the repo's own typecheck/lint/test commands, mirroring an allowed
  // read-only `bun test` shell for leadership).
  "ui_geometry_audit",
  "repo_map",
  "blast_radius",
  "file_outline",
  "symbol_references",
  "architecture_audit",
  "verify_scoped",
  "checkpoint_create",
]);

/**
 * Harness tools that mutate the workspace without taking a single target
 * path (`rename_symbol` rewrites every touched file, `checkpoint_rollback`
 * restores snapshots). They are edit-class for leadership/QA/unknown-role
 * purposes but exempt from the path-required rule.
 */
const WORKSPACE_WIDE_EDIT_TOOLS = new Set([
  "rename_symbol",
  "checkpoint_rollback",
]);

export function defaultGuardConfig(): GuardPolicyConfig {
  return { lockedContractGlobs: [...DEFAULT_LOCKED_CONTRACT_GLOBS] };
}

/**
 * Resolve the acting role for a harness tool `execute`: prefer an explicit
 * `ctx.role`, fall back to the host `ctx.agent` (upstream `build`/`plan` /
 * `explore` ids), and default unattributed local calls to `builder`. The
 * read-only `explore`/`plan` agents map to `director`, mirroring the
 * permission hook. Empty attributions also default to `builder` so local
 * programmatic use keeps working; the `permission.evaluate` hook still
 * enforces destructive blocks for every role.
 */
export function resolveExecuteRole(ctx: unknown): string {
  const rec = (ctx ?? {}) as { role?: unknown; agent?: unknown };
  const raw =
    typeof rec.role === "string" && rec.role.trim() !== ""
      ? rec.role
      : typeof rec.agent === "string" && rec.agent.trim() !== ""
        ? rec.agent
        : "builder";
  const norm = normalizeRoleName(raw);
  if (norm === "explore" || norm === "plan") {
    return "director";
  }
  return norm === "" ? "builder" : norm;
}

/**
 * Pull the guard-relevant target out of raw tool args: the first non-empty
 * `path`/`filePath`/`file`/`targetFile` string (or the first entry of a
 * `files` list, e.g. `checkpoint_create`), plus a `command` string when the
 * tool takes one. Workspace-wide tools (`rename_symbol`,
 * `checkpoint_rollback`) intentionally yield no path; the guard judges them
 * by tool name.
 */
export function extractGuardTargetFromArgs(
  args: Record<string, unknown>,
): { path?: string; command?: string } {
  const source = (args ?? {}) as Record<string, unknown>;
  const command =
    typeof source.command === "string" && source.command.trim() !== ""
      ? source.command
      : undefined;
  const pathKeys = ["path", "filePath", "file", "targetFile"] as const;
  for (const key of pathKeys) {
    const value = source[key];
    if (typeof value === "string" && value.trim() !== "") {
      return command !== undefined ? { path: value, command } : { path: value };
    }
  }
  if (Array.isArray(source.files)) {
    const first = source.files.find(
      (entry): entry is string => typeof entry === "string" && entry.trim() !== "",
    );
    if (first !== undefined) {
      return { path: first };
    }
  }
  return command !== undefined ? { command } : {};
}

export function isEditTool(tool: string): boolean {
  return EDIT_TOOL_NAMES.has(tool) || WORKSPACE_WIDE_EDIT_TOOLS.has(tool);
}

export function isWorkspaceWideEditTool(tool: string): boolean {
  return WORKSPACE_WIDE_EDIT_TOOLS.has(tool);
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
      source += glob[index].replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
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

/**
 * Extract `>` / `>>` redirect target paths from a shell command string.
 * Handles unquoted, double-quoted, and single-quoted targets; fd-prefixed
 * redirects (`2> /dev/null`) are never treated as file targets and
 * `/dev/null` is skipped (OH-6.4-contract-shell-bypass).
 */
export function shellRedirectTargets(command: string): string[] {
  if (typeof command !== "string" || command.length === 0) {
    return [];
  }
  const targets: string[] = [];
  const re = /(^|[^\d])>{1,2}\s*("([^"]+)"|'([^']+)'|([^\s;|&<>]+))/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(command)) !== null) {
    const target = (m[3] ?? m[4] ?? m[5] ?? "") as string;
    if (target.length > 0 && target !== "/dev/null") {
      targets.push(target);
    }
  }
  return targets;
}

/** Split a command into `|`/`;`/`&`/newline segments, quote-aware. */
function splitTeeSegments(command: string): string[] {
  const segments: string[] = [];
  let current = "";
  let quote: "'" | '"' | null = null;
  for (let i = 0; i < command.length; i++) {
    const ch = command[i] as string;
    if (quote !== null) {
      if (ch === quote) {
        quote = null;
      }
      current += ch;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      current += ch;
      continue;
    }
    if (ch === "|" || ch === ";" || ch === "&" || ch === "\n") {
      if (current.trim().length > 0) {
        segments.push(current.trim());
      }
      current = "";
      continue;
    }
    current += ch;
  }
  if (current.trim().length > 0) {
    segments.push(current.trim());
  }
  return segments;
}

/** Tokenize one pipeline segment, stripping quotes but keeping quoted spans whole. */
function tokenizeTeeSegment(segment: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let quote: "'" | '"' | null = null;
  for (let i = 0; i < segment.length; i++) {
    const ch = segment[i] as string;
    if (quote !== null) {
      if (ch === quote) {
        quote = null;
      } else {
        current += ch;
      }
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      continue;
    }
    if (/\s/.test(ch)) {
      if (current.length > 0) {
        tokens.push(current);
        current = "";
      }
      continue;
    }
    if (ch === "<" || ch === ">" || ch === "(" || ch === ")") {
      if (current.length > 0) {
        tokens.push(current);
        current = "";
      }
      continue;
    }
    current += ch;
  }
  if (current.length > 0) {
    tokens.push(current);
  }
  return tokens;
}

/**
 * Extract `tee` (and `sudo tee`) target paths from a shell command string.
 * Option flags (`-a`, `--append`, `-i`, …) are skipped; `--` terminates
 * option parsing. Bare `-` (stdout marker) is not a file target.
 * (OH-6.4-contract-shell-bypass: `tee` needs the same treatment as `>`.)
 */
export function shellTeeTargets(command: string): string[] {
  if (typeof command !== "string" || command.length === 0) {
    return [];
  }
  const targets: string[] = [];
  for (const segment of splitTeeSegments(command)) {
    const tokens = tokenizeTeeSegment(segment);
    if (tokens.length === 0) {
      continue;
    }
    let teeIndex = -1;
    for (let i = 0; i < tokens.length; i++) {
      const base = (tokens[i] as string).split("/").pop() ?? "";
      if (base === "tee") {
        teeIndex = i;
        break;
      }
    }
    if (teeIndex < 0) {
      continue;
    }
    let endOfOptions = false;
    for (let i = teeIndex + 1; i < tokens.length; i++) {
      const token = tokens[i] as string;
      if (!endOfOptions && token === "--") {
        endOfOptions = true;
        continue;
      }
      if (!endOfOptions && token.startsWith("-") && token !== "-") {
        continue;
      }
      if (token === "-" || token.length === 0) {
        continue;
      }
      targets.push(token);
    }
  }
  return targets;
}

/**
 * Union of `shellRedirectTargets` and `shellTeeTargets` (deduplicated,
 * redirects first) — the named-file write surface of a shell command.
 */
export function shellNamedFileTargets(command: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const target of [...shellRedirectTargets(command), ...shellTeeTargets(command)]) {
    if (!seen.has(target)) {
      seen.add(target);
      out.push(target);
    }
  }
  return out;
}

/**
 * Union of `shellNamedFileTargets` and `shellArgvFileTargets` — every named
 * file a shell command can create, overwrite, or move (redirects, `tee`,
 * `cp`/`mv`/`ln`/`install` operands, `sed -i` files). The Rule-0 shell
 * target gate runs every entry through `shellTargetEscapesWorkspace`.
 */
export function shellAllFileTargets(command: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const target of [...shellNamedFileTargets(command), ...shellArgvFileTargets(command)]) {
    if (!seen.has(target)) {
      seen.add(target);
      out.push(target);
    }
  }
  return out;
}

function resolveGuardWorkspaceRoot(policy: GuardPolicyConfig): string {
  const raw = policy.workspaceRoot;
  if (typeof raw === "string" && raw.trim() !== "") {
    return resolve(raw);
  }
  return resolve(process.cwd());
}

function isPathWithinRoot(absTarget: string, absRoot: string): boolean {
  if (absTarget === absRoot) {
    return true;
  }
  const root = absRoot.endsWith(sep) ? absRoot : absRoot + sep;
  return absTarget.startsWith(root);
}

/**
 * OH-6.5-redirect-escape / OH-6.5-cp-mv-argv-targets: `true` when a shell
 * named-file target escapes the workspace root (absolute outside the root
 * and outside the OS temp dir, `..` traversal resolving outside, NUL bytes,
 * drive-letter paths, `~` home expansion, `$VAR`/`${VAR}`/`$(…)`/backtick
 * targets which the shell would expand outside the root). Relative targets
 * resolve under the workspace root. `fd`-redirect markers (`-`, `/dev/null`)
 * are not file targets and never escape. Fail-closed: anything unresolvable
 * escapes. Single-quoted literals containing `$`/backtick are over-blocked
 * (safe direction; quote info is lost upstream of this predicate).
 */
export function shellTargetEscapesWorkspace(target: string, workspaceRoot: string): boolean {
  if (typeof target !== "string") {
    return true;
  }
  const trimmed = target.trim();
  if (trimmed === "" || trimmed.includes(String.fromCharCode(0))) {
    return true;
  }
  if (trimmed === "-" || trimmed === "/dev/null") {
    return false;
  }
  // OH-6.5-env-var-target-escape: any `$` (env-var / `${…}` / `$(…)`) or
  // backtick (legacy command substitution) escapes fail-closed. Quote info
  // is already lost before this predicate (`shellRedirectTargets` captures
  // the inner group without quotes; `tokenizeTeeSegment` strips quotes), so
  // a single-quoted literal such as `'$HOME/x'` is indistinguishable from
  // an expandable target and is over-blocked — the safe direction.
  if (trimmed.includes("$") || trimmed.includes("`"))
    return true;
  if (/^[A-Za-z]:[\\/]/.test(trimmed)) {
    return true;
  }
  if (trimmed.startsWith("~")) {
    return true;
  }
  let abs: string;
  let absoluteTarget: boolean;
  try {
    absoluteTarget = isAbsolute(trimmed);
    abs = absoluteTarget ? resolve(trimmed) : resolve(workspaceRoot, trimmed);
  } catch {
    return true;
  }
  if (absoluteTarget) {
    // Legitimate builder scratch (`> /tmp/…/artifact.txt`): explicit
    // absolute paths inside the OS temp dir are allowed. Relative `..`
    // escapes that merely land in the temp dir are still escapes — only
    // absolute targets earn the temp-dir allowance.
    try {
      if (isPathWithinRoot(abs, resolve(tmpdir()))) {
        return false;
      }
    } catch {
      // Fall through to the workspace check when the temp dir is unreadable.
    }
  }
  return !isPathWithinRoot(abs, resolve(workspaceRoot));
}

function deny(reason: string, rule: string): GuardVerdict {
  return { allowed: false, reason, rule };
}

/**
 * Normalize a role name for comparison: Unicode NFKC, lowercase, trimmed.
 * Role matching is therefore case-insensitive (`Director` === `director`),
 * while tool-name matching stays exact (fail-closed: `Edit`/`SHELL` deny).
 */
export function normalizeRoleName(role: string): string {
  return (role ?? "").normalize("NFKC").toLowerCase().trim();
}

/**
 * Evaluate a tool/permission request against Rules 0–5 plus optional
 * per-role `taskOwnedPaths`. Unknown tool names are denied (fail-closed);
 * anything not denied by an explicit rule is allowed.
 */
export function evaluateBoardGuard(
  request: GuardRequest,
  config?: GuardPolicyConfig,
): GuardVerdict {
  const policy: GuardPolicyConfig = config ?? defaultGuardConfig();
  const role = normalizeRoleName(request.role ?? "");
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
    if (!WORKSPACE_WIDE_EDIT_TOOLS.has(tool)) {
      return deny(
        `guard: ${tool} without a target path is rejected for role ${JSON.stringify(role)} (fail-closed)`,
        "rule-0-path-safety",
      );
    }
  }

  if (isShellTool(tool)) {
    if (command.trim() === "") {
      return deny(
        `guard: empty shell command is rejected for role ${JSON.stringify(role)} (fail-closed)`,
        "rule-0-path-safety",
      );
    }
    // OH-6.5-redirect-escape / OH-6.5-cp-mv-argv-targets: every named file
    // a shell command can create, overwrite, or move (redirects, `tee`,
    // `cp`/`mv`/`ln`/`install` operands, `sed -i` files) must stay inside
    // the workspace root (or the OS temp-dir scratch space) for EVERY role
    // — before any other shell rule, fail-closed.
    const workspaceRoot = resolveGuardWorkspaceRoot(policy);
    for (const target of shellAllFileTargets(command)) {
      if (shellTargetEscapesWorkspace(target, workspaceRoot)) {
        return deny(
          `guard: shell target ${JSON.stringify(target)} escapes the workspace root ${JSON.stringify(workspaceRoot)} (fail-closed)`,
          "rule-0-shell-target-containment",
        );
      }
    }
    if (isDestructiveShellCommand(command)) {
      return deny(
        `guard: destructive shell command denied for role ${JSON.stringify(role)}: ${JSON.stringify(command)}`,
        "rule-1-destructive",
      );
    }
  }

  // Unknown roles fail closed to least privilege: reads and read-only shell
  // stay allowed, but every edit/write/patch and every file-mutating shell
  // command is denied. Roles named in `taskOwnedPaths` count as known.
  const isKnownRole =
    KNOWN_STANDARD_ROLES.has(role) || policy.taskOwnedPaths?.[role] !== undefined;
  if (!isKnownRole) {
    const mutates =
      isEditTool(tool) ||
      (isShellTool(tool) && classifyShellCommand(command).class !== "read-only");
    if (mutates) {
      return deny(
        `guard: unknown role ${JSON.stringify(request.role)} is held to least privilege; ${tool} denied (fail-closed)`,
        "rule-0-unknown-role",
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
        "rule-3a-qa-src-lock",
      );
    }
    if (!matchesAnyGlob(path, QA_WRITABLE_GLOBS)) {
      return deny(
        `guard: red-team role ${JSON.stringify(role)} may only modify test/spec/accept/docs paths: ${JSON.stringify(path)}`,
        "rule-3b-qa-allowlist",
      );
    }
  }

  // OH-6.3-qa-shell-bypass: the QA red-team `src/**` lock covers edit tools
  // only without this leg — any file-mutating shell (`rm src/…`, redirect,
  // `sed -i`, `git checkout -- src/…`) would be allowed. Deny every
  // non-read-only shell command for QA roles (fail-closed).
  if (QA_RED_TEAM_ROLES.has(role) && isShellTool(tool)) {
    if (classifyShellCommand(command).class !== "read-only") {
      return deny(
        `guard: red-team role ${JSON.stringify(role)} may not run file-mutating shell (fail-closed): ${JSON.stringify(command)}`,
        "rule-3-qa-source-lock",
      );
    }
  }

  // Workspace-wide mutations span `src/**`, which red-team roles may never
  // touch: deny them pathlessly (fail-closed).
  if (QA_RED_TEAM_ROLES.has(role) && WORKSPACE_WIDE_EDIT_TOOLS.has(tool)) {
    return deny(
      `guard: red-team role ${JSON.stringify(role)} may not run workspace-wide mutation ${tool} (fail-closed)`,
      "rule-3-qa-source-lock",
    );
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

  // OH-6.4-contract-shell-bypass: locked contract globs are enforceable only
  // via `path` without this leg — shell requests carry the target in
  // `command` (`echo … > contracts/…`, `… | tee …`) and are never inspected.
  // Enforce redirect/tee targets for non-architect roles (fail-closed).
  if (isShellTool(tool) && role !== "architect") {
    if (classifyShellCommand(command).class !== "read-only") {
      for (const target of shellNamedFileTargets(command)) {
        if (matchesAnyGlob(target, lockedGlobs)) {
          return deny(
            `guard: contract path ${JSON.stringify(target)} is locked to the architect role (fail-closed); ${JSON.stringify(role)} denied`,
            "rule-4-contract-lock",
          );
        }
      }
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

  // OH-6.4-task-owned-shell-bypass: `taskOwnedPaths` confinement is
  // edit-only without this leg — shell redirect/tee targets outside the
  // owned globs would be writable. Enforce shell targets the same way.
  if (owned !== undefined && isShellTool(tool)) {
    if (classifyShellCommand(command).class !== "read-only") {
      for (const target of shellNamedFileTargets(command)) {
        if (!matchesAnyGlob(target, owned)) {
          return deny(
            `guard: role ${JSON.stringify(role)} owns [${owned.join(", ")}]; shell target ${JSON.stringify(target)} is outside its task paths (fail-closed)`,
            "rule-5-task-owned-paths",
          );
        }
      }
    }
  }

  return { allowed: true, reason: "guard: allowed (no rule denied the request)" };
}
