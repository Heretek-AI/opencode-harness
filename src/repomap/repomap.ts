import { existsSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, extname, isAbsolute, join, relative, resolve } from "node:path";
import { computeLineHash } from "../editors/hashline-tools.js";
import {
  beginEditTransaction,
  finalizeEditTransaction,
} from "../transactions/edit-transaction.js";
import { collectFileDiagnostics } from "../diagnostics/diagnostics-runner.js";

export interface SymbolOutlineItem {
  name: string;
  kind:
    | "function"
    | "class"
    | "interface"
    | "type"
    | "const"
    | "enum"
    | "struct"
    | "trait";
  line: number;
  exported: boolean;
  signature: string;
}

export interface FileNode {
  relPath: string;
  absPath: string;
  imports: string[];
  exports: string[];
  symbols: SymbolOutlineItem[];
  score: number;
}

export interface RepoMapResult {
  rootDir: string;
  totalFiles: number;
  rankedFiles: FileNode[];
  edges: Array<{ from: string; to: string }>;
}

export interface BlastRadiusResult {
  targetFile: string;
  symbol?: string;
  directImporters: string[];
  transitiveDependents: string[];
  symbolCallers: Array<{ file: string; line: number; preview: string }>;
  affectedTests: string[];
}

export interface SymbolReferenceMatch {
  file: string;
  line: number;
  lineHash: string;
  kind: "definition" | "import" | "export" | "reference";
  preview: string;
  anchoredLine: string;
}

export interface SymbolReferencesResult {
  symbol: string;
  totalMatches: number;
  definitions: SymbolReferenceMatch[];
  references: SymbolReferenceMatch[];
  formattedBlock: string;
}

export interface SymbolRenameResult {
  oldSymbol: string;
  newSymbol: string;
  applied: boolean;
  rolledBack: boolean;
  modifiedFiles: string[];
  totalReplacements: number;
  diagnosticsErrors: string[];
  formattedBlock: string;
}

const IGNORED_DIRS = new Set([
  ".git",
  "node_modules",
  "dist",
  "build",
  "coverage",
  ".next",
  ".turbo",
  "target",
  "__pycache__",
  ".venv",
  "venv",
]);

const CODE_EXTENSIONS = new Set([
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".py",
  ".go",
  ".rs",
]);

/**
 * Strips comments and multi-line template strings while preserving line breaks
 * and single-line string literals (for module import specifier extraction).
 */
export function stripCommentsAndStringsPreserveLines(source: string): string {
  let out = "";
  let i = 0;
  const n = source.length;
  let state:
    | "code"
    | "line_comment"
    | "block_comment"
    | "single_str"
    | "double_str"
    | "template_str" = "code";

  while (i < n) {
    const ch = source[i];
    const next = i + 1 < n ? source[i + 1] : "";

    if (state === "code") {
      if (ch === "/" && next === "/") {
        state = "line_comment";
        out += "  ";
        i += 2;
        continue;
      }
      if (ch === "/" && next === "*") {
        state = "block_comment";
        out += "  ";
        i += 2;
        continue;
      }
      if (ch === "#") {
        state = "line_comment";
        out += " ";
        i += 1;
        continue;
      }
      if (ch === "'") {
        state = "single_str";
        out += "'";
        i += 1;
        continue;
      }
      if (ch === '"') {
        state = "double_str";
        out += '"';
        i += 1;
        continue;
      }
      if (ch === "`") {
        state = "template_str";
        out += "`";
        i += 1;
        continue;
      }
      out += ch;
      i += 1;
      continue;
    }

    if (state === "line_comment") {
      if (ch === "\n") {
        state = "code";
        out += "\n";
      } else {
        out += " ";
      }
      i += 1;
      continue;
    }

    if (state === "block_comment") {
      if (ch === "*" && next === "/") {
        state = "code";
        out += "  ";
        i += 2;
        continue;
      }
      out += ch === "\n" ? "\n" : " ";
      i += 1;
      continue;
    }

    if (state === "single_str") {
      if (ch === "\\") {
        out += source.slice(i, i + 2);
        i += 2;
        continue;
      }
      if (ch === "'" || ch === "\n") {
        state = "code";
      }
      out += ch;
      i += 1;
      continue;
    }

    if (state === "double_str") {
      if (ch === "\\") {
        out += source.slice(i, i + 2);
        i += 2;
        continue;
      }
      if (ch === '"' || ch === "\n") {
        state = "code";
      }
      out += ch;
      i += 1;
      continue;
    }

    if (state === "template_str") {
      if (ch === "\\") {
        out += "  ";
        i += 2;
        continue;
      }
      if (ch === "`") {
        state = "code";
        out += "`";
        i += 1;
        continue;
      }
      out += ch === "\n" ? "\n" : " ";
      i += 1;
    }
  }

  return out;
}

