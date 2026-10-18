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
 *
 * Hardening (audit-20261018 remediation, OH-6.5-wrapper-laundering (P0)):
 * - The wrapper set is extended to every realistic prefix launcher
 *   (`exec`, `setsid`, `timeout`, `stdbuf`, `ionice`, `taskset`, `chroot`,
 *   `unshare`, `nsenter`, `runuser`, `su`, `doas`, `sg`, `busybox`) so a
 *   one-word prefix can no longer launder `rm -rf /` to `read-only`.
 * - Each wrapper understands its own option grammar: value-taking flags
 *   (`nsenter -t`, `runuser -u`, `ionice -c`, `stdbuf -o`, …), `timeout`'s
 *   duration positional (`timeout 5 …`), `taskset`'s mask and `chroot`'s
 *   newroot positionals, and `su`/`runuser`/`sg -c` inline payloads whose
 *   snippet is re-injected into the token stream (so `su -c 'rm -rf /'`
 *   classifies by its payload, and `su root -c '…'` skips the username).
 * - Stripping loops until the next token is no longer a wrapper/dispatcher,
 *   so stacked prefixes (`sudo timeout 5 …`, `VAR1=x exec …`) resolve to the
 *   real executable. A wrapper chain that ends with no executable resolves
 *   to `UNRESOLVED_NESTING_SENTINEL` (destructive, fail-closed) rather than
 *   an empty token list that reads as `read-only`.
 * - `segmentIsDestructive` additionally scans the whole post-wrapper token
 *   stream: any `rm` + recursive/force flags + root-wipe target ANYWHERE in
 *   the stream is destructive regardless of position 0, backstopping exotic
 *   flag spellings the per-wrapper grammar does not model.
 * - Unknown verbs default to `write`, never `read-only` (fail-closed); only
 *   `command -v`/`-V` display queries stay `read-only` (they print a path
 *   and execute nothing).
 *
 * Hardening (audit-20261018 remediation, OH-6.5-sudo-attached-value (P0)):
 * - Combined short-flag clusters follow getopt: the FIRST value-taking
 *   letter takes the remainder of the cluster as its attached value
 *   (`-uroot` → `-u` = `root`), and only a value letter that is LAST with
 *   nothing attached consumes the following token (`-nu root` eats `root`,
 *   `-nuroot` does not eat anything). `-uroot` therefore no longer eats the
 *   payload (`rm`) as the flag value.
 *
 * Hardening (audit-20261018 remediation, OH-6.5-cp-mv-argv-targets (P2)):
 * - `shellArgvFileTargets` exposes the named-file write surface of
 *   `cp`/`mv`/`ln`/`install` operands (plus `-t`/`--target-directory`) and
 *   `sed -i` files so the Rule-0 shell-target gate in `permission-guard.ts`
 *   can confine them to the workspace root. Mode/owner-style values
 *   (`-m`/`--mode`, `-o`/`--owner`, `-g`/`--group`, `--suffix`, …) are
 *   consumed as option values but never reported as file targets.
 */

import { posix } from "node:path";

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

/**
 * Command-prefix wrappers/dispatchers stripped to reach the effective
 * executable (OH-6.5-wrapper-laundering). The original six (`sudo`, `env`,
 * `command`, `nohup`, `time`, `nice`) are joined by every realistic launcher
 * a model can emit in front of a payload: POSIX `exec`, session/detach
 * tools (`setsid`, `nohup`), duration/CPU/IO shapers (`timeout`, `stdbuf`,
 * `ionice`, `taskset`, `nice`, `time`), container/namespace enters
 * (`chroot`, `unshare`, `nsenter`, `busybox`), and privilege switches
 * (`runuser`, `su`, `doas`, `sg`).
 */
const WRAPPER_BINARIES = new Set([
  "sudo",
  "env",
  "command",
  "nohup",
  "time",
  "nice",
  "exec",
  "setsid",
  "timeout",
  "stdbuf",
  "ionice",
  "taskset",
  "chroot",
  "unshare",
  "nsenter",
  "runuser",
  "su",
  "doas",
  "sg",
  "busybox",
]);
const SHELL_INTERPRETERS = new Set(["sh", "bash", "zsh", "dash", "ksh"]);

/**
 * Wrapper flags that consume the following token as their value. Scoped per
 * wrapper so `command -p` (no value) is not confused with `sudo -p` (prompt).
 * Only flags the implementation is SURE take a separate value are listed
 * here: over-marking a boolean flag would eat the payload as the flag value
 * (the laundering direction), while under-marking merely leaves residue the
 * anywhere-stream `rm`+wipe scan backstops (the fail-closed direction).
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
  exec: new Set(["-a"]),
  setsid: new Set([]),
  timeout: new Set(["-s", "--signal", "-k", "--kill-after"]),
  stdbuf: new Set(["-i", "--input", "-o", "--output", "-e", "--error"]),
  ionice: new Set(["-c", "--class", "-n", "--classdata", "-p", "--pid"]),
  taskset: new Set([]),
  chroot: new Set(["--userspec", "--groups"]),
  unshare: new Set([
    "-S", "--setuid",
    "-G", "--setgid",
    "--root", "--wd", "--propagation",
    "--map-user", "--map-users", "--map-group", "--map-groups",
  ]),
  nsenter: new Set([
    "-t", "--target",
    "-r", "--root",
    "-w", "--wd",
    "-S", "--setuid",
    "-G", "--setgid",
  ]),
  runuser: new Set([
    "-u", "--user",
    "-g", "--group",
    "-G", "--supp-groups",
    "-s", "--shell",
  ]),
  su: new Set(["-s", "--shell"]),
  doas: new Set(["-u", "-C"]),
  sg: new Set([]),
  busybox: new Set([]),
};

/** Short-flag letters (inside combined short-flag groups) that take a value. */
const SUDO_COMBINED_VALUE_LETTERS = new Set(["u", "g", "h", "p", "r", "t", "C", "D"]);

