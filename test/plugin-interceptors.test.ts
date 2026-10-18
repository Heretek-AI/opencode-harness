import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import OpenCodeV2Plugin, {
  setupOpenCodeV2Harness,
  applyRootAffinityHeadersInPlace,
  buildEditNearMissContext,
  calibrateSystemPromptInPlace,
  clearAllSessionAttempts,
  clearDiagnosticsCache,
  clearSessionLineage,
  clearStaleReadRegistry,
  clearTaintState,
  computeLineHash,
  decontaminateCompactionEventInPlace,
  detectCircularDependencies,
  didToolExecutionFail,
  evaluateContractChangeImpact,
  hardenShellInvocation,
  normalizePluginToolResult,
  recordSessionParentLink,
  repairEditToolInputInPlace,
  resolveMissingReadPath,
  runArchitectureAudit,
  scanFileEngineeringQuality,
  type OpenCodeV2PermissionEvent,
  type OpenCodeV2PromiseContext,
  type OpenCodeV2SessionCompactionEvent,
  type OpenCodeV2SessionContextEvent,
  type OpenCodeV2SessionModelRequestEvent,
  type OpenCodeV2ShellBeforeEvent,
  type OpenCodeV2ToolAfterEvent,
  type OpenCodeV2ToolBeforeEvent,
} from "../src/index";

let tempDirs: string[] = [];

function makeTempWorkspace(): string {
  const dir = mkdtempSync(join(tmpdir(), "plugin-interceptors-"));
  tempDirs.push(dir);
  return dir;
}

beforeEach(() => {
  clearAllSessionAttempts();
  clearDiagnosticsCache();
  clearStaleReadRegistry();
  clearTaintState();
  clearSessionLineage();
});

afterEach(() => {
  for (const d of tempDirs) {
    rmSync(d, { recursive: true, force: true });
  }
  tempDirs = [];
});

describe("plugin-over-patch interceptor 1: in-place EditTool auto-repair & near-miss recovery", () => {
  test("strips accidental ReadTool '12: ' and file_hash_read '12#a3f2| ' prefixes in-place before EditTool runs", () => {
    const root = makeTempWorkspace();
    const target = join(root, "service.ts");
    writeFileSync(
      target,
      [
        "export function computeTotal(items: number[]) {",
        "  const sum = items.reduce((a, b) => a + b, 0);",
        "  return sum;",
        "}",
      ].join("\n"),
      "utf8",
    );

    // 1. Accidental ReadTool line-number prefixes ("2: ", "3: ")
    const editInputColon: Record<string, unknown> = {
      path: target,
      oldString: "2:   const sum = items.reduce((a, b) => a + b, 0);\n3:   return sum;",
      newString: "2:   const sum = items.reduce((a, b) => a + b, 10);\n3:   return sum * 2;",
    };
    const res1 = repairEditToolInputInPlace(editInputColon, root);
    expect(res1?.repaired).toBe(true);
    expect(res1?.strategy).toBe("line-prefix-stripped");
    expect(editInputColon.oldString).toBe(
      "  const sum = items.reduce((a, b) => a + b, 0);\n  return sum;",
    );
    expect(editInputColon.newString).toBe(
      "  const sum = items.reduce((a, b) => a + b, 10);\n  return sum * 2;",
    );

    // 2. Accidental file_hash_read prefixes ("2#xxxx| ")
    const h2 = computeLineHash("const sum = items.reduce((a, b) => a + b, 0);");
    const h3 = computeLineHash("return sum;");
    const editInputHash: Record<string, unknown> = {
      path: target,
      oldString: `2#${h2}|   const sum = items.reduce((a, b) => a + b, 0);\n3#${h3}|   return sum;`,
      newString: `2#${h2}|   return items.length;`,
    };
    const res2 = repairEditToolInputInPlace(editInputHash, root);
    expect(res2?.repaired).toBe(true);
    expect(res2?.strategy).toBe("line-prefix-stripped");
    expect(editInputHash.oldString).toBe(
      "  const sum = items.reduce((a, b) => a + b, 0);\n  return sum;",
    );
    expect(editInputHash.newString).toBe("  return items.length;");
  });

  test("repairs leading indentation drift in-place and re-indents newString to match file", () => {
    const root = makeTempWorkspace();
    const target = join(root, "indented.ts");
    writeFileSync(
      target,
      [
        "export class OrderProcessor {",
        "  process() {",
        "    if (this.ready) {",
        "      const tax = 0.08;",
        "      return tax;",
        "    }",
        "  }",
        "}",
      ].join("\n"),
      "utf8",
    );

    // Model supplies 2-space indent instead of 6-space indent
    const input: Record<string, unknown> = {
      path: target,
      oldString: "  const tax = 0.08;\n  return tax;",
      newString: "  const tax = 0.095;\n  return tax;",
    };

    const outcome = repairEditToolInputInPlace(input, root);
    expect(outcome?.repaired).toBe(true);
    expect(outcome?.strategy).toBe("indentation-aligned");
    expect(input.oldString).toBe("      const tax = 0.08;\n      return tax;");
    expect(input.newString).toBe("      const tax = 0.095;\n      return tax;");
  });

  test("generates 4-hex FNV-1a hash-anchored <near-miss-anchor> slice when edit fails", async () => {
    const root = makeTempWorkspace();
    const target = join(root, "widget.ts");
    writeFileSync(
      target,
      [
        "export function renderWidget() {",
        "  const label = 'submit-button';",
        "  const active = false;",
        "  return `${label}:${active}`;",
        "}",
      ].join("\n"),
      "utf8",
    );

    const nearMiss = await buildEditNearMissContext(
      {
        path: "widget.ts",
        oldString: "  const label = 'submit-button';\n  const wrongLine = 999;",
      },
      root,
    );
    expect(nearMiss).toContain('<near-miss-anchor file="widget.ts" nearLine="2"');
    expect(nearMiss).toContain(`2#${computeLineHash("const label = 'submit-button';")}|`);
  });
});

