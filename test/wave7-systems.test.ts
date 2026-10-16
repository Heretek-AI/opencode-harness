import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import OpenCodeV2Plugin, {
  setupOpenCodeV2Harness,
  buildPostMutationAnchorReceipt,
  clearAllSessionAttempts,
  clearDiagnosticsCache,
  clearPendingLessonProposals,
  clearSessionLineage,
  clearStaleReadRegistry,
  clearTaintState,
  computeLineHash,
  detectUnusedExportsAndOrphanModules,
  handleSessionRetryInPlace,
  HARNESS_RELEASE_VERSION,
  renameSymbolAcrossWorkspace,
  runArchitectureAudit,
  trackCircuitBreakerAndAutoProposeLesson,
  type OpenCodeV2PromiseContext,
  type OpenCodeV2SessionRetryEvent,
  type OpenCodeV2ToolAfterEvent,
  type OpenCodeV2ToolBeforeEvent,
} from "../src/index";
import pkgJson from "../package.json";
const PKG_VERSION: string = pkgJson.version;

let tempDirs: string[] = [];

function makeTempWorkspace(): string {
  const dir = mkdtempSync(join(tmpdir(), "wave7-systems-"));
  tempDirs.push(dir);
  return dir;
}

beforeEach(() => {
  clearAllSessionAttempts();
  clearDiagnosticsCache();
  clearStaleReadRegistry();
  clearTaintState();
  clearSessionLineage();
  clearPendingLessonProposals();
});

afterEach(() => {
  for (const d of tempDirs) {
    rmSync(d, { recursive: true, force: true });
  }
  tempDirs = [];
});

describe("Wave 7 capability 1: lexer-safe atomic multi-file rename_symbol engine", () => {
  test("renames identifier across definitions, imports, exports, and call sites while ignoring comments and strings", () => {
    const root = makeTempWorkspace();
    writeFileSync(
      join(root, "math.ts"),
      [
        "// calculateDiscount should remain untouched in this comment",
        "export function calculateDiscount(price: number): number {",
        '  const tag = "calculateDiscount literal string";',
        "  return price * 0.9;",
        "}",
      ].join("\n"),
      "utf8",
    );
    writeFileSync(
      join(root, "checkout.ts"),
      [
        'import { calculateDiscount } from "./math.js";',
        "export function finalTotal(amount: number): number {",
        "  return calculateDiscount(amount);",
        "}",
      ].join("\n"),
      "utf8",
    );

    const outcome = renameSymbolAcrossWorkspace(
      "calculateDiscount",
      "computeMemberDiscount",
      root,
    );

    expect(outcome.applied).toBe(true);
    expect(outcome.rolledBack).toBe(false);
    expect(outcome.totalReplacements).toBe(3);
    expect(outcome.modifiedFiles.sort()).toEqual(["checkout.ts", "math.ts"]);
    expect(outcome.formattedBlock).toContain(
      '<symbol-rename from="calculateDiscount" to="computeMemberDiscount" status="applied"',
    );

    const updatedMath = readFileSync(join(root, "math.ts"), "utf8");
    expect(updatedMath).toContain(
      "// calculateDiscount should remain untouched in this comment",
    );
    expect(updatedMath).toContain(
      'const tag = "calculateDiscount literal string";',
    );
    expect(updatedMath).toContain(
      "export function computeMemberDiscount(price: number): number {",
    );

    const updatedCheckout = readFileSync(join(root, "checkout.ts"), "utf8");
    expect(updatedCheckout).toContain(
      'import { computeMemberDiscount } from "./math.js";',
    );
    expect(updatedCheckout).toContain("return computeMemberDiscount(amount);");
  });
});

