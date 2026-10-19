import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { extname, isAbsolute, relative, resolve } from "node:path";
import { hashReadFile } from "../editors/hashline-tools.js";
import { verifyModuleImportsAndExports } from "./import-verifier.js";

export interface FileDiagnostic {
  file: string;
  line: number;
  column: number;
  severity: "error" | "warning";
  message: string;
  source: string;
}

export interface DiagnosticsResult {
  file: string;
  clean: boolean;
  cached: boolean;
  durationMs: number;
  diagnostics: FileDiagnostic[];
  formattedTag: string;
}

interface CacheEntry {
  key: string;
  diagnostics: FileDiagnostic[];
}

const DIAGNOSTICS_CACHE = new Map<string, CacheEntry>();
let cacheHits = 0;
let cacheMisses = 0;

export function clearDiagnosticsCache(): void {
  DIAGNOSTICS_CACHE.clear();
  cacheHits = 0;
  cacheMisses = 0;
}

export function getDiagnosticsCacheStats(): {
  size: number;
  hits: number;
  misses: number;
} {
  return {
    size: DIAGNOSTICS_CACHE.size,
    hits: cacheHits,
    misses: cacheMisses,
  };
}

function getFileCacheKey(absPath: string): string | null {
  try {
    const st = statSync(absPath);
    return `${absPath}:${st.mtimeMs}:${st.size}`;
  } catch (err) {
    if (err) return null;
    return null;
  }
}

function checkJsonSyntax(absPath: string, content: string): FileDiagnostic[] {
  try {
    JSON.parse(content);
    return [];
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const posMatch = /position\s+(\d+)/i.exec(msg);
    let line = 1;
    let column = 1;
    if (posMatch) {
      const offset = Number(posMatch[1]);
      const prefix = content.slice(0, Math.max(0, offset));
      const lines = prefix.split("\n");
      line = lines.length;
      column = (lines[lines.length - 1]?.length ?? 0) + 1;
    }
    return [
      {
        file: absPath,
        line,
        column,
        severity: "error",
        message: msg,
        source: "json-parse",
      },
    ];
  }
}

function checkJsTsSyntax(
  absPath: string,
  content: string,
  ext: string,
): FileDiagnostic[] {
  const globalBun = (
    globalThis as unknown as {
      Bun?: {
        Transpiler?: new (opts: { loader: string }) => {
          scan(code: string): unknown;
        };
      };
    }
  ).Bun;

  if (globalBun && typeof globalBun.Transpiler === "function") {
    try {
      const loader =
        ext === ".tsx"
          ? "tsx"
          : ext === ".jsx"
            ? "jsx"
            : ext === ".js" || ext === ".mjs" || ext === ".cjs"
              ? "js"
              : "ts";
      const transpiler = new globalBun.Transpiler({ loader });
      transpiler.scan(content);
      return [];
    } catch (err) {
      const raw = err as {
        message?: string;
        line?: number;
        column?: number;
        errors?: Array<{
          message?: string;
          location?: { line?: number; column?: number };
        }>;
      };
      if (Array.isArray(raw.errors) && raw.errors.length > 0) {
        return raw.errors.map((e) => ({
          file: absPath,
          line: e.location?.line ?? 1,
          column: e.location?.column ?? 1,
          severity: "error",
          message: e.message ?? "Syntax error",
          source: "bun-transpiler",
        }));
      }
      return [
        {
          file: absPath,
          line: typeof raw.line === "number" ? raw.line : 1,
          column: typeof raw.column === "number" ? raw.column : 1,
          severity: "error",
          message: raw.message ?? String(err),
          source: "bun-transpiler",
        },
      ];
    }
  }

  try {
    const require = createRequire(import.meta.url);
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const babel = require("@babel/core") as {
      parseSync(code: string, opts: Record<string, unknown>): unknown;
    };
    babel.parseSync(content, {
      filename: absPath,
      presets: ["/usr/share/nodejs/@babel/preset-typescript"],
      sourceType: "module",
    });
    return [];
  } catch (err) {
    const raw = err as {
      code?: string;
      message?: string;
      loc?: { line?: number; column?: number };
    };
    if (raw && raw.loc && typeof raw.loc.line === "number") {
      const firstLine =
        (raw.message ?? "Syntax error").split("\n")[0] ?? "Syntax error";
      return [
        {
          file: absPath,
          line: raw.loc.line,
          column: (raw.loc.column ?? 0) + 1,
          severity: "error",
          message: firstLine,
          source: "ts-parser",
        },
      ];
    }
  }

  if (ext === ".js" || ext === ".mjs" || ext === ".cjs") {
    const res = spawnSync("node", ["--check", absPath], {
      encoding: "utf8",
      timeout: 2500,
    });
    if (res.status !== 0) {
      const stderr = (res.stderr || res.stdout || "").trim();
      const lineMatch = /:(\d+)\n/.exec(stderr);
      return [
        {
          file: absPath,
          line: lineMatch ? Number(lineMatch[1]) : 1,
          column: 1,
          severity: "error",
          message:
            stderr.split("\n").slice(0, 3).join(" | ") ||
            "JavaScript syntax error",
          source: "node-check",
        },
      ];
    }
  }

  return [];
}