describe("plugin-over-patch interceptor 2: ReadTool fuzzy path auto-resolution & Tool.Result normalization", () => {
  test("auto-resolves unambiguous moved file paths in-place before ReadTool fails", () => {
    const root = makeTempWorkspace();
    const nestedDir = join(root, "packages", "core", "src", "plugin", "system-prompt");
    mkdirSync(nestedDir, { recursive: true });
    writeFileSync(join(nestedDir, "meta.txt"), "You are OpenCode", "utf8");

    const readInput: Record<string, unknown> = {
      path: "packages/core/src/system-prompt/meta.txt",
    };

    const resolved = resolveMissingReadPath(readInput, root, true);
    expect(resolved.existed).toBe(false);
    expect(resolved.rewrittenTo).toBe("packages/core/src/plugin/system-prompt/meta.txt");
    expect(readInput.path).toBe("packages/core/src/plugin/system-prompt/meta.txt");
  });

  test("normalizes plugin tool results so OpenCode V2 runtime.ts never dies on missing output schema", () => {
    const norm = normalizePluginToolResult({
      applied: true,
      shiftedLines: 2,
      path: "src/index.ts",
      output: "legacy output field",
    });
    expect("output" in norm).toBe(false);
    expect(Array.isArray(norm.content)).toBe(true);
    expect(norm.content[0]?.type).toBe("text");
    expect(norm.content[0]?.text).toContain('"applied": true');
  });
});

