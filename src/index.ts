/**
 * `src/index.ts` — Unified OpenCode v2 plugin entrypoint.
 *
 * Wires Wave 1–3 modules plus the ported SwarmOS single-session harness
 * upgrades (post-mutation diagnostics, cross-file import/export verifier,
 * stack-frame fault localizer, atomic edit transactions, stale-read detector,
 * multi-language PageRank RepoMap, blast-radius analyzer, symbol reference
 * finder, atomic multi-file rename_symbol engine, incremental verifier,
 * diff-coverage & anti-tautology auditor, taint tracking, episodic memory,
 * Muse 1.3 calibration, architecture advisor, zero-patch tool/session
 * interceptors, and the native OpenCode V2 `PromiseContext` `default`
 * plugin export).
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import {
  astRewriteFile,
  astSearch,
  type AstLanguage,
} from "./editors/ast-codemod.js";
import {
  hashEditFile,
  hashReadFile,
  type HashEditHunk,
} from "./editors/hashline-tools.js";
import {
  defaultGuardConfig,
  evaluateBoardGuard,
  type GuardPolicyConfig,
  type GuardRequest,
  type GuardVerdict,
} from "./guards/permission-guard.js";
import {
  commandPrefixOf,
  recordToolAttempt,
  type CircuitBreakerVerdict,
} from "./guards/circuit-breaker.js";
import {
  buildDynamicContextBlocks,
  injectContextBudgetIntoMessages,
  packBlocks,
  type LessonInput,
  type SessionEvent,
} from "./context/context-budget.js";
import {
  auditLivePageWithPlaywright,
  evaluateDomGeometryInPage,
  type DomElementInput,
  type ViewportInput,
} from "./ui-auditor/dom-auditor.js";
import {
  analyzeBlastRadius,
  buildRepoMap,
  extractOutline,
  findSymbolReferences,
  formatBlastRadiusBlock,
  formatRepoMapBlock,
  renameSymbolAcrossWorkspace,
} from "./repomap/repomap.js";
import {
  createCheckpoint,
  rollbackCheckpoint,
} from "./transactions/edit-transaction.js";
import { runIncrementalVerification } from "./verify/verifier.js";
import { runArchitectureAudit } from "./verify/architecture-advisor.js";
import {
  wireOpenCodeV2PromiseContext,
  type DoctorReport,
  type OpenCodeV2PromiseContext,
} from "./host/contract-adapter.js";

export * from "./editors/hashline-tools.js";
export * from "./editors/ast-codemod.js";
export * from "./guards/shell-parse.js";
export * from "./guards/permission-guard.js";
export * from "./guards/circuit-breaker.js";
export * from "./guards/taint-guard.js";
export * from "./context/context-budget.js";
export * from "./context/episodic-memory.js";
export * from "./ui-auditor/dom-auditor.js";
export * from "./diagnostics/diagnostics-runner.js";
export * from "./diagnostics/import-verifier.js";
export * from "./transactions/edit-transaction.js";
export * from "./repomap/repomap.js";
export * from "./verify/verifier.js";
export * from "./verify/architecture-advisor.js";
export * from "./muse/muse-calibration.js";
export * from "./interceptors/tool-interceptors.js";
export * from "./interceptors/session-interceptors.js";
export * from "./host/contract-adapter.js";
import { HARNESS_VERSION } from "./version.js";
// Explicit re-export: both `./editors/hashline-tools.js` and
// `./interceptors/tool-interceptors.js` export `computeLineHash`, so the
// bare `export *` pair would leave the name ambiguous (and unexported).
// The explicit export wins and keeps the canonical symbol available.
export { computeLineHash } from "./editors/hashline-tools.js";
export { getRecommendedMcpConfig } from "./ui-auditor/mcp-defaults.js";
export type {
  McpServerEntry,
  RecommendedMcpConfig,
} from "./ui-auditor/mcp-defaults.js";

export const HARNESS_NAME = "@heretek-ai/opencode-harness";
export { HARNESS_RELEASE_VERSION, HARNESS_VERSION } from "./version.js";

export const HARNESS_TOOL_NAMES = [
  "file_hash_read",
  "file_hash_edit",
  "ast_structural_search",
  "ast_structural_rewrite",
  "ui_geometry_audit",
] as const;

export type HarnessToolName = (typeof HARNESS_TOOL_NAMES)[number];

export const EXTENDED_HARNESS_TOOL_NAMES = [
  ...HARNESS_TOOL_NAMES,
  "repo_map",
  "blast_radius",
  "file_outline",
  "symbol_references",
  "rename_symbol",
  "verify_scoped",
  "architecture_audit",
  "checkpoint_create",
  "checkpoint_rollback",
] as const;

export type ExtendedHarnessToolName =
  (typeof EXTENDED_HARNESS_TOOL_NAMES)[number];

export const HARNESS_HOOK_NAMES = [
  "permission.evaluate",
  "tool.execute.after",
  "session.context",
] as const;

export type HarnessHookName = (typeof HARNESS_HOOK_NAMES)[number];

export const DEFAULT_CONTEXT_BUDGET_TOKENS = 4000;

/* ------------------------------------------------------------------ */
/* Plugin host types (minimal OpenCode v2 surface)                     */
/* ------------------------------------------------------------------ */

