/**
 * `src/host/contract-adapter.ts` — Real OpenCode V2 (`@opencode-ai/plugin` /
 * `packages/core/src/plugin/module.ts`) `PromiseContext` host adapter,
 * plugin-over-patch interceptors, Dual Direct + Code Mode (`tools.harness.*`)
 * tool registration, and `/doctor` self-diagnostics report.
 */

import { existsSync, readFileSync } from "node:fs";
import type { ZodTypeAny } from "zod";
import { HARNESS_RELEASE_VERSION } from "../version.js";
import { zodToJsonSchema } from "zod-to-json-schema";
import type { GuardRequest, GuardVerdict } from "../guards/permission-guard.js";
import type { SessionEvent, SessionMessage } from "../context/context-budget.js";
import {
  buildMuseSystemOverlay,
  captureWorkspaceDigests,
  createMutationReceipt,
  isCompactionAgent,
  sanitizeCompactionPseudoTranscript,
} from "../muse/muse-calibration.js";
import {
  collectFileDiagnostics,
  localizeFaultContext,
} from "../diagnostics/diagnostics-runner.js";
import {
  beginEditTransaction,
  checkStaleFileRead,
  extractTargetPathsFromToolInput,
  finalizeEditTransaction,
  recordFileReadTimestamp,
} from "../transactions/edit-transaction.js";
import {
  evaluateTaintGuard,
  isUntrustedIngestionTool,
  recordUntrustedContentTaint,
} from "../guards/taint-guard.js";
import {
  appendBlocksToToolAfterEvent,
  buildEditNearMissContext,
  buildPostMutationAnchorReceipt,
  didToolExecutionFail,
  extractToolOutputText,
  hardenShellInvocation,
  normalizePluginToolResult,
  repairEditToolInputInPlace,
  repairPatchToolInputInPlace,
  resolveMissingReadPath,
} from "../interceptors/tool-interceptors.js";
import {
  applyRootAffinityHeadersInPlace,
  calibrateSystemPromptInPlace,
  decontaminateCompactionEventInPlace,
  handleSessionRetryInPlace,
  recordSessionParentLink,
  type SessionRetryEvent,
} from "../interceptors/session-interceptors.js";
import {
  evaluateContractChangeImpact,
  runArchitectureAudit,
} from "../verify/architecture-advisor.js";
import { trackCircuitBreakerAndAutoProposeLesson } from "../context/episodic-memory.js";
import { buildRepoMap, extractOutline } from "../repomap/repomap.js";
import { getRecommendedMcpConfig } from "../ui-auditor/mcp-defaults.js";
import type { ToolDefinition } from "../index.js";

export type { SessionRetryEvent as OpenCodeV2SessionRetryEvent } from "../interceptors/session-interceptors.js";

export interface OpenCodeV2ToolEditor {
  namespace?: (ns: { name: string; description?: string }) => void;
  add: (tool: {
    name: string;
    description: string;
    input: unknown;
    options?: {
      codemode?: boolean;
      namespace?: string;
      permission?: string;
      pinned?: boolean;
    };
    execute: (
      args: Record<string, unknown>,
      ctx?: unknown,
    ) => Promise<{
      content: Array<{ type: "text"; text: string }>;
      metadata?: Record<string, unknown>;
      [k: string]: unknown;
    }>;
  }) => void;
  update?: (id: string, fn: (tool: Record<string, unknown>) => void) => void;
  get?: (id: string) => Record<string, unknown> | undefined;
}

export interface OpenCodeV2ToolBeforeEvent {
  sessionID: string;
  agent?: string;
  tool: string;
  input?: Record<string, unknown>;
}

export interface OpenCodeV2ToolAfterEvent {
  sessionID: string;
  agent?: string;
  tool: string;
  input?: Record<string, unknown>;
  status: "completed" | "error";
  result?: {
    output?: unknown;
    content?: Array<{ type: string; text?: string }>;
    metadata?: Record<string, unknown>;
  };
  error?: { message?: string } | string;
}