/**
 * Per-wrapper combined-cluster value letters. `sudo` needs getopt-correct
 * FIRST-value-letter-wins parsing (OH-6.5-sudo-attached-value); `nice`,
 * `stdbuf`, and `ionice` accept the same attached spellings (`-n5`, `-o0`,
 * `-c2`), so they share the helper.
 */
const WRAPPER_COMBINED_VALUE_LETTERS: Record<string, Set<string>> = {
  sudo: SUDO_COMBINED_VALUE_LETTERS,
  nice: new Set(["n"]),
  stdbuf: new Set(["i", "o", "e"]),
  ionice: new Set(["c", "n", "p"]),
};

/**
 * GNU `timeout` durations: a number with an optional fraction and an
 * optional single-letter suffix (`5`, `1.5m`, `10s`, `2h`). Positionals that
 * do not match are NOT skipped (they resolve as the command: `write` or the
 * destructive sentinel — never silently dropped).
 */
const TIMEOUT_DURATION_RE = /^\d+(\.\d+)?[smhd]?$/i;

/**
 * Wrappers whose grammar requires one positional operand before the command:
 * `timeout`'s duration (regex-gated), `taskset`'s CPU mask, `chroot`'s
 * newroot directory.
 */
const WRAPPER_POSITIONAL_KIND: Record<string, "duration" | "single" | undefined> = {
  timeout: "duration",
  taskset: "single",
  chroot: "single",
};

/**
 * Wrappers whose `-c`/`--command` value is an inline shell payload
 * re-injected into the token stream (`su -c 'rm -rf /'` classifies by its
 * payload). `runuser --session-command` is the same shape.
 */
const WRAPPER_PAYLOAD_FLAGS: Record<string, Set<string>> = {
  su: new Set(["-c", "--command"]),
  runuser: new Set(["-c", "--command", "--session-command"]),
  sg: new Set(["-c", "--command"]),
};

/**
 * Join backslash-newline continuations before any matching so a line
 * continuation cannot split a destructive token sequence (`rm -rf \<nl>/`).
 */
export function canonicalizeShellCommand(command: string): string {
  if (typeof command !== "string") return "";
  return command.replace(/\\\r?\n/g, " ");
}

/**
 * Whether the raw token stream after `wrapper` contains an exact-form inline
 * payload flag (`-c`, `--command`, `--command=…`, a `-*c` cluster, or an
 * attached `-c…` form). `su`/`sg` only skip their username/group positional
 * when a payload flag is present: `su root -c '…'` skips `root`, while
 * `su rm -rf /` (no `-c`) resolves to the payload itself — destructive,
 * fail-closed (real `su` would just fail with "user rm does not exist").
 */
function hasInlinePayloadFlag(work: string[], from: number): boolean {
  for (let k = from; k < work.length; k++) {
    const t = work[k] ?? "";
    if (t === "-c") return true;
    if (t === "--command") return true;
    if (t.startsWith("--command=")) return true;
    if (/^-[A-Za-z]*c$/.test(t)) return true;
    if (/^-c.+/.test(t)) return true;
  }
  return false;
}

/**
 * Consume one wrapper occurrence at `work[idx]` plus its option grammar.
 * Returns the remaining token stream (payload snippets already spliced in),
 * or `null` when nothing remains (the caller maps that to the destructive
 * sentinel — a bare wrapper with no executable never reads as `read-only`).
 */
