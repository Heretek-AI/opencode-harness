import { spawnSync } from "node:child_process"
import { existsSync, readFileSync, statSync } from "node:fs"
import { isAbsolute, relative, resolve } from "node:path"
import { analyzeBlastRadius } from "../repomap/repomap.js"

export interface RepoCheckCommands {
  typecheck?: string[]
  lint?: string[]
  test?: string[]
}

export interface VerificationFailure {
  file: string
  line: number
  column: number
  message: string
}

export interface VerificationStageResult {
  stage: "typecheck" | "lint" | "test"
  command: string
  ok: boolean
  exitCode: number
  durationMs: number
  failures: VerificationFailure[]
  outputExcerpt: string
}

export interface VerificationSummary {
  ok: boolean
  scopedTests: string[]
  stages: VerificationStageResult[]
  formattedReport: string
}

export function stripAnsiCodes(input: string): string {
  return input.replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, "")
}

export function discoverRepoChecks(rootDir: string = process.cwd()): RepoCheckCommands {
  const absRoot = resolve(rootDir)
  const pkgPath = resolve(absRoot, "package.json")
  const cmds: RepoCheckCommands = {}

  if (existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as {
        scripts?: Record<string, string>
      }
      const scripts = pkg.scripts ?? {}
      const runner = existsSync(resolve(absRoot, "bun.lockb")) || existsSync(resolve(absRoot, "bun.lock"))
        ? "bun"
        : "npm"

      if (scripts.typecheck) {
        cmds.typecheck = [runner, "run", "typecheck"]
      } else if (existsSync(resolve(absRoot, "tsconfig.json"))) {
        cmds.typecheck = ["tsc", "--noEmit"]
      }

      if (scripts.lint) {
        cmds.lint = [runner, "run", "lint"]
      }

      if (scripts.test) {
        cmds.test = runner === "bun" ? ["bun", "test"] : ["npm", "test"]
      }
    } catch (err) {
      if (err) return cmds
    }
  } else if (existsSync(resolve(absRoot, "Cargo.toml"))) {
    cmds.typecheck = ["cargo", "check"]
    cmds.test = ["cargo", "test"]
  } else if (existsSync(resolve(absRoot, "go.mod"))) {
    cmds.typecheck = ["go", "vet", "./..."]
    cmds.test = ["go", "test", "./..."]
  } else if (existsSync(resolve(absRoot, "pyproject.toml")) || existsSync(resolve(absRoot, "pytest.ini"))) {
    cmds.test = ["pytest"]
  }

  return cmds
}

export function parseVerificationFailures(rawOutput: string): VerificationFailure[] {
  const clean = stripAnsiCodes(rawOutput)
  const failures: VerificationFailure[] = []
  const seen = new Set<string>()

  const patterns = [
    // TypeScript: src/file.ts(10,5): error TS2322: ...
    /([A-Za-z0-9_./\\-]+\.[A-Za-z0-9]+)\((\d+),(\d+)\):\s*(?:error|warning)\s+([^\r\n]+)/g,
    // Standard compiler/linter/test: src/file.ts:10:5 - error ... or src/file.ts:10:5: ...
    /([A-Za-z0-9_./\\-]+\.(?:ts|tsx|js|jsx|py|go|rs)):(\d+):(\d+)[:\s-]+([^\r\n]+)/g,
  ]

  for (const regex of patterns) {
    let m: RegExpExecArray | null
    while ((m = regex.exec(clean)) !== null) {
      const file = m[1] ?? ""
      const line = Number(m[2] ?? 1)
      const column = Number(m[3] ?? 1)
      const message = (m[4] ?? "").trim()
      const key = `${file}:${line}:${column}`
      if (seen.has(key)) continue
      seen.add(key)
      failures.push({ file, line, column, message })
      if (failures.length >= 25) break
    }
  }

  return failures
}

export function computeScopedTestsForFiles(
  modifiedFiles: string[],
  rootDir: string = process.cwd(),
): string[] {
  const absRoot = resolve(rootDir)
  const affectedTests = new Set<string>()

  for (const file of modifiedFiles) {
    const rel = (isAbsolute(file) ? relative(absRoot, file) : file).replace(/\\/g, "/")
    if (/(?:\.test\.|\.spec\.|__tests__|\/test\/|^test\/)/i.test(rel)) {
      affectedTests.add(rel)
    }
    const radius = analyzeBlastRadius(rel, absRoot)
    for (const t of radius.affectedTests) {
      affectedTests.add(t)
    }
  }

  return [...affectedTests].sort()
}

