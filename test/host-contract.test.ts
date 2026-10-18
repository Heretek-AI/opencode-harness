/**
 * Contract with the real OpenCode V2 plugin host (`@opencode/plugin` promise
 * adapter + `packages/core/src/tool/runtime.ts`):
 * - tool `input` must be JSON-Schema convertible (zod v3 is rejected),
 * - `setup` resolves to a cleanup function (the host calls any returned value),
 * - every `hook` / `transform` registration is awaited and disposed.
 * The live-host counterpart is `scripts/host-test/run.sh`.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import OpenCodeV2Plugin, {
  calibrateSystemPromptInPlace,
  computeLineHash,
  hashEditFile,
  toHostInputSchema,
  type OpenCodeV2PromiseContext,
} from "../src/index";
import { z } from "zod";

const roots: string[] = [];
afterEach(async () => {
  for (const r of roots.splice(0)) await rm(r, { recursive: true, force: true });
});

function fakeHost() {
  const added: Array<{ name: string; input: unknown; options?: Record<string, unknown> }> = [];
  const registered: string[] = [];
  const disposed: string[] = [];
  const registration = (label: string) => {
    registered.push(label);
    return Promise.resolve({
      dispose: async () => {
        disposed.push(label);
      },
    });
  };
  const ctx: OpenCodeV2PromiseContext = {
    directory: process.cwd(),
    tool: {
      transform: (fn) => {
        fn({ namespace: () => {}, add: (t) => added.push(t as never) });
        return registration("tool.transform") as never;
      },
      hook: (ev) => registration(`tool.hook:${ev}`) as never,
    },
    permission: { hook: (ev) => registration(`permission.hook:${ev}`) as never },
    session: { hook: (ev) => registration(`session.hook:${ev}`) as never },
    shell: { hook: (ev) => registration(`shell.hook:${ev}`) as never },
  };
  return { ctx, added, registered, disposed };
}

describe("OpenCode V2 host contract", () => {
  test("tool inputs are plain JSON Schema, never zod instances", async () => {
    const host = fakeHost();
    await OpenCodeV2Plugin.setup(host.ctx);
    expect(host.added.length).toBeGreaterThan(10);
    for (const tool of host.added) {
      const input = tool.input as Record<string, unknown>;
      expect(input).not.toHaveProperty("_def");
      expect(input).not.toHaveProperty("~standard");
      expect(input).not.toHaveProperty("$schema");
      expect(input.type).toBe("object");
      expect(() => JSON.parse(JSON.stringify(input))).not.toThrow();
    }
    const read = host.added.find((t) => t.name === "file_hash_read");
    expect(read?.input).toMatchObject({
      type: "object",
      required: ["path"],
      properties: { path: { type: "string" } },
    });
  });

  test("toHostInputSchema inlines nested schemas without $ref", () => {
    const inner = z.object({ x: z.number() });
    const schema = toHostInputSchema(z.object({ a: inner, b: inner.optional() }));
    expect(JSON.stringify(schema)).not.toContain("$ref");
    expect(schema).toMatchObject({ type: "object", required: ["a"] });
  });

  test("setup resolves to a cleanup function that disposes every registration", async () => {
    const host = fakeHost();
    const cleanup = await OpenCodeV2Plugin.setup(host.ctx);
    expect(typeof cleanup).toBe("function");
    expect(host.registered).toContain("tool.transform");
    expect(host.registered).toContain("permission.hook:evaluate");
    expect(host.disposed).toEqual([]);
    await cleanup();
    expect([...host.disposed].sort()).toEqual([...host.registered].sort());
  });

  test("a dispose that throws synchronously does not stop the others", async () => {
    const host = fakeHost();
    const failing = { dispose: () => { throw new Error("boom"); } };
    const ctx = {
      ...host.ctx,
      tool: { ...host.ctx.tool, hook: () => Promise.resolve(failing) as never },
    };
    const cleanup = await OpenCodeV2Plugin.setup(ctx);
    await cleanup();
    expect(host.disposed.length).toBeGreaterThan(0);
    expect([...host.disposed].sort()).toEqual([...host.registered].sort());
  });

  test("plugin options arrive on ctx.options", async () => {
    const host = fakeHost();
    const seeded = new Map<string, unknown>();
    await OpenCodeV2Plugin.setup({
      ...host.ctx,
      options: { seedRecommendedMcp: true },
      mcp: { transform: (fn) => fn({ get: (n) => seeded.get(n), set: (n, c) => seeded.set(n, c) }) },
    });
    expect(seeded.get("fallow-mcp")).toEqual({
      type: "local",
      command: ["npx", "--yes", "--package", "fallow", "fallow-mcp"],
    });
  });
});

describe("Muse 1.3 system prompt calibration option", () => {
  async function promptHandlers(options?: Record<string, unknown>) {
    const host = fakeHost();
    const handlers = new Map<string, (event: never) => unknown>();
    await OpenCodeV2Plugin.setup({
      ...host.ctx,
      ...(options ? { options } : {}),
      session: {
        hook: (ev, fn) => {
          handlers.set(ev, fn as never);
          return Promise.resolve({ dispose: async () => {} }) as never;
        },
      },
    });
    return handlers;
  }

  function events() {
    const system = [{ text: "You are a coding agent." }];
    return {
      prompt: { agent: "builder", system },
      context: {
        agent: "builder",
        system,
        messages: [{ role: "user", content: "hi" }],
      },
    };
  }

  test("leaves the system prompt untouched by default", async () => {
    const handlers = await promptHandlers();
    const { prompt, context } = events();
    await handlers.get("prompt")!(prompt as never);
    await handlers.get("context")!(context as never);
    expect(prompt.system).toEqual([{ text: "You are a coding agent." }]);
  });

  test("applies the overlay when museCalibration is true", async () => {
    const handlers = await promptHandlers({ museCalibration: true });
    const { prompt } = events();
    await handlers.get("prompt")!(prompt as never);
    expect(prompt.system[0]!.text).toContain("<muse-1.3-harness-calibration>");
  });

  test("rejects a non-boolean museCalibration", async () => {
    await expect(promptHandlers({ museCalibration: "yes" })).rejects.toThrow(/museCalibration/);
  });

  test("prompt hook sanitizes upstream-shaped prompt text without system (OH-2.4)", async () => {
    const handlers = await promptHandlers();
    const upstreamShaped = {
      agent: "builder",
      prompt: "<recent-context>\n[Assistant tool call]: read({\"path\": \"x\"})\n</recent-context>",
    };
    await handlers.get("prompt")!(upstreamShaped as never);
    expect((upstreamShaped as { prompt: string }).prompt).toContain(
      "historical-summary-only-use-native-tool-calls",
    );
    // Compaction agents are skipped entirely.
    const compactionShaped = {
      agent: "compaction",
      prompt: "<recent-context>\n[Assistant tool call]: read({\"path\": \"x\"})\n</recent-context>",
    };
    await handlers.get("prompt")!(compactionShaped as never);
    expect((compactionShaped as { prompt: string }).prompt).toContain("[Assistant tool call]");
  });
});

describe("hashEditFile partial anchor mismatch", () => {
  async function setupFile(): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), "harness-anchor-"));
    roots.push(root);
    await Bun.write(join(root, "f.ts"), "a\nb\nc\nd\n");
    return root;
  }

  test("fails closed when only the end anchor is wrong", async () => {
    const root = await setupFile();
    const result = await hashEditFile(root, "f.ts", [
      { startLine: 2, startHash: computeLineHash("b"), endLine: 3, endHash: computeLineHash("zzz"), replacement: "X" },
    ]);
    expect(result.applied).toBe(false);
    expect(result.error).toContain("anchor mismatch");
    expect(await Bun.file(join(root, "f.ts")).text()).toBe("a\nb\nc\nd\n");
  });

  test("fails closed when only the start anchor is wrong", async () => {
    const root = await setupFile();
    const result = await hashEditFile(root, "f.ts", [
      { startLine: 2, startHash: computeLineHash("zzz"), endLine: 3, endHash: computeLineHash("c"), replacement: "X" },
    ]);
    expect(result.applied).toBe(false);
    expect(result.error).toContain("anchor mismatch");
    expect(await Bun.file(join(root, "f.ts")).text()).toBe("a\nb\nc\nd\n");
  });
});

describe("calibrateSystemPromptInPlace", () => {
  test("replaces a reworded upstream subagent bullet and stays byte-stable", () => {
    const reworded =
      "intro\n- Prefer the `subagent` tool to reduce context token usage when outputs are large.\n- other rule";
    const parts = [{ text: reworded }];
    expect(calibrateSystemPromptInPlace(parts)).toBe(true);
    expect(parts[0]?.text).not.toContain("reduce context token usage");
    expect(parts[0]?.text).toContain("- other rule");
    const once = parts[0]?.text;
    calibrateSystemPromptInPlace(parts);
    expect(parts[0]?.text).toBe(once);
  });
});
