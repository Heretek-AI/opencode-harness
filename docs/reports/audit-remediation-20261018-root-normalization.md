# Programmer Report: Audit Remediation 20261018 — OH-6.5-root-normalization (P0) + OH-6.5-embedded-placeholder (P1)

- **Branch:** `fix/oh-6-5-root-normalization-embedded-placeholder`
- **Worktree:** `/home/john/Projects/Heretek-AI-Rebuild/opencode-harness/worktrees/audit-remediation`
- **Date (UTC):** 2026-10-18
- **Scope:** `src/guards/shell-parse.ts` (guard logic + comments only) and `test/guards.test.ts` (new regression tests only). No other production files touched; no version bump, tags, publishes, or CI changes.

## Defects remediated

### OH-6.5-root-normalization (P0)

`isRootWipeTarget` used exact-match only, so `rm -rf //`, `///`, `/.`, `/./`,
`~root`, `~root/.ssh` classified `write`/ALLOW, and `find // …`, `find /./ …`,
`find /tmp/../ …`, `find .. …`, `find ~root …` (`-exec rm -rf {} \;` and
`-delete` forms) classified `write`/ALLOW for builder/architect, including
while tainted.

### OH-6.5-embedded-placeholder (P1)

`findExecPayloadIsPlaceholderWipe` used exact `a === "{}"`, so
`find / -exec rm -rf {}/foo \;`, `{}foo`, `prefix{}` (and `-- {}/foo`)
classified `write`/ALLOW.

## Logic implemented (`src/guards/shell-parse.ts`)

1. **Added `import { posix } from "node:path";`** — the file previously had no
   imports; POSIX normalization is stdlib-only.
2. **Added `normalizeWipeTarget(t)`** — fail-closed normalization: trims,
   maps every `~`-leading form (`~`, `~/x`, `~<user>`, `~<user>/x` — unknown
   home, fail closed) to `/`, expands `$HOME`/`${HOME}` to `/`, collapses
   repeated slashes, then applies `posix.normalize`, so `//`, `///`, `/.`,
   `/./`, `/../`, `/tmp/../` all resolve to `/` (matching `realpath -m` /
   same device:inode as `/` per the audit).
3. **Rewrote `isRootWipeTarget(t)`** — preserves every pre-existing exact/prefix
   rule (`*`, `/*`, `--no-preserve-root`, `~`, `~/*`, `~/…`, `$HOME`,
   `${HOME}`, `$HOME/…`, `${HOME}/…`), adds `~<user>` fail-closed, and falls
   through to `normalizeWipeTarget(t) === "/"`. Multi-line branch style is kept
   so the wave-1 accept zero-stub scan (which flags `||` + `true` on one line)
   stays clean.
4. **Added `isFindWipeRootOperand(p)`** — `true` when `isRootWipeTarget(p)` or
   the operand contains a `..` segment (covers `..`, `../x`, `a/../b`),
   i.e. the fail-closed workspace-escape approximation; `findHasWipeRoot`
   now uses it, so `find ..`, `find //`, `find /tmp/../`, `find ~root` count
   as wipe roots for the `-exec`-payload gate.
5. **Fixed the `-delete` branch** — was `args.filter(…).some(p === "/" || "/*")`
   (exact match, and it wrongly swept `-exec` payload tokens into the path
   set); now `findPathOperands(args).some(isFindWipeRootOperand)`, the same
   normalized/outside-workspace check as the `-exec` branch.
6. **Embedded placeholder** — `a === "{}"` → `a.includes("{}")` in
   `findExecPayloadIsPlaceholderWipe` (post-`--` tokens included, as before,
   so `-- {}/foo` denies; `{}` never appears legitimately in `rm` targets).
7. **Taint mapping preserved** — `evaluateTaintGuard` already denies any
   `isDestructiveShellCommand(command)` as `TAINT-DESTRUCTIVE-1` while tainted;
   fixing the classifier automatically fixes the taint layer with no bypass.

