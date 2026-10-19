/**
 * `src/diagnostics/import-verifier.ts` — Fast, zero-subprocess cross-file
 * relative import and named-export contract verifier for TypeScript/JavaScript.
 *
 * Single-file syntax parsers (`Bun.Transpiler`, `@babel/core`, `node --check`)
 * only validate syntax in isolation and cannot see when an agent:
 * 1. Imports a relative path (`./missing.js`) that does not exist on disk.
 * 2. Imports a named symbol (`import { missingFn } from "./utils.js"`) that
 *    the target module does not export (or removed during refactoring).
 *
 * This module resolves relative specifiers using TypeScript ESM rules
 * (`.js` -> `.ts`/`.tsx`, extensionless `.ts`/`.tsx`/`.js`, `/index.ts`) and
 * checks named imports against the target file's exported symbols (including
 * transitive `export * from` and `export { a as b } from` re-exports).
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, dirname, extname, resolve } from "node:path";
import { stripCommentsAndStringsPreserveLines } from "../repomap/repomap.js";
import type { FileDiagnostic } from "./diagnostics-runner.js";

export interface ParsedNamedImport {
  importedName: string;
  localName: string;
  isTypeOnly: boolean;
}

export interface ParsedImportStatement {
  specifier: string;
  line: number;
  column: number;
  isTypeOnlyStatement: boolean;
  hasNamespaceOrDefault: boolean;
  namedImports: ParsedNamedImport[];
}

const TS_JS_EXTENSIONS = new Set([
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
]);

/**
 * Resolves a relative module specifier (`./foo`, `./foo.js`, `../bar`) from
 * `fromAbsPath` to an existing file on disk following TypeScript/Node ESM rules.
 */
export function resolveRelativeModuleFile(
  fromAbsPath: string,
  specifier: string,
): string | null {
  if (!specifier.startsWith(".")) return null;
  const baseDir = dirname(fromAbsPath);
  const rawTarget = resolve(baseDir, specifier);

  // 1. Exact match if it has an extension and exists as a file
  const ext = extname(rawTarget);
  if (ext && existsSync(rawTarget)) {
    return rawTarget;
  }

  // 2. TypeScript ESM resolution: `.js` / `.jsx` / `.mjs` -> `.ts` / `.tsx` / `.d.ts`
  if (ext === ".js" || ext === ".mjs" || ext === ".cjs") {
    const stem = rawTarget.slice(0, -ext.length);
    for (const candidateExt of [".ts", ".tsx", ".d.ts", ".js", ".jsx"]) {
      const candidate = `${stem}${candidateExt}`;
      if (existsSync(candidate)) return candidate;
    }
  } else if (ext === ".jsx") {
    const stem = rawTarget.slice(0, -ext.length);
    for (const candidateExt of [".tsx", ".ts", ".jsx", ".js"]) {
      const candidate = `${stem}${candidateExt}`;
      if (existsSync(candidate)) return candidate;
    }
  }

  // 3. Extensionless resolution
  if (!ext) {
    for (const candidateExt of [
      ".ts",
      ".tsx",
      ".js",
      ".jsx",
      ".mjs",
      ".cjs",
      ".d.ts",
      ".json",
    ]) {
      const candidate = `${rawTarget}${candidateExt}`;
      if (existsSync(candidate)) return candidate;
    }
    for (const indexFile of [
      "index.ts",
      "index.tsx",
      "index.js",
      "index.jsx",
      "index.mjs",
      "index.d.ts",
    ]) {
      const candidate = resolve(rawTarget, indexFile);
      if (existsSync(candidate)) return candidate;
    }
  }

  return null;
}

function suggestSiblingModule(fromAbsPath: string, specifier: string): string | null {
  try {
    const targetPath = resolve(dirname(fromAbsPath), specifier);
    const dir = dirname(targetPath);
    if (!existsSync(dir)) return null;
    const reqStem = basename(specifier)
      .replace(/\.(tsx?|jsx?|mjs|cjs|json)$/, "")
      .toLowerCase();
    if (!reqStem) return null;

    const entries = readdirSync(dir);
    for (const entry of entries) {
      const stem = entry
        .replace(/\.(tsx?|jsx?|mjs|cjs|json)$/, "")
        .toLowerCase();
      if (
        stem === reqStem ||
        stem.includes(reqStem) ||
        reqStem.includes(stem)
      ) {
        return entry;
      }
    }
  } catch (err) {
    if (err) return null;
  }
  return null;
}

/**
 * Parses relative `import ... from "./x.js"` and `export { ... } from "./x.js"`
 * statements from a TypeScript/JavaScript source string.
 */