function consumeWrapper(work: string[], idx: number, wrapper: string): string[] | null {
  const valueFlags = WRAPPER_VALUE_FLAGS[wrapper] ?? new Set<string>();
  const combinedLetters = WRAPPER_COMBINED_VALUE_LETTERS[wrapper];
  const payloadFlags = WRAPPER_PAYLOAD_FLAGS[wrapper];
  const positionalKind = WRAPPER_POSITIONAL_KIND[wrapper] ?? undefined;
  const skipUsername =
    (wrapper === "su" || wrapper === "sg") && hasInlinePayloadFlag(work, idx + 1);
  let usernameSkipped = false;
  let positionalSkipped = false;
  let i = idx + 1;
  while (i < work.length) {
    const t = work[i] ?? "";
    if (t === "--") {
      if (positionalKind !== undefined && !positionalSkipped) {
        i++;
        continue;
      }
      const rest = work.slice(i + 1);
      if (skipUsername && !usernameSkipped && rest.length > 0) {
        usernameSkipped = true;
        i++;
        continue;
      }
      return rest.length > 0 ? rest : null;
    }
    const isDashFlag = t.startsWith("-") && t !== "-";
    if (!isDashFlag) {
      // Positional operand. `su`/`sg -` is the login-shell flag, not a
      // username: skip it without consuming the username slot.
      if (t === "-" && (wrapper === "su" || wrapper === "sg")) {
        i++;
        continue;
      }
      if (skipUsername && !usernameSkipped) {
        usernameSkipped = true;
        i++;
        continue;
      }
      if (positionalKind !== undefined && !positionalSkipped) {
        if (positionalKind === "single") {
          // A bare `${wrapper} <verb> …` (e.g. `chroot rm -rf /`) names no
          // positional operand: when the candidate is itself a known
          // command word it IS the command — skipping it as the
          // newroot/mask would hide the payload (OH-6.5-wrapper-laundering).
          if (!isKnownCommandWord(t)) {
            positionalSkipped = true;
            i++;
            continue;
          }
        } else if (TIMEOUT_DURATION_RE.test(t)) {
          positionalSkipped = true;
          i++;
          continue;
        }
        // `timeout` positional outside the duration grammar: it is the
        // command, not a duration — fall through and return it.
      }
      return work.slice(i);
    }
    // Dash-flag forms.
    if (payloadFlags !== undefined) {
      if (payloadFlags.has(t)) {
        if (i + 1 >= work.length) return null;
        const payload = work[i + 1] ?? "";
        return [...tokenizeSegment(payload), ...work.slice(i + 2)];
      }
      const payloadEq = t.indexOf("=");
      if (payloadEq >= 0 && payloadFlags.has(t.slice(0, payloadEq))) {
        const payload = t.slice(payloadEq + 1);
        return [...tokenizeSegment(payload), ...work.slice(i + 1)];
      }
      // Short cluster carrying the payload letter (`su -lc 'cmd'`,
      // attached `-cfoo`): getopt gives the letter the remainder of the
      // cluster, else the next token.
      if (/^-[A-Za-z]{2,}$/.test(t)) {
        const letters = t.slice(1);
        const ci = letters.indexOf("c");
        if (ci >= 0) {
          const attached = letters.slice(ci + 1);
          if (attached.length > 0) {
            return [...tokenizeSegment(attached), ...work.slice(i + 1)];
          }
          if (i + 1 >= work.length) return null;
          return [...tokenizeSegment(work[i + 1] ?? ""), ...work.slice(i + 2)];
        }
      }
    }
    const eq = t.indexOf("=");
    if (eq >= 0) {
      i++;
      continue;
    }
    if (valueFlags.has(t)) {
      i += 2;
      continue;
    }
    if (combinedLetters !== undefined && /^-[A-Za-z]{2,}$/.test(t)) {
      // Getopt-correct cluster parsing (OH-6.5-sudo-attached-value): the
      // FIRST value-taking letter takes the remainder of the cluster as its
      // attached value (`-uroot` → `-u` = `root`) and nothing is consumed
      // past the token. Only a value letter that is LAST with nothing
      // attached consumes the following token (`-nu root` eats `root`).
      const letters = t.slice(1);
      let vi = -1;
      for (let k = 0; k < letters.length; k++) {
        if (combinedLetters.has(letters[k] ?? "")) {
          vi = k;
          break;
        }
      }
      if (vi === -1) {
        i++;
        continue;
      }
      const attached = letters.slice(vi + 1);
      if (attached.length > 0) {
        i++;
        continue;
      }
      i++;
      if (i < work.length && !(work[i] ?? "").startsWith("-")) {
        i++;
      }
      continue;
    }
    // Boolean/unknown flag: skip the token itself. A separate value (if the
    // real tool takes one and it is not modelled above) is left as residue
    // and caught by the anywhere-stream rm+wipe scan (fail-closed).
    i++;
  }
  return null;
}

interface StrippedWithChain {
  stripped: string[];
  chain: string[];
  envVars: Record<string, string>;
}

/**
 * Shared strip core: loops until the next token is no longer a
 * wrapper/dispatcher, expanding inline payloads and skipping per-wrapper
 * option grammars along the way. A wrapper chain that ends with no
 * executable resolves to `[UNRESOLVED_NESTING_SENTINEL]` (destructive,
 * fail-closed) when at least one wrapper was consumed; input with no
 * wrappers at all is returned as-is (leading `VAR=val` assignments skipped).
 */
function stripWithChain(tokens: string[]): StrippedWithChain {
  const work = Array.isArray(tokens) ? [...tokens] : [];
  const chain: string[] = [];
  const envVars: Record<string, string> = {};
  let sawWrapper = false;
  for (let guard = 0; guard < 32; guard++) {
    let i = 0;
    while (i < work.length && ENV_ASSIGNMENT_RE.test(work[i] ?? "")) {
      const m = ENV_ASSIGNMENT_RE.exec(work[i] ?? "");
      if (m) {
        envVars[m[1] ?? ""] = m[2] ?? "";
      }
      i++;
    }
    if (i >= work.length) {
      return {
        stripped: sawWrapper ? [UNRESOLVED_NESTING_SENTINEL] : [],
        chain,
        envVars,
      };
    }
    const tok = work[i] ?? "";
    if (!WRAPPER_BINARIES.has(tok)) {
      return { stripped: work.slice(i), chain, envVars };
    }
    sawWrapper = true;
    chain.push(tok);
    const rest = consumeWrapper(work, i, tok);
    if (rest === null) {
      return { stripped: [UNRESOLVED_NESTING_SENTINEL], chain, envVars };
    }
    work.length = 0;
    work.push(...rest);
  }
  // Non-convergence guard (pathological nesting): fail closed.
  return { stripped: [UNRESOLVED_NESTING_SENTINEL], chain, envVars };
}