export interface ToolContext {
  sessionId?: string;
  role?: string;
}

export interface ToolDefinition {
  description: string;
  parameters: z.ZodTypeAny;
  execute: (
    args: Record<string, unknown>,
    ctx?: ToolContext,
  ) => Promise<unknown>;
}

export type PermissionEvaluateHandler = (
  request: GuardRequest,
) => GuardVerdict | Promise<GuardVerdict>;

export interface ToolAfterEvent {
  sessionId: string;
  tool: string;
  ok: boolean;
  path?: string;
  command?: string;
  error?: string;
}

export type ToolAfterHandler = (
  event: ToolAfterEvent,
) =>
  | CircuitBreakerVerdict
  | Promise<CircuitBreakerVerdict>
  | void
  | Promise<void>;

export type SessionContextHandler = (
  event: SessionEvent,
) => void | Promise<void>;

export interface ToolRegistrar {
  (name: string, definition: ToolDefinition): void;
  execute: {
    after: (handler: ToolAfterHandler) => void;
  };
}

export interface PermissionHookRegistrar {
  hook: (event: "evaluate", handler: PermissionEvaluateHandler) => void;
}

export interface SessionHookRegistrar {
  hook: (event: "context", handler: SessionContextHandler) => void;
}

export interface PluginContext {
  tool: ToolRegistrar;
  permission: PermissionHookRegistrar;
  session: SessionHookRegistrar;
}

/* ------------------------------------------------------------------ */
/* Plugin options                                                     */
/* ------------------------------------------------------------------ */

export interface HarnessPluginOptions {
  rootDir?: string;
  guardConfig?: GuardPolicyConfig;
  contextBudgetTokens?: number;
  taskMd?: string;
  planMd?: string;
  lessons?: LessonInput[];
  /** Opt-in seeding of the recommended MCP servers (default false). */
  seedRecommendedMcp?: boolean;
}

export interface ResolvedHarnessOptions {
  rootDir: string;
  guardConfig: GuardPolicyConfig;
  contextBudgetTokens: number;
  taskMd?: string;
  planMd?: string;
  lessons?: LessonInput[];
  seedRecommendedMcp: boolean;
}

export interface HarnessPlugin {
  name: string;
  version: string;
  toolNames: readonly string[];
  hookNames: readonly string[];
  options: ResolvedHarnessOptions;
  activate: (context: PluginContext) => void;
}

