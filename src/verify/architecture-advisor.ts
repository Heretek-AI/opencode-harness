/**
 * `src/verify/architecture-advisor.ts` — Systems engineering and code quality
 * advisor for OpenCode V2 agents.
 *
 * Helps agents engineer cleaner systems and avoid architectural degradation:
 * 1. Tarjan's Strongly Connected Components (SCC) circular dependency detector
 *    over the workspace import graph (`detectCircularDependencies`).
 * 2. Pre/post-mutation exported contract signature diffing (`evaluateContractChangeImpact`)
 *    paired with `analyzeBlastRadius` so agents immediately see every downstream
 *    caller affected when they change an exported function, class, or type signature.
 * 3. File-level engineering quality scanner (`scanFileEngineeringQuality`) that flags
 *    empty catch blocks, god-files (>650 lines), and high-arity functions.
 * 4. Dead export and orphaned internal module detector (`detectUnusedExportsAndOrphanModules`)
 *    to prevent dead-code accumulation during multi-turn refactors.
 */

import { existsSync, readFileSync } from "node:fs";
import { basename, isAbsolute, relative, resolve } from "node:path";
import {
  analyzeBlastRadius,
  buildCodeOnlyMask,
  buildRepoMap,
  extractOutline,
  stripCommentsAndStringsPreserveLines,
  type SymbolOutlineItem,
} from "../repomap/repomap.js";

export interface CircularDependencyCycle {
  files: string[];
  formatted: string;
}

export interface ContractChangeImpact {
  file: string;
  changedExports: Array<{
    name: string;
    kind: string;
    beforeSignature?: string;
    afterSignature?: string;
    changeType: "modified" | "removed" | "added";
  }>;
  affectedImporters: string[];
  affectedTests: string[];
  symbolCallers: Array<{ file: string; line: number; preview: string }>;
  formattedTag: string;
}

export interface EngineeringSmell {
  file: string;
  line: number;
  kind:
    | "empty-catch"
    | "god-file"
    | "high-parameter-count"
    | "unhandled-json-parse"
    | "console-debug-leftover";
  message: string;
}

export interface DeadExportReport {
  unusedExports: Array<{ file: string; symbol: string; line: number }>;
  orphanModules: string[];
}

export interface ArchitectureAuditReport {
  rootDir: string;
  totalFiles: number;
  cycles: CircularDependencyCycle[];
  smells: EngineeringSmell[];
  godFiles: Array<{ file: string; lines: number; exportCount: number }>;
  unusedExports: Array<{ file: string; symbol: string; line: number }>;
  orphanModules: string[];
  healthy: boolean;
  formattedReport: string;
}

/**
 * Finds all non-trivial strongly connected components (cycles of length >= 2)
 * in the workspace module dependency graph using Tarjan's SCC algorithm.
 */
export function detectCircularDependencies(
  rootDir: string = process.cwd(),
): CircularDependencyCycle[] {
  const map = buildRepoMap(rootDir);
  const adj = new Map<string, string[]>();
  for (const node of map.rankedFiles) {
    adj.set(node.relPath, node.imports);
  }

  let index = 0;
  const indices = new Map<string, number>();
  const lowlink = new Map<string, number>();
  const onStack = new Set<string>();
  const stack: string[] = [];
  const cycles: CircularDependencyCycle[] = [];

  function strongConnect(v: string): void {
    indices.set(v, index);
    lowlink.set(v, index);
    index += 1;
    stack.push(v);
    onStack.add(v);

    for (const w of adj.get(v) ?? []) {
      if (!adj.has(w)) continue;
      if (!indices.has(w)) {
        strongConnect(w);
        lowlink.set(v, Math.min(lowlink.get(v)!, lowlink.get(w)!));
      } else if (onStack.has(w)) {
        lowlink.set(v, Math.min(lowlink.get(v)!, indices.get(w)!));
      }
    }

    if (lowlink.get(v) === indices.get(v)) {
      const scc: string[] = [];
      while (stack.length > 0) {
        const w = stack.pop()!;
        onStack.delete(w);
        scc.push(w);
        if (w === v) break;
      }
      if (scc.length > 1) {
        const ordered = [...scc].reverse();
        const cyclePath = [...ordered, ordered[0]!];
        cycles.push({
          files: ordered,
          formatted: cyclePath.join(" -> "),
        });
      }
    }
  }

  for (const node of map.rankedFiles) {
    if (!indices.has(node.relPath)) {
      strongConnect(node.relPath);
    }
  }

  return cycles;
}