export interface OpenCodeV2PermissionEvent {
  sessionID?: string;
  agent?: string;
  action: string;
  resources: string[];
  effect: "allow" | "ask" | "deny";
  message?: string;
}

export interface OpenCodeV2SessionPromptEvent {
  sessionID?: string;
  agent?: string;
  system: Array<{ text: string; [k: string]: unknown }>;
  prompt?: unknown;
}

export interface OpenCodeV2SessionContextEvent {
  sessionID?: string;
  agent?: string;
  system?: Array<{ text: string; [k: string]: unknown }>;
  messages: Array<{
    role: string;
    content: string | Array<{ type: string; text?: string; [k: string]: unknown }>;
  }>;
  tools?: Record<string, unknown>;
}

export interface OpenCodeV2SessionCompactionEvent {
  sessionID?: string;
  agent?: string;
  system?: Array<{ text: string; [k: string]: unknown }>;
  messages?: Array<unknown>;
  tools?: Record<string, unknown>;
}

export interface OpenCodeV2SessionModelRequestEvent {
  sessionID?: string;
  agent?: string;
  kind?: "primary" | "compaction" | "title" | "generate";
  baseURL?: string;
  headers: Record<string, string>;
}

export interface OpenCodeV2ShellBeforeEvent {
  command: string;
  cwd?: string;
  timeout?: number;
  shell?: string;
  env?: Record<string, string | undefined>;
}

export interface OpenCodeV2AgentEditor {
  get?: (id: string) => Record<string, unknown> | undefined;
  update: (
    id: string,
    fn: (agent: {
      name?: string;
      description?: string;
      system?: string;
      permissions?: Array<{
        action: string;
        resource: string;
        effect: "allow" | "ask" | "deny";
      }>;
    }) => void,
  ) => void;
}

export interface OpenCodeV2CommandEditor {
  add: (definition: {
    name: string;
    description?: string;
    execute: (input: { sessionID: string; prompt?: unknown }) => Promise<void>;
  }) => void;
}

export interface OpenCodeV2McpEditor {
  get?: (name: string) => unknown;
  set: (name: string, config: unknown) => void;
}

export interface OpenCodeV2PromiseContext {
  /** Plugin options from the `plugins` config entry (OpenCode V2 `PluginOptions`). */
  options?: Readonly<Record<string, unknown>>;
  directory?: string;
  worktree?: string;
  location?: { directory?: string; worktree?: string };
  tool?: {
    transform?: (fn: (editor: OpenCodeV2ToolEditor) => void) => void;
    hook?: (
      event: "execute.before" | "execute.after",
      handler: (ev: any) => void | Promise<void>,
    ) => void;
  };
  permission?: {
    hook?: (
      event: "evaluate",
      handler: (ev: OpenCodeV2PermissionEvent) => void | Promise<void>,
    ) => void;
  };
  session?: {
    hook?: (
      event:
        | "prompt"
        | "context"
        | "compaction"
        | "generate"
        | "model.request"
        | "retry",
      handler: (ev: any) => void | Promise<void>,
    ) => void;
    synthetic?: (input: { sessionID: string; text: string }) => Promise<unknown>;
  };
  shell?: {
    hook?: (
      event: "create.before",
      handler: (ev: OpenCodeV2ShellBeforeEvent) => void | Promise<void>,
    ) => void;
  };
  agent?: {
    transform?: (fn: (editor: OpenCodeV2AgentEditor) => void) => void;
  };
  command?: {
    transform?: (fn: (editor: OpenCodeV2CommandEditor) => void) => void;
  };
  mcp?: {
    transform?: (fn: (editor: OpenCodeV2McpEditor) => void) => void;
  };
}