export function resolveHarnessOptions(
  options?: HarnessPluginOptions,
): ResolvedHarnessOptions {
  if (options !== undefined) {
    const isRecord =
      typeof options === "object" &&
      options !== null &&
      Array.isArray(options) === false;
    if (isRecord === false) {
      throw new Error(
        "opencode-harness: plugin options must be an object when present (fail-closed)",
      );
    }
  }
  const settings: HarnessPluginOptions = options ?? {};
  const cwd = process.cwd();
  const rootDir = settings.rootDir !== undefined ? settings.rootDir : cwd;
  if (typeof rootDir !== "string" || rootDir.trim() === "") {
    throw new Error(
      "opencode-harness: rootDir must be a non-empty string (fail-closed)",
    );
  }
  const guardConfig: GuardPolicyConfig =
    settings.guardConfig !== undefined
      ? settings.guardConfig
      : defaultGuardConfig();
  if (
    guardConfig === null ||
    typeof guardConfig !== "object" ||
    Array.isArray(guardConfig.lockedContractGlobs) === false
  ) {
    throw new Error(
      "opencode-harness: guardConfig must carry a lockedContractGlobs array (fail-closed)",
    );
  }
  const budget =
    settings.contextBudgetTokens !== undefined
      ? settings.contextBudgetTokens
      : DEFAULT_CONTEXT_BUDGET_TOKENS;
  const budgetUsable =
    typeof budget === "number" && Number.isFinite(budget) && budget >= 0;
  if (budgetUsable === false) {
    throw new Error(
      `opencode-harness: contextBudgetTokens must be a finite number >= 0, got ${String(settings.contextBudgetTokens)} (fail-closed)`,
    );
  }
  if (settings.taskMd !== undefined && typeof settings.taskMd !== "string") {
    throw new Error(
      "opencode-harness: taskMd must be a string when present (fail-closed)",
    );
  }
  if (settings.planMd !== undefined && typeof settings.planMd !== "string") {
    throw new Error(
      "opencode-harness: planMd must be a string when present (fail-closed)",
    );
  }
  if (
    settings.lessons !== undefined &&
    Array.isArray(settings.lessons) === false
  ) {
    throw new Error(
      "opencode-harness: lessons must be an array when present (fail-closed)",
    );
  }
  if (
    settings.seedRecommendedMcp !== undefined &&
    typeof settings.seedRecommendedMcp !== "boolean"
  ) {
    throw new Error(
      "opencode-harness: seedRecommendedMcp must be a boolean when present (fail-closed)",
    );
  }
  return {
    rootDir,
    guardConfig,
    contextBudgetTokens: Math.floor(budget as number),
    seedRecommendedMcp: settings.seedRecommendedMcp === true,
    ...(settings.taskMd !== undefined ? { taskMd: settings.taskMd } : {}),
    ...(settings.planMd !== undefined ? { planMd: settings.planMd } : {}),
    ...(settings.lessons !== undefined ? { lessons: settings.lessons } : {}),
  };
}

/* ------------------------------------------------------------------ */
/* Tool argument schemas (zod-validated, fail-closed)                 */
/* ------------------------------------------------------------------ */

export interface FileHashReadArgs {
  path: string;
  offset?: number;
  limit?: number;
}

export interface FileHashEditArgs {
  path: string;
  hunks: HashEditHunk[];
}

export interface AstStructuralSearchArgs {
  code: string;
  pattern: string;
  language?: AstLanguage;
}

export interface AstStructuralRewriteArgs {
  path: string;
  pattern: string;
  rewrite: string;
  language?: string;
}

export interface UiGeometryAuditArgs {
  elements?: DomElementInput[];
  url?: string;
  viewports?: ViewportInput[];
}

const fileHashReadSchema: z.ZodType<FileHashReadArgs> = z.object({
  path: z.string().min(1),
  offset: z.number().int().min(1).optional(),
  limit: z.number().int().min(1).optional(),
});

const hashEditHunkSchema: z.ZodType<HashEditHunk> = z.object({
  startLine: z.number().int().min(1),
  startHash: z.string().regex(/^[0-9a-f]{4}$/),
  endLine: z.number().int().min(1),
  endHash: z.string().regex(/^[0-9a-f]{4}$/),
  replacement: z.string(),
});

const fileHashEditSchema: z.ZodType<FileHashEditArgs> = z.object({
  path: z.string().min(1),
  hunks: z.array(hashEditHunkSchema).min(1),
});

const astLanguageSchema: z.ZodType<AstLanguage> = z.enum([
  "typescript",
  "tsx",
  "javascript",
  "python",
  "rust",
  "go",
]);

const astStructuralSearchSchema: z.ZodType<AstStructuralSearchArgs> = z.object({
  code: z.string().min(1),
  pattern: z.string().min(1),
  language: astLanguageSchema.optional(),
});

const astStructuralRewriteSchema: z.ZodType<AstStructuralRewriteArgs> =
  z.object({
    path: z.string().min(1),
    pattern: z.string().min(1),
    rewrite: z.string(),
    language: z.string().min(1).optional(),
  });

const domRectSchema = z.object({
  x: z.number().finite(),
  y: z.number().finite(),
  width: z.number().finite(),
  height: z.number().finite(),
});

const domElementSchema: z.ZodType<DomElementInput> = z.object({
  tag: z.string().min(1),
  id: z.string().optional(),
  rect: domRectSchema,
  scrollWidth: z.number().finite().optional(),
  clientWidth: z.number().finite().optional(),
  fontSize: z.number().finite().optional(),
  lineHeight: z.number().finite().optional(),
  overflow: z.string().optional(),
  interactive: z.boolean().optional(),
  parentId: z.string().optional(),
});

