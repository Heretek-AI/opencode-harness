/**
 * `src/guards/shell-parse.ts` — Salvaged AST/token shell command classifier.
 *
 * Wave 1 module per `docs/prompts/SPEC.md` Section 2.3 C. Decoupled from
 * `OrgBoard`: a pure, dependency-free classifier that labels shell commands
 * as `read-only`, `write` (file-mutating), or `destructive`.
 *
 * - Destructive covers SPEC Rule 1: `rm -rf /`, `rm -rf *`,
 *   `git reset --hard`, `git push --force`, `mkfs`, `dd if=`
 *   (plus flag-order/`sudo` variants of the same operations).
 * - Write covers file-mutating shell: redirections, mutating file verbs,
 *   mutating `git` subcommands, and package installs.
 * - Everything else (listing, inspection, verification commands such as
 *   `bun test`, `make check`, `git status`) is read-only.
 */

export type ShellCommandClass = "read-only" | "write" | "destructive";

export interface ParsedShellCommand {
  raw: string;
  class: ShellCommandClass;
  targets: string[];
}

const CHAIN_SEPARATOR = /&&|\|\||;;|[;\n]+|\|(?!\|)/;

function stripSudoPrefix(segment: string): string {
  let rest = segment.trim();
  while (/^sudo(\s+(-[^\s]+\s+)*)/.test(rest)) {
    rest = rest.replace(/^sudo(\s+(-[^\s]+\s+)*)/, "").trim();
  }
  return rest;
}

function splitChain(command: string): string[] {
  return command
    .split(CHAIN_SEPARATOR)
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}

function firstTokens(segment: string, count: number): string[] {
  return segment.split(/\s+/).slice(0, count);
}

/** Detect SPEC Rule 1 destructive operations in a single chain segment. */
function segmentIsDestructive(segment: string): boolean {
  const clean = stripSudoPrefix(segment);
  if (clean.length === 0) {
    return false;
  }

  const rmMatch = /^rm\s+(.+)$/.exec(clean);
  if (rmMatch) {
    const args = rmMatch[1].split(/\s+/);
    const flags = args.filter((arg) => arg.startsWith("-") && arg.length > 1);
    const hasRecursiveForce = flags.some((flag) => {
      const letters = flag.replace(/^-+/, "");
      return letters.includes("r") && letters.includes("f");
    });
    const targets = args.filter((arg) => !arg.startsWith("-"));
    const hitsRoot = targets.some(
      (target) =>
        target === "/" ||
        target === "/*" ||
        target === "*" ||
        target === "--no-preserve-root" ||
        target === "~" ||
        target === "~/*" ||
        target === "$HOME" ||
        target === "${HOME}",
    );
    if ((hasRecursiveForce && hitsRoot) || clean.includes("--no-preserve-root")) {
      return true;
    }
  }

  if (/\bgit\s+reset\s+--hard\b/.test(clean)) {
    return true;
  }
  if (/\bgit\s+push\s+(--[a-z-]*force|-f)\b/.test(clean)) {
    return true;
  }
  if (/(^|\s)(mkfs)(\s|$|\.)/.test(clean) || /(^|\s)mkfs\.[a-z0-9]+/.test(clean)) {
    return true;
  }
  if (/(^|\s)dd(\s|$)/.test(clean) && (/\bif=/.test(clean) || /\bof=/.test(clean))) {
    return true;
  }
  return false;
}

const READ_ONLY_GIT_SUBCOMMANDS = new Set([
  "status",
  "log",
  "diff",
  "show",
  "rev-parse",
  "ls-files",
  "ls-remote",
  "branch",
  "tag",
  "describe",
  "shortlog",
  "blame",
  "grep",
  "stash",
  "help",
  "version",
]);

const READ_ONLY_VERBS = new Set([
  "ls",
  "cat",
  "less",
  "more",
  "head",
  "tail",
  "grep",
  "rg",
  "fd",
  "find",
  "pwd",
  "echo",
  "printf",
  "whoami",
  "date",
  "uname",
  "which",
  "file",
  "wc",
  "diff",
  "git",
  "bun",
  "node",
  "tsc",
  "make",
  "bash",
  "sh",
]);