export function runIncrementalVerification(options: {
  rootDir?: string
  modifiedFiles?: string[]
  timeoutMs?: number
  customCommands?: RepoCheckCommands
}): VerificationSummary {
  const rootDir = resolve(options.rootDir ?? process.cwd())
  const timeoutMs = options.timeoutMs ?? 30_000
  const commands = options.customCommands ?? discoverRepoChecks(rootDir)
  const scopedTests = options.modifiedFiles
    ? computeScopedTestsForFiles(options.modifiedFiles, rootDir)
    : []

  const stages: VerificationStageResult[] = []

  const runStage = (stage: VerificationStageResult["stage"], argv: string[]) => {
    const start = Date.now()
    const [bin, ...args] = argv
    if (!bin) return
    const res = spawnSync(bin, args, {
      cwd: rootDir,
      encoding: "utf8",
      timeout: timeoutMs,
    })
    const combined = stripAnsiCodes(`${res.stdout ?? ""}\n${res.stderr ?? ""}`).trim()
    const ok = res.status === 0
    stages.push({
      stage,
      command: argv.join(" "),
      ok,
      exitCode: res.status ?? 1,
      durationMs: Date.now() - start,
      failures: ok ? [] : parseVerificationFailures(combined),
      outputExcerpt: combined.slice(0, 1500),
    })
  }

  if (commands.typecheck) {
    runStage("typecheck", commands.typecheck)
  }
  if (commands.lint) {
    runStage("lint", commands.lint)
  }
  if (commands.test) {
    const testCmd = [...commands.test]
    if (scopedTests.length > 0 && testCmd[0] === "bun" && testCmd[1] === "test") {
      testCmd.push(...scopedTests)
    }
    runStage("test", testCmd)
  }

  const ok = stages.every((s) => s.ok)
  return {
    ok,
    scopedTests,
    stages,
    formattedReport: formatVerificationReport({ ok, scopedTests, stages }),
  }
}

export function formatVerificationReport(summary: {
  ok: boolean
  scopedTests: string[]
  stages: VerificationStageResult[]
}): string {
  const lines: string[] = [
    `<verification-report status="${summary.ok ? "pass" : "fail"}" scopedTests="${summary.scopedTests.length}">`,
  ]
  for (const s of summary.stages) {
    lines.push(
      `  <stage name="${s.stage}" status="${s.ok ? "pass" : "fail"}" durationMs="${s.durationMs}" command="${s.command}">`,
    )
    for (const f of s.failures.slice(0, 10)) {
      lines.push(`    [FAIL] ${f.file}:${f.line}:${f.column} - ${f.message}`)
    }
    if (!s.ok && s.failures.length === 0 && s.outputExcerpt) {
      lines.push(`    ${s.outputExcerpt.split("\n").slice(0, 8).join("\n    ")}`)
    }
    lines.push(`  </stage>`)
  }
  lines.push(`</verification-report>`)
  return lines.join("\n")
}

export interface DiffCoverageAndTautologyReport {
  tautologicalTests: Array<{ file: string; reason: string }>
  uncoveredLines: Array<{ file: string; lines: number[] }>
  coverageRatio: number
  passed: boolean
}

/**
 * Audits test files for tautological patterns (e.g., zero assertions or mocking the
 * exact module under test) and optionally evaluates LCOV diff coverage on modified lines.
 */