const viewportSchema: z.ZodType<ViewportInput> = z.object({
  name: z.string().min(1),
  width: z.number().finite().positive(),
  height: z.number().finite().positive(),
});

const uiGeometryAuditSchema: z.ZodType<UiGeometryAuditArgs> = z.object({
  elements: z.array(domElementSchema).min(1).optional(),
  url: z.string().min(1).optional(),
  viewports: z.array(viewportSchema).min(1).optional(),
});

const repoMapSchema = z.object({
  topK: z.number().int().min(1).max(200).optional(),
});

const blastRadiusSchema = z.object({
  path: z.string().min(1),
  symbol: z.string().min(1).optional(),
});

const fileOutlineSchema = z.object({
  path: z.string().min(1),
});

const symbolReferencesSchema = z.object({
  symbol: z.string().min(1),
  maxResults: z.number().int().min(1).max(500).optional(),
});

const renameSymbolSchema = z.object({
  oldSymbol: z.string().min(1),
  newSymbol: z.string().min(1),
});

const verifyScopedSchema = z.object({
  modifiedFiles: z.array(z.string().min(1)).optional(),
  timeoutMs: z.number().int().min(500).max(300000).optional(),
});

const architectureAuditSchema = z.object({
  files: z.array(z.string().min(1)).optional(),
});

const checkpointCreateSchema = z.object({
  label: z.string().min(1),
  files: z.array(z.string().min(1)).min(1),
});

const checkpointRollbackSchema = z.object({
  checkpointId: z.string().min(1).optional(),
});

/* ------------------------------------------------------------------ */
/* Hook implementations                                               */
/* ------------------------------------------------------------------ */

export function recordAndEvaluateCircuitBreaker(
  event: ToolAfterEvent,
): CircuitBreakerVerdict {
  if (event === null || typeof event !== "object") {
    throw new Error(
      "opencode-harness: tool-after event must be an object (fail-closed)",
    );
  }
  if (typeof event.sessionId !== "string" || event.sessionId === "") {
    throw new Error(
      "opencode-harness: tool-after event requires a non-empty sessionId (fail-closed)",
    );
  }
  if (typeof event.tool !== "string" || event.tool === "") {
    throw new Error(
      "opencode-harness: tool-after event requires a non-empty tool name (fail-closed)",
    );
  }
  if (typeof event.ok !== "boolean") {
    throw new Error(
      "opencode-harness: tool-after event requires a boolean ok flag (fail-closed)",
    );
  }
  return recordToolAttempt(event.sessionId, {
    tool: event.tool,
    ok: event.ok,
    ...(event.path !== undefined ? { path: event.path } : {}),
    ...(event.command !== undefined ? { command: event.command } : {}),
    ...(event.command !== undefined
      ? { commandPrefix: commandPrefixOf(event.command) }
      : {}),
    ...(event.error !== undefined ? { error: event.error } : {}),
  });
}

export interface ContextHookOverrides {
  rootDir?: string;
  budgetTokens?: number;
  taskMd?: string;
  planMd?: string;
  lessons?: LessonInput[];
}

export function toTrippedDirective(verdict: CircuitBreakerVerdict): {
  tripped: boolean;
  directive?: string;
} {
  if (verdict === null || typeof verdict !== "object") {
    throw new Error(
      "opencode-harness: circuit-breaker verdict must be an object (fail-closed)",
    );
  }
  const foreign = verdict as CircuitBreakerVerdict & {
    tripped?: unknown;
    directive?: unknown;
  };
  const tripped =
    typeof foreign.tripped === "boolean" ? foreign.tripped : verdict.triggered;
  if (typeof tripped !== "boolean") {
    throw new Error(
      "opencode-harness: circuit-breaker verdict carries no boolean trip flag (fail-closed)",
    );
  }
  const directive =
    typeof foreign.directive === "string"
      ? foreign.directive
      : (verdict.intervention ?? verdict.message);
  return {
    tripped,
    ...(directive !== undefined ? { directive } : {}),
  };
}

