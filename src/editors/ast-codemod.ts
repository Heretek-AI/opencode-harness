/**
 * `src/editors/ast-codemod.ts` — Structural code search and rewrite.
 *
 * Wave 1 module per `docs/prompts/SPEC.md` Section 2.3 B:
 *
 * - `astSearch` uses `@ast-grep/napi`
 *   (`parse(lang, code).root().findAll({ rule: { pattern } })`) for precise
 *   structural matches, with a deterministic structural-metavariable
 *   (`$VAR`, `$$$ARGS`) regex fallback when native bindings are unavailable
 *   for a target language.
 * - `astRewriteFile` locates matches with the same engine and substitutes
 *   captured metavariables into the rewrite template, applying edits from
 *   the end of the file backwards so offsets stay valid.
 */

import { createRequire } from "node:module";
import { resolveSafePath } from "./hashline-tools.js";

export type AstLanguage =
  | "typescript"
  | "tsx"
  | "javascript"
  | "python"
  | "rust"
  | "go";

export interface AstMatch {
  text: string;
  startLine: number;
  endLine: number;
}

export interface AstRewriteResult {
  modified: boolean;
  matchCount: number;
  output: string;
}

const NAPI_LANG_BY_ALIAS: Record<string, string> = {
  typescript: "TypeScript",
  tsx: "Tsx",
  javascript: "JavaScript",
  python: "Python",
  rust: "Rust",
  go: "Go",
};

const METAVARIABLE_TOKEN = /\$\$\$[A-Za-z_][A-Za-z0-9_]*|\$[A-Za-z_][A-Za-z0-9_]*/g;

