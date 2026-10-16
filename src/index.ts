/**
 * `src/index.ts` — Unified OpenCode v2 plugin entrypoint.
 *
 * Wave 3 module per `docs/prompts/SPEC.md` Section 2.5. Wires every Wave 1
 * and Wave 2 module into a single in-process OpenCode v2 plugin:
 *
 * - Tools: `file_hash_read`, `file_hash_edit` (hash-anchored II/O over
 *   `src/editors/hashline-tools.ts`), `ast_structural_search`,
 *   `ast_structural_rewrite` (`src/editors/ast-codemod.ts`), and
 *   `ui_geometry_audit` (deterministic `evaluateDomGeometryInPage` plus the
 *   live `auditLivePageWithPlaywright` from `src/ui-auditor/dom-auditor.ts`).
 * - Hooks: `permission.hook("evaluate")` delegates to `evaluateBoardGuard`
 *   (`src/guards/permission-guard.ts`, backed by the
 *   `src/guards/shell-parse.ts` classifier); `tool.execute.after` records
 *   every attempt through `recordAndEvaluateCircuitBreaker`
 *   (`src/guards/circuit-breaker.ts`); `session.hook("context")` runs
 *   `registerContextBudgetHook`, which packs blocks with `packBlocks` /
 *   `buildDynamicContextBlocks` and injects them with
 *   `injectContextBudgetIntoMessages` (`src/context/context-budget.ts`)
 *   without ever mutating `event.system`.
 * - `getRecommendedMcpConfig()` is re-exported from
 *   `src/ui-auditor/mcp-defaults.ts` and returns exactly the `lsp-mcp-server`
 *   (`bunx`) and `fallow-mcp` (`npx --yes --package fallow`) blocks.
 *
 * Every value, type, and constant from the Wave 1 and Wave 2 modules is
 * re-exported below so no module is left unwired. All invalid inputs fail
 * closed with descriptive domain errors.
 */

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

export * from "./editors/hashline-tools.js";
export * from "./editors/ast-codemod.js";
export * from "./guards/shell-parse.js";
export * from "./guards/permission-guard.js";
export * from "./guards/circuit-breaker.js";
export * from "./context/context-budget.js";
export * from "./ui-auditor/dom-auditor.js";
export { getRecommendedMcpConfig } from "./ui-auditor/mcp-defaults.js";
export type {
  McpServerEntry,
  RecommendedMcpConfig,
} from "./ui-auditor/mcp-defaults.js";

export const HARNESS_NAME = "@heretek-ai/opencode-harness";
export const HARNESS_VERSION = "1.0.0";

export const HARNESS_TOOL_NAMES = [
  "file_hash_read",
  "file_hash_edit",
  "ast_structural_search",
  "ast_structural_rewrite",
  "ui_geometry_audit",
] as const;

export type HarnessToolName = (typeof HARNESS_TOOL_NAMES)[number];

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

/** Per-invocation ambient data handed to tool `execute` functions. */
export interface ToolContext {
  sessionId?: string;
  role?: string;
}

/** A registered harness tool: validated args plus a fail-closed executor. */
export interface ToolDefinition {
  description: string;
  parameters: z.ZodTypeAny;
  execute: (
    args: Record<string, unknown>,
    ctx?: ToolContext,
  ) => Promise<unknown>;
}

/** Permission evaluation handler (`permission.hook("evaluate")`). */
export type PermissionEvaluateHandler = (
  request: GuardRequest,
) => GuardVerdict | Promise<GuardVerdict>;

/** A single tool execution observed after it ran. */
export interface ToolAfterEvent {
  sessionId: string;
  tool: string;
  ok: boolean;
  path?: string;
  command?: string;
  error?: string;
}

/** Post-execution observer (`tool.execute.after`). */
export type ToolAfterHandler = (
  event: ToolAfterEvent,
) => CircuitBreakerVerdict | Promise<CircuitBreakerVerdict> | void | Promise<void>;

/** Dynamic-context hook (`session.hook("context")`). */
export type SessionContextHandler = (
  event: SessionEvent,
) => void | Promise<void>;

/**
 * Callable tool registrar carrying the post-execution hook namespace, so
 * `context.tool(name, def)` registers tools and
 * `context.tool.execute.after(handler)` observes executions.
 */
export interface ToolRegistrar {
  (name: string, definition: ToolDefinition): void;
  execute: {
    after: (handler: ToolAfterHandler) => void;
  };
}