/**
 * Strips comments AND all string literal bodies (`'...'`, `"..."`, `` `...` ``)
 * to spaces of the exact same character length so character offsets and line
 * numbers in the returned mask match the original source 1-to-1.
 */
export function buildCodeOnlyMask(source: string): string {
  return stripCommentsAndStringsPreserveLines(source)
    .replace(/"(?:\\.|[^"\\\n])*"/g, (m) => `"${" ".repeat(Math.max(0, m.length - 2))}"`)
    .replace(/'(?:\\.|[^'\\\n])*'/g, (m) => `'${" ".repeat(Math.max(0, m.length - 2))}'`);
}

export function extractOutline(
  absPath: string,
  rawContent?: string,
): SymbolOutlineItem[] {
  const content =
    rawContent ?? (existsSync(absPath) ? readFileSync(absPath, "utf8") : "");
  if (!content) return [];

  const stripped = stripCommentsAndStringsPreserveLines(content);
  const lines = stripped.split("\n");
  const rawLines = content.split("\n");
  const items: SymbolOutlineItem[] = [];

  const patterns: Array<{
    kind: SymbolOutlineItem["kind"];
    regex: RegExp;
    exportedGroup?: boolean;
  }> = [
    {
      kind: "function",
      regex:
        /^\s*(export\s+)?(?:default\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/,
      exportedGroup: true,
    },
    {
      kind: "class",
      regex:
        /^\s*(export\s+)?(?:default\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/,
      exportedGroup: true,
    },
    {
      kind: "interface",
      regex: /^\s*(export\s+)?interface\s+([A-Za-z_$][\w$]*)/,
      exportedGroup: true,
    },
    {
      kind: "type",
      regex: /^\s*(export\s+)?type\s+([A-Za-z_$][\w$]*)\s*[=<]/,
      exportedGroup: true,
    },
    {
      kind: "enum",
      regex: /^\s*(export\s+)?(?:const\s+)?enum\s+([A-Za-z_$][\w$]*)/,
      exportedGroup: true,
    },
    {
      kind: "const",
      regex: /^\s*(export\s+)?const\s+([A-Za-z_$][\w$]*)\s*=/,
      exportedGroup: true,
    },
    {
      kind: "function",
      regex: /^\s*(?:async\s+)?def\s+([A-Za-z_][\w]*)\s*\(/,
    },
    {
      kind: "function",
      regex: /^\s*func\s+(?:\([^)]+\)\s+)?([A-Za-z_][\w]*)\s*\(/,
    },
    {
      kind: "function",
      regex: /^\s*(pub(?:\([^)]*\))?\s+)?(?:async\s+)?fn\s+([A-Za-z_][\w]*)/,
      exportedGroup: true,
    },
    {
      kind: "struct",
      regex: /^\s*(pub(?:\([^)]*\))?\s+)?struct\s+([A-Za-z_][\w]*)/,
      exportedGroup: true,
    },
    {
      kind: "trait",
      regex: /^\s*(pub(?:\([^)]*\))?\s+)?trait\s+([A-Za-z_][\w]*)/,
      exportedGroup: true,
    },
  ];

  for (let idx = 0; idx < lines.length; idx++) {
    const line = lines[idx] ?? "";
    for (const pat of patterns) {
      const m = pat.regex.exec(line);
      if (!m) continue;
      const exported = pat.exportedGroup
        ? Boolean(m[1] && m[1].trim().length > 0)
        : !(m[1] ?? "").startsWith("_");
      const name = (pat.exportedGroup ? m[2] : m[1]) ?? "";
      if (!name) continue;
      const rawLine = (rawLines[idx] ?? "").trim().replace(/\s*\{$/, "");
      items.push({
        name,
        kind: pat.kind,
        line: idx + 1,
        exported,
        signature: rawLine.slice(0, 120),
      });
      break;
    }
  }

  return items;
}

function parseRawImportSpecifiers(
  strippedContent: string,
  ext: string,
): string[] {
  const specs = new Set<string>();
  if ([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"].includes(ext)) {
    const importRegex =
      /(?:import|export)\s+(?:type\s+)?(?:[^"'`\n]+?\s+from\s+)?["']([^"']+)["']|require\(\s*["']([^"']+)["']\s*\)|import\(\s*["']([^"']+)["']\s*\)/g;
    let m: RegExpExecArray | null;
    while ((m = importRegex.exec(strippedContent)) !== null) {
      const spec = m[1] ?? m[2] ?? m[3];
      if (spec) specs.add(spec);
    }
  } else if (ext === ".py") {
    const pyRegex =
      /^\s*(?:from\s+([A-Za-z0-9_.]+)\s+import|import\s+([A-Za-z0-9_.]+))/gm;
    let m: RegExpExecArray | null;
    while ((m = pyRegex.exec(strippedContent)) !== null) {
      const spec = m[1] ?? m[2];
      if (spec) specs.add(spec);
    }
  } else if (ext === ".rs") {
    const rsRegex = /^\s*(?:pub\s+)?(?:use|mod)\s+([A-Za-z0-9_:]+)/gm;
    let m: RegExpExecArray | null;
    while ((m = rsRegex.exec(strippedContent)) !== null) {
      if (m[1]) specs.add(m[1]);
    }
  }
  return [...specs];
}

function resolveImportToRelPath(
  fromAbsPath: string,
  specifier: string,
  rootDir: string,
  knownRelPaths: Set<string>,
): string | null {
  if (specifier.startsWith(".")) {
    const baseAbs = resolve(dirname(fromAbsPath), specifier);
    const baseRel = relative(rootDir, baseAbs).replace(/\\/g, "/");
    const stemRel = baseRel.replace(/\.(tsx?|jsx?|mjs|cjs)$/, "");
    const candidates = [
      baseRel,
      `${baseRel}.ts`,
      `${baseRel}.tsx`,
      `${baseRel}.js`,
      `${baseRel}.jsx`,
      `${baseRel}.mjs`,
      `${stemRel}.ts`,
      `${stemRel}.tsx`,
      `${stemRel}.js`,
      `${baseRel}/index.ts`,
      `${baseRel}/index.tsx`,
      `${baseRel}/index.js`,
    ];
    for (const c of candidates) {
      if (knownRelPaths.has(c)) return c;
    }
  } else {
    const slashPath = specifier.replace(/^\.+/, "").replace(/\./g, "/");
    const candidates = [`${slashPath}.py`, `${slashPath}/__init__.py`];
    for (const c of candidates) {
      if (knownRelPaths.has(c)) return c;
    }
  }
  return null;
}

function walkWorkspaceFiles(rootDir: string, maxFiles: number = 1500): string[] {
  const results: string[] = [];
  function visit(dir: string) {
    if (results.length >= maxFiles) return;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch (err) {
      if (err) return;
      return;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (results.length >= maxFiles) break;
      if (entry.isDirectory()) {
        if (IGNORED_DIRS.has(entry.name)) continue;
        visit(join(dir, entry.name));
      } else if (entry.isFile()) {
        const ext = extname(entry.name).toLowerCase();
        if (CODE_EXTENSIONS.has(ext)) {
          results.push(join(dir, entry.name));
        }
      }
    }
  }
  visit(rootDir);
  return results;
}

export function buildRepoMap(
  rootDir: string = process.cwd(),
  maxFiles: number = 1000,
): RepoMapResult {
  const absRoot = resolve(rootDir);
  const absFiles = walkWorkspaceFiles(absRoot, maxFiles);
  const relToAbs = new Map<string, string>();
  const knownRelPaths = new Set<string>();

  for (const abs of absFiles) {
    const rel = relative(absRoot, abs).replace(/\\/g, "/");
    relToAbs.set(rel, abs);
    knownRelPaths.add(rel);
  }

  const nodes = new Map<string, FileNode>();
  const edges: Array<{ from: string; to: string }> = [];

  for (const [rel, abs] of relToAbs.entries()) {
    let raw = "";
    try {
      raw = readFileSync(abs, "utf8");
    } catch (err) {
      if (err) continue;
    }
    const stripped = stripCommentsAndStringsPreserveLines(raw);
    const ext = extname(abs).toLowerCase();
    const rawSpecs = parseRawImportSpecifiers(stripped, ext);
    const resolvedImports: string[] = [];
    for (const spec of rawSpecs) {
      const targetRel = resolveImportToRelPath(
        abs,
        spec,
        absRoot,
        knownRelPaths,
      );
      if (targetRel && targetRel !== rel) {
        resolvedImports.push(targetRel);
        edges.push({ from: rel, to: targetRel });
      }
    }

    const symbols = extractOutline(abs, raw);
    const exports = symbols.filter((s) => s.exported).map((s) => s.name);
    nodes.set(rel, {
      relPath: rel,
      absPath: abs,
      imports: [...new Set(resolvedImports)],
      exports,
      symbols,
      score: 1.0,
    });
  }

  const N = nodes.size;
  if (N > 0) {
    const damping = 0.85;
    const base = (1 - damping) / N;
    const relList = [...nodes.keys()];
    const scores = new Map<string, number>();
    for (const r of relList) scores.set(r, 1 / N);

    for (let iter = 0; iter < 16; iter++) {
      const nextScores = new Map<string, number>();
      let sinkMass = 0;
      for (const r of relList) {
        nextScores.set(r, base);
        const node = nodes.get(r)!;
        if (node.imports.length === 0) {
          sinkMass += scores.get(r) ?? 0;
        }
      }
      const sinkShare = (damping * sinkMass) / N;
      for (const r of relList) {
        nextScores.set(r, (nextScores.get(r) ?? 0) + sinkShare);
      }
      for (const r of relList) {
        const node = nodes.get(r)!;
        const outDeg = node.imports.length;
        if (outDeg === 0) continue;
        const share = (damping * (scores.get(r) ?? 0)) / outDeg;
        for (const target of node.imports) {
          nextScores.set(target, (nextScores.get(target) ?? 0) + share);
        }
      }
      for (const [k, v] of nextScores.entries()) {
        scores.set(k, v);
      }
    }

    for (const [rel, node] of nodes.entries()) {
      node.score = Number(((scores.get(rel) ?? 0) * N).toFixed(4));
    }
  }

  const rankedFiles = [...nodes.values()].sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return a.relPath.localeCompare(b.relPath);
  });

  return {
    rootDir: absRoot,
    totalFiles: rankedFiles.length,
    rankedFiles,
    edges,
  };
}