describe("Wave 7 capability 2: post-mutation & post-formatter FNV-1a anchor resync receipt", () => {
  test("computes fresh 4-hex FNV-1a <post-edit-anchors> around modified or reformatted lines", () => {
    const root = makeTempWorkspace();
    const file = join(root, "widget.ts");
    const beforeContent = [
      "export function renderCard(title: string) {",
      "  const x = 1;",
      "  return title;",
      "}",
    ].join("\n");
    // Simulate edit + Prettier/Biome multi-line reflow
    const afterContent = [
      "export function renderCard(title: string) {",
      "  const formattedValue =",
      "    title.trim().toUpperCase();",
      "  return formattedValue;",
      "}",
    ].join("\n");
    writeFileSync(file, afterContent, "utf8");

    const receipt = buildPostMutationAnchorReceipt({
      filePath: file,
      beforeContent,
      afterContent,
      workspaceRoot: root,
      contextRadius: 1,
    });

    expect(receipt).toContain('<post-edit-anchors file="widget.ts" lines="1-5" totalLines="5">');
    expect(receipt).toContain(
      `2#${computeLineHash("const formattedValue =")}|   const formattedValue =`,
    );
  });
});

describe("Wave 7 capability 3: adaptive session.hook('retry') stream & overload recovery", () => {
  test("recovers from transient incomplete-stream and 503 overload errors while halting on auth or context-overflow", () => {
    const streamDropEvent: OpenCodeV2SessionRetryEvent = {
      sessionID: "s1",
      error: {
        type: "incomplete-stream",
        message: "Model stream ended before finish-step",
      },
      attempt: 1,
      decision: { retry: false },
    };

    const outcome1 = handleSessionRetryInPlace(streamDropEvent);
    expect(outcome1.retry).toBe(true);
    expect(streamDropEvent.decision.retry).toBe(true);
    if (streamDropEvent.decision.retry) {
      expect(streamDropEvent.decision.delay).toBeGreaterThanOrEqual(500);
    }

    const authFailEvent: OpenCodeV2SessionRetryEvent = {
      sessionID: "s1",
      error: {
        type: "auth",
        message: "401 Unauthorized: invalid_api_key",
      },
      attempt: 1,
      decision: { retry: true, delay: 2000 },
    };

    const outcome2 = handleSessionRetryInPlace(authFailEvent);
    expect(outcome2).toEqual({ retry: false });
    expect(authFailEvent.decision).toEqual({ retry: false });
  });
});

describe("Wave 7 capability 4: unused export & orphan module dead-code detector", () => {
  test("identifies unused exports on internal modules and orphan non-entrypoint modules", () => {
    const root = makeTempWorkspace();
    mkdirSync(join(root, "src"), { recursive: true });
    writeFileSync(
      join(root, "src", "index.ts"),
      'import { usedHelper } from "./helpers.js";\nexport function mainEntry() { return usedHelper(); }\n',
      "utf8",
    );
    writeFileSync(
      join(root, "src", "helpers.ts"),
      [
        "export function usedHelper() { return 1; }",
        "export function deadUnusedHelper() { return 2; }",
      ].join("\n"),
      "utf8",
    );
    writeFileSync(
      join(root, "src", "abandoned.ts"),
      "export function neverImportedAnywhere() { return 0; }\n",
      "utf8",
    );

    const dead = detectUnusedExportsAndOrphanModules(root);
    expect(
      dead.unusedExports.some(
        (u) => u.file === "src/helpers.ts" && u.symbol === "deadUnusedHelper",
      ),
    ).toBe(true);
    expect(dead.unusedExports.some((u) => u.symbol === "mainEntry")).toBe(false);
    expect(dead.orphanModules).toContain("src/abandoned.ts");

    const audit = runArchitectureAudit(root);
    expect(audit.unusedExports.length).toBeGreaterThanOrEqual(1);
    expect(audit.orphanModules).toContain("src/abandoned.ts");
    expect(audit.formattedReport).toContain("<unused-exports");
    expect(audit.formattedReport).toContain("<orphan-modules");
  });
});