/**
 * Compares the exported symbol outline of a file before and after an edit.
 * When an exported symbol is removed or its signature changes, computes the
 * downstream blast radius (importers, callers, and affected tests).
 */
export function evaluateContractChangeImpact(params: {
  filePath: string;
  beforeContent: string;
  afterContent: string;
  rootDir?: string;
}): ContractChangeImpact | null {
  const rootDir = resolve(params.rootDir ?? process.cwd());
  const absPath = isAbsolute(params.filePath)
    ? params.filePath
    : resolve(rootDir, params.filePath);
  const relPath = relative(rootDir, absPath).replace(/\\/g, "/");

  const beforeOutline = extractOutline(absPath, params.beforeContent).filter(
    (s) => s.exported,
  );
  const afterOutline = extractOutline(absPath, params.afterContent).filter(
    (s) => s.exported,
  );

  const beforeByName = new Map<string, SymbolOutlineItem>();
  for (const item of beforeOutline) beforeByName.set(item.name, item);

  const afterByName = new Map<string, SymbolOutlineItem>();
  for (const item of afterOutline) afterByName.set(item.name, item);

  const changedExports: ContractChangeImpact["changedExports"] = [];

  for (const [name, beforeSym] of beforeByName.entries()) {
    const afterSym = afterByName.get(name);
    if (!afterSym) {
      changedExports.push({
        name,
        kind: beforeSym.kind,
        beforeSignature: beforeSym.signature,
        changeType: "removed",
      });
    } else if (
      normalizeSignature(beforeSym.signature) !==
      normalizeSignature(afterSym.signature)
    ) {
      changedExports.push({
        name,
        kind: beforeSym.kind,
        beforeSignature: beforeSym.signature,
        afterSignature: afterSym.signature,
        changeType: "modified",
      });
    }
  }

  if (changedExports.length === 0) {
    return null;
  }

  const primarySymbol = changedExports[0]?.name;
  const blast = analyzeBlastRadius(relPath, rootDir, primarySymbol);

  if (
    blast.directImporters.length === 0 &&
    blast.symbolCallers.length === 0
  ) {
    return null;
  }

  const changeLines = changedExports.map((c) =>
    c.changeType === "removed"
      ? `  - [REMOVED EXPORT] ${c.kind} ${c.name} (was: ${c.beforeSignature})`
      : `  - [SIGNATURE CHANGED] ${c.kind} ${c.name}: "${c.beforeSignature}" -> "${c.afterSignature}"`,
  );

  const callerLines = blast.symbolCallers
    .slice(0, 8)
    .map((c) => `  - Caller at ${c.file}:${c.line}: ${c.preview}`);

  const formattedTag = [
    `<contract-impact file="${relPath}" importers="${blast.directImporters.length}" tests="${blast.affectedTests.length}">`,
    ...changeLines,
    ...(blast.directImporters.length > 0
      ? [`  Direct importers to verify: ${blast.directImporters.join(", ")}`]
      : []),
    ...(blast.affectedTests.length > 0
      ? [`  Affected tests to run: ${blast.affectedTests.join(", ")}`]
      : []),
    ...callerLines,
    `</contract-impact>`,
  ].join("\n");

  return {
    file: relPath,
    changedExports,
    affectedImporters: blast.directImporters,
    affectedTests: blast.affectedTests,
    symbolCallers: blast.symbolCallers,
    formattedTag,
  };
}

function normalizeSignature(sig: string): string {
  return sig.replace(/\s+/g, " ").trim();
}

/**
 * Scans a source file for structural engineering smells (empty catch blocks,
 * oversized god-files, and excessive parameter lists).
 */