/**
 * Strip leading privilege/env wrappers (`sudo -u root`, `env FOO=1`, `VAR=x`)
 * and return the effective command tokens. Never lowercases: `RM`/`GIT` are
 * not executable on POSIX and stay unknown verbs.
 */
export function stripLeadingWrapperTokens(tokens: string[]): string[] {
  return stripWithChain(tokens).stripped;
}

/** Basename of a command word (`/bin/rm` -> `rm`); case is preserved. */
export function commandBasename(word: string): string {
  const base = (word ?? "").split("/").pop() ?? "";
  return base;
}

/**
 * Whether `token` is itself a known command word (read-only, mutating,
 * always-write, wrapper, or interpreter). Used by the `taskset`/`chroot`
 * positional gate: a known word in operand position IS the command.
 * Declared here so the wrapper grammar above can call it; the verb sets it
 * consults are defined below and resolved at call time.
 */
function isKnownCommandWord(token: string): boolean {
  const base = commandBasename(token);
  return (
    READ_ONLY_VERBS.has(base) ||
    WRITE_VERBS.has(base) ||
    ALWAYS_WRITE_VERBS.has(base) ||
    WRAPPER_BINARIES.has(base) ||
    SHELL_INTERPRETERS.has(base)
  );
}

/** Effective (wrapper-stripped) tokens for one chain segment. */
function effectiveTokensOf(segment: string): string[] {
  const canon = canonicalizeShellCommand(segment);
  return stripLeadingWrapperTokens(tokenizeSegment(canon));
}

/**
 * `command -v foo` / `command -V foo`: display queries that print a path and
 * execute nothing. They stay `read-only` even though the unknown-verb
 * default is `write` — but only when no redirect/`tee` metacharacters are
 * present (those are checked first and always win: `command -v foo > /etc/x`
 * is still a write).
 */
function isCommandDisplayQuery(segment: string): boolean {
  const tokens = tokenizeSegment(canonicalizeShellCommand(segment).trim());
  let i = 0;
  while (i < tokens.length && ENV_ASSIGNMENT_RE.test(tokens[i] ?? "")) {
    i++;
  }
  if ((tokens[i] ?? "") !== "command") {
    return false;
  }
  for (let k = i + 1; k < tokens.length; k++) {
    const t = tokens[k] ?? "";
    if (t === "-v" || t === "-V") {
      return true;
    }
    if (t.startsWith("-") && t !== "-") {
      continue;
    }
    break;
  }
  return false;
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

  const { stripped, chain, envVars } = stripWithChain(tokens);
  let executable: string;
  let args: string[];
  if (stripped.length === 1 && stripped[0] === UNRESOLVED_NESTING_SENTINEL) {
    executable = "";
    args = [];
  } else {
    executable = stripped[0] ?? "";
    args = stripped.slice(1);
  }

  return {
    raw: trimmed,
    tokens,
    envVars,
    executable,
    args,
    wrapperChain: chain,
  };
}

export const MAX_SHELL_UNWRAP_DEPTH = 10;

/**
 * Fail-closed sentinel for recursion-cap exhaustion: when nested interpreter
 * payloads (`bash -c "..."`, `eval ...`) nest deeper than
 * `MAX_SHELL_UNWRAP_DEPTH`, the unwrapper cannot prove the payload safe, so it
 * emits this marker executable and `segmentIsDestructive` treats it as
 * destructive (deny for every role) rather than silently allowing it.
 */
export const UNRESOLVED_NESTING_SENTINEL = "__harness_unresolved_nesting__";

/**
 * Whether `text` still contains a live code-execution verb (`sh`/`bash`/
 * `zsh`/`dash`/`ksh`/`eval`). Used only at the unwrap recursion cap to
 * decide fail-closed (destructive sentinel) vs benign cutoff (`[]`).
 */
function containsLiveInterpreterVerb(text: string): boolean {
  return /\b(sh|bash|zsh|dash|ksh|eval)\b/.test(text);
}

/**
 * Long `xargs` options that consume the following token as their value when
 * given without `=`. Boolean long flags are simply skipped.
 */
const XARGS_LONG_VALUE_FLAGS = new Set([
  "--arg-file",
  "--delimiter",
  "--eof",
  "--replace",
  "--max-lines",
  "--max-args",
  "--max-procs",
  "--max-chars",
  "--process-slot-var",
]);

/** Short `xargs` option letters that require a value (consumed from the same token or the next). */
const XARGS_SHORT_VALUE_LETTERS = new Set(["a", "d", "E", "I", "L", "n", "P", "s"]);
/** Short `xargs` option letters with an optional attached value (`-e[EOF]`, `-i[repl]`, `-l[lines]`). */
const XARGS_SHORT_OPTIONAL_VALUE_LETTERS = new Set(["e", "i", "l"]);
/** Short `xargs` boolean letters (never consume a value). */
const XARGS_SHORT_BOOL_LETTERS = new Set(["0", "o", "p", "r", "t", "x", "v"]);