export function registerContextBudgetHook(
  event: SessionEvent,
  overrides?: ContextHookOverrides,
): void {
  const rootDir = overrides?.rootDir ?? process.cwd();
  if (typeof rootDir !== "string" || rootDir.trim() === "") {
    throw new Error(
      "opencode-harness: context hook rootDir must be a non-empty string (fail-closed)",
    );
  }
  const budget = overrides?.budgetTokens ?? DEFAULT_CONTEXT_BUDGET_TOKENS;
  const budgetUsable =
    typeof budget === "number" && Number.isFinite(budget) && budget >= 0;
  if (budgetUsable === false) {
    throw new Error(
      `opencode-harness: context hook budgetTokens must be a finite number >= 0, got ${String(overrides?.budgetTokens)} (fail-closed)`,
    );
  }
  const blocks = buildDynamicContextBlocks(rootDir, {
    ...(overrides?.taskMd !== undefined ? { taskMd: overrides.taskMd } : {}),
    ...(overrides?.planMd !== undefined ? { planMd: overrides.planMd } : {}),
    ...(overrides?.lessons !== undefined ? { lessons: overrides.lessons } : {}),
  });
  const packed = packBlocks(blocks, budget);
  if (packed.text === "") {
    return;
  }
  injectContextBudgetIntoMessages(event, packed.text);
}

/* ------------------------------------------------------------------ */
/* Tool tables                                                        */
/* ------------------------------------------------------------------ */

export function buildHarnessTools(
  resolved: ResolvedHarnessOptions,
): Record<HarnessToolName, ToolDefinition> {
  return {
    file_hash_read: {
      description:
        "Read a workspace file with 4-hex FNV-1a hash-anchored lines " +
        "(<lineNo>#<hash>| <content>); supports 1-based offset/limit windows.",
      parameters: fileHashReadSchema,
      execute: async (args: Record<string, unknown>): Promise<unknown> => {
        const parsed = fileHashReadSchema.parse(args);
        return hashReadFile(
          resolved.rootDir,
          parsed.path,
          parsed.offset,
          parsed.limit,
        );
      },
    },
    file_hash_edit: {
      description:
        "Apply hash-anchored hunks to a workspace file; anchors resolve " +
        "across +/-25 shifted lines and any mismatch fails closed with no " +
        "disk write.",
      parameters: fileHashEditSchema,
      execute: async (args: Record<string, unknown>): Promise<unknown> => {
        const parsed = fileHashEditSchema.parse(args);
        return hashEditFile(resolved.rootDir, parsed.path, parsed.hunks);
      },
    },
    ast_structural_search: {
      description:
        "Structural code search with $VAR / $$$ARGS metavariables " +
        "(@ast-grep/napi with a deterministic fallback); returns " +
        "text plus 1-based start/end lines.",
      parameters: astStructuralSearchSchema,
      execute: async (args: Record<string, unknown>): Promise<unknown> => {
        const parsed = astStructuralSearchSchema.parse(args);
        return astSearch(parsed.code, parsed.pattern, parsed.language);
      },
    },
    ast_structural_rewrite: {
      description:
        "Structural file rewrite: substitutes metavariable bindings from " +
        "the matched pattern into the rewrite template and writes the " +
        "file only when at least one match is replaced.",
      parameters: astStructuralRewriteSchema,
      execute: async (args: Record<string, unknown>): Promise<unknown> => {
        const parsed = astStructuralRewriteSchema.parse(args);
        return astRewriteFile(
          resolved.rootDir,
          parsed.path,
          parsed.pattern,
          parsed.rewrite,
          parsed.language,
        );
      },
    },
    ui_geometry_audit: {
      description:
        "DOM geometry audit: evaluates caller-supplied element rects for " +
        "overflow-x, tiny (<24px) interactive targets, descender-clip " +
        "risk, sibling collision, and row baseline jitter; or audits a " +
        "live http(s) URL headlessly with WCAG 2.2 axe tags.",
      parameters: uiGeometryAuditSchema,
      execute: async (args: Record<string, unknown>): Promise<unknown> => {
        const parsed = uiGeometryAuditSchema.parse(args);
        if (parsed.url !== undefined) {
          return auditLivePageWithPlaywright(parsed.url, parsed.viewports);
        }
        if (parsed.elements !== undefined) {
          const defects = evaluateDomGeometryInPage(parsed.elements);
          return {
            url: null,
            defects,
            axeViolations: [],
            viewports: [],
          };
        }
        throw new Error(
          "ui_geometry_audit: provide either a live http(s) url or a non-empty elements array (fail-closed)",
        );
      },
    },
  };
}