export function scanFileEngineeringQuality(
  filePath: string,
  rootDir: string = process.cwd(),
  rawContent?: string,
): EngineeringSmell[] {
  const absRoot = resolve(rootDir);
  const absPath = isAbsolute(filePath) ? filePath : resolve(absRoot, filePath);
  const relPath = relative(absRoot, absPath).replace(/\\/g, "/");

  const content =
    rawContent ?? (existsSync(absPath) ? readFileSync(absPath, "utf8") : "");
  if (!content) return [];

  const smells: EngineeringSmell[] = [];
  const lines = content.split("\n");

  if (lines.length > 650) {
    smells.push({
      file: relPath,
      line: 1,
      kind: "god-file",
      message: `File has ${lines.length} lines (>650 line modularity threshold); consider extracting cohesive submodules.`,
    });
  }

  const stripped = stripCommentsAndStringsPreserveLines(content);
  const strippedLines = stripped.split("\n");

  for (let i = 0; i < strippedLines.length; i++) {
    const line = strippedLines[i] ?? "";

    if (/\bcatch\s*(?:\([^)]*\))?\s*\{\s*\}/.test(line)) {
      smells.push({
        file: relPath,
        line: i + 1,
        kind: "empty-catch",
        message:
          "Empty catch block silently swallows runtime errors; handle or rethrow with context.",
      });
      continue;
    }

    // Multi-line empty catch (`} catch (err) {` … `}` on a later line, the
    // dominant formatting style): track brace depth from the opener; when
    // the block closes with no non-blank content inside, it is the same
    // smell as the single-line form (OH-7.2-multiline-empty-catch-missed).
    if (/\bcatch\s*(?:\([^)]*\))?\s*\{\s*$/.test(line)) {
      let depth = 1;
      let j = i + 1;
      let onlyBlank = true;
      for (; j < strippedLines.length && j < i + 1 + 50; j++) {
        const inner = strippedLines[j] ?? "";
        for (const ch of inner) {
          if (ch === "{") {
            depth++;
          } else if (ch === "}") {
            depth--;
          }
        }
        if (depth === 0) {
          break;
        }
        if (inner.trim() !== "") {
          onlyBlank = false;
        }
      }
      if (depth === 0 && onlyBlank) {
        smells.push({
          file: relPath,
          line: i + 1,
          kind: "empty-catch",
          message:
            "Empty catch block silently swallows runtime errors; handle or rethrow with context.",
        });
      }
    }

    const fnParamMatch =
      /\b(?:function\s+[A-Za-z_$][\w$]*|def\s+[A-Za-z_][\w]*|fn\s+[A-Za-z_][\w]*)\s*\(([^)]+)\)/.exec(
        line,
      );
    if (fnParamMatch && fnParamMatch[1]) {
      const params = fnParamMatch[1]
        .split(",")
        .map((p) => p.trim())
        .filter(Boolean);
      if (params.length >= 7) {
        smells.push({
          file: relPath,
          line: i + 1,
          kind: "high-parameter-count",
          message: `Function declares ${params.length} positional parameters; prefer a typed options/parameter object.`,
        });
      }
    }
  }

  return smells;
}

const ENTRYPOINT_BASENAMES = new Set([
  "index.ts",
  "index.tsx",
  "index.js",
  "main.ts",
  "main.js",
  "cli.ts",
  "cli.js",
  "app.ts",
  "mod.ts",
]);

/**
 * Detects unused exported symbols and orphaned internal modules (zero incoming
 * imports across the workspace, excluding top-level entrypoints and test files).
 */
export function detectUnusedExportsAndOrphanModules(
  rootDir: string = process.cwd(),
): DeadExportReport {
  const absRoot = resolve(rootDir);
  const map = buildRepoMap(absRoot);

  const incomingCount = new Map<string, number>();
  for (const edge of map.edges) {
    incomingCount.set(edge.to, (incomingCount.get(edge.to) ?? 0) + 1);
  }

  const codeMasksByFile = new Map<string, string>();
  const barrelReExports = new Set<string>();

  for (const node of map.rankedFiles) {
    try {
      const raw = readFileSync(node.absPath, "utf8");
      codeMasksByFile.set(node.relPath, buildCodeOnlyMask(raw));
      const starRe = /\bexport\s+\*\s+from\s+["']([^"']+)["']/g;
      let m: RegExpExecArray | null;
      while ((m = starRe.exec(raw)) !== null) {
        for (const imp of node.imports) {
          barrelReExports.add(imp);
        }
      }
    } catch (err) {
      if (err) continue;
    }
  }

  const orphanModules: string[] = [];
  const unusedExports: Array<{ file: string; symbol: string; line: number }> =
    [];

  for (const node of map.rankedFiles) {
    const base = basename(node.relPath).toLowerCase();
    const isTest = /(?:\.test\.|\.spec\.|__tests__|\/test\/|^test\/)/i.test(
      node.relPath,
    );
    const isEntrypoint = ENTRYPOINT_BASENAMES.has(base) || isTest;

    if (!isEntrypoint && (incomingCount.get(node.relPath) ?? 0) === 0) {
      orphanModules.push(node.relPath);
    }

    // If re-exported via `export * from` in a barrel (like index.ts), its exports are part of the public package surface
    if (isEntrypoint || barrelReExports.has(node.relPath)) {
      continue;
    }

    for (const sym of node.symbols) {
      if (!sym.exported) continue;
      const escaped = sym.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const wordRe = new RegExp(`\\b${escaped}\\b`);
      let usedInOtherFile = false;

      for (const [otherRel, mask] of codeMasksByFile.entries()) {
        if (otherRel === node.relPath) continue;
        if (wordRe.test(mask)) {
          usedInOtherFile = true;
          break;
        }
      }

      if (!usedInOtherFile) {
        unusedExports.push({
          file: node.relPath,
          symbol: sym.name,
          line: sym.line,
        });
      }
    }
  }

  return {
    unusedExports,
    orphanModules: orphanModules.sort(),
  };
}