export function parseRelativeImportStatements(
  rawContent: string,
): ParsedImportStatement[] {
  if (rawContent.length > 500000) {
    rawContent = rawContent.slice(0, 500000);
  }
  const stripped = stripCommentsAndStringsPreserveLines(rawContent);
  const statements: ParsedImportStatement[] = [];

  const stmtRegex =
    /\b(import|export)\s+(type\s+)?([\s\S]{0,2000}?)\s+from\s+["'](\.[^"']{1,500})["']/g;
  let match: RegExpExecArray | null;

  while ((match = stmtRegex.exec(stripped)) !== null) {
    const isTypeOnlyStatement = Boolean(match[2] && match[2].trim() === "type");
    const clause = (match[3] ?? "").trim();
    const specifier = (match[4] ?? "").trim();
    if (!specifier) continue;

    // Guard against matching across multiple statements if `from` appeared later
    if (clause.includes(";") || /\b(?:import|export)\b/.test(clause)) {
      continue;
    }

    const prefix = stripped.slice(0, match.index);
    const prefixLines = prefix.split("\n");
    const line = prefixLines.length;
    const column = (prefixLines[prefixLines.length - 1]?.length ?? 0) + 1;

    const namedImports: ParsedNamedImport[] = [];
    let hasNamespaceOrDefault = false;

    const braceOpen = clause.indexOf("{");
    const braceClose = braceOpen === -1 ? -1 : clause.indexOf("}", braceOpen + 1);
    const braceBody =
      braceOpen !== -1 && braceClose !== -1 && braceClose - braceOpen - 1 <= 2000
        ? clause.slice(braceOpen + 1, braceClose)
        : undefined;
    if (braceBody !== undefined) {
      const outsideBraces = (clause.slice(0, braceOpen) + clause.slice(braceClose + 1)).replace(/,/g, "").trim();
      if (outsideBraces.length > 0) {
        hasNamespaceOrDefault = true;
      }
      const items = braceBody
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
      for (const item of items) {
        let cleaned = item;
        let itemTypeOnly = isTypeOnlyStatement;
        if (cleaned.startsWith("type ")) {
          itemTypeOnly = true;
          cleaned = cleaned.slice(5).trim();
        }
        const asParts = cleaned.split(/[ \t]{1,100}as[ \t]{1,100}/);
        const importedName = (asParts[0] ?? "").trim();
        const localName = (asParts[1] ?? importedName).trim();
        if (
          importedName &&
          importedName !== "default" &&
          /^[A-Za-z_$][\w$]*$/.test(importedName)
        ) {
          namedImports.push({
            importedName,
            localName,
            isTypeOnly: itemTypeOnly,
          });
        } else if (importedName === "default") {
          hasNamespaceOrDefault = true;
        }
      }
    } else {
      hasNamespaceOrDefault = true;
    }

    statements.push({
      specifier,
      line,
      column,
      isTypeOnlyStatement,
      hasNamespaceOrDefault,
      namedImports,
    });
  }

  return statements;
}

/**
 * Collects all exported symbol names from a TypeScript/JavaScript module,
 * following `export * from "./sub.js"` and `export { a, b as c } from "./sub.js"`
 * re-exports up to `maxDepth`.
 */