/**
 * Split `xargs [options] [command [initial-args]]` into the payload command
 * tokens, preserving the payload verbatim (including its `-rf` flags).
 * Only xargs's own options are consumed; the first non-option token starts
 * the payload. A bare `xargs` (no payload, defaults to `echo`) yields `[]`.
 */
export function xargsPayloadArgs(args: string[]): string[] {
  let i = 0;
  while (i < args.length) {
    const token = args[i] ?? "";
    if (token === "--") {
      return args.slice(i + 1);
    }
    if (!token.startsWith("-") || token === "-") {
      return args.slice(i);
    }
    if (token.startsWith("--")) {
      const eq = token.indexOf("=");
      const name = eq >= 0 ? token.slice(0, eq) : token;
      if (XARGS_LONG_VALUE_FLAGS.has(name) && eq < 0) {
        i += 2;
      } else {
        i += 1;
      }
      continue;
    }
    // Short-option cluster (`-0`, `-r`, `-n1`, `-I{}`, `-d\n`, `-pt`, ...).
    let j = 1;
    let consumedNext = false;
    while (j < token.length) {
      const letter = token[j] ?? "";
      if (XARGS_SHORT_VALUE_LETTERS.has(letter)) {
        if (j + 1 < token.length) {
          j = token.length;
        } else {
          consumedNext = true;
          j = token.length;
        }
        break;
      }
      if (XARGS_SHORT_OPTIONAL_VALUE_LETTERS.has(letter)) {
        j = token.length;
        break;
      }
      if (XARGS_SHORT_BOOL_LETTERS.has(letter)) {
        j++;
        continue;
      }
      // Unknown short letter: fail-closed toward skipping only this token so
      // a following payload token is never swallowed as an option value.
      j++;
    }
    i += 1;
    if (consumedNext) {
      i += 1;
    }
  }
  return [];
}

/**
 * Split `find` `-exec`/`-execdir`/`-ok`/`-okdir` payloads (`-exec cmd {} \;`)
 * into re-parseable command strings so destructive payloads
 * (`find . -exec rm -rf / \;`) cannot hide behind the `find` wrapper.
 */
export function findExecPayloads(args: string[]): string[] {
  const payloads: string[] = [];
  const starters = new Set(["-exec", "-execdir", "-ok", "-okdir"]);
  let i = 0;
  while (i < args.length) {
    if (starters.has(args[i] ?? "")) {
      i++;
      const parts: string[] = [];
      while (i < args.length && args[i] !== ";" && args[i] !== "+") {
        parts.push(args[i] ?? "");
        i++;
      }
      if (parts.length > 0) {
        payloads.push(parts.join(" "));
      }
      if (i < args.length) {
        i++;
      }
    } else {
      i++;
    }
  }
  return payloads;
}
/**
 * Leading path operands of a `find` invocation: tokens before the first
 * expression primary (`-…`), negation, or paren. `find` with no path
 * defaults to `.` (safe — never a wipe root).
 */
function findPathOperands(args: string[]): string[] {
  const roots: string[] = [];
  for (const a of args) {
    if (a === "") {
      continue;
    }
    if (
      a.startsWith("-") ||
      a === "(" ||
      a === ")" ||
      a === "!" ||
      a === ","
    ) {
      break;
    }
    if (a === ";" || a === "+" || a === "{}") {
      break;
    }
    roots.push(a);
  }
  return roots;
}

/** Whether any leading find-path operand is a root-wipe target. */
function findHasWipeRoot(args: string[]): boolean {
  return findPathOperands(args).some((p) => isFindWipeRootOperand(p));
}

/** Leading `find` path operand naming a wipe root (`//`, `/tmp/../`, `..`, `~root`). */
function isFindWipeRootOperand(operand: string): boolean {
  const t = (operand ?? "").trim();
  return t !== "" && (isRootWipeTarget(t) || t.replace(/\\/g, "/").split("/").includes(".."));
}

/**
 * OH-6.5-find-exec-placeholder (+ OH-6.5-embedded-placeholder): `true` when
 * an `-exec`/`-execdir`/`-ok`/`-okdir` payload runs `rm` with recursive+force
 * flags over a `{}-including` target (`{}`, `{}/foo`, `{}foo`, `prefix{}` —
 * substring match, fail-closed). Callers gate this on a wipe-root find root
 * so scoped uses (`find /tmp -name x -exec rm -rf {} \;`) stay write-class. A
 * payload substitution (`$(…)`/backticks) with recursive+force flags is
 * destructive because a real shell expands it before `rm` sees its targets.
 */