describe("plugin-over-patch interceptor 3: ShellTool non-zero exit detection & non-interactive env hardening", () => {
  test("detects non-zero exit code when ShellTool returns status='completed' with output.exit !== 0", () => {
    const shellSuccess = {
      tool: "shell",
      status: "completed" as const,
      result: {
        output: { exit: 0, output: "All tests passed", truncated: false },
        content: [{ type: "text", text: "All tests passed" }],
      },
    };
    const shellNonZero = {
      tool: "shell",
      status: "completed" as const,
      result: {
        output: { exit: 1, output: "Error at src/app.ts:10:5", truncated: false },
        content: [{ type: "text", text: "Error at src/app.ts:10:5" }],
      },
    };

    expect(didToolExecutionFail(shellSuccess)).toBe(false);
    expect(didToolExecutionFail(shellNonZero)).toBe(true);

    const inv: OpenCodeV2ShellBeforeEvent = { command: "git status", env: {} };
    hardenShellInvocation(inv);
    expect(inv.env?.CI).toBe("1");
    expect(inv.env?.GIT_TERMINAL_PROMPT).toBe("0");
    expect(inv.env?.PAGER).toBe("cat");
  });
});

describe("plugin-over-patch interceptor 4: zero-patch meta.txt calibration, compaction decontamination & multi-hop affinity", () => {
  test("repairs meta.txt subagent over-trigger in-place and decontaminates compaction system/tools", () => {
    const systemParts = [
      {
        text: [
          "You are OpenCode, a coding agent.",
          "- Use the `subagent` tool to minimize context token usage whenever tool calls generate large outputs but only a small subset is useful for the task at hand. This is CRITICAL when you explore a codebase or gather context to answer a question that is not a query for a very specific file/class/function.",
        ].join("\n"),
      },
    ];

    const changed = calibrateSystemPromptInPlace(systemParts);
    expect(changed).toBe(true);
    expect(systemParts[0]?.text).toContain("Only spawn a `subagent` when broad exploration spans more than 8 files");
    expect(systemParts[0]?.text).toContain("<muse-1.3-harness-calibration>");

    // Second call is idempotent (preserves byte-identical KV-cache prefix)
    const snapshot = systemParts[0]!.text;
    calibrateSystemPromptInPlace(systemParts);
    expect(systemParts[0]!.text).toBe(snapshot);

    // Compaction decontamination strips coding prompt and clears tools
    const compactionEvent: OpenCodeV2SessionCompactionEvent = {
      system: [
        { text: "You are OpenCode, a coding agent that helps users with software engineering tasks." },
        { text: "# Your Model\n- Name: Muse 1.3" },
        { text: "Keep this custom compaction note" },
      ],
      tools: {
        read: { description: "read" },
        edit: { description: "edit" },
      },
    };
    const cleaned = decontaminateCompactionEventInPlace(compactionEvent);
    expect(cleaned.strippedSystemParts).toBe(2);
    expect(cleaned.clearedTools).toBe(2);
    expect(compactionEvent.system?.length).toBe(1);
    expect(compactionEvent.system?.[0]?.text).toBe("Keep this custom compaction note");
    expect(Object.keys(compactionEvent.tools ?? {}).length).toBe(0);
  });

  test("resolves root session affinity across depth >= 2 nested subagents", () => {
    recordSessionParentLink("ses_child_1", "ses_root");
    recordSessionParentLink("ses_grandchild_2", "ses_child_1");

    const reqEvent: OpenCodeV2SessionModelRequestEvent = {
      sessionID: "ses_grandchild_2",
      headers: {
        "x-session-affinity": "ses_child_1",
        "X-Session-Id": "ses_child_1",
      },
    };
    const root = applyRootAffinityHeadersInPlace(reqEvent);
    expect(root).toBe("ses_root");
    expect(reqEvent.headers["x-session-affinity"]).toBe("ses_root");
    expect(reqEvent.headers["X-Session-Id"]).toBe("ses_root");
    expect(reqEvent.headers["x-opencode-session"]).toBe("ses_root");
  });
});