export function runArchitectureAudit(
  rootDir: string = process.cwd(),
  targetFiles?: string[],
): ArchitectureAuditReport {
  const absRoot = resolve(rootDir);
  const map = buildRepoMap(absRoot);
  const cycles = detectCircularDependencies(absRoot);
  const dead = detectUnusedExportsAndOrphanModules(absRoot);

  const filesToScan =
    targetFiles && targetFiles.length > 0
      ? targetFiles
      : map.rankedFiles.map((f) => f.relPath);

  const smells: EngineeringSmell[] = [];
  const godFiles: Array<{ file: string; lines: number; exportCount: number }> =
    [];

  for (const f of filesToScan) {
    const abs = isAbsolute(f) ? f : resolve(absRoot, f);
    if (!existsSync(abs)) continue;
    const raw = readFileSync(abs, "utf8");
    const lineCount = raw.split("\n").length;
    const fileSmells = scanFileEngineeringQuality(abs, absRoot, raw);
    smells.push(...fileSmells);

    if (lineCount > 650) {
      const node = map.rankedFiles.find((n) => n.absPath === abs);
      godFiles.push({
        file: relative(absRoot, abs).replace(/\\/g, "/"),
        lines: lineCount,
        exportCount: node?.exports.length ?? 0,
      });
    }
  }

  const healthy = cycles.length === 0 && smells.length === 0;
  const reportLines: string[] = [
    `<architecture-audit status="${healthy ? "healthy" : "warnings"}" files="${map.totalFiles}" cycles="${cycles.length}" smells="${smells.length}" unusedExports="${dead.unusedExports.length}" orphanModules="${dead.orphanModules.length}">`,
  ];

  if (cycles.length > 0) {
    reportLines.push(`  <circular-dependencies count="${cycles.length}">`);
    for (const c of cycles.slice(0, 10)) {
      reportLines.push(`    - ${c.formatted}`);
    }
    reportLines.push(`  </circular-dependencies>`);
  }

  if (smells.length > 0) {
    reportLines.push(`  <engineering-smells count="${smells.length}">`);
    for (const s of smells.slice(0, 15)) {
      reportLines.push(`    - [${s.kind}] ${s.file}:${s.line}: ${s.message}`);
    }
    reportLines.push(`  </engineering-smells>`);
  }

  if (dead.unusedExports.length > 0) {
    reportLines.push(`  <unused-exports count="${dead.unusedExports.length}">`);
    for (const u of dead.unusedExports.slice(0, 15)) {
      reportLines.push(`    - ${u.file}:${u.line} (${u.symbol})`);
    }
    reportLines.push(`  </unused-exports>`);
  }

  if (dead.orphanModules.length > 0) {
    reportLines.push(`  <orphan-modules count="${dead.orphanModules.length}">`);
    for (const m of dead.orphanModules.slice(0, 15)) {
      reportLines.push(`    - ${m}`);
    }
    reportLines.push(`  </orphan-modules>`);
  }

  reportLines.push(`</architecture-audit>`);

  return {
    rootDir: absRoot,
    totalFiles: map.totalFiles,
    cycles,
    smells,
    godFiles,
    unusedExports: dead.unusedExports,
    orphanModules: dead.orphanModules,
    healthy,
    formattedReport: reportLines.join("\n"),
  };
}