function escapeRegExp(literal: string): string {
  return literal.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

interface CompiledPattern {
  source: string;
  names: string[];
}

function compileStructuralPattern(pattern: string): CompiledPattern {
  const names: string[] = [];
  let source = "";
  let lastIndex = 0;
  METAVARIABLE_TOKEN.lastIndex = 0;
  let token: RegExpExecArray | null;
  while ((token = METAVARIABLE_TOKEN.exec(pattern)) !== null) {
    source += escapeRegExp(pattern.slice(lastIndex, token.index));
    const name = token[0];
    names.push(name);
    source += name.startsWith("$$$") ? "([\\s\\S]*?)" : "([\\s\\S]+?)";
    lastIndex = token.index + name.length;
  }
  source += escapeRegExp(pattern.slice(lastIndex));
  return { source, names };
}

function offsetToLine(offsets: number[], index: number): number {
  let line = 1;
  for (const boundary of offsets) {
    if (boundary <= index) {
      line++;
    } else {
      break;
    }
  }
  return line;
}

function lineStartOffsets(code: string): number[] {
  const offsets: number[] = [];
  for (let i = 0; i < code.length; i++) {
    if (code[i] === "\n") {
      offsets.push(i + 1);
    }
  }
  return offsets;
}

/**
 * Deterministic structural-metavariable fallback matcher. Translates `$VAR`
 * into a non-greedy single-or-more matcher and `$$$ARGS` into a non-greedy
 * zero-or-more matcher, then scans the code globally. Returns 1-based line
 * numbers. Used whenever `@ast-grep/napi` cannot serve the request.
 */
export function structuralFallbackSearch(code: string, pattern: string): AstMatch[] {
  const compiled = compileStructuralPattern(pattern);
  const expression = new RegExp(compiled.source, "g");
  const offsets = lineStartOffsets(code);
  const matches: AstMatch[] = [];
  let found: RegExpExecArray | null;
  while ((found = expression.exec(code)) !== null) {
    if (found[0].length === 0) {
      expression.lastIndex++;
      continue;
    }
    matches.push({
      text: found[0],
      startLine: offsetToLine(offsets, found.index),
      endLine: offsetToLine(offsets, found.index + found[0].length - 1),
    });
  }
  return matches;
}

function toNapiLanguage(language: AstLanguage | string | undefined): string {
  const key = (language ?? "typescript").toLowerCase();
  return NAPI_LANG_BY_ALIAS[key] ?? "TypeScript";
}

/**
 * Structural search over `code` for `pattern`.
 *
 * Tries `@ast-grep/napi` first for tree-accurate matches (1-based lines
 * derived from the 0-based node ranges). Any native failure — unknown
 * language registration, unparsable pattern, missing bindings — falls through
 * to the deterministic structural-metavariable fallback so results are always
 * available with zero network flakiness.
 */
export function astSearch(
  code: string,
  pattern: string,
  language?: AstLanguage,
): AstMatch[] {
  if (typeof code !== "string" || typeof pattern !== "string" || pattern.length === 0) {
    throw new Error("astSearch: code and pattern must be non-empty strings (fail-closed)");
  }
  const napiLang = toNapiLanguage(language);
  let native: { text: string; startLine: number; endLine: number }[] | null = null;
  try {
    const require = createRequire(import.meta.url);
    const napi = require("@ast-grep/napi") as {
      parse: (lang: string, src: string) => {
        root: () => {
          findAll: (matcher: unknown) => Array<{
            text: () => string;
            range: () => { start: { line: number }; end: { line: number } };
          }>;
        };
      };
    };
    const nodes = napi.parse(napiLang, code).root().findAll({ rule: { pattern } });
    native = nodes.map((node) => {
      const range = node.range();
      return {
        text: node.text(),
        startLine: range.start.line + 1,
        endLine: range.end.line + 1,
      };
    });
  } catch (nativeError) {
    native = null;
    void nativeError;
  }
  if (native !== null) {
    return native;
  }
  return structuralFallbackSearch(code, pattern);
}

/**
 * Substitute captured metavariable bindings from `matchedText` into the
 * rewrite template. `$NAME`/`$$$NAME` tokens are replaced positionally with
 * the values captured by the same structural compilation used for search.
 * Throws (fail-closed) when bindings cannot be derived so no partial,
 * template-leaking write ever reaches disk.
 */
export function substituteRewrite(
  pattern: string,
  rewrite: string,
  matchedText: string,
): string {
  const compiled = compileStructuralPattern(pattern);
  const anchored = new RegExp(`^(?:${compiled.source})$`);
  const bound = anchored.exec(matchedText);
  if (bound === null) {
    throw new Error(
      `astRewriteFile: cannot derive metavariable bindings for match ${JSON.stringify(matchedText)} (fail-closed)`,
    );
  }
  let index = 0;
  return rewrite.replace(METAVARIABLE_TOKEN, () => {
    index++;
    const captured = bound[index] ?? "";
    return captured;
  });
}

function findRewriteSpans(
  code: string,
  pattern: string,
): Array<{ start: number; end: number; text: string }> {
  const compiled = compileStructuralPattern(pattern);
  const expression = new RegExp(compiled.source, "g");
  const spans: Array<{ start: number; end: number; text: string }> = [];
  let found: RegExpExecArray | null;
  while ((found = expression.exec(code)) !== null) {
    if (found[0].length === 0) {
      expression.lastIndex++;
      continue;
    }
    spans.push({ start: found.index, end: found.index + found[0].length, text: found[0] });
  }
  return spans;
}

/**
 * Rewrite every structural occurrence of `pattern` in the file at
 * `rootDir/relPath` using the `rewrite` template.
 *
 * Match discovery prefers `@ast-grep/napi` positions; substitution always
 * uses deterministic metavariable bindings so `$VAR`/`$$$ARGS` values flow
 * into the output. Writes the file only when at least one match is replaced.
 * Throws (fail-closed) on unreadable files, escaping paths, or
 * underivable bindings.
 */
export async function astRewriteFile(
  rootDir: string,
  relPath: string,
  pattern: string,
  rewrite: string,
  language?: string,
): Promise<AstRewriteResult> {
  const fullPath = resolveSafePath(rootDir, relPath);
  if (typeof pattern !== "string" || pattern.length === 0) {
    throw new Error("astRewriteFile: pattern must be a non-empty string (fail-closed)");
  }
  if (typeof rewrite !== "string") {
    throw new Error("astRewriteFile: rewrite must be a string (fail-closed)");
  }
  let code: string;
  try {
    code = await Bun.file(fullPath).text();
  } catch (readError) {
    throw new Error(
      `astRewriteFile: cannot read ${JSON.stringify(relPath)}: ${(readError as Error).message} (fail-closed)`,
    );
  }

  let spans: Array<{ start: number; end: number; text: string }> = [];
  let nativeServed = false;
  try {
    const require = createRequire(import.meta.url);
    const napi = require("@ast-grep/napi") as {
      parse: (lang: string, src: string) => {
        root: () => {
          findAll: (matcher: unknown) => Array<{
            text: () => string;
            range: () => { start: { index: number }; end: { index: number } };
          }>;
        };
      };
    };
    const nodes = napi
      .parse(toNapiLanguage(language), code)
      .root()
      .findAll({ rule: { pattern } });
    spans = nodes.map((node) => ({
      start: node.range().start.index,
      end: node.range().end.index,
      text: node.text(),
    }));
    nativeServed = true;
  } catch (nativeError) {
    void nativeError;
    spans = [];
    nativeServed = false;
  }
  if (!nativeServed) {
    spans = findRewriteSpans(code, pattern);
  }
  if (spans.length === 0) {
    return { modified: false, matchCount: 0, output: code };
  }

  const edits = spans.map((span) => ({
    start: span.start,
    end: span.end,
    inserted: substituteRewrite(pattern, rewrite, span.text),
  }));
  edits.sort((a, b) => b.start - a.start);
  let output = code;
  for (const edit of edits) {
    output = output.slice(0, edit.start) + edit.inserted + output.slice(edit.end);
  }
  await Bun.write(fullPath, output);
  return { modified: true, matchCount: spans.length, output };
}