function findExecPayloadIsPlaceholderWipe(payload: string): boolean {
  const tokens = stripLeadingWrapperTokens(
    tokenizeSegment(canonicalizeShellCommand(payload)),
  );
  const subst = /`[^`]*`|\$\(/.test(payload);
  for (let s = 0; s < tokens.length; s++) {
    if (commandBasename(tokens[s] ?? "") !== "rm") {
      continue;
    }
    let hasRecursive = false;
    let hasForce = false;
    let hasPlaceholder = false;
    let endOfOptions = false;
    for (let k = s + 1; k < tokens.length; k++) {
      const a = tokens[k] ?? "";
      if (!endOfOptions && a === "--") {
        endOfOptions = true;
        continue;
      }
      if (!endOfOptions && a === "--no-preserve-root") {
        return true;
      }
      if (!endOfOptions && (a === "--recursive" || a === "-r" || a === "-R")) {
        hasRecursive = true;
        continue;
      }
      if (!endOfOptions && (a === "--force" || a === "-f")) {
        hasForce = true;
        continue;
      }
      if (!endOfOptions && /^-[rRf]+$/.test(a)) {
        hasRecursive = true;
        hasForce = true;
        continue;
      }
      if (!endOfOptions && /^-[A-Za-z]+$/.test(a)) {
        const letters = a.slice(1);
        if (/[rR]/.test(letters)) hasRecursive = true;
        if (letters.includes("f")) hasForce = true;
        continue;
      }
      if (!endOfOptions && a.startsWith("-") && a !== "-") {
        continue;
      }
      if (a.includes("{}")) {
        hasPlaceholder = true;
      }
    }
    if (hasRecursive && hasForce && (hasPlaceholder || subst)) {
      return true;
    }
  }
  return false;
}

export function parseCommandSegments(command: string, depth: number = 0): ParsedSegment[] {
  if (!command.trim()) return [];
  if (depth > MAX_SHELL_UNWRAP_DEPTH) {
    if (containsLiveInterpreterVerb(command)) {
      return [
        {
          raw: command.trim(),
          tokens: [UNRESOLVED_NESTING_SENTINEL],
          envVars: {},
          executable: UNRESOLVED_NESTING_SENTINEL,
          args: [],
          wrapperChain: [],
        },
      ];
    }
    return [];
  }
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
      const payload = xargsPayloadArgs(seg.args);
      if (payload.length > 0) {
        parsed.push(...parseCommandSegments(payload.join(" "), depth + 1));
      }
    } else if (baseExe === "find" && seg.args.length > 0) {
      for (const payload of findExecPayloads(seg.args)) {
        parsed.push(...parseCommandSegments(payload, depth + 1));
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

/** Fail-closed wipe-target normalization (`//`→`/`, `/tmp/../`→`/`, `~…`→`/`, `$HOME`→`/`). */
function normalizeWipeTarget(target: string): string {
  const s = (target ?? "").trim();
  if (s.startsWith("~")) return "/";
  try {
    return posix.normalize(s.replace(/\$\{HOME\}|\$HOME/g, "/").replace(/\/+/g, "/"));
  } catch {
    return s;
  }
}

/** Targets whose recursive-force removal wipes a home/root scope. */
function isRootWipeTarget(target: string): boolean {
  const t = (target ?? "").trim();
  if (t === "*" || t === "/*" || t === "--no-preserve-root") {
    return true;
  }
  if (t.startsWith("~")) {
    return true; // `~`, `~/…`, `~<user>` fail closed
  }
  if (t === "$HOME" || t === "${HOME}") {
    return true;
  }
  if (t.startsWith("$HOME/") || t.startsWith("${HOME}/")) {
    return true;
  }
  // Normalized `/` covers `//`, `///`, `/.`, `/./`, `/../`, `/tmp/../`.
  return normalizeWipeTarget(t) === "/";
}

/**
 * Anywhere-stream `rm`+wipe scan (OH-6.5-wrapper-laundering backstop): when a
 * per-wrapper grammar does not model some exotic flag spelling, the residue
 * still cannot hide a recursive-force root wipe — any `rm` token followed by
 * recursive+force flags and a root-wipe target ANYWHERE in the post-wrapper
 * stream is destructive regardless of position 0. `subst` mirrors the
 * position-0 command-substitution rule: `rm -r[f]` whose segment carries a
 * substitution is destructive because a real shell expands it before `rm`
 * sees its targets.
 */
function scanTokensForRmWipe(tokens: string[], subst: boolean): boolean {
  for (let s = 0; s < tokens.length; s++) {
    if (commandBasename(tokens[s] ?? "") !== "rm") {
      continue;
    }
    let hasRecursive = false;
    let hasForce = false;
    const targets: string[] = [];
    let endOfOptions = false;
    for (let k = s + 1; k < tokens.length; k++) {
      const a = tokens[k] ?? "";
      if (!endOfOptions && a === "--") {
        endOfOptions = true;
        continue;
      }
      if (!endOfOptions && a === "--no-preserve-root") {
        return true;
      }
      if (!endOfOptions && (a === "--recursive" || a === "-r" || a === "-R")) {
        hasRecursive = true;
        continue;
      }
      if (!endOfOptions && (a === "--force" || a === "-f")) {
        hasForce = true;
        continue;
      }
      if (!endOfOptions && /^-[rRf]+$/.test(a)) {
        hasRecursive = true;
        hasForce = true;
        continue;
      }
      if (!endOfOptions && /^-[A-Za-z]+$/.test(a)) {
        const letters = a.slice(1);
        if (/[rR]/.test(letters)) hasRecursive = true;
        if (letters.includes("f")) hasForce = true;
        continue;
      }
      if (!endOfOptions && a.startsWith("-") && a !== "-") {
        continue;
      }
      targets.push(a);
    }
    if (!hasRecursive || !hasForce) {
      continue;
    }
    if (subst) {
      return true;
    }
    for (const target of targets) {
      if (isRootWipeTarget(target)) {
        return true;
      }
      // Fail-closed static traversal check: any `..` inside a
      // recursive-force removal is treated as a workspace escape.
      if (target.split("/").includes("..")) {
        return true;
      }
    }
  }
  return false;
}

