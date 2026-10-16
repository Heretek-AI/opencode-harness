/**
 * `src/host/contract-adapter.ts` — Real OpenCode V2 (`@opencode-ai/plugin` /
 * `packages/core/src/plugin/module.ts`) `PromiseContext` host adapter and
 * `/doctor` self-diagnostics report, ported from `SwarmOS/src/host/contract.ts`.
 */

import type { GuardRequest, GuardVerdict } from "../guards/permission-guard.js";
import type { SessionEvent, SessionMessage } from "../context/context-budget.js";
import {
  buildMuseSystemOverlay,
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
import type { ToolDefinition } from "../index.js";

export interface OpenCodeV2ToolEditor {
  add: (tool: {
    name: string;
    description: string;
    input: unknown;
    execute: (args: Record<string, unknown>, ctx?: unknown) => Promise<unknown>;
  }) => void;
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
    output?: string;
    metadata?: Record<string, unknown>;
  };
  error?: string;
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
}

export interface OpenCodeV2SessionContextEvent {
  sessionID?: string;
  agent?: string;
  messages: Array<{
    role: string;
    content: string | Array<{ type: string; text?: string; [k: string]: unknown }>;
  }>;
}

export interface OpenCodeV2PromiseContext {
  directory?: string;
  worktree?: string;
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
      event: "prompt" | "context",
      handler: (ev: any) => void | Promise<void>,
    ) => void;
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
  };
  registeredTools: string[];
  activeGuards: string[];
  healthy: boolean;
}

const MUTATING_FILE_TOOLS = new Set([
  "edit",
  "write",
  "patch",
  "multiedit",
  "file_hash_edit",
  "ast_structural_rewrite",
]);

const READ_FILE_TOOLS = new Set(["read", "file_hash_read"]);

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
      "stack-frame-fault-localizer",
      "doom-loop-circuit-breaker",
      "kv-cache-safe-context-budget",
      "compaction-contamination-guard",
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
}): DoctorReport {
  const {
    ctx,
    workspaceRoot,
    tools,
    evaluatePermission,
    recordCircuitBreaker,
    runContextBudget,
  } = params;

  const toolNames = Object.keys(tools);

  if (typeof ctx.tool?.transform === "function") {
    ctx.tool.transform((editor) => {
      for (const [name, def] of Object.entries(tools)) {
        editor.add({
          name,
          description: def.description,
          input: def.parameters,
          execute: (args, execCtx) => def.execute(args, execCtx as any),
        });
      }
    });
  }

  if (typeof ctx.permission?.hook === "function") {
    ctx.permission.hook("evaluate", (event: OpenCodeV2PermissionEvent) => {
      const sessionId = event.sessionID ?? "default";
      const firstResource = event.resources?.[0] ?? "";
      const isShell = event.action === "shell" || event.action === "bash";

      const guardReq: GuardRequest = {
        role: event.agent ?? "builder",
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

  if (typeof ctx.tool?.hook === "function") {
    ctx.tool.hook("execute.before", (event: OpenCodeV2ToolBeforeEvent) => {
      const sessionId = event.sessionID || "default";
      const toolName = (event.tool || "").toLowerCase();

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
          beginEditTransaction(sessionId, toolName, targets, workspaceRoot);
        }
      }
    });

    ctx.tool.hook(
      "execute.after",
      async (event: OpenCodeV2ToolAfterEvent): Promise<void> => {
        const sessionId = event.sessionID || "default";
        const toolName = (event.tool || "").toLowerCase();
        const ok = event.status === "completed";
        const targets = extractTargetPathsFromToolInput(
          event.input,
          workspaceRoot,
        );
        const primaryPath = targets[0];
        const command =
          typeof event.input?.command === "string"
            ? event.input.command
            : undefined;

        if (READ_FILE_TOOLS.has(toolName) && ok && primaryPath) {
          recordFileReadTimestamp(sessionId, primaryPath, workspaceRoot);
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
          if (ok && targets.length > 0) {
            for (const target of targets) {
              const diag = collectFileDiagnostics(target, workspaceRoot);
              if (!diag.clean && diag.formattedTag) {
                appendedBlocks.push(diag.formattedTag);
              }
            }
          }
        }

        if ((toolName === "bash" || toolName === "shell") && !ok) {
          const rawOut = event.result?.output ?? event.error ?? "";
          const fault = await localizeFaultContext(rawOut, workspaceRoot);
          if (fault.formattedBlock) {
            appendedBlocks.push(fault.formattedBlock);
          }
        }

        const cbVerdict = recordCircuitBreaker({
          sessionId,
          tool: toolName,
          ok,
          ...(primaryPath !== undefined ? { path: primaryPath } : {}),
          ...(command !== undefined ? { command } : {}),
          ...(event.error !== undefined ? { error: event.error } : {}),
        });

        if (cbVerdict.tripped && cbVerdict.directive) {
          appendedBlocks.push(cbVerdict.directive);
        }

        if (appendedBlocks.length > 0 && event.result) {
          const prev = event.result.output ?? "";
          event.result.output = prev
            ? `${prev}\n\n${appendedBlocks.join("\n")}`
            : appendedBlocks.join("\n");
        }
      },
    );
  }

  if (typeof ctx.session?.hook === "function") {
    ctx.session.hook("prompt", (event: OpenCodeV2SessionPromptEvent) => {
      if (isCompactionAgent(event.agent)) {
        return;
      }
      if (Array.isArray(event.system)) {
        const overlay = buildMuseSystemOverlay();
        const alreadyPresent = event.system.some(
          (part) =>
            typeof part.text === "string" &&
            part.text.includes("<muse-1.3-harness-calibration>"),
        );
        if (!alreadyPresent) {
          event.system.push({ text: overlay });
        }
      }
    });

    ctx.session.hook("context", (event: OpenCodeV2SessionContextEvent) => {
      if (isCompactionAgent(event.agent)) {
        return;
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
    });
  }

  return inspectHostContract(
    ctx,
    "@heretek-ai/opencode-harness",
    "1.1.0",
    workspaceRoot,
    toolNames,
  );
}
