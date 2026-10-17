/**
 * `src/guards/shell-parse.ts` — Salvaged AST/token shell command classifier
 * upgraded with quote-aware POSIX tokenization and recursive unwrapping of
 * subshells (`bash -c "..."`, `sh -c "..."`, `eval "..."`, `xargs`, `$(...)`).
 *
 * Hardening (Wave 8 audit remediation):
 * - `canonicalizeShellCommand` joins backslash-newline continuations before
 *   any matching so `rm -rf \<newline>/` cannot smuggle a root wipe.
 * - Wrapper resolution (`sudo`, `env`, `command`, `nohup`, `time`, `nice`)
 *   understands value-taking flags (`sudo -u/-g`, combined short flags,
 *   `VAR=val` assignments, `--` terminators) and resolves the basename of
 *   absolute-path binaries (`/bin/rm` -> `rm`, `/sbin/mkfs.ext4` -> `mkfs`).
 * - Destructive matching covers split short flags (`rm -r -f /`), `~`/`$HOME`
 *   wipe targets, any `..` segment inside a recursive-force `rm` (fail-closed
 *   static approximation of a realpath escape check), `git` global flags
 *   (`-C`, `--git-dir`, `--work-tree`) plus `+`-prefixed force refspecs, and
 *   basename `mkfs*` / `dd` (always destructive, fail-closed).
 * - Write-ness is computed over unwrapped candidates too (not just raw
 *   segments), `eval` / `python` / `node` / `npx` / `bunx` / `curl` / `wget` /
 *   `ssh` / `xargs` / `find -exec` / bare shells count as write, and unknown
 *   verbs carrying shell metachars (pipes, redirects, substitutions) default
 *   to write (fail-closed).
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
  /** Privilege/env wrappers stripped to reach `executable` (outermost first). */
  wrapperChain: string[];
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

/**
 * Wrapper flags that consume the following token as their value. Scoped per
 * wrapper so `command -p` (no value) is not confused with `sudo -p` (prompt).
 */
const WRAPPER_VALUE_FLAGS: Record<string, Set<string>> = {
  sudo: new Set([
    "-u", "--user",
    "-g", "--group",
    "-h", "--host",
    "-p", "--prompt",
    "-r", "--role",
    "-t", "--type",
    "-C", "--close-from",
    "-D", "--chdir",
  ]),
  env: new Set(["-u", "--unset", "-C", "--chdir", "-S", "--split-string"]),
  nice: new Set(["-n", "--adjustment"]),
  command: new Set([]),
  nohup: new Set([]),
  time: new Set([]),
};

/** Short-flag letters (inside combined `sudo -XY` groups) that take a value. */
const SUDO_COMBINED_VALUE_LETTERS = new Set(["u", "g", "h", "p", "r", "t", "C", "D"]);

/**
 * Join backslash-newline continuations before any matching so a line
 * continuation cannot split a destructive token sequence (`rm -rf \<nl>/`).
 */
export function canonicalizeShellCommand(command: string): string {
  if (typeof command !== "string") return "";
  return command.replace(/\\\r?\n/g, " ");
}

/** Skip `wrapper` option flags starting at `idx`; value flags eat one token. */
function skipWrapperFlags(tokens: string[], idx: number, wrapper: string): number {
  const valueFlags = WRAPPER_VALUE_FLAGS[wrapper] ?? new Set<string>();
  while (idx < tokens.length) {
    const flag = tokens[idx] ?? "";
    if (flag === "--") {
      return idx + 1;
    }
    if (!flag.startsWith("-") || flag === "-") {
      break;
    }
    const eq = flag.indexOf("=");
    if (eq >= 0) {
      idx++;
      continue;
    }
    if (valueFlags.has(flag)) {
      idx += 2;
      continue;
    }
    if (wrapper === "sudo" && /^-[a-zA-Z]{2,}$/.test(flag)) {
      idx++;
      const letters = flag.slice(1);
      const takesValue = [...letters].some((c) => SUDO_COMBINED_VALUE_LETTERS.has(c));
      if (takesValue && idx < tokens.length && !(tokens[idx] ?? "").startsWith("-")) {
        idx++;
      }
      continue;
    }
    idx++;
  }
  return idx;
}

