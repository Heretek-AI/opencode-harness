/**
 * `test/plugin.test.ts` — Wave 3 unified plugin entrypoint suite.
 *
 * Covers `src/index.ts` per `docs/prompts/SPEC.md` Section 2.5: tool
 * registration (all five tools with zod-validated executors), hook
 * registration (`permission.hook("evaluate")`, `tool.execute.after`,
 * `session.hook("context")`), guard integration (Rules 1–4 through the
 * registered permission handler), circuit-breaker integration, session
 * context KV-cache invariants through the registered hook, the exact MCP
 * config re-export, and re-export wiring for every Wave 1 + Wave 2 module.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  activate,
  buildHarnessTools,
  classifyShellCommand,
  clearAllSessionAttempts,
  computeLineHash,
  createHarnessPlugin,
  DEFAULT_CONTEXT_BUDGET_TOKENS,
  DEFAULT_LOCKED_CONTRACT_GLOBS,
  evaluateBoardGuard,
  evaluateSession,
  getRecommendedMcpConfig,
  HARNESS_HOOK_NAMES,
  HARNESS_NAME,
  HARNESS_TOOL_NAMES,
  HARNESS_VERSION,
  isDestructiveShellCommand,
  estimateTokens,
  injectContextBudgetIntoMessages,
  packBlocks,
  recordAndEvaluateCircuitBreaker,
  recordToolAttempt,
  registerContextBudgetHook,
  resetSessionAttempts,
  resolveHarnessOptions,
  resolveSafePath,
  sessionAttempts,
  splitLines,
  structuralFallbackSearch,
  substituteRewrite,
  type GuardRequest,
  type HarnessToolName,
  type PermissionEvaluateHandler,
  type PluginContext,
  type SessionContextHandler,
  type SessionEvent,
  type ToolAfterEvent,
  type ToolAfterHandler,
  type ToolDefinition,
} from "../src/index";

let roots: string[] = [];

async function makeRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "wave3-plugin-"));
  roots.push(root);
  return root;
}

interface FakePluginHost {
  tools: Map<string, ToolDefinition>;
  permissionHandlers: PermissionEvaluateHandler[];
  afterHandlers: ToolAfterHandler[];
  contextHandlers: SessionContextHandler[];
  context: PluginContext;
}

function createFakePluginHost(): FakePluginHost {
  const tools = new Map<string, ToolDefinition>();
  const permissionHandlers: PermissionEvaluateHandler[] = [];
  const afterHandlers: ToolAfterHandler[] = [];
  const contextHandlers: SessionContextHandler[] = [];
  const registrar = Object.assign(
    (name: string, definition: ToolDefinition): void => {
      if (tools.has(name)) {
        throw new Error(`duplicate tool registration: ${name}`);
      }
      tools.set(name, definition);
    },
    {
      execute: {
        after: (handler: ToolAfterHandler): void => {
          afterHandlers.push(handler);
        },
      },
    },
  );
  const context: PluginContext = {
    tool: registrar,
    permission: {
      hook: (event: "evaluate", handler: PermissionEvaluateHandler): void => {
        expect(event).toBe("evaluate");
        permissionHandlers.push(handler);
      },
    },
    session: {
      hook: (event: "context", handler: SessionContextHandler): void => {
        expect(event).toBe("context");
        contextHandlers.push(handler);
      },
    },
  };
  return { tools, permissionHandlers, afterHandlers, contextHandlers, context };
}

function userEvent(systemText: string, userText: string): SessionEvent {
  return {
    system: [{ text: systemText }],
    messages: [
      { role: "assistant", content: "standing by" },
      { role: "user", content: userText },
    ],
  };
}

beforeEach(() => {
  clearAllSessionAttempts();
});

afterEach(async () => {
  for (const root of roots) {
    await rm(root, { recursive: true, force: true });
  }
  roots = [];
  clearAllSessionAttempts();
});

describe("plugin identity", () => {
  test("exposes the published package identity", () => {
    expect(HARNESS_NAME).toBe("@heretek-ai/opencode-harness");
    expect(HARNESS_VERSION).toBe("1.0.0");
  });

  test("declares exactly the five SPEC tool names", () => {
    expect([...HARNESS_TOOL_NAMES]).toEqual([
      "file_hash_read",
      "file_hash_edit",
      "ast_structural_search",
      "ast_structural_rewrite",
      "ui_geometry_audit",
    ]);
  });

  test("declares exactly the three SPEC hook names", () => {
    expect([...HARNESS_HOOK_NAMES]).toEqual([
      "permission.evaluate",
      "tool.execute.after",
      "session.context",
    ]);
  });

  test("default context budget is a positive finite number", () => {
    expect(Number.isFinite(DEFAULT_CONTEXT_BUDGET_TOKENS)).toBe(true);
    expect(DEFAULT_CONTEXT_BUDGET_TOKENS > 0).toBe(true);
  });
});

describe("activate tool registration", () => {
  test("registers exactly the five harness tools", () => {
    const host = createFakePluginHost();
    activate(host.context);
    expect([...host.tools.keys()].sort()).toEqual([
      "ast_structural_rewrite",
      "ast_structural_search",
      "file_hash_edit",
      "file_hash_read",
      "ui_geometry_audit",
    ]);
  });

  test("every registered tool carries a non-empty description", () => {
    const host = createFakePluginHost();
    activate(host.context);
    for (const name of HARNESS_TOOL_NAMES) {
      const definition = host.tools.get(name) as ToolDefinition;
      expect(typeof definition.description).toBe("string");
      expect(definition.description.length > 0).toBe(true);
    }
  });

  test("every registered tool exposes a zod parameters schema", () => {
    const host = createFakePluginHost();
    activate(host.context);
    const validSamples: Record<HarnessToolName, Record<string, unknown>> = {
      file_hash_read: { path: "src/index.ts" },
      file_hash_edit: {
        path: "src/index.ts",
        hunks: [
          {
            startLine: 1,
            startHash: computeLineHash("x"),
            endLine: 1,
            endHash: computeLineHash("x"),
            replacement: "y",
          },
        ],
      },
      ast_structural_search: { code: "const a = 1;", pattern: "console.log($VAR)" },
      ast_structural_rewrite: {
        path: "src/a.ts",
        pattern: "console.log($VAR)",
        rewrite: "logger($VAR)",
      },
      ui_geometry_audit: { url: "https://example.com/" },
    };
    for (const name of HARNESS_TOOL_NAMES) {
      const definition = host.tools.get(name) as ToolDefinition;
      expect(typeof definition.parameters.parse).toBe("function");
      expect(definition.parameters.parse(validSamples[name])).toBeDefined();
    }
  });

  test("createHarnessPlugin activate registers the same five tools", () => {
    const host = createFakePluginHost();
    const plugin = createHarnessPlugin();
    expect(plugin.name).toBe(HARNESS_NAME);
    expect(plugin.version).toBe(HARNESS_VERSION);
    expect([...plugin.toolNames]).toEqual([...HARNESS_TOOL_NAMES]);
    expect([...plugin.hookNames]).toEqual([...HARNESS_HOOK_NAMES]);
    plugin.activate(host.context);
    expect([...host.tools.keys()].sort()).toEqual([
      "ast_structural_rewrite",
      "ast_structural_search",
      "file_hash_edit",
      "file_hash_read",
      "ui_geometry_audit",
    ]);
  });

  test("activate registers one handler per hook namespace", () => {
    const host = createFakePluginHost();
    activate(host.context);
    expect(host.permissionHandlers.length).toBe(1);
    expect(host.afterHandlers.length).toBe(1);
    expect(host.contextHandlers.length).toBe(1);
  });

  test("activate rejects a null context fail-closed", () => {
    expect(() =>
      activate(null as unknown as PluginContext),
    ).toThrow("fail-closed");
  });

  test("activate rejects a context missing hook surface fail-closed", () => {
    const partial = { tool: (() => undefined) as unknown as PluginContext["tool"] };
    expect(() =>
      activate(partial as unknown as PluginContext),
    ).toThrow("fail-closed");
  });
});

describe("tool argument validation", () => {
  test("file_hash_read schema rejects empty paths and zero offsets", () => {
    const host = createFakePluginHost();
    activate(host.context);
    const definition = host.tools.get("file_hash_read") as ToolDefinition;
    expect(() => definition.parameters.parse({ path: "" })).toThrow();
    expect(() =>
      definition.parameters.parse({ path: "a.ts", offset: 0 }),
    ).toThrow();
    expect(() =>
      definition.parameters.parse({ path: "a.ts", limit: 0 }),
    ).toThrow();
  });

  test("file_hash_edit schema rejects empty hunks and malformed hashes", () => {
    const host = createFakePluginHost();
    activate(host.context);
    const definition = host.tools.get("file_hash_edit") as ToolDefinition;
    expect(() =>
      definition.parameters.parse({ path: "a.ts", hunks: [] }),
    ).toThrow();
    expect(() =>
      definition.parameters.parse({
        path: "a.ts",
        hunks: [
          {
            startLine: 1,
            startHash: "ZZZZ",
            endLine: 1,
            endHash: "0000",
            replacement: "y",
          },
        ],
      }),
    ).toThrow();
  });

  test("structural schemas reject empty patterns", () => {
    const host = createFakePluginHost();
    activate(host.context);
    const search = host.tools.get("ast_structural_search") as ToolDefinition;
    const rewrite = host.tools.get(
      "ast_structural_rewrite",
    ) as ToolDefinition;
    expect(() =>
      search.parameters.parse({ code: "const a = 1;", pattern: "" }),
    ).toThrow();
    expect(() =>
      rewrite.parameters.parse({ path: "a.ts", pattern: "", rewrite: "b" }),
    ).toThrow();
    expect(() =>
      search.parameters.parse({
        code: "const a = 1;",
        pattern: "console.log($VAR)",
        language: "cobol",
      }),
    ).toThrow();
  });

  test("geometry audit executor demands url or elements fail-closed", async () => {
    const host = createFakePluginHost();
    activate(host.context);
    const definition = host.tools.get("ui_geometry_audit") as ToolDefinition;
    await expect(definition.execute({})).rejects.toThrow("fail-closed");
  });

  test("geometry audit executor rejects unparsable urls without launching a browser", async () => {
    const host = createFakePluginHost();
    activate(host.context);
    const definition = host.tools.get("ui_geometry_audit") as ToolDefinition;
    await expect(
      definition.execute({ url: "nota-valid-url" }),
    ).rejects.toThrow("fail-closed");
    await expect(
      definition.execute({ url: "ftp://example.com/page" }),
    ).rejects.toThrow("fail-closed");
  });

  test("hash executors reject schema-invalid args before touching disk", async () => {
    const host = createFakePluginHost();
    activate(host.context);
    const reader = host.tools.get("file_hash_read") as ToolDefinition;
    const editor = host.tools.get("file_hash_edit") as ToolDefinition;
    await expect(reader.execute({})).rejects.toThrow();
    await expect(
      editor.execute({ path: "a.ts", hunks: [] }),
    ).rejects.toThrow();
  });
});

describe("file_hash tools end to end", () => {
  test("file_hash_read returns hash-anchored lines matching computeLineHash", async () => {
    const root = await makeRoot();
    await Bun.write(join(root, "sample.ts"), "const a = 1;\nconst b = 2;\n");
    const host = createFakePluginHost();
    createHarnessPlugin({ rootDir: root }).activate(host.context);
    const reader = host.tools.get("file_hash_read") as ToolDefinition;
    const result = (await reader.execute({ path: "sample.ts" })) as {
      path: string;
      totalLines: number;
      content: string;
    };
    expect(result.path).toBe("sample.ts");
    expect(result.totalLines).toBe(2);
    expect(result.content).toBe(
      `1#${computeLineHash("const a = 1;")}| const a = 1;\n2#${computeLineHash("const b = 2;")}| const b = 2;`,
    );
  });

  test("file_hash_read honors offset and limit windows", async () => {
    const root = await makeRoot();
    await Bun.write(join(root, "lines.txt"), "one\ntwo\nthree\n");
    const host = createFakePluginHost();
    createHarnessPlugin({ rootDir: root }).activate(host.context);
    const reader = host.tools.get("file_hash_read") as ToolDefinition;
    const result = (await reader.execute({
      path: "lines.txt",
      offset: 2,
      limit: 1,
    })) as { totalLines: number; content: string };
    expect(result.totalLines).toBe(3);
    expect(result.content).toBe(`2#${computeLineHash("two")}| two`);
  });

  test("file_hash_edit applies a hunk and the read reflects the replacement", async () => {
    const root = await makeRoot();
    await Bun.write(join(root, "doc.txt"), "hello\nworld\n");
    const host = createFakePluginHost();
    createHarnessPlugin({ rootDir: root }).activate(host.context);
    const editor = host.tools.get("file_hash_edit") as ToolDefinition;
    const reader = host.tools.get("file_hash_read") as ToolDefinition;
    const applied = (await editor.execute({
      path: "doc.txt",
      hunks: [
        {
          startLine: 2,
          startHash: computeLineHash("world"),
          endLine: 2,
          endHash: computeLineHash("world"),
          replacement: "WORLD",
        },
      ],
    })) as { applied: boolean; shiftedLines: number };
    expect(applied.applied).toBe(true);
    expect(applied.shiftedLines).toBe(0);
    const reread = (await reader.execute({ path: "doc.txt" })) as {
      content: string;
    };
    expect(reread.content).toContain("WORLD");
  });

  test("file_hash_edit fails closed on anchor mismatch with disk untouched", async () => {
    const root = await makeRoot();
    await Bun.write(join(root, "doc.txt"), "hello\nworld\n");
    const host = createFakePluginHost();
    createHarnessPlugin({ rootDir: root }).activate(host.context);
    const editor = host.tools.get("file_hash_edit") as ToolDefinition;
    const result = (await editor.execute({
      path: "doc.txt",
      hunks: [
        {
          startLine: 2,
          startHash: "0000",
          endLine: 2,
          endHash: "ffff",
          replacement: "WORLD",
        },
      ],
    })) as { applied: boolean; error?: string };
    expect(result.applied).toBe(false);
    expect(typeof result.error).toBe("string");
    const raw = await Bun.file(join(root, "doc.txt")).text();
    expect(raw).toBe("hello\nworld\n");
  });
});

describe("ast tools end to end", () => {
  test("ast_structural_search finds pattern matches with line numbers", async () => {
    const host = createFakePluginHost();
    activate(host.context);
    const search = host.tools.get("ast_structural_search") as ToolDefinition;
    const matches = (await search.execute({
      code: 'const a = 1;\nconsole.log(a);\nconsole.log("hi");\n',
      pattern: "console.log($VAR)",
      language: "typescript",
    })) as Array<{ text: string; startLine: number; endLine: number }>;
    expect(matches.length).toBe(2);
    expect(matches[0].text).toContain("console.log");
    expect(matches[0].startLine).toBe(2);
  });

  test("ast_structural_rewrite substitutes metavariables into a temp file", async () => {
    const root = await makeRoot();
    await Bun.write(
      join(root, "app.ts"),
      'console.log("a");\nconst x = 1;\nconsole.log("b");\n',
    );
    const host = createFakePluginHost();
    createHarnessPlugin({ rootDir: root }).activate(host.context);
    const rewrite = host.tools.get("ast_structural_rewrite") as ToolDefinition;
    const result = (await rewrite.execute({
      path: "app.ts",
      pattern: "console.log($MSG)",
      rewrite: "logger.info($MSG)",
    })) as { modified: boolean; matchCount: number; output: string };
    expect(result.modified).toBe(true);
    expect(result.matchCount).toBe(2);
    expect(result.output).toContain('logger.info("a")');
    expect(result.output).toContain('logger.info("b")');
  });

  test("ast_structural_rewrite reports zero matches without modifying", async () => {
    const root = await makeRoot();
    await Bun.write(join(root, "plain.ts"), "const x = 1;\n");
    const host = createFakePluginHost();
    createHarnessPlugin({ rootDir: root }).activate(host.context);
    const rewrite = host.tools.get("ast_structural_rewrite") as ToolDefinition;
    const result = (await rewrite.execute({
      path: "plain.ts",
      pattern: "console.log($MSG)",
      rewrite: "logger.info($MSG)",
    })) as { modified: boolean; matchCount: number; output: string };
    expect(result.modified).toBe(false);
    expect(result.matchCount).toBe(0);
    expect(result.output).toBe("const x = 1;\n");
  });
});

describe("ui_geometry_audit end to end", () => {
  test("flags a tiny interactive target", async () => {
    const host = createFakePluginHost();
    activate(host.context);
    const audit = host.tools.get("ui_geometry_audit") as ToolDefinition;
    const report = (await audit.execute({
      elements: [
        {
          tag: "button",
          id: "cta",
          rect: { x: 8, y: 8, width: 10, height: 10 },
          interactive: true,
        },
      ],
    })) as {
      url: null;
      defects: Array<{ kind: string; elementId?: string }>;
      axeViolations: unknown[];
      viewports: unknown[];
    };
    expect(report.url).toBe(null);
    expect(report.axeViolations).toEqual([]);
    expect(report.defects.length).toBe(1);
    expect(report.defects[0].kind).toBe("tiny-interactive-target");
    expect(report.defects[0].elementId).toBe("cta");
  });

  test("passes a clean layout with zero defects", async () => {
    const host = createFakePluginHost();
    activate(host.context);
    const audit = host.tools.get("ui_geometry_audit") as ToolDefinition;
    const report = (await audit.execute({
      elements: [
        {
          tag: "div",
          id: "hero",
          rect: { x: 0, y: 0, width: 200, height: 120 },
          parentId: "page",
        },
        {
          tag: "button",
          id: "ok",
          rect: { x: 300, y: 0, width: 96, height: 40 },
          interactive: true,
          parentId: "page",
        },
      ],
    })) as { defects: unknown[] };
    expect(report.defects).toEqual([]);
  });

  test("flags horizontal overflow past the tolerance", async () => {
    const host = createFakePluginHost();
    activate(host.context);
    const audit = host.tools.get("ui_geometry_audit") as ToolDefinition;
    const report = (await audit.execute({
      elements: [
        {
          tag: "div",
          id: "wide",
          rect: { x: 0, y: 0, width: 300, height: 40 },
          scrollWidth: 300,
          clientWidth: 100,
        },
      ],
    })) as { defects: Array<{ kind: string }> };
    expect(report.defects.map((defect) => defect.kind)).toEqual([
      "element-overflow-x",
    ]);
  });

  test("flags sibling collision between overlapping boxes", async () => {
    const host = createFakePluginHost();
    activate(host.context);
    const audit = host.tools.get("ui_geometry_audit") as ToolDefinition;
    const report = (await audit.execute({
      elements: [
        {
          tag: "div",
          id: "first",
          rect: { x: 0, y: 0, width: 100, height: 20 },
          parentId: "row",
        },
        {
          tag: "div",
          id: "second",
          rect: { x: 50, y: 5, width: 100, height: 20 },
          parentId: "row",
        },
      ],
    })) as { defects: Array<{ kind: string }> };
    expect(
      report.defects.some((defect) => defect.kind === "sibling-collision"),
    ).toBe(true);
  });

  test("flags descender-clip risk on tight hidden lines", async () => {
    const host = createFakePluginHost();
    activate(host.context);
    const audit = host.tools.get("ui_geometry_audit") as ToolDefinition;
    const report = (await audit.execute({
      elements: [
        {
          tag: "p",
          id: "tight",
          rect: { x: 0, y: 0, width: 200, height: 16 },
          fontSize: 16,
          lineHeight: 16,
          overflow: "hidden",
        },
      ],
    })) as { defects: Array<{ kind: string }> };
    expect(report.defects.map((defect) => defect.kind)).toEqual([
      "descender-clip-risk",
    ]);
  });
});

describe("permission hook integration", () => {
  function guardedHost(): FakePluginHost {
    const host = createFakePluginHost();
    activate(host.context);
    return host;
  }

  async function decide(
    host: FakePluginHost,
    request: GuardRequest,
  ): Promise<{ allowed: boolean; reason: string; rule?: string }> {
    const handler = host.permissionHandlers[0];
    return handler(request);
  }

  test("allows an ordinary read for a developer role", async () => {
    const host = guardedHost();
    const verdict = await decide(host, {
      role: "developer",
      tool: "file_hash_read",
      path: "src/index.ts",
    });
    expect(verdict.allowed).toBe(true);
  });

  test("denies qa-adversary edits under src (rule-3)", async () => {
    const host = guardedHost();
    const verdict = await decide(host, {
      role: "qa-adversary",
      tool: "edit",
      path: "src/index.ts",
    });
    expect(verdict.allowed).toBe(false);
    expect(verdict.rule).toBe("rule-3-qa-source-lock");
  });

  test("permits agency-qa edits to test and docs paths", async () => {
    const host = guardedHost();
    const testVerdict = await decide(host, {
      role: "agency-qa",
      tool: "edit",
      path: "test/plugin.test.ts",
    });
    expect(testVerdict.allowed).toBe(true);
    const docsVerdict = await decide(host, {
      role: "agency-qa",
      tool: "write",
      path: "docs/notes.md",
    });
    expect(docsVerdict.allowed).toBe(true);
  });

  test("denies destructive shell for every role including architect (rule-1)", async () => {
    const host = guardedHost();
    for (const role of ["architect", "developer", "director"]) {
      const verdict = await decide(host, {
        role,
        tool: "shell",
        command: "rm -rf /",
      });
      expect(verdict.allowed).toBe(false);
      expect(verdict.rule).toBe("rule-1-destructive");
    }
  });

  test("denies leadership edits while allowing leadership reads (rule-2)", async () => {
    const host = guardedHost();
    const denied = await decide(host, {
      role: "director",
      tool: "file_hash_edit",
      path: "test/plugin.test.ts",
    });
    expect(denied.allowed).toBe(false);
    expect(denied.rule).toBe("rule-2-leadership-read-only");
    const allowed = await decide(host, {
      role: "director",
      tool: "file_hash_read",
      path: "src/index.ts",
    });
    expect(allowed.allowed).toBe(true);
  });

  test("locks contract globs to the architect role (rule-4)", async () => {
    const host = guardedHost();
    const denied = await decide(host, {
      role: "developer",
      tool: "edit",
      path: "contracts/api.json",
    });
    expect(denied.allowed).toBe(false);
    expect(denied.rule).toBe("rule-4-contract-lock");
    const allowed = await decide(host, {
      role: "architect",
      tool: "edit",
      path: "contracts/api.json",
    });
    expect(allowed.allowed).toBe(true);
  });

  test("registered handler matches evaluateBoardGuard verdict for verdict", async () => {
    const host = guardedHost();
    const request: GuardRequest = {
      role: "manager",
      tool: "bash",
      command: "bun test",
    };
    const viaHook = await decide(host, request);
    const direct = evaluateBoardGuard(request);
    expect(viaHook).toEqual(direct);
  });

  test("custom guardConfig taskOwnedPaths is honored through the hook", async () => {
    const host = createFakePluginHost();
    createHarnessPlugin({
      guardConfig: {
        lockedContractGlobs: [...DEFAULT_LOCKED_CONTRACT_GLOBS],
        taskOwnedPaths: { developer: ["src/owned/**"] },
      },
    }).activate(host.context);
    const inside = await host.permissionHandlers[0]({
      role: "developer",
      tool: "edit",
      path: "src/owned/feature.ts",
    });
    expect(inside.allowed).toBe(true);
    const outside = await host.permissionHandlers[0]({
      role: "developer",
      tool: "edit",
      path: "src/other/feature.ts",
    });
    expect(outside.allowed).toBe(false);
  });
});

describe("circuit breaker integration", () => {
  function failingEdit(path: string): ToolAfterEvent {
    return {
      sessionId: "plugin-cb-edit",
      tool: "edit",
      ok: false,
      path,
      error: "anchor mismatch",
    };
  }

  test("stays quiet after a single failed edit", () => {
    resetSessionAttempts("plugin-cb-quiet");
    const verdict = recordAndEvaluateCircuitBreaker({
      sessionId: "plugin-cb-quiet",
      tool: "edit",
      ok: false,
      path: "src/a.ts",
      error: "anchor mismatch",
    });
    expect(verdict.triggered).toBe(false);
    expect(verdict.shouldEscalateModel).toBe(false);
    expect(verdict.consecutiveFailures).toBe(1);
  });

  test("triggers critical intervention after two failed edits on one path", () => {
    resetSessionAttempts("plugin-cb-edit");
    recordAndEvaluateCircuitBreaker(failingEdit("src/a.ts"));
    const verdict = recordAndEvaluateCircuitBreaker(failingEdit("src/a.ts"));
    expect(verdict.triggered).toBe(true);
    expect(verdict.shouldEscalateModel).toBe(true);
    expect(verdict.severity).toBe("critical");
    expect(verdict.consecutiveFailures).toBe(2);
    expect(verdict.intervention).toContain(
      '<circuit-breaker-intervention severity="critical">',
    );
  });

  test("triggers after three failed shells on one command prefix", () => {
    resetSessionAttempts("plugin-cb-shell");
    const attempt = (command: string): ToolAfterEvent => ({
      sessionId: "plugin-cb-shell",
      tool: "shell",
      ok: false,
      command,
      error: "exit 1",
    });
    recordAndEvaluateCircuitBreaker(attempt("bun test editors"));
    recordAndEvaluateCircuitBreaker(attempt("bun test guards"));
    const verdict = recordAndEvaluateCircuitBreaker(
      attempt("bun test circuit"),
    );
    expect(verdict.triggered).toBe(true);
    expect(verdict.shouldEscalateModel).toBe(true);
    expect(verdict.consecutiveFailures).toBe(3);
  });

  test("a success breaks the trailing failure streak", () => {
    resetSessionAttempts("plugin-cb-reset");
    recordAndEvaluateCircuitBreaker({
      sessionId: "plugin-cb-reset",
      tool: "edit",
      ok: false,
      path: "src/a.ts",
    });
    recordAndEvaluateCircuitBreaker({
      sessionId: "plugin-cb-reset",
      tool: "edit",
      ok: true,
      path: "src/a.ts",
    });
    const verdict = recordAndEvaluateCircuitBreaker({
      sessionId: "plugin-cb-reset",
      tool: "edit",
      ok: false,
      path: "src/a.ts",
    });
    expect(verdict.triggered).toBe(false);
    expect(verdict.consecutiveFailures).toBe(1);
  });

  test("rejects observations without a session id fail-closed", () => {
    expect(() =>
      recordAndEvaluateCircuitBreaker({
        sessionId: "",
        tool: "edit",
        ok: false,
      }),
    ).toThrow("fail-closed");
    expect(() =>
      recordAndEvaluateCircuitBreaker({
        sessionId: "plugin-cb-bad",
        tool: "",
        ok: false,
      }),
    ).toThrow("fail-closed");
  });

  test("sessions stay isolated from each other", () => {
    resetSessionAttempts("plugin-cb-iso-a");
    resetSessionAttempts("plugin-cb-iso-b");
    recordAndEvaluateCircuitBreaker({
      sessionId: "plugin-cb-iso-a",
      tool: "edit",
      ok: false,
      path: "src/a.ts",
    });
    const other = recordAndEvaluateCircuitBreaker({
      sessionId: "plugin-cb-iso-b",
      tool: "edit",
      ok: false,
      path: "src/a.ts",
    });
    expect(other.triggered).toBe(false);
    expect(sessionAttempts.has("plugin-cb-iso-a")).toBe(true);
    expect(sessionAttempts.has("plugin-cb-iso-b")).toBe(true);
  });

  test("the registered tool.execute.after handler records attempts", () => {
    const host = createFakePluginHost();
    activate(host.context);
    const session = "plugin-cb-hook";
    resetSessionAttempts(session);
    const handler = host.afterHandlers[0];
    handler({ sessionId: session, tool: "edit", ok: false, path: "src/h.ts" });
    handler({ sessionId: session, tool: "edit", ok: false, path: "src/h.ts" });
    const verdict = evaluateSession(session);
    expect(verdict.triggered).toBe(true);
    expect(verdict.severity).toBe("critical");
  });
});

describe("session context hook KV invariants", () => {
  test("appends packed task context to the last user message only", () => {
    const event = userEvent("base instructions", "please continue");
    registerContextBudgetHook(event, {
      rootDir: "workspace",
      taskMd: "ship the plugin entrypoint",
    });
    expect(event.system).toEqual([{ text: "base instructions" }]);
    expect(event.messages?.[0]).toEqual({
      role: "assistant",
      content: "standing by",
    });
    const last = event.messages?.[event.messages.length - 1];
    expect(last?.role).toBe("user");
    expect(String(last?.content)).toContain("<opencode-harness-context>");
    expect(String(last?.content)).toContain("ship the plugin entrypoint");
  });

  test("leaves event.system bit-identical after injection", () => {
    const event = userEvent("pinned prefix", "go");
    const before = JSON.stringify(event.system);
    registerContextBudgetHook(event, {
      rootDir: "workspace",
      taskMd: "task text",
      planMd: "plan text",
      lessons: [{ id: "l-1", trigger: "t", lesson: "u" }],
    });
    expect(JSON.stringify(event.system)).toBe(before);
  });

  test("throws fail-closed with no user message and keeps system untouched", () => {
    const event: SessionEvent = {
      system: [{ text: "pinned" }],
      messages: [{ role: "assistant", content: "hello" }],
    };
    const before = JSON.stringify(event.system);
    expect(() =>
      registerContextBudgetHook(event, {
        rootDir: "workspace",
        taskMd: "task text",
      }),
    ).toThrow("fail-closed");
    expect(JSON.stringify(event.system)).toBe(before);
  });

  test("is a strict no-op when no artifacts are configured", () => {
    const event = userEvent("pinned", "hello");
    const before = JSON.stringify(event);
    registerContextBudgetHook(event, { rootDir: "workspace" });
    expect(JSON.stringify(event)).toBe(before);
  });

  test("sorts lessons by id with bare id-only tags", () => {
    const event = userEvent("pinned", "hello");
    registerContextBudgetHook(event, {
      rootDir: "workspace",
      lessons: [
        { id: "m-2", trigger: "second", lesson: "beta" },
        { id: "m-10", trigger: "tenth", lesson: "gamma" },
        { id: "m-1", trigger: "first", lesson: "alpha" },
      ],
    });
    const last = event.messages?.[event.messages.length - 1];
    const text = String(last?.content);
    const ids = [...text.matchAll(/<episodic-repository-memory id="([^"]+)">/g)].map(
      (match) => match[1],
    );
    expect(ids).toEqual(["m-1", "m-10", "m-2"]);
    expect(text).not.toContain("relevance");
    const openings = [...text.matchAll(/<episodic-repository-memory[^>]*>/g)].map(
      (match) => match[0],
    );
    expect(openings).toEqual(
      ids.map((id) => `<episodic-repository-memory id="${id}">`),
    );
  });

  test("honors a tiny budget by keeping higher-priority blocks first", () => {
    const event = userEvent("pinned", "hello");
    registerContextBudgetHook(event, {
      rootDir: "workspace",
      budgetTokens: 50,
      taskMd: "x".repeat(400),
      lessons: [{ id: "l-1", trigger: "t", lesson: "u" }],
    });
    const last = event.messages?.[event.messages.length - 1];
    const text = String(last?.content);
    expect(text).toContain("episodic-repository-memory");
    expect(text).not.toContain("xxxx");
  });

  test("rejects invalid budgets fail-closed", () => {
    const event = userEvent("pinned", "hello");
    expect(() =>
      registerContextBudgetHook(event, {
        rootDir: "workspace",
        budgetTokens: -1,
        taskMd: "task",
      }),
    ).toThrow("fail-closed");
    expect(() =>
      registerContextBudgetHook(event, {
        rootDir: "   ",
        taskMd: "task",
      }),
    ).toThrow("fail-closed");
  });

  test("packBlocks orders by priority with localeCompare tie-breaks", () => {
    const packed = packBlocks(
      [
        { id: "b", text: "B", priority: 1 },
        { id: "a", text: "A", priority: 1 },
        { id: "top", text: "T", priority: 9 },
      ],
      100,
    );
    const order = [...packed.text.matchAll(/id="([^"]+)"/g)].map(
      (match) => match[1],
    );
    expect(order).toEqual(["top", "a", "b"]);
    expect(packed.usedTokens).toBeGreaterThan(0);
  });

  test("the registered session hook performs the same injection", async () => {
    const host = createFakePluginHost();
    createHarnessPlugin({
      taskMd: "plugin task",
      lessons: [{ id: "h-1", trigger: "hook", lesson: "wired" }],
    }).activate(host.context);
    const event = userEvent("pinned prefix", "run the checks");
    const before = JSON.stringify(event.system);
    await host.contextHandlers[0](event);
    expect(JSON.stringify(event.system)).toBe(before);
    const last = event.messages?.[event.messages.length - 1];
    expect(String(last?.content)).toContain("plugin task");
    expect(String(last?.content)).toContain('id="h-1"');
  });
});

describe("mcp config and module wiring", () => {
  test("getRecommendedMcpConfig returns exactly the two SPEC blocks", () => {
    const config = getRecommendedMcpConfig();
    expect(Object.keys(config.mcpServers).sort()).toEqual([
      "fallow-mcp",
      "lsp-mcp-server",
    ]);
    expect(config.mcpServers["lsp-mcp-server"]).toEqual({
      command: "bunx",
      args: ["lsp-mcp-server"],
    });
    expect(config.mcpServers["fallow-mcp"]).toEqual({
      command: "npx",
      args: ["--yes", "--package", "fallow", "fallow-mcp"],
    });
  });

  test("getRecommendedMcpConfig returns a fresh object per call", () => {
    const first = getRecommendedMcpConfig();
    const second = getRecommendedMcpConfig();
    expect(first).toEqual(second);
    expect(first).not.toBe(second);
    expect(first.mcpServers).not.toBe(second.mcpServers);
  });

  test("re-exports the Wave 1 editor surface", () => {
    expect(typeof computeLineHash).toBe("function");
    expect(typeof resolveSafePath).toBe("function");
    expect(typeof splitLines).toBe("function");
    expect(typeof structuralFallbackSearch).toBe("function");
    expect(typeof substituteRewrite).toBe("function");
    expect(computeLineHash("wired")).toMatch(/^[0-9a-f]{4}$/);
    expect(splitLines("a\nb\n")).toEqual(["a", "b"]);
    expect(
      structuralFallbackSearch("console.log(x);", "console.log($VAR)").length,
    ).toBe(1);
    expect(estimateTokens("abcd")).toBe(1);
  });

  test("re-exports the guard surface with default contract globs", () => {
    expect(typeof evaluateBoardGuard).toBe("function");
    expect(typeof classifyShellCommand).toBe("function");
    expect(classifyShellCommand("bun test").class).toBe("read-only");
    expect(isDestructiveShellCommand("rm -rf /")).toBe(true);
    expect([...DEFAULT_LOCKED_CONTRACT_GLOBS]).toEqual([
      "**/contracts/**",
      "**/schemas/*.schema.json",
    ]);
  });

  test("re-exports the circuit breaker surface", () => {
    expect(typeof recordToolAttempt).toBe("function");
    expect(typeof evaluateSession).toBe("function");
    expect(sessionAttempts instanceof Map).toBe(true);
  });

  test("re-exports the context budget surface", () => {
    expect(typeof packBlocks).toBe("function");
    expect(typeof injectContextBudgetIntoMessages).toBe("function");
  });

  test("buildHarnessTools returns five bound executors", () => {
    const resolved = resolveHarnessOptions({ rootDir: "workspace" });
    const tools = buildHarnessTools(resolved);
    expect(Object.keys(tools).sort()).toEqual([
      "ast_structural_rewrite",
      "ast_structural_search",
      "file_hash_edit",
      "file_hash_read",
      "ui_geometry_audit",
    ]);
    for (const name of HARNESS_TOOL_NAMES) {
      expect(typeof tools[name].execute).toBe("function");
    }
  });

  test("resolveHarnessOptions defaults rootDir and validates budgets", () => {
    const resolved = resolveHarnessOptions();
    expect(resolved.rootDir).toBe(process.cwd());
    expect(resolved.contextBudgetTokens).toBe(DEFAULT_CONTEXT_BUDGET_TOKENS);
    expect(() =>
      resolveHarnessOptions({ contextBudgetTokens: Number.NaN }),
    ).toThrow("fail-closed");
    expect(() => resolveHarnessOptions({ rootDir: "" })).toThrow(
      "fail-closed",
    );
  });
});