export function formatRepoMapBlock(
  repoMap: RepoMapResult,
  topK: number = 15,
): string {
  const slice = repoMap.rankedFiles.slice(0, topK);
  const lines = slice.map((n) => {
    const symPreview = n.exports.slice(0, 6).join(", ");
    return `  ${n.relPath} (rank=${n.score.toFixed(2)})${symPreview ? ` -> exports: [${symPreview}]` : ""}`;
  });
  return [
    `<repo-map totalFiles="${repoMap.totalFiles}" shown="${slice.length}">`,
    ...lines,
    `</repo-map>`,
  ].join("\n");
}

export function analyzeBlastRadius(
  targetFilePath: string,
  rootDir: string = process.cwd(),
  symbol?: string,
): BlastRadiusResult {
  const absRoot = resolve(rootDir);
  const absTarget = isAbsolute(targetFilePath)
    ? targetFilePath
    : resolve(absRoot, targetFilePath);
  const relTarget = relative(absRoot, absTarget).replace(/\\/g, "/");

  const map = buildRepoMap(absRoot);
  const reverseAdj = new Map<string, string[]>();
  for (const edge of map.edges) {
    const list = reverseAdj.get(edge.to) ?? [];
    list.push(edge.from);
    reverseAdj.set(edge.to, list);
  }

  const directImporters = [...new Set(reverseAdj.get(relTarget) ?? [])].sort();
  const visited = new Set<string>([relTarget]);
  const queue = [...directImporters];
  const transitiveDependents: string[] = [];

  while (queue.length > 0) {
    const curr = queue.shift()!;
    if (visited.has(curr)) continue;
    visited.add(curr);
    transitiveDependents.push(curr);
    for (const next of reverseAdj.get(curr) ?? []) {
      if (!visited.has(next)) queue.push(next);
    }
  }
  transitiveDependents.sort();

  const affectedTests = transitiveDependents.filter((f) =>
    /(?:\.test\.|\.spec\.|__tests__|\/test\/|^test\/)/i.test(f),
  );

  const symbolCallers: Array<{ file: string; line: number; preview: string }> =
    [];
  if (symbol && symbol.trim().length > 0) {
    const escaped = symbol.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const symRegex = new RegExp(`\\b${escaped}\\b`);
    const searchFiles =
      transitiveDependents.length > 0
        ? transitiveDependents
        : map.rankedFiles.map((f) => f.relPath);
    for (const rel of searchFiles) {
      if (rel === relTarget) continue;
      const abs = resolve(absRoot, rel);
      if (!existsSync(abs)) continue;
      const content = readFileSync(abs, "utf8");
      const lines = content.split("\n");
      for (let i = 0; i < lines.length; i++) {
        if (symRegex.test(lines[i] ?? "")) {
          symbolCallers.push({
            file: rel,
            line: i + 1,
            preview: (lines[i] ?? "").trim().slice(0, 120),
          });
        }
      }
    }
  }

  return {
    targetFile: relTarget,
    symbol,
    directImporters,
    transitiveDependents,
    symbolCallers,
    affectedTests,
  };
}