function checkPythonSyntax(absPath: string): FileDiagnostic[] {
  const res = spawnSync("python3", ["-m", "py_compile", absPath], {
    encoding: "utf8",
    timeout: 2500,
  });
  if (res.status === 0 || res.error) return [];
  const stderr = (res.stderr || res.stdout || "").trim();
  const lineMatch = /line\s+(\d+)/i.exec(stderr);
  return [
    {
      file: absPath,
      line: lineMatch ? Number(lineMatch[1]) : 1,
      column: 1,
      severity: "error",
      message:
        stderr.split("\n").slice(-2).join(" ").trim() || "Python syntax error",
      source: "py_compile",
    },
  ];
}

export function formatDiagnosticsTag(
  absPath: string,
  diagnostics: FileDiagnostic[],
): string {
  if (diagnostics.length === 0) return "";
  const lines = diagnostics
    .slice(0, 15)
    .map(
      (d) =>
        `  [${d.severity.toUpperCase()}] ${d.file}:${d.line}:${d.column} (${d.source}) - ${d.message}`,
    );
  return [
    `<diagnostics file="${absPath}" status="errors" count="${diagnostics.length}">`,
    ...lines,
    `</diagnostics>`,
  ].join("\n");
}

export function collectFileDiagnostics(
  filePath: string,
  workspaceRoot?: string,
): DiagnosticsResult {
  const start = Date.now();
  const absPath = isAbsolute(filePath)
    ? filePath
    : resolve(workspaceRoot ?? process.cwd(), filePath);

  if (!existsSync(absPath)) {
    return {
      file: absPath,
      clean: true,
      cached: false,
      durationMs: Date.now() - start,
      diagnostics: [],
      formattedTag: "",
    };
  }

  const key = getFileCacheKey(absPath);
  if (key) {
    const hit = DIAGNOSTICS_CACHE.get(absPath);
    if (hit && hit.key === key) {
      cacheHits += 1;
      return {
        file: absPath,
        clean: hit.diagnostics.length === 0,
        cached: true,
        durationMs: Date.now() - start,
        diagnostics: hit.diagnostics,
        formattedTag: formatDiagnosticsTag(absPath, hit.diagnostics),
      };
    }
  }

  cacheMisses += 1;
  const ext = extname(absPath).toLowerCase();
  let diagnostics: FileDiagnostic[] = [];

  try {
    const content = readFileSync(absPath, "utf8");
    if (ext === ".json") {
      diagnostics = checkJsonSyntax(absPath, content);
    } else if ([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"].includes(ext)) {
      diagnostics = checkJsTsSyntax(absPath, content, ext);
      if (diagnostics.length === 0) {
        const importDiags = verifyModuleImportsAndExports(absPath, content);
        if (importDiags.length > 0) {
          diagnostics.push(...importDiags);
        }
      }
    } else if (ext === ".py") {
      diagnostics = checkPythonSyntax(absPath);
    }
  } catch (err) {
    diagnostics = [
      {
        file: absPath,
        line: 1,
        column: 1,
        severity: "error",
        message: err instanceof Error ? err.message : String(err),
        source: "fs",
      },
    ];
  }

  if (key) {
    DIAGNOSTICS_CACHE.set(absPath, { key, diagnostics });
  }

  return {
    file: absPath,
    clean: diagnostics.length === 0,
    cached: false,
    durationMs: Date.now() - start,
    diagnostics,
    formattedTag: formatDiagnosticsTag(absPath, diagnostics),
  };
}

export interface FaultFrame {
  file: string;
  line: number;
  column?: number;
  slice: string;
}

export interface FaultLocalizationResult {
  frames: FaultFrame[];
  formattedBlock: string;
}

/**
 * Parses stack traces from failed shell/test output and produces `<fault-context>`
 * blocks containing 4-hex FNV-1a hash-anchored source slices (`hashReadFile`)
 * around each crash site so the model can immediately issue `file_hash_edit`
 * without spending an extra turn reading files.
 */
export async function localizeFaultContext(
  rawOutput: string,
  workspaceRoot: string = process.cwd(),
  maxFrames: number = 3,
  contextRadius: number = 6,
): Promise<FaultLocalizationResult> {
  if (!rawOutput || rawOutput.trim().length === 0) {
    return { frames: [], formattedBlock: "" };
  }

  const absRoot = resolve(workspaceRoot);
  const candidates: Array<{
    absPath: string;
    relPath: string;
    line: number;
    column?: number;
  }> = [];
  const seen = new Set<string>();

  const frameCandidate =
    /([A-Za-z0-9_./\\-]{1,256}\.(?:ts|tsx|js|jsx|mjs|cjs|py|go|rs)):(\d{1,7})(?::(\d{1,7}))?/;
  const pyFileLine = /File\s+"([^"]{1,500}\.py)",\s+line\s+(\d{1,7})/;
  const rsArrow = /-->\s+([A-Za-z0-9_./\\-]{1,256}\.rs):(\d{1,7})(?::(\d{1,7}))?/;

  for (const rawLine of rawOutput.split("\n")) {
    if (candidates.length >= maxFrames) break;
    if (!rawLine.includes("at ") && !rawLine.includes("File \"") && !rawLine.includes("-->")) {
      continue;
    }
    const window = rawLine.length > 500 ? rawLine.slice(0, 500) : rawLine;
    const perLine: RegExp[] = [frameCandidate, pyFileLine, rsArrow];
    for (const regex of perLine) {
      const match = regex.exec(window);
      if (!match) continue;
      const rawPath = match[1];
      const lineNum = Number(match[2]);
      const colNum = match[3] ? Number(match[3]) : undefined;
      if (!rawPath || !Number.isFinite(lineNum) || lineNum < 1) continue;
      if (rawPath.includes("node_modules")) continue;

      const absPath = isAbsolute(rawPath) ? rawPath : resolve(absRoot, rawPath);
      if (!existsSync(absPath)) continue;
      const relPath = relative(absRoot, absPath).replace(/\\/g, "/");
      if (relPath.startsWith("..")) continue;

      const dedupeKey = `${absPath}:${lineNum}`;
      if (seen.has(dedupeKey)) continue;
      seen.add(dedupeKey);
      candidates.push({ absPath, relPath, line: lineNum, column: colNum });
      if (candidates.length >= maxFrames) break;
    }
    if (candidates.length >= maxFrames) break;
  }

  if (candidates.length === 0) {
    return { frames: [], formattedBlock: "" };
  }

  const frames: FaultFrame[] = [];
  for (const item of candidates) {
    try {
      const startLine = Math.max(1, item.line - contextRadius);
      const limit = contextRadius * 2 + 1;
      const readRes = await hashReadFile(
        absRoot,
        item.relPath,
        startLine,
        limit,
      );
      frames.push({
        file: item.relPath,
        line: item.line,
        column: item.column,
        slice: readRes.content,
      });
    } catch (err) {
      if (err) continue;
    }
  }

  if (frames.length === 0) {
    return { frames: [], formattedBlock: "" };
  }

  const blocks = frames.map(
    (f) =>
      `  <frame file="${f.file}" line="${f.line}"${f.column ? ` column="${f.column}"` : ""}>\n${f.slice}\n  </frame>`,
  );
  const formattedBlock = [
    `<fault-context frames="${frames.length}">`,
    ...blocks,
    `</fault-context>`,
  ].join("\n");

  return { frames, formattedBlock };
}