const WRITE_VERBS = new Set([
  "rm",
  "rmdir",
  "mkdir",
  "touch",
  "mv",
  "cp",
  "ln",
  "unlink",
  "chmod",
  "chown",
  "chgrp",
  "truncate",
  "shred",
  "tee",
  "install",
  "sed",
  "awk",
  "perl",
  "dd",
  "mkfs",
  "npm",
  "pip",
  "cargo",
  "go",
  "docker",
]);

/** Detect file-mutating (write-class) operations in a single chain segment. */
function segmentIsWrite(segment: string): boolean {
  const clean = stripSudoPrefix(segment);
  if (clean.length === 0) {
    return false;
  }
  if (/(^|[^<>])>(>|[^|])/.test(clean) || />>/.test(clean)) {
    return true;
  }
  if (/(^|\s)tee(\s|$)/.test(clean)) {
    return true;
  }
  const tokens = firstTokens(clean, 3);
  const verb = tokens[0] ?? "";
  if (!READ_ONLY_VERBS.has(verb) && WRITE_VERBS.has(verb)) {
    return true;
  }
  if (verb === "sed" && (/\s-i(\s|$)/.test(clean) || /\s--in-place(\s|$)/.test(clean))) {
    return true;
  }
  if (verb === "git") {
    const subcommand = (tokens[1] ?? "").toLowerCase();
    if (subcommand === "") {
      return false;
    }
    if (subcommand === "branch" || subcommand === "tag" || subcommand === "stash") {
      const rest = clean.split(/\s+/).slice(2).join(" ");
      const mutatingFlags = /(^|\s)(-[a-zA-Z]*[dDmDf]|--delete|--move|--force|push|pop|apply|drop|clear|create)\b/;
      return mutatingFlags.test(rest);
    }
    return !READ_ONLY_GIT_SUBCOMMANDS.has(subcommand);
  }
  if (verb === "bun") {
    const sub = tokens[1] ?? "";
    return ["install", "add", "remove", "pm"].includes(sub);
  }
  if (verb === "node" || verb === "tsc") {
    return false;
  }
  if (verb === "make") {
    return false;
  }
  if (verb === "bash" || verb === "sh") {
    const script = tokens[1] ?? "";
    if (/^scripts\/accept\//.test(script) || /\.(test|spec)\.[a-z]+$/.test(script)) {
      return false;
    }
    return script !== "";
  }
  if (!READ_ONLY_VERBS.has(verb) && !WRITE_VERBS.has(verb)) {
    return false;
  }
  return false;
}

/**
 * Classify a shell command string. Multi-command chains (`&&`, `;`, `||`,
 * pipes, newlines) resolve to the most severe class of any segment:
 * `destructive` beats `write` beats `read-only`. Empty input is read-only
 * (a no-op). Targets lists the leading tokens of mutating segments for
 * audit logging.
 */
export function classifyShellCommand(command: string): ParsedShellCommand {
  const raw = typeof command === "string" ? command : "";
  const segments = splitChain(raw);
  const targets: string[] = [];
  let sawWrite = false;
  for (const segment of segments) {
    if (segmentIsDestructive(segment)) {
      targets.push(stripSudoPrefix(segment));
      return { raw, class: "destructive", targets };
    }
    if (segmentIsWrite(segment)) {
      sawWrite = true;
      targets.push(stripSudoPrefix(segment));
    }
  }
  return { raw, class: sawWrite ? "write" : "read-only", targets };
}

/** SPEC Rule 1 predicate: denied across ALL roles. */
export function isDestructiveShellCommand(command: string): boolean {
  return classifyShellCommand(command).class === "destructive";
}

/** Write-class or destructive: any command that can mutate files. */
export function isFileMutatingShellCommand(command: string): boolean {
  return classifyShellCommand(command).class !== "read-only";
}