export function formatBlastRadiusBlock(res: BlastRadiusResult): string {
  const lines: string[] = [
    `<blast-radius target="${res.targetFile}"${res.symbol ? ` symbol="${res.symbol}"` : ""}>`,
    `  directImporters (${res.directImporters.length}): ${res.directImporters.join(", ") || "none"}`,
    `  transitiveDependents (${res.transitiveDependents.length}): ${res.transitiveDependents.join(", ") || "none"}`,
    `  affectedTests (${res.affectedTests.length}): ${res.affectedTests.join(", ") || "none"}`,
  ];
  if (res.symbolCallers.length > 0) {
    lines.push(`  symbolCallers (${res.symbolCallers.length}):`);
    for (const c of res.symbolCallers.slice(0, 15)) {
      lines.push(`    - ${c.file}:${c.line}: ${c.preview}`);
    }
  }
  lines.push(`</blast-radius>`);
  return lines.join("\n");
}

/**
 * Lexer-aware workspace symbol reference finder.
 * Strips comments and string literals before matching whole-word occurrences of
 * `symbol`, classifies each match (`definition`, `import`, `export`, `reference`),
 * and formats each line with its 4-hex FNV-1a hash (`<line>#<hash>| <content>`)
 * so the agent can immediately edit call sites with `file_hash_edit`.
 */