export interface DoctorReport {
  pluginId: string;
  version: string;
  workspaceRoot: string;
  hostSurface: {
    toolTransform: boolean;
    toolHook: boolean;
    permissionHook: boolean;
    sessionHook: boolean;
    shellHook: boolean;
    agentTransform: boolean;
    commandTransform: boolean;
    mcpTransform: boolean;
  };
  registeredTools: string[];
  activeGuards: string[];
  activeInterceptors: string[];
  healthy: boolean;
}

const MUTATING_FILE_TOOLS = new Set([
  "edit",
  "write",
  "patch",
  "multiedit",
  "file_hash_edit",
  "ast_structural_rewrite",
  "rename_symbol",
]);

const READ_FILE_TOOLS = new Set(["read", "file_hash_read"]);

const CODEMODE_PINNED_TOOLS = new Set([
  "file_hash_read",
  "ast_structural_search",
  "repo_map",
  "blast_radius",
  "file_outline",
  "symbol_references",
  "rename_symbol",
  "architecture_audit",
]);

/**
 * Convert a harness zod (v3) argument schema into a plain JSON Schema object
 * for `ToolEditor.add({ input })`. The real OpenCode V2 host
 * (`packages/core/src/tool/runtime.ts`) only accepts Effect schemas, Standard
 * JSON Schema implementations, or plain JSON Schema; zod v3 schemas are
 * rejected at registration ("Schema vendor zod does not support JSON Schema
 * conversion") and the tool silently disappears. Arguments are still
 * validated by the zod schema inside each tool's `execute`.
 */
export function toHostInputSchema(schema: ZodTypeAny): Record<string, unknown> {
  const json = zodToJsonSchema(schema, {
    target: "jsonSchema7",
    $refStrategy: "none",
  }) as Record<string, unknown>;
  const { $schema: _ignored, ...rest } = json;
  return rest;
}

export function inspectHostContract(
  ctx: OpenCodeV2PromiseContext,
  pluginId: string,
  version: string,
  workspaceRoot: string,
  registeredTools: string[],
): DoctorReport {
  const hostSurface = {
    toolTransform: typeof ctx?.tool?.transform === "function",
    toolHook: typeof ctx?.tool?.hook === "function",
    permissionHook: typeof ctx?.permission?.hook === "function",
    sessionHook: typeof ctx?.session?.hook === "function",
    shellHook: typeof ctx?.shell?.hook === "function",
    agentTransform: typeof ctx?.agent?.transform === "function",
    commandTransform: typeof ctx?.command?.transform === "function",
    mcpTransform: typeof ctx?.mcp?.transform === "function",
  };
  const healthy =
    hostSurface.toolTransform &&
    hostSurface.permissionHook &&
    hostSurface.sessionHook;

  return {
    pluginId,
    version,
    workspaceRoot,
    hostSurface,
    registeredTools,
    activeGuards: [
      "board-permission-guard (Rules 0-4)",
      "posix-subshell-unwrapper",
      "prompt-injection-taint-guard",
      "atomic-edit-transaction-rollback",
      "stale-file-read-detector",
      "post-mutation-diagnostics-runner",
      "cross-file-import-export-contract-verifier",
      "stack-frame-fault-localizer",
      "doom-loop-circuit-breaker",
      "kv-cache-safe-context-budget",
      "compaction-contamination-guard",
    ],
    activeInterceptors: [
      "edit-line-prefix-and-indentation-auto-repair",
      "patch-envelope-and-line-prefix-auto-repair",
      "edit-near-miss-hashline-anchor-recovery",
      "post-edit-formatter-anchor-resync-receipt",
      "edit-exported-contract-impact-analyzer",
      "read-missing-path-fuzzy-resolver",
      "shell-non-interactive-env-hardener",
      "shell-nonzero-exit-fault-localizer",
      "tool-output-head-tail-anti-truncation-compactor",
      "subagent-sha256-mutation-receipt-verifier",
      "meta-txt-prompt-guidance-calibrator",
      "compaction-prompt-and-tools-decontaminator",
      "multihop-root-session-affinity-propagator",
      "session-retry-adaptive-stream-backoff",
      "circuit-breaker-episodic-lesson-auto-proposer",
      "codemode-harness-namespace-bridge",
    ],
    healthy,
  };
}