export function collectExportedSymbolNames(
  absPath: string,
  visited: Set<string> = new Set(),
  depth: number = 0,
): { names: Set<string>; hasWildcardExternal: boolean } {
  const names = new Set<string>();
  if (depth > 4 || visited.has(absPath) || !existsSync(absPath)) {
    return { names, hasWildcardExternal: false };
  }
  visited.add(absPath);

  let raw = "";
  try {
    raw = readFileSync(absPath, "utf8");
  } catch (err) {
    if (err) return { names, hasWildcardExternal: false };
    return { names, hasWildcardExternal: false };
  }

  const stripped = stripCommentsAndStringsPreserveLines(raw);
  let hasWildcardExternal = false;

  // 1. Direct declaration exports: export [async] function/class/interface/type/enum/const/let/var Name
  const declRe =
    /\bexport\s+(?:declare\s+)?(?:default\s+)?(?:abstract\s+)?(?:async\s+)?(?:const\s+enum|enum|function|class|interface|type|const|let|var)\s+([A-Za-z_$][\w$]*)/g;
  let m: RegExpExecArray | null;
  while ((m = declRe.exec(stripped)) !== null) {
    if (m[1]) names.add(m[1]);
  }

  // 2. Destructured object/array const exports: export const { a, b: c } = ...
  const destructRe = /\bexport\s+(?:const|let|var)\s+\{([^}]+)\}/g;
  while ((m = destructRe.exec(stripped)) !== null) {
    if (m[1]) {
      for (const part of m[1].split(",")) {
        const kv = part.split(":");
        const target = (kv[1] ?? kv[0] ?? "").split("=")[0]?.trim() ?? "";
        if (/^[A-Za-z_$][\w$]*$/.test(target)) {
          names.add(target);
        }
      }
    }
  }

  // 3. Export lists: export [type] { a, b as c } [from "..."]
  const exportListRe = /\bexport\s+(?:type\s+)?\{([\s\S]{0,2000}?)\}/g;
  while ((m = exportListRe.exec(stripped)) !== null) {
    if (m[1]) {
      for (const item of m[1].split(",")) {
        const cleaned = item.trim().replace(/^type\s+/, "").trim();
        if (!cleaned) continue;
        const asParts = cleaned.split(/[ \t]{1,100}as[ \t]{1,100}/);
        const exportedName = (asParts[1] ?? asParts[0] ?? "").trim();
        if (/^[A-Za-z_$][\w$]*$/.test(exportedName)) {
          names.add(exportedName);
        }
      }
    }
  }

  // 4. Namespace re-exports: export * as ns from "..."
  const nsReExportRe = /\bexport\s+\*\s+as\s+([A-Za-z_$][\w$]*)\s+from\s+["'][^"']+["']/g;
  while ((m = nsReExportRe.exec(stripped)) !== null) {
    if (m[1]) names.add(m[1]);
  }

  // 5. Wildcard re-exports: export * from "./sub.js"
  const starReExportRe = /\bexport\s+\*\s+from\s+["']([^"']+)["']/g;
  while ((m = starReExportRe.exec(stripped)) !== null) {
    const spec = (m[1] ?? "").trim();
    if (!spec) continue;
    if (spec.startsWith(".")) {
      const targetAbs = resolveRelativeModuleFile(absPath, spec);
      if (targetAbs) {
        const sub = collectExportedSymbolNames(targetAbs, visited, depth + 1);
        for (const n of sub.names) names.add(n);
        if (sub.hasWildcardExternal) hasWildcardExternal = true;
      }
    } else {
      hasWildcardExternal = true;
    }
  }

  if (/\bexport\s+default\b/.test(stripped)) {
    names.add("default");
  }

  return { names, hasWildcardExternal };
}

/**
 * Verifies all relative imports and named exports in `absPath`.
 * Returns `FileDiagnostic[]` for any broken relative module path or missing named export.
 */
export function verifyModuleImportsAndExports(
  absPath: string,
  rawContent?: string,
): FileDiagnostic[] {
  const ext = extname(absPath).toLowerCase();
  if (!TS_JS_EXTENSIONS.has(ext)) return [];

  const content =
    rawContent ?? (existsSync(absPath) ? readFileSync(absPath, "utf8") : "");
  if (!content) return [];

  const statements = parseRelativeImportStatements(content);
  if (statements.length === 0) return [];

  const diagnostics: FileDiagnostic[] = [];

  for (const stmt of statements) {
    const resolvedTarget = resolveRelativeModuleFile(absPath, stmt.specifier);
    if (!resolvedTarget) {
      const suggestion = suggestSiblingModule(absPath, stmt.specifier);
      const hint = suggestion ? ` (did you mean "./${suggestion}"?)` : "";
      diagnostics.push({
        file: absPath,
        line: stmt.line,
        column: stmt.column,
        severity: "error",
        message: `Cannot resolve relative module "${stmt.specifier}"${hint}`,
        source: "import-resolver",
      });
      continue;
    }

    if (
      stmt.namedImports.length === 0 ||
      !TS_JS_EXTENSIONS.has(extname(resolvedTarget).toLowerCase())
    ) {
      continue;
    }

    const exported = collectExportedSymbolNames(resolvedTarget);
    // If the target file has `export * from "external-pkg"`, skip strict negative checks
    if (exported.hasWildcardExternal) continue;

    for (const named of stmt.namedImports) {
      if (!exported.names.has(named.importedName)) {
        const available = [...exported.names]
          .filter((n) => n !== "default")
          .sort()
          .slice(0, 10);
        const availSuffix =
          available.length > 0
            ? ` Available exports: [${available.join(", ")}]`
            : "";
        diagnostics.push({
          file: absPath,
          line: stmt.line,
          column: stmt.column,
          severity: "error",
          message: `Module "${stmt.specifier}" has no exported member "${named.importedName}".${availSuffix}`,
          source: "export-contract",
        });
      }
    }
  }

  return diagnostics;
}