export function buildExtendedHarnessTools(
  resolved: ResolvedHarnessOptions,
): Record<ExtendedHarnessToolName, ToolDefinition> {
  const core = buildHarnessTools(resolved);
  return {
    ...core,
    repo_map: {
      description:
        "Compute a PageRank-ranked repository dependency map showing top architectural modules and their exported symbols.",
      parameters: repoMapSchema,
      execute: async (args: Record<string, unknown>): Promise<unknown> => {
        const parsed = repoMapSchema.parse(args);
        const map = buildRepoMap(resolved.rootDir);
        return {
          totalFiles: map.totalFiles,
          formatted: formatRepoMapBlock(map, parsed.topK ?? 15),
          rankedFiles: map.rankedFiles.slice(0, parsed.topK ?? 15),
        };
      },
    },
    blast_radius: {
      description:
        "Analyze the direct importers, transitive dependents, symbol callers, and affected test files for a target module before mutating its public contract.",
      parameters: blastRadiusSchema,
      execute: async (args: Record<string, unknown>): Promise<unknown> => {
        const parsed = blastRadiusSchema.parse(args);
        const res = analyzeBlastRadius(
          parsed.path,
          resolved.rootDir,
          parsed.symbol,
        );
        return {
          ...res,
          formatted: formatBlastRadiusBlock(res),
        };
      },
    },
    file_outline: {
      description:
        "Extract a compact structural symbol outline (functions, classes, interfaces, types, structs) with 1-based line numbers without reading the full file body.",
      parameters: fileOutlineSchema,
      execute: async (args: Record<string, unknown>): Promise<unknown> => {
        const parsed = fileOutlineSchema.parse(args);
        return {
          path: parsed.path,
          symbols: extractOutline(`${resolved.rootDir}/${parsed.path}`),
        };
      },
    },
    symbol_references: {
      description:
        "Find all lexer-verified definitions, imports, exports, and call sites of a symbol across the workspace with 1-based line numbers and 4-hex FNV-1a anchors for immediate file_hash_edit.",
      parameters: symbolReferencesSchema,
      execute: async (args: Record<string, unknown>): Promise<unknown> => {
        const parsed = symbolReferencesSchema.parse(args);
        return findSymbolReferences(
          parsed.symbol,
          resolved.rootDir,
          parsed.maxResults ?? 50,
        );
      },
    },
    rename_symbol: {
      description:
        "Atomically rename an exported or local symbol across all definitions, imports, exports, and call sites in the workspace (ignoring comments and string literals), with automatic syntax/import verification and rollback on error.",
      parameters: renameSymbolSchema,
      execute: async (
        args: Record<string, unknown>,
        ctx?: ToolContext,
      ): Promise<unknown> => {
        const parsed = renameSymbolSchema.parse(args);
        return renameSymbolAcrossWorkspace(
          parsed.oldSymbol,
          parsed.newSymbol,
          resolved.rootDir,
          ctx?.sessionId ?? "rename-tx",
        );
      },
    },
    verify_scoped: {
      description:
        "Run blast-radius-scoped incremental verification (typecheck, lint, and affected tests) and return structured file:line:col failure locations.",
      parameters: verifyScopedSchema,
      execute: async (args: Record<string, unknown>): Promise<unknown> => {
        const parsed = verifyScopedSchema.parse(args);
        return runIncrementalVerification({
          rootDir: resolved.rootDir,
          modifiedFiles: parsed.modifiedFiles,
          timeoutMs: parsed.timeoutMs,
        });
      },
    },
    architecture_audit: {
      description:
        "Audit workspace architecture for circular module dependencies (Tarjan SCC), unused exported symbols, orphan modules, oversized god-files, empty catch blocks, and high-arity functions.",
      parameters: architectureAuditSchema,
      execute: async (args: Record<string, unknown>): Promise<unknown> => {
        const parsed = architectureAuditSchema.parse(args);
        return runArchitectureAudit(resolved.rootDir, parsed.files);
      },
    },
    checkpoint_create: {
      description:
        "Create an in-memory time-travel snapshot checkpoint for a list of workspace files prior to a risky refactoring sequence.",
      parameters: checkpointCreateSchema,
      execute: async (
        args: Record<string, unknown>,
        ctx?: ToolContext,
      ): Promise<unknown> => {
        const parsed = checkpointCreateSchema.parse(args);
        const entry = createCheckpoint(
          ctx?.sessionId ?? "default",
          parsed.label,
          parsed.files,
          resolved.rootDir,
        );
        return {
          checkpointId: entry.id,
          label: entry.label,
          fileCount: entry.snapshots.length,
        };
      },
    },
    checkpoint_rollback: {
      description:
        "Restore workspace files to a previously created checkpoint snapshot.",
      parameters: checkpointRollbackSchema,
      execute: async (
        args: Record<string, unknown>,
        ctx?: ToolContext,
      ): Promise<unknown> => {
        const parsed = checkpointRollbackSchema.parse(args);
        const outcome = rollbackCheckpoint(
          ctx?.sessionId ?? "default",
          parsed.checkpointId,
        );
        if (!outcome) {
          throw new Error(
            "checkpoint_rollback: no matching checkpoint found for session (fail-closed)",
          );
        }
        return outcome;
      },
    },
  };
}