export function wireOpenCodeV2PromiseContext(params: {
  ctx: OpenCodeV2PromiseContext;
  workspaceRoot: string;
  tools: Record<string, ToolDefinition>;
  evaluatePermission: (req: GuardRequest) => GuardVerdict;
  recordCircuitBreaker: (ev: {
    sessionId: string;
    tool: string;
    ok: boolean;
    path?: string;
    command?: string;
    error?: string;
  }) => { tripped: boolean; directive?: string };
  runContextBudget: (ev: SessionEvent) => void;
  /**
   * Opt-in: add the recommended `lsp-mcp-server` / `fallow-mcp` servers when
   * absent. Off by default because both launch through `bunx` / `npx --yes`,
   * which download and run npm packages the user never configured.
   */
  seedRecommendedMcp?: boolean;
}): DoctorReport {
  const {
    ctx,
    workspaceRoot,
    tools,
    evaluatePermission,
    recordCircuitBreaker,
    runContextBudget,
    seedRecommendedMcp = false,
  } = params;

  const toolNames = Object.keys(tools);
  const preEditContentBySession = new Map<string, Map<string, string>>();
  const preSubagentDigestsBySession = new Map<
    string,
    Map<string, string | null>
  >();
  const pendingReadSuggestions = new Map<string, string[]>();

  // 1. Register direct top-level tools (`options: { codemode: false }`) AND, when the host
  //    supports `editor.namespace`, also register `tools.harness.*` for Code Mode (`execute`).
  if (typeof ctx.tool?.transform === "function") {
    ctx.tool.transform((editor) => {
      for (const [name, def] of Object.entries(tools)) {
        editor.add({
          name,
          description: def.description,
          input: toHostInputSchema(def.parameters),
          options: { codemode: false },
          execute: async (args, execCtx) => {
            const raw = await def.execute(args, execCtx as any);
            return normalizePluginToolResult(raw);
          },
        });
      }

      if (typeof editor.namespace === "function") {
        editor.namespace({
          name: "harness",
          description:
            "In-process repository intelligence, hash-anchored file reads, symbol reference search, atomic multi-file rename, blast-radius analysis, and architecture auditing for batched Code Mode scripts.",
        });
        for (const [name, def] of Object.entries(tools)) {
          if (!CODEMODE_PINNED_TOOLS.has(name)) continue;
          editor.add({
            name,
            description: def.description,
            input: toHostInputSchema(def.parameters),
            options: {
              namespace: "harness",
              codemode: true,
              pinned: true,
            },
            execute: async (args, execCtx) => {
              const raw = await def.execute(args, execCtx as any);
              return normalizePluginToolResult(raw);
            },
          });
        }
      }
    });
  }

  // 2. Harden read-only agents (`explore`) via `ctx.agent.transform`
  if (typeof ctx.agent?.transform === "function") {
    ctx.agent.transform((editor) => {
      editor.update("explore", (agent) => {
        if (typeof agent.description === "string") {
          agent.description = `${agent.description} (Read-only enforced by opencode-harness permission guard.)`;
        }
      });
    });
  }

  // 3. Opt-in: seed recommended MCP servers (`lsp-mcp-server`, `fallow-mcp`)
  //    in the OpenCode V2 `Mcp.LocalConfig` shape when not already configured.
  if (seedRecommendedMcp && typeof ctx.mcp?.transform === "function") {
    ctx.mcp.transform((editor) => {
      const rec = getRecommendedMcpConfig().mcpServers;
      for (const [serverName, cfg] of Object.entries(rec)) {
        const existing =
          typeof editor.get === "function" ? editor.get(serverName) : undefined;
        if (!existing) {
          editor.set(serverName, {
            type: "local",
            command: [cfg.command, ...cfg.args],
            ...(cfg.env !== undefined ? { environment: cfg.env } : {}),
          });
        }
      }
    });
  }

  // 4. Register `/doctor` and `/audit` slash commands via `ctx.command.transform`
  if (typeof ctx.command?.transform === "function") {
    ctx.command.transform((editor) => {
      editor.add({
        name: "doctor",
        description:
          "Run opencode-harness self-diagnostics and verify active guards and interceptors.",
        execute: async (input) => {
          const rep = inspectHostContract(
            ctx,
            "@heretek-ai/opencode-harness",
            HARNESS_RELEASE_VERSION,
            workspaceRoot,
            toolNames,
          );
          if (typeof ctx.session?.synthetic === "function") {
            await ctx.session.synthetic({
              sessionID: input.sessionID,
              text: `<harness-doctor>\n${JSON.stringify(rep, null, 2)}\n</harness-doctor>`,
            });
          }
        },
      });
      editor.add({
        name: "audit",
        description:
          "Run a repository-wide circular dependency, unused export, and engineering quality audit.",
        execute: async (input) => {
          const audit = runArchitectureAudit(workspaceRoot);
          if (typeof ctx.session?.synthetic === "function") {
            await ctx.session.synthetic({
              sessionID: input.sessionID,
              text: audit.formattedReport,
            });
          }
        },
      });
    });
  }

  // 5. Harden `shell.hook("create.before")` with non-interactive environment defaults
  if (typeof ctx.shell?.hook === "function") {
    ctx.shell.hook("create.before", (invocation: OpenCodeV2ShellBeforeEvent) => {
      hardenShellInvocation(invocation);
    });
  }

  // 6. Enforce permission guards (Rules 0-4, explore read-only shell lock, and taint guard)
  if (typeof ctx.permission?.hook === "function") {
    ctx.permission.hook("evaluate", (event: OpenCodeV2PermissionEvent) => {
      const sessionId = event.sessionID ?? "default";
      const firstResource = event.resources?.[0] ?? "";
      const isShell = event.action === "shell" || event.action === "bash";
      const agentRole =
        event.agent === "explore" || event.agent === "plan"
          ? "director"
          : (event.agent ?? "builder");

      const guardReq: GuardRequest = {
        role: agentRole,
        tool: isShell ? "bash" : event.action,
        ...(isShell ? { command: firstResource } : { path: firstResource }),
      };

      const verdict = evaluatePermission(guardReq);
      if (verdict.allowed === false) {
        event.effect = "deny";
        event.message = verdict.reason;
        return;
      }

      const taintVerdict = evaluateTaintGuard(
        sessionId,
        firstResource,
        isShell ? "shell" : "file",
      );
      if (taintVerdict.action === "deny") {
        event.effect = "deny";
        event.message = taintVerdict.reason;
      } else if (taintVerdict.action === "ask" && event.effect === "allow") {
        event.effect = "ask";
        event.message = taintVerdict.reason;
      }
    });
  }

  // 7. Wire `tool.hook("execute.before" | "execute.after")` interceptors
  if (typeof ctx.tool?.hook === "function") {
    ctx.tool.hook("execute.before", (event: OpenCodeV2ToolBeforeEvent) => {
      const sessionId = event.sessionID || "default";
      const toolName = (event.tool || "").toLowerCase();

      // Auto-repair EditTool line-number prefixes ("12: " / "12#a3f2| ") and indentation drift in-place
      if (toolName === "edit" && event.input) {
        repairEditToolInputInPlace(event.input, workspaceRoot);
      }

      // Auto-repair PatchTool missing *** Begin/End Patch envelope and hunk line prefixes in-place
      if (toolName === "patch" && event.input) {
        repairPatchToolInputInPlace(event.input);
      }

      // Auto-resolve unambiguous missing read paths or cache suggestions for error enrichment
      if (toolName === "read" && event.input) {
        const res = resolveMissingReadPath(event.input, workspaceRoot, true);
        if (!res.existed && res.suggestions.length > 0 && !res.rewrittenTo) {
          pendingReadSuggestions.set(sessionId, res.suggestions);
        } else {
          pendingReadSuggestions.delete(sessionId);
        }
      }

      // Snapshot workspace digests before subagent execution to verify ground-truth mutations
      if (toolName === "subagent") {
        const map = buildRepoMap(workspaceRoot, 500);
        const digests = captureWorkspaceDigests(
          map.rankedFiles.map((f) => f.absPath),
          workspaceRoot,
        );
        preSubagentDigestsBySession.set(sessionId, digests);
      }

      if (MUTATING_FILE_TOOLS.has(toolName)) {
        const targets = extractTargetPathsFromToolInput(
          event.input,
          workspaceRoot,
        );
        for (const target of targets) {
          const staleCheck = checkStaleFileRead(
            sessionId,
            target,
            workspaceRoot,
            false,
          );
          if (staleCheck.stale) {
            throw new Error(staleCheck.reason);
          }
        }
        if (targets.length > 0) {
          const contentMap = new Map<string, string>();
          for (const target of targets) {
            if (existsSync(target)) {
              try {
                contentMap.set(target, readFileSync(target, "utf8"));
              } catch (err) {
                if (err) continue;
              }
            }
          }
          preEditContentBySession.set(sessionId, contentMap);
          beginEditTransaction(sessionId, toolName, targets, workspaceRoot);
        }
      }
    });

    ctx.tool.hook(
      "execute.after",
      async (event: OpenCodeV2ToolAfterEvent): Promise<void> => {
        const sessionId = event.sessionID || "default";
        const toolName = (event.tool || "").toLowerCase();
        const failed = didToolExecutionFail(event);
        const ok = !failed;
        const targets = extractTargetPathsFromToolInput(
          event.input,
          workspaceRoot,
        );
        const primaryPath = targets[0];
        const command =
          typeof event.input?.command === "string"
            ? event.input.command
            : undefined;

        if (READ_FILE_TOOLS.has(toolName) && primaryPath) {
          if (ok) {
            recordFileReadTimestamp(sessionId, primaryPath, workspaceRoot);
          } else {
            const suggestions = pendingReadSuggestions.get(sessionId);
            pendingReadSuggestions.delete(sessionId);
            if (suggestions && suggestions.length > 0) {
              appendBlocksToToolAfterEvent(event, [
                `<path-suggestions requested="${primaryPath}">Did you mean one of these repo-relative files?\n  - ${suggestions.join("\n  - ")}\n</path-suggestions>`,
              ]);
            }
          }
        }

        if (isUntrustedIngestionTool(toolName) && ok) {
          recordUntrustedContentTaint(sessionId, toolName);
        }

        const appendedBlocks: string[] = [];

        if (MUTATING_FILE_TOOLS.has(toolName)) {
          const rollback = finalizeEditTransaction(sessionId, ok);
          if (rollback && rollback.formattedTag) {
            appendedBlocks.push(rollback.formattedTag);
          }
          if (!ok && toolName === "edit") {
            const nearMiss = await buildEditNearMissContext(
              event.input,
              workspaceRoot,
            );
            if (nearMiss) {
              appendedBlocks.push(nearMiss);
            }
          }
          const preContents = preEditContentBySession.get(sessionId);
          preEditContentBySession.delete(sessionId);

          if (ok && targets.length > 0) {
            for (const target of targets) {
              recordFileReadTimestamp(sessionId, target, workspaceRoot);
              const diag = collectFileDiagnostics(target, workspaceRoot);
              if (!diag.clean && diag.formattedTag) {
                appendedBlocks.push(diag.formattedTag);
              }
              const beforeText = preContents?.get(target);
              if (existsSync(target)) {
                try {
                  const afterText = readFileSync(target, "utf8");
                  const anchorReceipt = buildPostMutationAnchorReceipt({
                    filePath: target,
                    beforeContent: beforeText,
                    afterContent: afterText,
                    workspaceRoot,
                  });
                  if (anchorReceipt) {
                    appendedBlocks.push(anchorReceipt);
                  }
                  if (beforeText !== undefined) {
                    const impact = evaluateContractChangeImpact({
                      filePath: target,
                      beforeContent: beforeText,
                      afterContent: afterText,
                      rootDir: workspaceRoot,
                    });
                    if (impact && impact.formattedTag) {
                      appendedBlocks.push(impact.formattedTag);
                    }
                  }
                } catch (err) {
                  if (err) continue;
                }
              }
            }
          }
        }

        // Verify subagent mutations and record child->parent session lineage
        if (toolName === "subagent") {
          const outObj =
            event.result?.output && typeof event.result.output === "object"
              ? (event.result.output as { sessionID?: string })
              : undefined;
          if (outObj?.sessionID) {
            recordSessionParentLink(outObj.sessionID, sessionId);
          }
          const beforeDigests = preSubagentDigestsBySession.get(sessionId);
          preSubagentDigestsBySession.delete(sessionId);
          if (beforeDigests && ok) {
            const receipt = createMutationReceipt(
              outObj?.sessionID ?? sessionId,
              beforeDigests,
              workspaceRoot,
            );
            appendedBlocks.push(receipt.formattedBlock);
            for (const changed of receipt.files.filter(
              (f) => f.changed && f.existsAfter,
            )) {
              const diag = collectFileDiagnostics(
                changed.relPath,
                workspaceRoot,
              );
              if (!diag.clean && diag.formattedTag) {
                appendedBlocks.push(diag.formattedTag);
              }
            }
          }
        }

        if ((toolName === "bash" || toolName === "shell") && !ok) {
          const rawOut = extractToolOutputText(event);
          const fault = await localizeFaultContext(rawOut, workspaceRoot);
          if (fault.formattedBlock) {
            appendedBlocks.push(fault.formattedBlock);
          }
        }

        // Enrich windowed `read` on large files with a compact symbol outline summary
        if (
          toolName === "read" &&
          ok &&
          primaryPath &&
          (event.input?.offset !== undefined || event.input?.limit !== undefined)
        ) {
          try {
            const symbols = extractOutline(primaryPath).filter(
              (s) => s.exported,
            );
            if (symbols.length >= 3) {
              const symList = symbols
                .slice(0, 12)
                .map((s) => `${s.name}@L${s.line}`)
                .join(", ");
              appendedBlocks.push(
                `<file-outline-summary exported="${symbols.length}">${symList}</file-outline-summary>`,
              );
            }
          } catch (err) {
            if (err) {
              // ignore outline errors on non-code files
            }
          }
        }

        const cbVerdict = recordCircuitBreaker({
          sessionId,
          tool: toolName,
          ok,
          ...(primaryPath !== undefined ? { path: primaryPath } : {}),
          ...(command !== undefined ? { command } : {}),
          ...(typeof event.error === "string"
            ? { error: event.error }
            : event.error?.message
              ? { error: event.error.message }
              : {}),
        });

        if (cbVerdict.tripped && cbVerdict.directive) {
          appendedBlocks.push(cbVerdict.directive);
        }

        const autoLesson = trackCircuitBreakerAndAutoProposeLesson({
          sessionId,
          toolName,
          ok,
          tripped: cbVerdict.tripped,
          targetPathOrCommand: primaryPath ?? command,
          workspaceRoot,
        });
        if (autoLesson) {
          appendedBlocks.push(
            `<episodic-recovery-lesson id="${autoLesson.id}" scope="${autoLesson.scopePrefix ?? ""}">${autoLesson.proposedSummary}</episodic-recovery-lesson>`,
          );
        }

        appendBlocksToToolAfterEvent(event, appendedBlocks);
      },
    );
  }

  // 8. Wire `session.hook` (`prompt`, `context`, `generate`, `compaction`, `model.request`, `retry`)
  if (typeof ctx.session?.hook === "function") {
    ctx.session.hook("prompt", (event: OpenCodeV2SessionPromptEvent) => {
      if (isCompactionAgent(event.agent)) {
        return;
      }
      if (Array.isArray(event.system)) {
        if (event.system.length === 0) {
          event.system.push({ text: buildMuseSystemOverlay() });
        } else {
          calibrateSystemPromptInPlace(event.system);
        }
      }
    });

    const handleContextOrGenerate = (event: OpenCodeV2SessionContextEvent) => {
      if (isCompactionAgent(event.agent)) {
        return;
      }

      if (Array.isArray(event.system)) {
        calibrateSystemPromptInPlace(event.system);
      }

      if (!Array.isArray(event.messages) || event.messages.length === 0) {
        return;
      }

      for (const msg of event.messages) {
        if (typeof msg.content === "string") {
          msg.content = sanitizeCompactionPseudoTranscript(msg.content);
        } else if (Array.isArray(msg.content)) {
          for (const part of msg.content) {
            if (part && part.type === "text" && typeof part.text === "string") {
              part.text = sanitizeCompactionPseudoTranscript(part.text);
            }
          }
        }
      }

      const adaptedMessages: SessionMessage[] = event.messages.map((m) => {
        if (typeof m.content === "string") {
          return { role: m.role as SessionMessage["role"], content: m.content };
        }
        const textPart = Array.isArray(m.content)
          ? m.content.find(
              (p) => p && p.type === "text" && typeof p.text === "string",
            )
          : undefined;
        return {
          role: m.role as SessionMessage["role"],
          content: textPart?.text ?? "",
        };
      });

      const hasUser = adaptedMessages.some((m) => m.role === "user");
      if (!hasUser) return;

      const syntheticEvent: SessionEvent = {
        system: [],
        messages: adaptedMessages,
      };
      runContextBudget(syntheticEvent);

      for (let i = event.messages.length - 1; i >= 0; i--) {
        if (event.messages[i]?.role === "user") {
          const updated: unknown = syntheticEvent.messages?.[i]?.content ?? "";
          if (typeof updated !== "string") {
            throw new Error(
              "opencode-harness: context hook produced non-string user content (fail-closed)",
            );
          }
          const updatedText: string = updated;
          const origContent = event.messages[i]!.content;
          if (typeof origContent === "string") {
            event.messages[i]!.content = updatedText;
          } else if (Array.isArray(origContent)) {
            const textPart = origContent.find((p) => p && p.type === "text");
            if (textPart) {
              textPart.text = updatedText;
            } else {
              origContent.push({ type: "text", text: updatedText });
            }
          }
          break;
        }
      }
    };

    ctx.session.hook("context", handleContextOrGenerate);
    ctx.session.hook("generate", handleContextOrGenerate);

    ctx.session.hook(
      "compaction",
      (event: OpenCodeV2SessionCompactionEvent) => {
        decontaminateCompactionEventInPlace(event);
      },
    );

    ctx.session.hook(
      "model.request",
      (event: OpenCodeV2SessionModelRequestEvent) => {
        applyRootAffinityHeadersInPlace(event);
      },
    );

    ctx.session.hook("retry", (event: SessionRetryEvent) => {
      handleSessionRetryInPlace(event);
    });
  }

  return inspectHostContract(
    ctx,
    "@heretek-ai/opencode-harness",
    HARNESS_RELEASE_VERSION,
    workspaceRoot,
    toolNames,
  );
}