/** Detect SPEC Rule 1 destructive operations in a single chain segment. */
function segmentIsDestructive(segment: string): boolean {
  if (isCommandDisplayQuery(segment)) {
    return false;
  }
  const effective = effectiveTokensOf(segment);
  if (effective.length === 0) {
    return false;
  }
  const exe = commandBasename(effective[0] ?? "");
  const args = effective.slice(1);

  if (exe === UNRESOLVED_NESTING_SENTINEL) {
    return true;
  }

  if (scanTokensForRmWipe(effective, /`[^`]*`|\$\(/.test(segment))) {
    return true;
  }

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
      // Fail-closed command substitution: a real shell expands `$(...)` and
      // `` `...` `` before `rm` sees its targets, so `rm -rf $(echo /)` and
      // `` rm -rf `echo /` `` both wipe root. Any `rm -r[f]` whose segment
      // carries a substitution is destructive (OH-6.5-backtick-substitution).
      if (/`[^`]*`|\$\(/.test(segment)) {
        return true;
      }
    }
    return false;
  }

  if (exe === "find") {
    // `find / -delete` removes the whole tree: destructive, as do the
    // normalized/escaping spellings (`//`, `/tmp/../`, `..`, `~root`).
    // Scoped deletes (`find /tmp/x -delete`) stay write-class.
    if (args.includes("-delete")) {
      if (findPathOperands(args).some((p) => isFindWipeRootOperand(p))) {
        return true;
      }
    }
    // OH-6.5-find-exec-placeholder: `{}` expands to every path under the
    // find root, so with a root-wipe root (`/`, `~`, `$HOME`, …) any
    // `-exec`/`-execdir`/`-ok`/`-okdir` payload running `rm` with
    // recursive+force flags over `{}` is a root wipe: destructive.
    // Scoped roots stay write-class (`segmentIsWrite`).
    if (findHasWipeRoot(args)) {
      for (const payload of findExecPayloads(args)) {
        if (findExecPayloadIsPlaceholderWipe(payload)) {
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
  if (isCommandDisplayQuery(segment)) {
    return false;
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
    // Fail-closed default for unknown verbs (OH-6.5-wrapper-laundering): a
    // command word we cannot prove read-only can mutate files or execute
    // code, so it is write-class — never `read-only`.
    return true;
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

/**
 * Long flags of `cp`/`mv`/`ln` whose value is a file target
 * (`--target-directory`), vs long flags whose value is consumed but never
 * treated as a file target (`--suffix`, `--backup`: mode/owner-style
 * strings, not paths).
 */
const COPY_TARGET_VALUE_FLAGS = new Set(["--target-directory"]);
const COPY_CONSUMED_VALUE_FLAGS = new Set(["--suffix", "--backup"]);
const COPY_SHORT_TARGET_LETTERS = new Set(["t"]);
const COPY_SHORT_VALUE_LETTERS = new Set(["S"]);

const INSTALL_TARGET_VALUE_FLAGS = new Set(["--target-directory"]);
const INSTALL_CONSUMED_VALUE_FLAGS = new Set([
  "--mode",
  "--owner",
  "--group",
  "--suffix",
  "--backup",
]);
const INSTALL_SHORT_TARGET_LETTERS = new Set(["t"]);
const INSTALL_SHORT_VALUE_LETTERS = new Set(["m", "o", "g", "S"]);

/**
 * Operand targets of `cp`/`mv`/`ln`/`install`: every non-option operand is a
 * named file the command creates, overwrites, or moves (sources and dests
 * alike — reading `/etc/passwd` as a `mv` source is as confinement-relevant
 * as writing `/etc/cron.d/x`). `-t`/`--target-directory` values are
 * targets; `-m`/`-o`/`-g`/`--mode`/`--owner`/`--group`/`--suffix`-style
 * values are consumed but never targeted.
 */
function collectCopyOperandTargets(
  args: string[],
  targetFlags: Set<string>,
  consumedFlags: Set<string>,
  shortTarget: Set<string>,
  shortValue: Set<string>,
): string[] {
  const targets: string[] = [];
  const pushTarget = (v: string): void => {
    if (v !== "" && v !== "-") {
      targets.push(v);
    }
  };
  let i = 0;
  while (i < args.length) {
    const t = args[i] ?? "";
    if (t === "--") {
      for (let k = i + 1; k < args.length; k++) {
        pushTarget(args[k] ?? "");
      }
      break;
    }
    if (t === "" || t === "-") {
      i++;
      continue;
    }
    if (t.startsWith("--")) {
      const eq = t.indexOf("=");
      const name = eq >= 0 ? t.slice(0, eq) : t;
      const attached = eq >= 0 ? t.slice(eq + 1) : null;
      if (targetFlags.has(name)) {
        if (attached !== null) {
          pushTarget(attached);
        } else if (i + 1 < args.length) {
          pushTarget(args[i + 1] ?? "");
          i++;
        }
        i++;
        continue;
      }
      if (consumedFlags.has(name)) {
        i += attached !== null ? 1 : 2;
        continue;
      }
      // Unknown long flag: skip the flag itself (boolean assumption). A
      // separate value, if the real tool takes one, stays behind as an
      // operand — over-targeting, which is the fail-closed direction for a
      // confinement gate.
      i++;
      continue;
    }
    if (t.startsWith("-") && t.length > 1) {
      let j = 1;
      let consumeNext = false;
      let nextIsTarget = false;
      while (j < t.length) {
        const c = t[j] ?? "";
        if (shortTarget.has(c)) {
          const rest = t.slice(j + 1);
          if (rest !== "") {
            pushTarget(rest);
          } else {
            consumeNext = true;
            nextIsTarget = true;
          }
          break;
        }
        if (shortValue.has(c)) {
          if (t.slice(j + 1) === "") {
            consumeNext = true;
          }
          break;
        }
        j++;
      }
      i++;
      if (consumeNext && i < args.length) {
        if (nextIsTarget) {
          pushTarget(args[i] ?? "");
        }
        i++;
      }
      continue;
    }
    pushTarget(t);
    i++;
  }
  return targets;
}

/**
 * Files a `sed` invocation rewrites in place. Only `sed -i`/`--in-place`
 * has argv targets (a bare `sed s/a/b/ file` reads); the script itself
 * (first free operand, or every `-e`/`-f` value) is consumed, never
 * targeted. `-i.bak`-style attached suffixes stay inside their token.
 */
function sedInPlaceTargetFiles(args: string[]): string[] {
  let inPlace = false;
  let scriptGiven = false;
  const free: string[] = [];
  let i = 0;
  while (i < args.length) {
    const t = args[i] ?? "";
    if (t === "--") {
      for (let k = i + 1; k < args.length; k++) {
        if ((args[k] ?? "") !== "") {
          free.push(args[k] ?? "");
        }
      }
      break;
    }
    if (t === "") {
      i++;
      continue;
    }
    if (t === "--in-place" || t.startsWith("--in-place=")) {
      inPlace = true;
      i++;
      continue;
    }
    if (t === "--expression" || t === "--file" || t === "--script") {
      scriptGiven = true;
      i += 2;
      continue;
    }
    if (
      t.startsWith("--expression=") ||
      t.startsWith("--file=") ||
      t.startsWith("--script=")
    ) {
      scriptGiven = true;
      i++;
      continue;
    }
    if (t.startsWith("--")) {
      i++;
      continue;
    }
    if (t === "-i") {
      inPlace = true;
      i++;
      continue;
    }
    if (t === "-e" || t === "-f") {
      scriptGiven = true;
      i += 2;
      continue;
    }
    if (/^-[A-Za-z]+$/.test(t)) {
      const letters = t.slice(1);
      if (letters.includes("i")) {
        inPlace = true;
      }
      if (letters.includes("e") || letters.includes("f")) {
        scriptGiven = true;
      }
      i++;
      continue;
    }
    if (t.startsWith("-i") && t.length > 2) {
      // Attached backup suffix (`-i.bak`): in-place, suffix consumed inline.
      inPlace = true;
      i++;
      continue;
    }
    if (t.startsWith("-") && t !== "-") {
      i++;
      continue;
    }
    free.push(t);
    i++;
  }
  if (!inPlace) {
    return [];
  }
  const files = scriptGiven ? free : free.slice(1);
  return files.filter((f) => f !== "" && f !== "-");
}

/**
 * Argv file targets of `cp`/`mv`/`ln`/`install` operands and `sed -i` files
 * (OH-6.5-cp-mv-argv-targets). Parsed per (recursively unwrapped) command
 * segment after wrapper stripping, so `sudo cp a /etc/x`, `VAR=x mv …`,
 * and `bash -c "cp a /etc/x"` payloads are all covered. Segments whose head
 * is any other verb (including `tee`, covered by `shellNamedFileTargets`)
 * contribute nothing. Results are deduplicated, segment order preserved.
 */
export function shellArgvFileTargets(command: string): string[] {
  if (typeof command !== "string" || command.trim() === "") {
    return [];
  }
  const seen = new Set<string>();
  const out: string[] = [];
  const push = (v: string): void => {
    if (v === "" || v === "-" || seen.has(v)) {
      return;
    }
    seen.add(v);
    out.push(v);
  };
  for (const seg of parseCommandSegments(command)) {
    const stripped = stripLeadingWrapperTokens(seg.tokens ?? []).filter(
      (t) => t !== UNRESOLVED_NESTING_SENTINEL,
    );
    if (stripped.length === 0) {
      continue;
    }
    const verb = commandBasename(stripped[0] ?? "");
    const args = stripped.slice(1);
    if (verb === "sed") {
      for (const f of sedInPlaceTargetFiles(args)) {
        push(f);
      }
    } else if (verb === "cp" || verb === "mv" || verb === "ln") {
      for (const f of collectCopyOperandTargets(
        args,
        COPY_TARGET_VALUE_FLAGS,
        COPY_CONSUMED_VALUE_FLAGS,
        COPY_SHORT_TARGET_LETTERS,
        COPY_SHORT_VALUE_LETTERS,
      )) {
        push(f);
      }
    } else if (verb === "install") {
      for (const f of collectCopyOperandTargets(
        args,
        INSTALL_TARGET_VALUE_FLAGS,
        INSTALL_CONSUMED_VALUE_FLAGS,
        INSTALL_SHORT_TARGET_LETTERS,
        INSTALL_SHORT_VALUE_LETTERS,
      )) {
        push(f);
      }
    }
  }
  return out;
}