/* ------------------------------------------------------------------ */
/* Activation                                                         */
/* ------------------------------------------------------------------ */

function assertValidPluginContext(context: PluginContext): void {
  const missing: string[] = [];
  if (context === null || typeof context !== "object") {
    throw new Error(
      "opencode-harness: activate requires a plugin context object (fail-closed)",
    );
  }
  if (typeof (context as PluginContext).tool !== "function") {
    missing.push("tool(name, definition)");
  }
  if (
    typeof (context as PluginContext).tool?.execute?.after !== "function"
  ) {
    missing.push("tool.execute.after(handler)");
  }
  if (typeof (context as PluginContext).permission?.hook !== "function") {
    missing.push('permission.hook("evaluate", handler)');
  }
  if (typeof (context as PluginContext).session?.hook !== "function") {
    missing.push('session.hook("context", handler)');
  }
  if (missing.length > 0) {
    throw new Error(
      `opencode-harness: plugin context is missing required surface: ${missing.join(", ")} (fail-closed)`,
    );
  }
}

function activateWithOptions(
  context: PluginContext,
  resolved: ResolvedHarnessOptions,
): void {
  assertValidPluginContext(context);
  const tools = buildHarnessTools(resolved);
  for (const name of HARNESS_TOOL_NAMES) {
    context.tool(name, tools[name]);
  }
  const guardConfig: GuardPolicyConfig = resolved.guardConfig;
  context.permission.hook("evaluate", (request: GuardRequest): GuardVerdict => {
    return evaluateBoardGuard(request, guardConfig);
  });
  context.tool.execute.after((event: ToolAfterEvent): void => {
    recordAndEvaluateCircuitBreaker(event);
  });
  context.session.hook("context", (event: SessionEvent): void => {
    registerContextBudgetHook(event, {
      rootDir: resolved.rootDir,
      budgetTokens: resolved.contextBudgetTokens,
      ...(resolved.taskMd !== undefined ? { taskMd: resolved.taskMd } : {}),
      ...(resolved.planMd !== undefined ? { planMd: resolved.planMd } : {}),
      ...(resolved.lessons !== undefined ? { lessons: resolved.lessons } : {}),
    });
  });
}

export function activate(context: PluginContext): void {
  activateWithOptions(context, resolveHarnessOptions());
}

export function createHarnessPlugin(
  options?: HarnessPluginOptions,
): HarnessPlugin {
  const resolved = resolveHarnessOptions(options);
  return {
    name: HARNESS_NAME,
    version: HARNESS_VERSION,
    toolNames: HARNESS_TOOL_NAMES,
    hookNames: HARNESS_HOOK_NAMES,
    options: resolved,
    activate: (context: PluginContext): void => {
      activateWithOptions(context, resolved);
    },
  };
}

function discoverOptionalWorkspaceFile(
  rootDir: string,
  candidates: string[],
): string | undefined {
  for (const rel of candidates) {
    const abs = join(rootDir, rel);
    if (existsSync(abs)) {
      try {
        return readFileSync(abs, "utf8");
      } catch (err) {
        if (err) continue;
      }
    }
  }
  return undefined;
}

/**
 * Wraps a host context so every `hook(...)` / `transform(...)` registration
 * the harness makes is collected. Real OpenCode V2 domains return
 * `Promise<Registration>`; older/fake hosts may return nothing.
 */