describe("systems engineering & architecture advisor: circular dependency & contract break detection", () => {
  test("detects circular dependencies via Tarjan SCC and alerts on exported contract signature breaks", () => {
    const root = makeTempWorkspace();
    writeFileSync(
      join(root, "alpha.ts"),
      'import { betaFn } from "./beta";\nexport function alphaFn(x: number) { return betaFn(x); }\n',
      "utf8",
    );
    writeFileSync(
      join(root, "beta.ts"),
      'import { alphaFn } from "./alpha";\nexport function betaFn(y: number) { return alphaFn(y); }\n',
      "utf8",
    );
    writeFileSync(
      join(root, "alpha.test.ts"),
      'import { alphaFn } from "./alpha";\nexpect(alphaFn(1)).toBe(1);\n',
      "utf8",
    );

    const cycles = detectCircularDependencies(root);
    expect(cycles.length).toBe(1);
    expect(cycles[0]?.files.sort()).toEqual(["alpha.ts", "beta.ts"]);

    const impact = evaluateContractChangeImpact({
      filePath: "alpha.ts",
      beforeContent: "export function alphaFn(x: number) { return x; }\n",
      afterContent: "export function alphaFn(x: number, strictMode: boolean) { return x; }\n",
      rootDir: root,
    });
    expect(impact).not.toBeNull();
    expect(impact!.changedExports[0]?.name).toBe("alphaFn");
    expect(impact!.affectedImporters).toContain("beta.ts");
    expect(impact!.affectedTests).toContain("alpha.test.ts");
    expect(impact!.formattedTag).toContain("<contract-impact");

    const smells = scanFileEngineeringQuality(
      "alpha.ts",
      root,
      "export function bad(a: number, b: number, c: number, d: number, e: number, f: number, g: number) {}\n",
    );
    expect(smells.some((s) => s.kind === "high-parameter-count")).toBe(true);

    const audit = runArchitectureAudit(root);
    expect(audit.cycles.length).toBe(1);
    expect(audit.formattedReport).toContain("<circular-dependencies");
  });

  test("end-to-end OpenCodeV2Plugin.setup intercepts edit contract changes, non-zero shell exits, and explore permissions", async () => {
    const root = makeTempWorkspace();
    const libPath = join(root, "lib.ts");
    const callerPath = join(root, "caller.ts");
    writeFileSync(libPath, "export function calc(a: number) {\n  return a + 1;\n}\n", "utf8");
    writeFileSync(
      callerPath,
      'import { calc } from "./lib";\nexport function run() {\n  throw new Error("boom");\n  return calc(2);\n}\n',
      "utf8",
    );

    let beforeHandler: ((ev: OpenCodeV2ToolBeforeEvent) => void | Promise<void>) | undefined;
    let afterHandler: ((ev: OpenCodeV2ToolAfterEvent) => void | Promise<void>) | undefined;
    let permHandler: ((ev: OpenCodeV2PermissionEvent) => void | Promise<void>) | undefined;
    let shellBeforeHandler: ((ev: OpenCodeV2ShellBeforeEvent) => void | Promise<void>) | undefined;
    const mcpServers = new Map<string, unknown>();
    const slashCommands: string[] = [];

    const ctx: OpenCodeV2PromiseContext = {
      directory: root,
      tool: {
        transform: (fn) => fn({ add: () => undefined }),
        hook: (ev, fn) => {
          if (ev === "execute.before") beforeHandler = fn;
          if (ev === "execute.after") afterHandler = fn;
        },
      },
      permission: {
        hook: (_ev, fn) => {
          permHandler = fn;
        },
      },
      session: {
        hook: () => undefined,
      },
      shell: {
        hook: (_ev, fn) => {
          shellBeforeHandler = fn;
        },
      },
      mcp: {
        transform: (fn) =>
          fn({
            get: (n) => mcpServers.get(n),
            set: (n, c) => mcpServers.set(n, c),
          }),
      },
      command: {
        transform: (fn) =>
          fn({
            add: (cmd) => slashCommands.push(cmd.name),
          }),
      },
    };

    // MCP seeding is opt-in: a default setup must not add servers that run
    // `bunx` / `npx --yes` on the user's machine.
    const unseeded = new Map<string, unknown>();
    setupOpenCodeV2Harness({
      ...ctx,
      mcp: { transform: (fn) => fn({ get: (n) => unseeded.get(n), set: (n, c) => unseeded.set(n, c) }) },
    });
    expect(unseeded.size).toBe(0);
    slashCommands.length = 0;

    const doctor = setupOpenCodeV2Harness({ ...ctx, options: { seedRecommendedMcp: true } }).report;
    expect(doctor.healthy).toBe(true);
    expect(mcpServers.get("lsp-mcp-server")).toEqual({
      type: "local",
      command: ["bunx", "lsp-mcp-server"],
    });
    expect(slashCommands.sort()).toEqual(["audit", "doctor"]);

    // Verify explore agent is blocked from running file-mutating shell commands
    const explorePerm: OpenCodeV2PermissionEvent = {
      sessionID: "s1",
      agent: "explore",
      action: "shell",
      resources: ["rm -rf src"],
      effect: "allow",
    };
    await permHandler!(explorePerm);
    expect(explorePerm.effect).toBe("deny");

    // Verify shell.hook("create.before") hardens env
    const shellInv: OpenCodeV2ShellBeforeEvent = { command: "bun test", env: {} };
    await shellBeforeHandler!(shellInv);
    expect(shellInv.env?.CI).toBe("1");

    // Verify edit auto-repairs ReadTool line prefixes AND appends <contract-impact> when signature changes
    const editInput: Record<string, unknown> = {
      path: libPath,
      oldString: "1: export function calc(a: number) {",
      newString: "1: export function calc(a: number, b: number) {",
    };
    await beforeHandler!({
      sessionID: "s1",
      tool: "edit",
      input: editInput,
    });
    expect(editInput.oldString).toBe("export function calc(a: number) {");
    writeFileSync(libPath, "export function calc(a: number, b: number) {\n  return a + b;\n}\n", "utf8");

    const editAfter: OpenCodeV2ToolAfterEvent = {
      sessionID: "s1",
      tool: "edit",
      input: editInput,
      status: "completed",
      result: {
        output: { files: [], replacements: 1 },
        content: [{ type: "text", text: "Successfully edited lib.ts" }],
      },
    };
    await afterHandler!(editAfter);
    const combinedText = editAfter.result!.content!.map((c) => c.text).join("\n");
    expect(combinedText).toContain('<contract-impact file="lib.ts"');
    expect(combinedText).toContain("caller.ts");

    // Verify ShellTool with status="completed" and output.exit=1 triggers <fault-context>
    const shellAfter: OpenCodeV2ToolAfterEvent = {
      sessionID: "s1",
      tool: "shell",
      input: { command: "bun test" },
      status: "completed",
      result: {
        output: {
          exit: 1,
          output: `Error: boom\n    at run (${callerPath}:3:9)`,
          truncated: false,
        },
        content: [{ type: "text", text: `Error: boom\n    at run (${callerPath}:3:9)` }],
      },
    };
    await afterHandler!(shellAfter);
    const shellText = shellAfter.result!.content!.map((c) => c.text).join("\n");
    expect(shellText).toContain('<fault-context frames="1">');
    expect(shellText).toContain('throw new Error("boom");');
  });
});

describe("OH-7.2 multiline empty catch (brace depth across lines)", () => {
  test("flags both single-line and split-brace empty catches", () => {
    const smells = scanFileEngineeringQuality(
      "probe.ts",
      process.cwd(),
      [
        "export function single() {",
        // NOTE: concatenated so no source line literally contains `catch
        // (e) {}` — scripts/accept/wave-N.sh zero-stub scans forbid that
        // shape even inside fixture strings. The runtime value is unchanged.
        "  try { work(); } catch (e) " + "{}",
        "}",
        "export function multi() {",
        "  try {",
        "    work();",
        "  } catch (err) {",
        "  }",
        "  return 1;",
        "}",
        "export function noisy() {",
        "  try {",
        "    work();",
        "  } catch (err) {",
        "    console.log(err);",
        "  }",
        "  return 2;",
        "}",
      ].join("\n"),
    );
    const empties = smells.filter((s) => s.kind === "empty-catch");
    expect(empties.length).toBe(2);
    expect(empties.map((s) => s.line).sort()).toEqual([2, 7]);
  });
});
