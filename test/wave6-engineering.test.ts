import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import OpenCodeV2Plugin, {
  appendBlocksToToolAfterEvent,
  clearAllSessionAttempts,
  clearDiagnosticsCache,
  clearSessionLineage,
  clearStaleReadRegistry,
  clearTaintState,
  collectFileDiagnostics,
  compactToolOutputHeadTail,
  computeLineHash,
  decontaminateCompactionEventInPlace,
  findSymbolReferences,
  HARNESS_RELEASE_VERSION,
  repairPatchToolInputInPlace,
  verifyModuleImportsAndExports,
  type OpenCodeV2PromiseContext,
  type OpenCodeV2SessionCompactionEvent,
  type OpenCodeV2ToolAfterEvent,
  type OpenCodeV2ToolBeforeEvent,
} from "../src/index";

let tempDirs: string[] = [];

function makeTempWorkspace(): string {
  const dir = mkdtempSync(join(tmpdir(), "wave6-engineering-"));
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

describe("Wave 6 capability 1: cross-file relative import & named-export contract verifier", () => {
  test("detects broken relative module paths and suggests closest sibling file", () => {
    const root = makeTempWorkspace();
    writeFileSync(
      join(root, "math-helpers.ts"),
      "export function clamp(x: number) { return x; }\n",
      "utf8",
    );
    const caller = join(root, "caller.ts");
    writeFileSync(
      caller,
      'import { clamp } from "./math-helper.js";\nexport const val = clamp(5);\n',
      "utf8",
    );

    const diags = verifyModuleImportsAndExports(caller);
    expect(diags.length).toBe(1);
    expect(diags[0]?.source).toBe("import-resolver");
    expect(diags[0]?.message).toContain('Cannot resolve relative module "./math-helper.js"');
    expect(diags[0]?.message).toContain("math-helpers.ts");
  });

  test("detects hallucinated or missing named exports across TypeScript .js -> .ts ESM imports and re-exports", () => {
    const root = makeTempWorkspace();
    writeFileSync(
      join(root, "leaf.ts"),
      "export function existingLeaf() { return 1; }\n",
      "utf8",
    );
    writeFileSync(
      join(root, "barrel.ts"),
      'export * from "./leaf.js";\nexport const BARREL_CONST = 42;\n',
      "utf8",
    );
    const consumer = join(root, "consumer.ts");
    writeFileSync(
      consumer,
      'import { existingLeaf, BARREL_CONST, nonExistentSymbol } from "./barrel.js";\nexport const x = existingLeaf() + BARREL_CONST;\n',
      "utf8",
    );

    const res = collectFileDiagnostics(consumer, root);
    expect(res.clean).toBe(false);
    expect(res.diagnostics.length).toBe(1);
    expect(res.diagnostics[0]?.source).toBe("export-contract");
    expect(res.diagnostics[0]?.message).toContain('has no exported member "nonExistentSymbol"');
    expect(res.diagnostics[0]?.message).toContain("BARREL_CONST");
    expect(res.diagnostics[0]?.message).toContain("existingLeaf");
  });
});

describe("Wave 6 capability 2: lexer-aware cross-file symbol reference & call-site locator", () => {
  test("ignores comments and string literals and attaches 4-hex FNV-1a anchors to definitions, imports, and call sites", () => {
    const root = makeTempWorkspace();
    writeFileSync(
      join(root, "auth.ts"),
      [
        "// verifyToken should not match in this comment",
        "export function verifyToken(token: string): boolean {",
        '  const label = "verifyToken inside string literal";',
        "  return token.length > 0;",
        "}",
      ].join("\n"),
      "utf8",
    );
    writeFileSync(
      join(root, "router.ts"),
      [
        'import { verifyToken } from "./auth.js";',
        "export function handleRequest(t: string) {",
        "  return verifyToken(t);",
        "}",
      ].join("\n"),
      "utf8",
    );

    const refs = findSymbolReferences("verifyToken", root);
    expect(refs.definitions.length).toBe(1);
    expect(refs.definitions[0]?.file).toBe("auth.ts");
    expect(refs.definitions[0]?.line).toBe(2);
    expect(refs.definitions[0]?.lineHash).toBe(
      computeLineHash("export function verifyToken(token: string): boolean {"),
    );

    // Only the import on router.ts:1 and the call on router.ts:3 should be in references (comment/string ignored)
    expect(refs.references.length).toBe(2);
    expect(refs.references[0]?.kind).toBe("import");
    expect(refs.references[1]?.kind).toBe("reference");
    expect(refs.formattedBlock).toContain('<symbol-references symbol="verifyToken"');
  });
});

describe("Wave 6 capability 3: PatchTool envelope & line-prefix auto-repair", () => {
  test("wraps bare *** Update File hunks in *** Begin/End Patch and strips 12: and 12#a3f2| prefixes", () => {
    const h1 = computeLineHash("const a = 1;");
    const h2 = computeLineHash("const a = 2;");
    const patchInput: Record<string, unknown> = {
      patchText: [
        "*** Update File: src/app.ts",
        "@@",
        ` 1: const header = true;`,
        `-2#${h1}| const a = 1;`,
        `+2#${h2}| const a = 2;`,
      ].join("\n"),
    };

    const outcome = repairPatchToolInputInPlace(patchInput);
    expect(outcome?.repaired).toBe(true);
    expect(outcome?.addedEnvelope).toBe(true);
    expect(outcome?.strippedLinePrefixes).toBe(true);
    expect(String(patchInput.patchText)).toBe(
      [
        "*** Begin Patch",
        "*** Update File: src/app.ts",
        "@@",
        " const header = true;",
        "-const a = 1;",
        "+const a = 2;",
        "*** End Patch",
      ].join("\n"),
    );
  });
});

describe("Wave 6 capability 4: head+tail anti-truncation output compactor", () => {
  test("compacts oversized middle lines so error tails and appended <diagnostics> stay below ToolOutput.truncate limits", () => {
    const noisyLines: string[] = ["=== TEST SUITE START ==="];
    for (let i = 1; i <= 2500; i++) {
      noisyLines.push(`PASS test/unit_${i}.test.ts (line ${i})`);
    }
    noisyLines.push("FAIL test/final_critical.test.ts: AssertionError at line 99");
    const hugeOutput = noisyLines.join("\n");

    const compacted = compactToolOutputHeadTail(hugeOutput, 400, 20_000);
    expect(compacted.compacted).toBe(true);
    expect(compacted.omittedLines).toBeGreaterThan(2000);
    expect(compacted.text).toContain("=== TEST SUITE START ===");
    expect(compacted.text).toContain("FAIL test/final_critical.test.ts: AssertionError at line 99");
    expect(compacted.text).toContain("middle lines compacted by opencode-harness");

    const afterEvent: OpenCodeV2ToolAfterEvent = {
      sessionID: "s1",
      tool: "shell",
      status: "completed",
      result: {
        content: [{ type: "text", text: hugeOutput }],
      },
    };
    appendBlocksToToolAfterEvent(afterEvent, ['<fault-context frames="1">frame</fault-context>']);
    const finalContent = afterEvent.result!.content!.map((c) => c.text).join("\n");
    expect(finalContent).toContain("=== TEST SUITE START ===");
    expect(finalContent).toContain("FAIL test/final_critical.test.ts");
    expect(finalContent).toContain('<fault-context frames="1">frame</fault-context>');
    expect(finalContent.split("\n").length).toBeLessThan(1600);
  });
});

describe("Wave 6 capability 5: Dual Direct + Code Mode (tools.harness.*) registration & full compaction cleanup", () => {
  test("registers both direct tools and pinned tools.harness.* Code Mode namespace when editor.namespace is present", async () => {
    const root = makeTempWorkspace();
    mkdirSync(join(root, "src"), { recursive: true });
    writeFileSync(join(root, "src", "mod.ts"), "export function helloWorld() { return 1; }\n", "utf8");

    const namespaces: string[] = [];
    const directTools: string[] = [];
    const codeModeTools: string[] = [];
    let beforeHandler: ((ev: OpenCodeV2ToolBeforeEvent) => void | Promise<void>) | undefined;
    let afterHandler: ((ev: OpenCodeV2ToolAfterEvent) => void | Promise<void>) | undefined;

    const ctx: OpenCodeV2PromiseContext = {
      directory: root,
      tool: {
        transform: (fn) =>
          fn({
            namespace: (ns) => namespaces.push(ns.name),
            add: (t) => {
              if (t.options?.codemode === false) {
                directTools.push(t.name);
              } else if (t.options?.namespace === "harness" && t.options?.codemode === true) {
                codeModeTools.push(t.name);
              }
            },
          }),
        hook: (ev, fn) => {
          if (ev === "execute.before") beforeHandler = fn;
          if (ev === "execute.after") afterHandler = fn;
        },
      },
      permission: { hook: () => undefined },
      session: { hook: () => undefined },
    };

    const doctor = OpenCodeV2Plugin.setup(ctx);
    expect(doctor.healthy).toBe(true);
    expect(doctor.version).toBe(HARNESS_RELEASE_VERSION);
    expect(HARNESS_RELEASE_VERSION).toBe("1.0.6");
    expect(namespaces).toEqual(["harness"]);
    expect(directTools).toContain("symbol_references");
    expect(codeModeTools).toContain("symbol_references");
    expect(codeModeTools).toContain("repo_map");
    expect(codeModeTools).toContain("blast_radius");

    // Verify patch input repair and post-edit cross-file import diagnostics fire in hooks
    const patchInput: Record<string, unknown> = {
      patchText: "*** Update File: src/caller.ts\n@@\n+1: import { missingExport } from \"./mod.js\";",
    };
    await beforeHandler!({
      sessionID: "s1",
      tool: "patch",
      input: patchInput,
    });
    expect(String(patchInput.patchText)).toContain("*** Begin Patch");

    writeFileSync(
      join(root, "src", "caller.ts"),
      'import { missingExport } from "./mod.js";\nexport const v = missingExport();\n',
      "utf8",
    );
    const afterEv: OpenCodeV2ToolAfterEvent = {
      sessionID: "s1",
      tool: "write",
      input: { path: join(root, "src", "caller.ts") },
      status: "completed",
      result: {
        content: [{ type: "text", text: "Created file src/caller.ts" }],
      },
    };
    await afterHandler!(afterEv);
    const combined = afterEv.result!.content!.map((c) => c.text).join("\n");
    expect(combined).toContain("export-contract");
    expect(combined).toContain('has no exported member "missingExport"');

    // Verify OpenCodeTools worktree instruction is stripped during compaction
    const compactionEvent: OpenCodeV2SessionCompactionEvent = {
      system: [
        {
          text: "When you create a worktree outside the current working directory and intend to use it as your primary working directory, consider using `execute` to call `tools.opencode.session_move` and make the worktree the session's working directory.",
        },
      ],
    };
    const cleaned = decontaminateCompactionEventInPlace(compactionEvent);
    expect(cleaned.strippedSystemParts).toBe(1);
    expect(compactionEvent.system?.length).toBe(0);
  });
});