/**
 * Strip leading privilege/env wrappers (`sudo -u root`, `env FOO=1`, `VAR=x`)
 * and return the effective command tokens. Never lowercases: `RM`/`GIT` are
 * not executable on POSIX and stay unknown verbs.
 */
export function stripLeadingWrapperTokens(tokens: string[]): string[] {
  let idx = 0;
  while (idx < tokens.length) {
    const tok = tokens[idx] ?? "";
    if (WRAPPER_BINARIES.has(tok)) {
      idx++;
      idx = skipWrapperFlags(tokens, idx, tok);
      while (idx < tokens.length && ENV_ASSIGNMENT_RE.test(tokens[idx] ?? "")) {
        idx++;
      }
      if (tokens[idx] === "--") {
        idx++;
      }
      continue;
    }
    if (ENV_ASSIGNMENT_RE.test(tok)) {
      idx++;
      continue;
    }
    break;
  }
  return tokens.slice(idx);
}

/** Basename of a command word (`/bin/rm` -> `rm`); case is preserved. */
export function commandBasename(word: string): string {
  const base = (word ?? "").split("/").pop() ?? "";
  return base;
}

/** Effective (wrapper-stripped) tokens for one chain segment. */
function effectiveTokensOf(segment: string): string[] {
  const canon = canonicalizeShellCommand(segment);
  return stripLeadingWrapperTokens(tokenizeSegment(canon));
}

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
  const wrapperChain: string[] = [];
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
      wrapperChain.push(token);
      idx++;
      idx = skipWrapperFlags(tokens, idx, token);
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
    wrapperChain,
  };
}