/** Permission hook namespace (`permission.hook("evaluate", handler)`). */
export interface PermissionHookRegistrar {
  hook: (event: "evaluate", handler: PermissionEvaluateHandler) => void;
}

/** Session hook namespace (`session.hook("context", handler)`). */
export interface SessionHookRegistrar {
  hook: (event: "context", handler: SessionContextHandler) => void;
}

/** Minimal OpenCode v2 plugin context consumed by `activate`. */
export interface PluginContext {
  tool: ToolRegistrar;
  permission: PermissionHookRegistrar;
  session: SessionHookRegistrar;
}

/* ------------------------------------------------------------------ */
/* Plugin options                                                     */
/* ------------------------------------------------------------------ */

/** Construction options for `createHarnessPlugin`. All fields optional. */
export interface HarnessPluginOptions {
  rootDir?: string;
  guardConfig?: GuardPolicyConfig;
  contextBudgetTokens?: number;
  taskMd?: string;
  planMd?: string;
  lessons?: LessonInput[];
}

/** Fully resolved options (every default applied, fail-closed validated). */
export interface ResolvedHarnessOptions {
  rootDir: string;
  guardConfig: GuardPolicyConfig;
  contextBudgetTokens: number;
  taskMd?: string;
  planMd?: string;
  lessons?: LessonInput[];
}

/** The created harness plugin: metadata plus its `activate` closure. */
export interface HarnessPlugin {
  name: string;
  version: string;
  toolNames: readonly string[];
  hookNames: readonly string[];
  options: ResolvedHarnessOptions;
  activate: (context: PluginContext) => void;
}

/**
 * Resolve caller options into concrete settings. Unknown or malformed
 * fields throw (fail-closed) instead of silently adopting permissive
 * defaults.
 */
export function resolveHarnessOptions(
  options?: HarnessPluginOptions,
): ResolvedHarnessOptions {
  if (options !== undefined) {
    const isRecord =
      typeof options === "object" && options !== null && Array.isArray(options) === false;
    if (isRecord === false) {
      throw new Error(
        "opencode-harness: plugin options must be an object when present (fail-closed)",
      );
    }
  }
  const settings: HarnessPluginOptions = options ?? {};
  const cwd = process.cwd();
  const rootDir =
    settings.rootDir !== undefined ? settings.rootDir : cwd;
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
  if (settings.lessons !== undefined && Array.isArray(settings.lessons) === false) {
    throw new Error(
      "opencode-harness: lessons must be an array when present (fail-closed)",
    );
  }
  return {
    rootDir,
    guardConfig,
    contextBudgetTokens: Math.floor(budget as number),
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

/* ------------------------------------------------------------------ */
/* Hook implementations                                               */
/* ------------------------------------------------------------------ */

/**
 * Record one post-execution observation and evaluate the doom-loop
 * circuit breaker. Thin adapter over `recordToolAttempt`: the command
 * prefix is derived with `commandPrefixOf` so shell streaks group by
 * their first two tokens. Invalid observations throw (fail-closed).
 */
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

/** Overrides accepted by `registerContextBudgetHook` for managed sessions. */
export interface ContextHookOverrides {
  rootDir?: string;
  budgetTokens?: number;
  taskMd?: string;
  planMd?: string;
  lessons?: LessonInput[];
}

/**
 * Build dynamic context blocks (`buildDynamicContextBlocks`), fit them
 * into the token budget (`packBlocks`), and inject the packed text into
 * the session event (`injectContextBudgetIntoMessages`). The injection
 * preserves the KV-cache prefix: `event.system` is never touched and the
 * wrapped context lands strictly on the last `role === "user"` message.
 * An empty pack (no artifacts configured) is a strict no-op; a pack with
 * content but no user message throws (fail-closed).
 */
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
/* Tool table                                                         */
/* ------------------------------------------------------------------ */

/**
 * Build the five harness tool definitions bound to `resolved` settings.
 * Every executor validates its args with zod first (fail-closed) and then
 * delegates to the underlying Wave 1 / Wave 2 implementation.
 */
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
  if (
    typeof (context as PluginContext).permission?.hook !== "function"
  ) {
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

/**
 * Activate the harness plugin with default settings (workspace root at
 * `process.cwd()`, default guard policy, default context budget) against
 * an OpenCode v2 plugin context.
 */
export function activate(context: PluginContext): void {
  activateWithOptions(context, resolveHarnessOptions());
}

/**
 * Create a configured harness plugin. The returned `activate` closure
 * registers the five tools and three hooks bound to the resolved options.
 */
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