function trackHostRegistrations(
  ctx: OpenCodeV2PromiseContext,
  registrations: unknown[],
): OpenCodeV2PromiseContext {
  const domains = ["tool", "permission", "session", "shell", "agent", "command", "mcp"] as const;
  const tracked: Record<string, unknown> = { ...ctx };
  for (const name of domains) {
    const domain = (ctx as Record<string, unknown>)[name];
    if (domain === null || typeof domain !== "object") continue;
    tracked[name] = new Proxy(domain as object, {
      get(target, prop, receiver) {
        const value = Reflect.get(target, prop, receiver);
        if ((prop === "hook" || prop === "transform") && typeof value === "function") {
          return (...args: unknown[]) => {
            const result = (value as (...a: unknown[]) => unknown).apply(target, args);
            registrations.push(result);
            return result;
          };
        }
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
  }
  return tracked as OpenCodeV2PromiseContext;
}

async function disposeRegistrations(registrations: unknown[]): Promise<void> {
  const settled = await Promise.allSettled(registrations.map((r) => Promise.resolve(r)));
  for (const outcome of settled) {
    if (outcome.status !== "fulfilled") continue;
    const reg = outcome.value as { dispose?: () => unknown } | undefined;
    if (reg && typeof reg.dispose === "function") {
      await reg.dispose();
    }
  }
}

export interface OpenCodeV2SetupResult {
  report: DoctorReport;
  /** Resolves once every host registration has been accepted. */
  ready: Promise<void>;
  dispose: () => Promise<void>;
}

/**
 * Wire the harness into an OpenCode V2 promise context and return the
 * `/doctor` report plus registration lifecycle handles. `OpenCodeV2Plugin.setup`
 * is the host-facing wrapper around this.
 */
export function setupOpenCodeV2Harness(
  ctx: OpenCodeV2PromiseContext,
  options?: HarnessPluginOptions,
): OpenCodeV2SetupResult {
  const hostOptions =
    ctx?.options !== null && typeof ctx?.options === "object"
      ? (ctx.options as HarnessPluginOptions)
      : undefined;
  const merged: HarnessPluginOptions = { ...hostOptions, ...options };
  const inferredRoot =
    ctx?.directory ??
    ctx?.worktree ??
    ctx?.location?.directory ??
    ctx?.location?.worktree ??
    process.cwd();
  const resolved = resolveHarnessOptions({
    rootDir: inferredRoot,
    ...merged,
  });
  const tools = buildExtendedHarnessTools(resolved);
  const registrations: unknown[] = [];
  const report = wireOpenCodeV2PromiseContext({
    ctx: trackHostRegistrations(ctx, registrations),
    workspaceRoot: resolved.rootDir,
    tools,
    seedRecommendedMcp: resolved.seedRecommendedMcp,
    evaluatePermission: (req) => evaluateBoardGuard(req, resolved.guardConfig),
    recordCircuitBreaker: (ev) => {
      const verdict = recordAndEvaluateCircuitBreaker(ev);
      return toTrippedDirective(verdict);
    },
    runContextBudget: (ev) => {
      const taskMd =
        resolved.taskMd ??
        discoverOptionalWorkspaceFile(resolved.rootDir, [
          "TASK.md",
          ".opencode/task.md",
        ]);
      const planMd =
        resolved.planMd ??
        discoverOptionalWorkspaceFile(resolved.rootDir, [
          "PLAN.md",
          ".opencode/plan.md",
        ]);
      registerContextBudgetHook(ev, {
        rootDir: resolved.rootDir,
        budgetTokens: resolved.contextBudgetTokens,
        ...(taskMd !== undefined ? { taskMd } : {}),
        ...(planMd !== undefined ? { planMd } : {}),
        ...(resolved.lessons !== undefined ? { lessons: resolved.lessons } : {}),
      });
    },
  });
  const ready = Promise.all(registrations.map((r) => Promise.resolve(r))).then(
    () => undefined,
  );
  return {
    report,
    ready,
    dispose: () => disposeRegistrations(registrations),
  };
}

/**
 * Native OpenCode V2 `PluginModule` default export (`{ id, setup(ctx) }`)
 * consumed by `packages/core/src/plugin/module.ts`. `setup` waits for every
 * registration and returns the cleanup function the host calls on unload
 * (the host treats any returned value as a cleanup callback). Plugin options
 * from `opencode.json` arrive on `ctx.options`.
 */
export const OpenCodeV2Plugin = {
  id: HARNESS_NAME,
  async setup(
    ctx: OpenCodeV2PromiseContext,
    options?: HarnessPluginOptions,
  ): Promise<() => Promise<void>> {
    const { ready, dispose } = setupOpenCodeV2Harness(ctx, options);
    await ready;
    return dispose;
  },
};

export default OpenCodeV2Plugin;