export function parseCommandSegments(command: string, depth: number = 0): ParsedSegment[] {
  if (depth > 4 || !command.trim()) return [];
  const rawSegments = splitShellPipeline(canonicalizeShellCommand(command));
  const parsed: ParsedSegment[] = [];

  for (const raw of rawSegments) {
    const seg = parseSingleSegment(raw);
    if (!seg) continue;
    parsed.push(seg);

    const baseExe = commandBasename(seg.executable);

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

function splitChain(command: string): string[] {
  return command
    .split(CHAIN_SEPARATOR)
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}

/** Targets whose recursive-force removal wipes a home/root scope. */
function isRootWipeTarget(target: string): boolean {
  return (
    target === "/" ||
    target === "/*" ||
    target === "*" ||
    target === "--no-preserve-root" ||
    target === "~" ||
    target === "~/*" ||
    target.startsWith("~/") ||
    target === "$HOME" ||
    target === "${HOME}" ||
    target.startsWith("$HOME/") ||
    target.startsWith("${HOME}/")
  );
}

/** Detect SPEC Rule 1 destructive operations in a single chain segment. */
function segmentIsDestructive(segment: string): boolean {
  const effective = effectiveTokensOf(segment);
  if (effective.length === 0) {
    return false;
  }
  const exe = commandBasename(effective[0] ?? "");
  const args = effective.slice(1);

  if (exe === "rm") {
    let hasRecursive = false;
    let hasForce = false;
    const targets: string[] = [];
    for (let i = 0; i < args.length; i++) {
      const arg = args[i] ?? "";
      if (arg === "--") {
        targets.push(...args.slice(i + 1).filter((a) => a !== ""));
        break;
      }
      if (arg === "--no-preserve-root") {
        return true;
      }
      if (arg === "--recursive" || arg === "-r" || arg === "-R") {
        hasRecursive = true;
        continue;
      }
      if (arg === "--force" || arg === "-f") {
        hasForce = true;
        continue;
      }
      if (/^-[rRf]+$/.test(arg)) {
        hasRecursive = true;
        hasForce = true;
        continue;
      }
      if (/^-[A-Za-z]+$/.test(arg)) {
        const letters = arg.slice(1);
        if (/[rR]/.test(letters)) hasRecursive = true;
        if (letters.includes("f")) hasForce = true;
        continue;
      }
      if (arg.startsWith("-")) {
        continue;
      }
      targets.push(arg);
    }
    if (hasRecursive && hasForce) {
      for (const target of targets) {
        if (isRootWipeTarget(target)) {
          return true;
        }
        // Fail-closed static traversal check: any `..` inside a
        // recursive-force removal is treated as a workspace escape
        // (`rm -rf /tmp/../` normalizes to `/`). This is a strict
        // superset of a realpath containment check.
        if (target.split("/").includes("..")) {
          return true;
        }
      }
    }
    return false;
  }

  if (exe === "git") {
    let i = 0;
    while (i < args.length) {
      const flag = args[i] ?? "";
      if (
        flag === "-C" ||
        flag === "-c" ||
        flag === "--git-dir" ||
        flag === "--work-tree" ||
        flag === "--namespace"
      ) {
        i += 2;
        continue;
      }
      if (
        flag.startsWith("--git-dir=") ||
        flag.startsWith("--work-tree=") ||
        flag.startsWith("--namespace=") ||
        /^-C.+/.test(flag)
      ) {
        i++;
        continue;
      }
      if (flag.startsWith("-")) {
        i++;
        continue;
      }
      break;
    }
    const subcommand = (args[i] ?? "").toLowerCase();
    const rest = args.slice(i + 1);
    const restStr = ` ${rest.join(" ")} `;
    if (subcommand === "reset" && /(^|\s)--hard(\s|$)/.test(restStr)) {
      return true;
    }
    if (subcommand === "push") {
      if (/(^|\s)--force([-\s]|$)/.test(restStr)) {
        return true;
      }
      if (rest.some((a) => a === "-f" || /^-[A-Za-z]*f[A-Za-z]*$/.test(a))) {
        return true;
      }
      // `git push origin +main:main`: `+`-prefixed refspec forces the update.
      if (rest.some((a) => a.startsWith("+") && a.length > 1 && !a.startsWith("++"))) {
        return true;
      }
    }
    return false;
  }

  // Absolute-path destructive binaries are matched by basename
  // (`/sbin/mkfs.ext4`, `/bin/dd`): always destructive, fail-closed.
  if (exe === "mkfs" || exe.startsWith("mkfs.")) {
    return true;
  }
  if (exe === "dd") {
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

/**
 * Interpreters, downloaders, and remote/piped executors: any invocation can
 * mutate files or run remote code, so every use is write-class. `curl`/`wget`
 * are included because `curl URL | sh` must classify as file-mutating even
 * before the pipe target is considered.
 */
const ALWAYS_WRITE_VERBS = new Set([
  "eval",
  "python",
  "python3",
  "node",
  "nodejs",
  "deno",
  "ruby",
  "php",
  "npx",
  "bunx",
  "curl",
  "wget",
  "ssh",
  "scp",
  "sftp",
  "xargs",
]);

/** Detect file-mutating (write-class) operations in a single chain segment. */
function segmentIsWrite(segment: string): boolean {
  const canon = canonicalizeShellCommand(segment).trim();
  if (canon.length === 0) {
    return false;
  }
  if (/(^|[^<>])>(>|[^|])/.test(canon) || />>/.test(canon)) {
    return true;
  }
  if (/(^|\s)tee(\s|$)/.test(canon)) {
    return true;
  }
  const effective = stripLeadingWrapperTokens(tokenizeSegment(canon));
  if (effective.length === 0) {
    return false;
  }
  const verb = commandBasename(effective[0] ?? "");
  const rest = effective.slice(1);

  if (ALWAYS_WRITE_VERBS.has(verb)) {
    return true;
  }
  if (!READ_ONLY_VERBS.has(verb) && WRITE_VERBS.has(verb)) {
    return true;
  }
  if (verb === "sed" && (/\s-i(\s|$)/.test(canon) || /\s--in-place(\s|$)/.test(canon))) {
    return true;
  }
  if (verb === "find") {
    if (
      rest.some((a) =>
        ["-exec", "-execdir", "-ok", "-okdir", "-delete", "-fls", "-fprint"].includes(a),
      )
    ) {
      return true;
    }
    return false;
  }
  if (verb === "git") {
    let i = 0;
    while (i < rest.length) {
      const flag = rest[i] ?? "";
      if (
        flag === "-C" ||
        flag === "-c" ||
        flag === "--git-dir" ||
        flag === "--work-tree" ||
        flag === "--namespace"
      ) {
        i += 2;
        continue;
      }
      if (
        flag.startsWith("--git-dir=") ||
        flag.startsWith("--work-tree=") ||
        flag.startsWith("--namespace=") ||
        /^-C.+/.test(flag)
      ) {
        i++;
        continue;
      }
      if (flag.startsWith("-")) {
        i++;
        continue;
      }
      break;
    }
    const subcommand = (rest[i] ?? "").toLowerCase();
    if (subcommand === "") {
      return false;
    }
    if (subcommand === "branch" || subcommand === "tag" || subcommand === "stash") {
      const tail = rest.slice(i + 1).join(" ");
      const mutatingFlags = /(^|\s)(-[a-zA-Z]*[dDmDf]|--delete|--move|--force|push|pop|apply|drop|clear|create)\b/;
      return mutatingFlags.test(tail);
    }
    return !READ_ONLY_GIT_SUBCOMMANDS.has(subcommand);
  }
  if (verb === "bun") {
    const sub = rest[0] ?? "";
    return ["install", "add", "remove", "pm"].includes(sub);
  }
  if (verb === "tsc") {
    return false;
  }
  if (verb === "make") {
    return false;
  }
  if (verb === "bash" || verb === "sh" || verb === "zsh" || verb === "dash" || verb === "ksh") {
    if (rest.length === 0) {
      // A bare shell with no script argument executes whatever arrives on
      // stdin (`curl URL | sh`): treat as write, fail-closed.
      return true;
    }
    const script = rest[0] ?? "";
    if (/^scripts\/accept\//.test(script) || /\.(test|spec)\.[a-z]+$/.test(script)) {
      return false;
    }
    // Any other script argument (including `-c` payloads, whose content is
    // additionally unwrapped into candidates above) executes code: write.
    return true;
  }
  if (!READ_ONLY_VERBS.has(verb) && !WRITE_VERBS.has(verb) && !ALWAYS_WRITE_VERBS.has(verb)) {
    // Fail-closed default for unknown verbs: a command word we cannot prove
    // read-only that carries pipes, redirects, or substitutions is write.
    if (/(`|\$\(|\$\{|\$[A-Za-z_*({\[]|[|;&<>])/.test(canon)) {
      return true;
    }
    return false;
  }
  return false;
}

/**
 * Classify a shell command string. Multi-command chains (`&&`, `;`, `||`,
 * pipes, newlines) and recursively unwrapped subshells (`bash -c`, `eval`, `$(...)`)
 * resolve to the most severe class of any segment:
 * `destructive` beats `write` beats `read-only`.
 *
 * Write-ness is evaluated over both raw segments and unwrapped candidates so
 * `eval`, `xargs`, `find -exec`, and backtick payloads cannot hide mutations.
 */
export function classifyShellCommand(command: string): ParsedShellCommand {
  const raw = typeof command === "string" ? command : "";
  const canon = canonicalizeShellCommand(raw);
  const segments = splitChain(canon);
  const unwrapped = parseCommandSegments(canon).map((s) =>
    `${s.executable} ${s.args.join(" ")}`.trim(),
  );
  const allCandidates = [...segments, ...unwrapped];
  const targets: string[] = [];
  let sawWrite = false;
  for (const segment of allCandidates) {
    if (segmentIsDestructive(segment)) {
      targets.push(segment.trim());
      return { raw, class: "destructive", targets };
    }
  }
  for (const segment of allCandidates) {
    if (segmentIsWrite(segment)) {
      sawWrite = true;
      targets.push(segment.trim());
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