export function auditDiffCoverageAndTautology(options: {
  testFiles: string[]
  subjectFiles?: string[]
  lcovContent?: string
  changedLinesByFile?: Record<string, number[]>
  minCoverageRatio?: number
  rootDir?: string
}): DiffCoverageAndTautologyReport {
  const rootDir = resolve(options.rootDir ?? process.cwd())
  const tautologicalTests: Array<{ file: string; reason: string }> = []
  const subjectBasenames = (options.subjectFiles ?? []).map((s) =>
    s.replace(/\\/g, "/").replace(/\.(tsx?|jsx?|mjs|cjs|py)$/, "").split("/").pop() ?? "",
  ).filter(Boolean)

  for (const testFile of options.testFiles) {
    const abs = isAbsolute(testFile) ? testFile : resolve(rootDir, testFile)
    if (!existsSync(abs)) continue
    const raw = readFileSync(abs, "utf8")

    const hasAssertion =
      /\b(?:expect|assert|assertEquals|assertStrictEquals|should)\s*\(/.test(raw) ||
      /\bassert\b/.test(raw)
    if (!hasAssertion) {
      tautologicalTests.push({
        file: testFile,
        reason: "Test file contains zero assertion calls (expect/assert).",
      })
      continue
    }

    for (const base of subjectBasenames) {
      const mockRegex = new RegExp(
        `(?:vi|jest|mock)\\.(?:mock|module)\\s*\\(\\s*["'\`][^"'\`]*\\b${base}\\b[^"'\`]*["'\`]`,
      )
      if (mockRegex.test(raw)) {
        tautologicalTests.push({
          file: testFile,
          reason: `Test mocks its own subject under test ("${base}"), creating a tautological test.`,
        })
      }
    }
  }

  const uncoveredLines: Array<{ file: string; lines: number[] }> = []
  let totalChangedLines = 0
  let coveredChangedLines = 0

  if (options.lcovContent && options.changedLinesByFile) {
    const hitMap = new Map<string, Map<number, number>>()
    let currentFile = ""
    for (const rawLine of options.lcovContent.split("\n")) {
      const line = rawLine.trim()
      if (line.startsWith("SF:")) {
        currentFile = line.slice(3).trim().replace(/\\/g, "/")
        if (!hitMap.has(currentFile)) {
          hitMap.set(currentFile, new Map<number, number>())
        }
      } else if (line.startsWith("DA:") && currentFile) {
        const parts = line.slice(3).split(",")
        const ln = Number(parts[0])
        const hits = Number(parts[1])
        if (Number.isFinite(ln) && Number.isFinite(hits)) {
          hitMap.get(currentFile)!.set(ln, hits)
        }
      }
    }

    for (const [fileKey, changedLines] of Object.entries(options.changedLinesByFile)) {
      const normKey = fileKey.replace(/\\/g, "/")
      let fileHits: Map<number, number> | undefined
      for (const [sf, map] of hitMap.entries()) {
        if (sf === normKey || sf.endsWith(`/${normKey}`) || normKey.endsWith(`/${sf}`)) {
          fileHits = map
          break
        }
      }

      const missed: number[] = []
      for (const ln of changedLines) {
        totalChangedLines += 1
        const count = fileHits?.get(ln) ?? 0
        if (count > 0) {
          coveredChangedLines += 1
        } else {
          missed.push(ln)
        }
      }
      if (missed.length > 0) {
        uncoveredLines.push({ file: fileKey, lines: missed })
      }
    }
  }

  const coverageRatio =
    totalChangedLines > 0 ? Number((coveredChangedLines / totalChangedLines).toFixed(4)) : 1.0
  const minRatio = options.minCoverageRatio ?? 0.8
  const passed = tautologicalTests.length === 0 && coverageRatio >= minRatio

  return {
    tautologicalTests,
    uncoveredLines,
    coverageRatio,
    passed,
  }
}

export interface TaskInvariantSpec {
  mustExistFiles?: string[]
  mustContainPatterns?: Array<{ file: string; pattern: RegExp | string }>
  mustNotContainPatterns?: Array<{ file: string; pattern: RegExp | string }>
  minFileSizeBytes?: number
}

export interface TaskInvariantResult {
  passed: boolean
  violations: string[]
}

export function assertTaskInvariants(
  spec: TaskInvariantSpec,
  rootDir: string = process.cwd(),
): TaskInvariantResult {
  const absRoot = resolve(rootDir)
  const violations: string[] = []
  const minBytes = spec.minFileSizeBytes ?? 1

  for (const f of spec.mustExistFiles ?? []) {
    const abs = isAbsolute(f) ? f : resolve(absRoot, f)
    if (!existsSync(abs)) {
      violations.push(`Missing required file: ${f}`)
      continue
    }
    const st = statSync(abs)
    if (st.size < minBytes) {
      violations.push(`File ${f} is smaller than minimum size (${st.size} < ${minBytes} bytes)`)
    }
  }

  for (const item of spec.mustContainPatterns ?? []) {
    const abs = isAbsolute(item.file) ? item.file : resolve(absRoot, item.file)
    if (!existsSync(abs)) {
      violations.push(`Cannot verify pattern in missing file: ${item.file}`)
      continue
    }
    const content = readFileSync(abs, "utf8")
    const matched =
      typeof item.pattern === "string"
        ? content.includes(item.pattern)
        : item.pattern.test(content)
    if (!matched) {
      violations.push(`File ${item.file} does not match required pattern: ${String(item.pattern)}`)
    }
  }

  for (const item of spec.mustNotContainPatterns ?? []) {
    const abs = isAbsolute(item.file) ? item.file : resolve(absRoot, item.file)
    if (!existsSync(abs)) continue
    const content = readFileSync(abs, "utf8")
    const matched =
      typeof item.pattern === "string"
        ? content.includes(item.pattern)
        : item.pattern.test(content)
    if (matched) {
      violations.push(`File ${item.file} contains forbidden pattern: ${String(item.pattern)}`)
    }
  }

  return {
    passed: violations.length === 0,
    violations,
  }
}