export function findSymbolReferences(
  symbol: string,
  rootDir: string = process.cwd(),
  maxResults: number = 50,
): SymbolReferencesResult {
  const trimmed = symbol.trim();
  if (!trimmed) {
    throw new Error(
      "repomap: findSymbolReferences requires a non-empty symbol name (fail-closed)",
    );
  }

  const absRoot = resolve(rootDir);
  const absFiles = walkWorkspaceFiles(absRoot, 1200);
  const escaped = trimmed.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const wordRegex = new RegExp(`\\b${escaped}\\b`);

  const definitions: SymbolReferenceMatch[] = [];
  const references: SymbolReferenceMatch[] = [];

  for (const abs of absFiles) {
    if (definitions.length + references.length >= maxResults) break;
    let raw = "";
    try {
      raw = readFileSync(abs, "utf8");
    } catch (err) {
      if (err) continue;
    }
    if (!raw.includes(trimmed)) continue;

    const rel = relative(absRoot, abs).replace(/\\/g, "/");
    const stripped = buildCodeOnlyMask(raw);
    const strippedLines = stripped.split("\n");
    const rawLines = raw.split("\n");
    const outline = extractOutline(abs, raw);
    const defLines = new Set(
      outline.filter((s) => s.name === trimmed).map((s) => s.line),
    );

    for (let i = 0; i < strippedLines.length; i++) {
      if (definitions.length + references.length >= maxResults) break;
      const sLine = strippedLines[i] ?? "";
      if (!wordRegex.test(sLine)) continue;

      const lineNo = i + 1;
      const origLine = rawLines[i] ?? "";
      const hash = computeLineHash(origLine);
      const anchoredLine = `${lineNo}#${hash}| ${origLine}`;
      const preview = origLine.trim().slice(0, 140);

      let kind: SymbolReferenceMatch["kind"] = "reference";
      if (defLines.has(lineNo)) {
        kind = "definition";
      } else if (/^\s*import\b/.test(sLine)) {
        kind = "import";
      } else if (/^\s*export\b/.test(sLine)) {
        kind = "export";
      }

      const item: SymbolReferenceMatch = {
        file: rel,
        line: lineNo,
        lineHash: hash,
        kind,
        preview,
        anchoredLine,
      };
      if (kind === "definition") {
        definitions.push(item);
      } else {
        references.push(item);
      }
    }
  }

  const totalMatches = definitions.length + references.length;
  const formattedBlock = formatSymbolReferencesBlock({
    symbol: trimmed,
    totalMatches,
    definitions,
    references,
  });

  return {
    symbol: trimmed,
    totalMatches,
    definitions,
    references,
    formattedBlock,
  };
}

