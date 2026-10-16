/**
 * `src/guards/shell-parse.ts` — Salvaged AST/token shell command classifier
 * upgraded with quote-aware POSIX tokenization and recursive unwrapping of
 * subshells (`bash -c "..."`, `sh -c "..."`, `eval "..."`, `xargs`, `$(...)`).
 */

export type ShellCommandClass = "read-only" | "write" | "destructive";

export interface ParsedShellCommand {
  raw: string;
  class: ShellCommandClass;
  targets: string[];
}

export interface ParsedSegment {
  raw: string;
  tokens: string[];
  envVars: Record<string, string>;
  executable: string;
  args: string[];
}

const SHELL_OPERATORS = new Set(["&&", "||", ";", "|", "&"]);
const CHAIN_SEPARATOR = /&&|\|\||;;|[;\n]+|\|(?!\|)/;

export function splitShellPipeline(command: string): string[] {
  const segments: string[] = [];
  let current = "";
  let quote: "'" | '"' | "`" | null = null;
  let escaped = false;
  let parenDepth = 0;

  for (let i = 0; i < command.length; i++) {
    const ch = command[i];
    const next = command[i + 1];

    if (escaped) {
      current += ch;
      escaped = false;
      continue;
    }

    if (ch === "\\" && quote !== "'") {
      escaped = true;
      current += ch;
      continue;
    }

    if (quote) {
      if (ch === quote) {
        quote = null;
      }
      current += ch;
      continue;
    }

    if (ch === "'" || ch === '"' || ch === "`") {
      quote = ch;
      current += ch;
      continue;
    }

    if (ch === "(") {
      parenDepth += 1;
      current += ch;
      continue;
    }

    if (ch === ")" && parenDepth > 0) {
      parenDepth -= 1;
      current += ch;
      continue;
    }

    if (parenDepth === 0) {
      if ((ch === "&" && next === "&") || (ch === "|" && next === "|")) {
        if (current.trim()) segments.push(current.trim());
        current = "";
        i++;
        continue;
      }

      if (ch === ";" || ch === "|" || ch === "&" || ch === "\n") {
        if (current.trim()) segments.push(current.trim());
        current = "";
        continue;
      }
    }

    current += ch;
  }

  if (current.trim()) {
    segments.push(current.trim());
  }

  return segments;
}

export function tokenizeSegment(segment: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let quote: "'" | '"' | null = null;
  let escaped = false;

  for (let i = 0; i < segment.length; i++) {
    const ch = segment[i];

    if (escaped) {
      current += ch;
      escaped = false;
      continue;
    }

    if (ch === "\\" && quote !== "'") {
      escaped = true;
      continue;
    }

    if (quote) {
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

    current += ch;
  }

  if (current.length > 0) {
    tokens.push(current);
  }

  return tokens.filter((t) => !SHELL_OPERATORS.has(t));
}

const ENV_ASSIGNMENT_RE = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/;
const WRAPPER_BINARIES = new Set(["sudo", "env", "command", "nohup", "time", "nice"]);
const SHELL_INTERPRETERS = new Set(["sh", "bash", "zsh", "dash", "ksh"]);

function extractInlineSubstitutions(raw: string): string[] {
  const extracted: string[] = [];
  const dollarParenRe = /\$\(([^()]+)\)/g;
  let m: RegExpExecArray | null;
  while ((m = dollarParenRe.exec(raw)) !== null) {
    if (m[1]?.trim()) extracted.push(m[1].trim());
  }
  const backtickRe = /`([^`]+)`/g;
  while ((m = backtickRe.exec(raw)) !== null) {
    if (m[1]?.trim()) extracted.push(m[1].trim());
  }
  return extracted;
}

function parseSingleSegment(raw: string): ParsedSegment | null {
  const trimmed = raw.trim().replace(/^\(+|\)+$/g, "").trim();
  if (!trimmed) return null;
  const tokens = tokenizeSegment(trimmed);
  if (tokens.length === 0) return null;

  const envVars: Record<string, string> = {};
  let idx = 0;

  while (idx < tokens.length) {
    const token = tokens[idx];
    const envMatch = ENV_ASSIGNMENT_RE.exec(token);
    if (envMatch) {
      envVars[envMatch[1]] = envMatch[2];
      idx++;
      continue;
    }

    if (WRAPPER_BINARIES.has(token)) {
      idx++;
      while (idx < tokens.length && tokens[idx].startsWith("-")) {
        idx++;
      }
      continue;
    }

    break;
  }

  const executable = tokens[idx] ?? "";
  const args = tokens.slice(idx + 1);

  return {
    raw: trimmed,
    tokens,
    envVars,
    executable,
    args,
  };
}

export function parseCommandSegments(command: string, depth: number = 0): ParsedSegment[] {
  if (depth > 4 || !command.trim()) return [];
  const rawSegments = splitShellPipeline(command);
  const parsed: ParsedSegment[] = [];

  for (const raw of rawSegments) {
    const seg = parseSingleSegment(raw);
    if (!seg) continue;
    parsed.push(seg);

    const baseExe = seg.executable.split("/").pop() ?? seg.executable;

    if (SHELL_INTERPRETERS.has(baseExe)) {
      const cIdx = seg.args.findIndex((a) => a === "-c" || a === "-lc" || a === "-ec");
      if (cIdx >= 0 && seg.args[cIdx + 1]) {
        parsed.push(...parseCommandSegments(seg.args[cIdx + 1], depth + 1));
      }
    } else if (baseExe === "eval" && seg.args.length > 0) {
      parsed.push(...parseCommandSegments(seg.args.join(" "), depth + 1));
    } else if (baseExe === "xargs" && seg.args.length > 0) {
      const targetArgs = seg.args.filter((a) => !a.startsWith("-"));
      if (targetArgs.length > 0) {
        parsed.push(...parseCommandSegments(targetArgs.join(" "), depth + 1));
      }
    }

    for (const sub of extractInlineSubstitutions(raw)) {
      parsed.push(...parseCommandSegments(sub, depth + 1));
    }
  }

  return parsed;
}

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
 * pipes, newlines) and recursively unwrapped subshells (`bash -c`, `eval`, `$(...)`)
 * resolve to the most severe class of any segment:
 * `destructive` beats `write` beats `read-only`.
 */
export function classifyShellCommand(command: string): ParsedShellCommand {
  const raw = typeof command === "string" ? command : "";
  const segments = splitChain(raw);
  const unwrapped = parseCommandSegments(raw).map((s) => `${s.executable} ${s.args.join(" ")}`.trim());
  const allCandidates = [...segments, ...unwrapped];
  const targets: string[] = [];
  let sawWrite = false;
  for (const segment of allCandidates) {
    if (segmentIsDestructive(segment)) {
      targets.push(stripSudoPrefix(segment));
      return { raw, class: "destructive", targets };
    }
  }
  for (const segment of segments) {
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