Net `src/` delta: raw 11961 → 11981 (budget 12000), stripped 9961 → 9975
(budget 10000). Comments kept concise deliberately to stay under the
OH-scope-loc-budget hard caps pinned by
`test/audit-20261018-remediation.test.ts`.

## Tests added (`test/guards.test.ts`, +169 lines, 9 new tests, none modified)

- `OH-6.5-root-normalization` (5 tests): every probe row
  (`rm -rf // /// /. /./ /../ /tmp/../ ~root ~root/.ssh`;
  `find //|/./|/tmp/../|..|~root -exec rm -rf {} \;`;
  `find //|/tmp/../|.. -delete`) asserts `class === "destructive"` +
  `isDestructiveShellCommand === true` + `rule-1-destructive` deny for
  builder/architect/director/qa-adversary; tainted sessions deny all 16 rows
  via `evaluateTaintGuard` with `TAINT-DESTRUCTIVE-1`; scoped controls
  (`rm -rf /tmp`, `/var/tmp/app`, `find /tmp … {}[ /{}/foo]`, `find . …`,
  `find /tmp -name x -delete`) stay `write`/ALLOW.
- `OH-6.5-embedded-placeholder` (4 tests): `{}/foo`, `{}foo`, `prefix{}`,
  `-- {}/foo` over `/` with `\;` and `-ok` terminators assert destructive +
  `rule-1-destructive` for all four roles; tainted deny `TAINT-DESTRUCTIVE-1`;
  scoped `find /tmp|… {}/foo` controls stay `write`/ALLOW.

## Gate results (exact commands + exit codes, from inside the worktree)

- `bun run check` (tsc --noEmit) → exit 0.
- `bun test test/guards.test.ts` (stock TMPDIR) → 41 pass, 0 fail, exit 0
  (was 32 tests; +9 new).
- `bun test test/guards.test.ts test/audit-20261018-remediation.test.ts`
  filtered `-t` re-runs of the two OS-temp tests (stock TMPDIR) → pass
  (proves the TMPDIR-override failures below are environmental, not regressions).
- `TMPDIR=/dev/shm bun test` (full suite; override required because host
  `/tmp` is inode-exhausted/ENOSPC) → 365 pass, 2 fail; both failures are the
  audit-documented TMPDIR-flip tests (`redirect-escape` OS-temp allow,
  `cp-mv-argv-targets` absolute-source allow) which pass with stock TMPDIR
  and fail identically on the pristine tree (verified via `git stash` A/B).
  The OH-scope-loc-budget hard-cap test passes (raw 11981 ≤ 12000).
- `TMPDIR=/dev/shm bash scripts/accept/wave-1.sh` → `WAVE 1 ACCEPT: ALL GATES
  GREEN`, exit 0 (84 tests, zero-stub/scope scans clean).
- `TMPDIR=/dev/shm make accept` → wave 1 green; wave 2 fails ONLY on the two
  pre-existing TMPDIR environmental tests above (identical with and without
  this change, proven by stash A/B). Stock-TMPDIR accept runs cannot execute
  on this host (`mkdtemp /tmp/*` → ENOSPC), as documented in the audit.

## Self-audit notes

- Fail-closed everywhere: unknown homes (`~user`), unresolvable normalizations
  (catch → raw string, still matched), non-converging wrappers (untouched),
  `..`-containing find roots, and embedded `{}` all resolve toward
  `destructive`/deny, never allow.
- No stubs/mocks/vacuous tests: every new assertion checks the public guard
  API (`classifyShellCommand`, `isDestructiveShellCommand`,
  `evaluateBoardGuard`, `evaluateTaintGuard`) with distinct attack/allow
  expectations; no `TODO`, `|| true`, empty catch, or `test.skip`.
- Out-of-scope findings untouched: OH-1.3/OH-1.1 (tags/publish), OH-6.6
  (no upstream fork hook), OH-scope-loc-budget (budget observed, not revised),
  OH-deps-caret/OH-1.1-no-gh-release (informational).