describe("Wave 7 capability 5: automatic circuit-breaker recovery lesson synthesis & full host integration", () => {
  test("auto-proposes a scope-tagged episodic lesson upon recovery from a circuit-breaker trip and wires Wave 7 hooks", async () => {
    const root = makeTempWorkspace();
    mkdirSync(join(root, "src", "parsers"), { recursive: true });
    const targetFile = join(root, "src", "parsers", "json-parser.ts");
    writeFileSync(
      targetFile,
      "export function parseToken(s: string) {\n  return s.trim();\n}\n",
      "utf8",
    );

    // Direct unit check on trackCircuitBreakerAndAutoProposeLesson
    const tripOut = trackCircuitBreakerAndAutoProposeLesson({
      sessionId: "sess-cb",
      toolName: "edit",
      ok: false,
      tripped: true,
      targetPathOrCommand: targetFile,
      workspaceRoot: root,
    });
    expect(tripOut).toBeNull();

    const recoveryLesson = trackCircuitBreakerAndAutoProposeLesson({
      sessionId: "sess-cb",
      toolName: "file_hash_edit",
      ok: true,
      tripped: false,
      targetPathOrCommand: targetFile,
      workspaceRoot: root,
    });
    expect(recoveryLesson).not.toBeNull();
    expect(recoveryLesson!.scopePrefix).toBe("src/parsers");
    expect(recoveryLesson!.proposedSummary).toContain("file_hash_edit");

    // End-to-end OpenCodeV2Plugin.setup check
    const directTools: string[] = [];
    const codeModeTools: string[] = [];
    let beforeHandler: ((ev: OpenCodeV2ToolBeforeEvent) => void | Promise<void>) | undefined;
    let afterHandler: ((ev: OpenCodeV2ToolAfterEvent) => void | Promise<void>) | undefined;
    let retryHandler: ((ev: OpenCodeV2SessionRetryEvent) => void | Promise<void>) | undefined;

    const ctx: OpenCodeV2PromiseContext = {
      directory: root,
      tool: {
        transform: (fn) =>
          fn({
            namespace: () => undefined,
            add: (t) => {
              if (t.options?.codemode === false) directTools.push(t.name);
              if (t.options?.namespace === "harness") codeModeTools.push(t.name);
            },
          }),
        hook: (ev, fn) => {
          if (ev === "execute.before") beforeHandler = fn;
          if (ev === "execute.after") afterHandler = fn;
        },
      },
      permission: { hook: () => undefined },
      session: {
        hook: (ev, fn) => {
          if (ev === "retry") retryHandler = fn;
        },
      },
    };

    const doctor = setupOpenCodeV2Harness(ctx).report;
    expect(doctor.healthy).toBe(true);
    expect(doctor.version).toBe(HARNESS_RELEASE_VERSION);
    expect(HARNESS_RELEASE_VERSION).toBe(PKG_VERSION);
    expect(directTools).toContain("rename_symbol");
    expect(codeModeTools).toContain("rename_symbol");

    // Verify retry hook is wired
    const retryEv: OpenCodeV2SessionRetryEvent = {
      sessionID: "s1",
      error: { message: "503 Service Unavailable (overloaded)" },
      attempt: 1,
      decision: { retry: false },
    };
    await retryHandler!(retryEv);
    expect(retryEv.decision.retry).toBe(true);

    // Verify post-edit anchor resync receipt is appended after edit
    await beforeHandler!({
      sessionID: "s1",
      tool: "edit",
      input: { path: targetFile },
    });
    writeFileSync(
      targetFile,
      "export function parseToken(s: string) {\n  return s.trim().toLowerCase();\n}\n",
      "utf8",
    );
    const afterEv: OpenCodeV2ToolAfterEvent = {
      sessionID: "s1",
      tool: "edit",
      input: { path: targetFile },
      status: "completed",
      result: {
        content: [{ type: "text", text: "Edited src/parsers/json-parser.ts" }],
      },
    };
    await afterHandler!(afterEv);
    const combined = afterEv.result!.content!.map((c) => c.text).join("\n");
    expect(combined).toContain('<post-edit-anchors file="src/parsers/json-parser.ts"');
  });
});