export function formatSymbolReferencesBlock(res: {
  symbol: string;
  totalMatches: number;
  definitions: SymbolReferenceMatch[];
  references: SymbolReferenceMatch[];
}): string {
  const lines: string[] = [
    `<symbol-references symbol="${res.symbol}" total="${res.totalMatches}" definitions="${res.definitions.length}" references="${res.references.length}">`,
  ];
  for (const d of res.definitions) {
    lines.push(`  [DEF] ${d.file}:${d.anchoredLine}`);
  }
  for (const r of res.references.slice(0, 35)) {
    lines.push(`  [${r.kind.toUpperCase()}] ${r.file}:${r.anchoredLine}`);
  }
  lines.push(`</symbol-references>`);
  return lines.join("\n");
}

/**
 * Lexer-safe, atomic multi-file symbol rename engine (`renameSymbolAcrossWorkspace`).
 *
 * Replaces whole-word identifier occurrences of `oldSymbol` with `newSymbol`
 * ONLY where the character-aligned `buildCodeOnlyMask` confirms the token is in
 * live code (never inside comments or string literals). Wraps all touched files
 * in an atomic transaction (`beginEditTransaction` / `finalizeEditTransaction`)
 * and verifies every modified file with `collectFileDiagnostics`, rolling back
 * all files if any syntax or cross-file import/export error is introduced.
 */
export function renameSymbolAcrossWorkspace(
  oldSymbol: string,
  newSymbol: string,
  rootDir: string = process.cwd(),
  sessionId: string = "rename-tx",
): SymbolRenameResult {
  const fromSym = oldSymbol.trim();
  const toSym = newSymbol.trim();
  const identRe = /^[A-Za-z_$][\w$]*$/;

  if (!identRe.test(fromSym) || !identRe.test(toSym)) {
    throw new Error(
      `renameSymbolAcrossWorkspace: both oldSymbol (${JSON.stringify(oldSymbol)}) and newSymbol (${JSON.stringify(newSymbol)}) must be valid identifiers (fail-closed)`,
    );
  }
  if (fromSym === toSym) {
    throw new Error(
      "renameSymbolAcrossWorkspace: newSymbol must differ from oldSymbol (fail-closed)",
    );
  }

  const absRoot = resolve(rootDir);
  const absFiles = walkWorkspaceFiles(absRoot, 1200);
  const escaped = fromSym.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const wordGlobalRe = new RegExp(`\\b${escaped}\\b`, "g");

  const plannedWrites: Array<{
    absPath: string;
    relPath: string;
    updatedContent: string;
    replacements: number;
  }> = [];

  for (const abs of absFiles) {
    let raw = "";
    try {
      raw = readFileSync(abs, "utf8");
    } catch (err) {
      if (err) continue;
    }
    if (!raw.includes(fromSym)) continue;

    const codeMask = buildCodeOnlyMask(raw);
    const spans: Array<{ start: number; end: number }> = [];
    let m: RegExpExecArray | null;
    while ((m = wordGlobalRe.exec(codeMask)) !== null) {
      spans.push({ start: m.index, end: m.index + fromSym.length });
    }
    if (spans.length === 0) continue;

    let updated = raw;
    for (let i = spans.length - 1; i >= 0; i--) {
      const sp = spans[i]!;
      updated = updated.slice(0, sp.start) + toSym + updated.slice(sp.end);
    }

    if (updated !== raw) {
      plannedWrites.push({
        absPath: abs,
        relPath: relative(absRoot, abs).replace(/\\/g, "/"),
        updatedContent: updated,
        replacements: spans.length,
      });
    }
  }

  if (plannedWrites.length === 0) {
    return {
      oldSymbol: fromSym,
      newSymbol: toSym,
      applied: false,
      rolledBack: false,
      modifiedFiles: [],
      totalReplacements: 0,
      diagnosticsErrors: [],
      formattedBlock: `<symbol-rename from="${fromSym}" to="${toSym}" status="noop" files="0" replacements="0" />`,
    };
  }

  beginEditTransaction(
    sessionId,
    "rename_symbol",
    plannedWrites.map((p) => p.absPath),
    absRoot,
  );

  let totalReplacements = 0;
  for (const item of plannedWrites) {
    writeFileSync(item.absPath, item.updatedContent, "utf8");
    totalReplacements += item.replacements;
  }

  const diagnosticsErrors: string[] = [];
  for (const item of plannedWrites) {
    const diag = collectFileDiagnostics(item.absPath, absRoot);
    if (!diag.clean) {
      for (const d of diag.diagnostics) {
        diagnosticsErrors.push(
          `${item.relPath}:${d.line}:${d.column} (${d.source}) - ${d.message}`,
        );
      }
    }
  }

  if (diagnosticsErrors.length > 0) {
    finalizeEditTransaction(sessionId, false);
    const formattedBlock = [
      `<symbol-rename from="${fromSym}" to="${toSym}" status="rolled-back" errors="${diagnosticsErrors.length}">`,
      ...diagnosticsErrors.slice(0, 10).map((e) => `  [ERROR] ${e}`),
      `</symbol-rename>`,
    ].join("\n");
    return {
      oldSymbol: fromSym,
      newSymbol: toSym,
      applied: false,
      rolledBack: true,
      modifiedFiles: [],
      totalReplacements: 0,
      diagnosticsErrors,
      formattedBlock,
    };
  }

  finalizeEditTransaction(sessionId, true);
  const modifiedFiles = plannedWrites.map((p) => p.relPath).sort();
  const formattedBlock = [
    `<symbol-rename from="${fromSym}" to="${toSym}" status="applied" files="${modifiedFiles.length}" replacements="${totalReplacements}">`,
    ...modifiedFiles.map((f) => `  - ${f}`),
    `</symbol-rename>`,
  ].join("\n");

  return {
    oldSymbol: fromSym,
    newSymbol: toSym,
    applied: true,
    rolledBack: false,
    modifiedFiles,
    totalReplacements,
    diagnosticsErrors: [],
    formattedBlock,
  };
}

/**
 * Safely moves a TypeScript/JavaScript module and rewrites relative imports both inside
 * the moved file and across all importing files in the workspace.
 */
export function moveModuleAndRewriteImports(
  fromPath: string,
  toPath: string,
  rootDir: string = process.cwd(),
): { movedFrom: string; movedTo: string; updatedFiles: string[] } {
  const absRoot = resolve(rootDir);
  const absFrom = isAbsolute(fromPath) ? fromPath : resolve(absRoot, fromPath);
  const absTo = isAbsolute(toPath) ? toPath : resolve(absRoot, toPath);

  if (!existsSync(absFrom)) {
    throw new Error(`Source module does not exist: ${absFrom}`);
  }

  const map = buildRepoMap(absRoot);
  const relFrom = relative(absRoot, absFrom).replace(/\\/g, "/");
  const relTo = relative(absRoot, absTo).replace(/\\/g, "/");
  const updatedFiles: string[] = [];

  const knownRelPaths = new Set(map.rankedFiles.map((n) => n.relPath));

  for (const node of map.rankedFiles) {
    if (node.relPath === relFrom) continue;
    if (!node.imports.includes(relFrom)) continue;

    const raw = readFileSync(node.absPath, "utf8");
    const rewritten = raw.replace(
      /((?:import|export)\s+(?:type\s+)?(?:[^"'`\n]+?\s+from\s+)?["'])([^"']+)(["'])/g,
      (full, prefix: string, spec: string, suffix: string) => {
        const resolved = resolveImportToRelPath(
          node.absPath,
          spec,
          absRoot,
          knownRelPaths,
        );
        if (resolved !== relFrom) return full;
        let newRel = relative(dirname(node.absPath), absTo).replace(/\\/g, "/");
        newRel = newRel.replace(/\.(tsx?|jsx?|mjs|cjs)$/, "");
        if (!newRel.startsWith(".")) newRel = `./${newRel}`;
        return `${prefix}${newRel}${suffix}`;
      },
    );
    if (rewritten !== raw) {
      writeFileSync(node.absPath, rewritten, "utf8");
      updatedFiles.push(node.relPath);
    }
  }

  renameSync(absFrom, absTo);
  return {
    movedFrom: relFrom,
    movedTo: relTo,
    updatedFiles,
  };
}
