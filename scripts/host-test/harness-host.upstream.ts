/**
 * Live OpenCode V2 host test. Copied into `packages/core/test/plugin/` of an
 * `anomalyco/opencode` checkout by `scripts/host-test/run.sh` and run with the
 * upstream `PluginTestLayer` fixture, so the harness is loaded through the
 * real promise-plugin adapter and tool registry (not a mock).
 *
 * Covers every direct tool (including failure-path executions that prove the
 * OH-3.2 host-level failure signaling), Code Mode companions, hook
 * registration/firing, options, calibration determinism, compaction,
 * affinity, and scope-close unload plus reload — adapted from the audit's
 * Alpha extended/session/unload suites to repo paths (no fixture dir needed;
 * read-only tools run against `HARNESS_ROOT`, mutating tools run failure-path
 * or in-memory only so the checkout is never modified).
 */
import { expect } from "bun:test"
import { Agent } from "@opencode/core/agent"
import { Plugin } from "@opencode/core/plugin"
import { PluginHost } from "@opencode/core/plugin/host"
import { PluginPromise } from "@opencode/core/plugin/promise"
import { PluginHooks } from "@opencode/core/plugin/hooks"
import { Tool } from "@opencode/core/tool"
import { Formatter } from "@opencode/core/formatter"
import { AppNodeBuilder } from "@opencode/core/effect/app-node-builder"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { AISDK } from "@opencode/core/aisdk"
import { Command } from "@opencode/core/command"
import { Config } from "@opencode/core/config"
import { Credential } from "@opencode/core/credential"
import { Database } from "@opencode/core/database/database"
import { FileAccess } from "@opencode/core/file-access"
import { LayerNodePlatform } from "@opencode/util/effect/app-node-platform"
import { AppProcess } from "@opencode/util/process"
import { Bus } from "@opencode/core/bus"
import { FileSystem } from "@opencode/core/filesystem"
import { FSUtil } from "@opencode/util/fs-util"
import { Form } from "@opencode/core/form"
import { Generate } from "@opencode/core/generate"
import { Integration } from "@opencode/core/integration"
import { KV } from "@opencode/core/kv"
import { Location } from "@opencode/core/location"
import { ManagedPolicy } from "@opencode/core/managed-policy"
import { Mcp } from "@opencode/core/mcp/index"
import { Model } from "@opencode/core/model"
import { Npm } from "@opencode/util/npm"
import { Provider } from "@opencode/core/provider"
import { Session } from "@opencode/schema/session"
import { Session as CoreSession } from "@opencode/core/session"
import { SessionMessage } from "@opencode/schema/session-message"
import { PersistentPty } from "@opencode/core/persistent-pty"
import { LocationServiceMap } from "@opencode/core/location-service-map"
import { Permission } from "@opencode/core/permission"
import { Reference } from "@opencode/core/reference"
import { Rpc } from "@opencode/core/rpc"
import { Skill } from "@opencode/core/skill"
import { SkillDiscovery } from "@opencode/core/skill/discovery"
import { Vcs } from "@opencode/core/vcs"
import { Watcher } from "@opencode/core/filesystem/watcher"
import { WebSearch } from "@opencode/core/websearch"
import { Worktree } from "@opencode/core/worktree"
import { WorktreeStrategies } from "@opencode/core/worktree/strategies"
import { Effect, Exit, Layer, Scope } from "effect"
import { testEffect } from "../lib/effect"
import { readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { PluginTestLayer } from "./fixture"
import { tempLocationLayer } from "../fixture/location"
import { emptyMcpLayer } from "../fixture/mcp"

const HARNESS_ROOT = process.env.HARNESS_ROOT
if (!HARNESS_ROOT) throw new Error("HARNESS_ROOT must point at the opencode-harness checkout")
const harness = (await import(`${HARNESS_ROOT}/src/index.ts`)).default
const { computeLineHash } = (await import(`${HARNESS_ROOT}/src/index.ts`)) as {
  computeLineHash: (line: string) => string
}

const EXPECTED_TOOLS = [
  "architecture_audit",
  "ast_structural_rewrite",
  "ast_structural_search",
  "blast_radius",
  "checkpoint_create",
  "checkpoint_rollback",
  "file_hash_edit",
  "file_hash_read",
  "file_outline",
  "rename_symbol",
  "repo_map",
  "symbol_references",
  "ui_geometry_audit",
  "verify_scoped",
]

// companions registered as tools.harness.* (effective names harness_<name>)
const EXPECTED_CODEMODE = [
  "file_hash_read",
  "ast_structural_search",
  "repo_map",
  "blast_radius",
  "file_outline",
  "symbol_references",
  "rename_symbol",
  "architecture_audit",
]

const it = testEffect(PluginTestLayer)

const call = (
  snapshot: { execute: (input: any) => Effect.Effect<any, any> },
  name: string,
  input: Record<string, unknown>,
) =>
  snapshot
    .execute({
      sessionID: Session.ID.make("ses_harness_host"),
      agent: Agent.ID.make("build"),
      messageID: SessionMessage.ID.make("msg_harness_host"),
      call: { type: "tool-call", id: `call_${name}_${Math.random().toString(36).slice(2, 8)}`, name, input },
    })
    .pipe(Effect.exit)

const textOf = (result: Exit.Exit<unknown, unknown>): string => JSON.stringify(Exit.isSuccess(result) ? result.value : result)

it.live("opencode-harness registers every tool in the real OpenCode V2 host and unloads cleanly", () =>
  Effect.gen(function* () {
    const plugins = yield* Plugin.Service
    const tools = yield* Tool.Service
    const hooks = yield* PluginHooks.Service
    yield* PluginPromise.fromPromise({
      id: harness.id,
      setup: (ctx: unknown) => harness.setup(ctx, { rootDir: HARNESS_ROOT, taskMd: "# Host task\nLive wires." }),
    }).effect(yield* PluginHost.make(plugins))

    const snapshot = yield* tools.snapshot()
    const names = snapshot.definitions.map((d: { name?: string; id?: string }) => d.name ?? d.id)
    for (const name of EXPECTED_TOOLS) expect(names).toContain(name)

    // ---- Code Mode companions: effective names + catalog + live execute ----
    const listed = yield* tools.list()
    for (const name of EXPECTED_CODEMODE) {
      const match = (listed as Array<{ name: string; options?: { namespace?: string; codemode?: boolean; pinned?: boolean } }>).find(
        (t) => t.name === name && t.options?.namespace === "harness" && t.options?.codemode === true && t.options?.pinned === true,
      )
      expect(match).not.toBeUndefined()
    }
    const catalogText = JSON.stringify((snapshot as unknown as { codeModeCatalog?: unknown }).codeModeCatalog ?? {})
    expect(catalogText).toContain("harness")

    // ---- direct tool executions (read-only tools succeed on the checkout) ----
    let r = yield* call(snapshot, "file_hash_read", { path: "package.json", limit: 2 })
    expect(Exit.isSuccess(r)).toBe(true)
    expect(textOf(r)).toContain("@heretek-ai/opencode-harness")

    r = yield* call(snapshot, "ast_structural_search", {
      code: "const a = 1;\nconsole.log(a);\n",
      pattern: "console.log($VAR)",
      language: "typescript",
    })
    expect(Exit.isSuccess(r)).toBe(true)
    expect(textOf(r)).toContain("console.log")

    r = yield* call(snapshot, "ui_geometry_audit", {
      elements: [{ tag: "button", rect: { x: 0, y: 0, width: 10, height: 10 }, interactive: true }],
    })
    expect(Exit.isSuccess(r)).toBe(true)
    expect(textOf(r)).toContain("tiny-interactive-target")

    r = yield* call(snapshot, "repo_map", { topK: 5 })
    expect(Exit.isSuccess(r)).toBe(true)

    r = yield* call(snapshot, "blast_radius", { path: "src/index.ts" })
    expect(Exit.isSuccess(r)).toBe(true)

    r = yield* call(snapshot, "file_outline", { path: "src/index.ts" })
    expect(Exit.isSuccess(r)).toBe(true)
    expect(textOf(r)).toContain("symbols")

    r = yield* call(snapshot, "symbol_references", { symbol: "computeLineHash", maxResults: 5 })
    expect(Exit.isSuccess(r)).toBe(true)
    expect(textOf(r)).toContain("computeLineHash")

    r = yield* call(snapshot, "architecture_audit", { files: ["package.json"] })
    expect(Exit.isSuccess(r)).toBe(true)
    expect(textOf(r)).toContain("architecture-audit")

    r = yield* call(snapshot, "verify_scoped", { modifiedFiles: ["package.json"], timeoutMs: 60000 })
    expect(Exit.isSuccess(r)).toBe(true)
    expect(textOf(r)).toContain("verification-report")

    // ---- mutating tools: in-memory/no-op paths, never touching the checkout ----
    r = yield* call(snapshot, "checkpoint_create", { label: "host", files: ["package.json"] })
    expect(Exit.isSuccess(r)).toBe(true)
    r = yield* call(snapshot, "checkpoint_rollback", {})
    expect(Exit.isSuccess(r)).toBe(true)

    r = yield* call(snapshot, "rename_symbol", { oldSymbol: "harnessNoSuchSymbolZZZ9", newSymbol: "x" })
    expect(Exit.isSuccess(r)).toBe(true)
    expect(textOf(r)).toContain("noop")

    // ---- OH-3.2 failure signaling through the real host pipeline ----
    // (re-read first: checkpoint_rollback above rewrote package.json, so the
    // stale-read detector requires a fresh read before any mutation attempt)
    r = yield* call(snapshot, "file_hash_read", { path: "package.json", limit: 1 })
    expect(Exit.isSuccess(r)).toBe(true)
    r = yield* call(snapshot, "file_hash_edit", {
      path: "package.json",
      hunks: [{ startLine: 1, startHash: "0000", endLine: 1, endHash: "ffff", replacement: "x" }],
    })
    expect(Exit.isFailure(r)).toBe(true)
    expect(textOf(r)).toContain("anchor mismatch")

    // (re-read again: the failed edit above opened + rolled back a
    // transaction, bumping mtime — the stale-read detector requires freshness)
    r = yield* call(snapshot, "file_hash_read", { path: "package.json", limit: 1 })
    expect(Exit.isSuccess(r)).toBe(true)
    r = yield* call(snapshot, "ast_structural_rewrite", {
      path: "package.json",
      pattern: "console.log($MSG)",
      rewrite: "logger.info($MSG)",
    })
    expect(Exit.isFailure(r)).toBe(true)
    expect(textOf(r)).toContain("no structural match")

    // ---- codemode companion executes through the real "execute" tool ----
    r = yield* call(snapshot, "execute", {
      code: 'return await tools.harness["file_hash_read"]({path:"package.json",limit:5});',
    })
    expect(Exit.isSuccess(r)).toBe(true)
    expect(textOf(r)).toContain("@heretek-ai/opencode-harness")

    // ---- hook registration in the real host ----
    expect(yield* hooks.has("tool", "execute.before")).toBe(true)
    expect(yield* hooks.has("tool", "execute.after")).toBe(true)
    expect(yield* hooks.has("permission", "evaluate")).toBe(true)
    expect(yield* hooks.has("shell", "create.before")).toBe(true)
    expect(yield* hooks.has("session", "context")).toBe(true)
    expect(yield* hooks.has("session", "compaction")).toBe(true)
    expect(yield* hooks.has("session", "generate")).toBe(true)
    expect(yield* hooks.has("session", "model.request")).toBe(true)
    expect(yield* hooks.has("session", "retry")).toBe(true)
    expect(yield* hooks.has("session", "prompt")).toBe(true)

    // ---- permission hook fires through the real pipeline ----
    const permEvent = {
      sessionID: Session.ID.make("ses_perm"),
      agent: Agent.ID.make("agency-qa"),
      action: "edit",
      resources: ["src/index.ts"],
      effect: "allow" as const,
    }
    yield* hooks.trigger("permission", "evaluate", permEvent as never)
    expect(permEvent.effect).toBe("deny")

    // ---- shell hook fires through the real pipeline ----
    const shellEvent = { command: "echo host-shell-probe", cwd: HARNESS_ROOT, timeout: 30000, shell: "bash", env: {} as Record<string, string | undefined> }
    yield* hooks.trigger("shell", "create.before", shellEvent as never)
    expect(shellEvent.env["CI"]).toBe("1")
    expect(shellEvent.env["PAGER"]).toBe("cat")

    // ---- session context hook: system untouched by default, budget on user msg ----
    const ctxEvent = {
      sessionID: Session.ID.make("ses_ctx"),
      agent: Agent.ID.make("build"),
      model: { providerID: "test", id: "test-model" },
      system: [{ type: "text", text: "You are OpenCode, a coding agent." }],
      messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
      options: {},
      tools: {},
    }
    const sysBefore = (ctxEvent.system[0] as { text: string }).text
    yield* hooks.trigger("session", "context", ctxEvent as never)
    expect((ctxEvent.system[0] as { text: string }).text).toBe(sysBefore)
    const userText = ((ctxEvent.messages[0] as { content: Array<{ text: string }> }).content[0] as { text: string }).text
    expect(userText).toContain("Host task")

    // ---- retry hook fires through the real pipeline ----
    const retryEvent = {
      sessionID: Session.ID.make("ses_retry"),
      agent: Agent.ID.make("build"),
      model: { providerID: "test", id: "test-model" },
      error: { type: "incomplete-stream", message: "stream cut" },
      attempt: 1,
      decision: { retry: false as const },
    }
    yield* hooks.trigger("session", "retry", retryEvent as never)
    expect((retryEvent.decision as { retry: boolean }).retry).toBe(true)
  }),
)

const OVER = "You are OpenCode, a coding agent.\n- Use the `subagent` tool to minimize context token usage whenever tool calls generate large outputs but only a small subset is useful for the task at hand. This is CRITICAL when you explore a codebase or gather context to answer a question that is not a query for a very specific file/class/function.\n"

it.live("opencode-harness calibration is deterministic; prompt hook sanitizes; compaction and affinity hold", () =>
  Effect.gen(function* () {
    const plugins = yield* Plugin.Service
    const hooks = yield* PluginHooks.Service
    yield* PluginPromise.fromPromise({
      id: harness.id,
      setup: (ctx: unknown) =>
        harness.setup(ctx, { rootDir: HARNESS_ROOT, museCalibration: true, taskMd: "# T" }),
    }).effect(yield* PluginHost.make(plugins))

    const mkCtx = () => ({
      sessionID: Session.ID.make("ses_cal"),
      agent: Agent.ID.make("build"),
      model: { providerID: "test", id: "test-model" },
      system: [{ type: "text", text: OVER }],
      messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
      options: {},
      tools: {},
    })
    const e1 = mkCtx()
    yield* hooks.trigger("session", "context", e1 as never)
    const sys1 = (e1.system[0] as { text: string }).text
    expect(sys1).toContain("<muse-1.3-harness-calibration>")
    expect(sys1).not.toContain("minimize context token usage whenever")
    // second turn, identical input -> identical system (KV-cache safe)
    const e2 = mkCtx()
    yield* hooks.trigger("session", "context", e2 as never)
    expect((e2.system[0] as { text: string }).text).toBe(sys1)

    // prompt hook: upstream SessionPrompt carries prompt text, not system —
    // the harness sanitizes the text instead of no-op'ing (OH-2.4).
    const promptEvent = {
      sessionID: Session.ID.make("ses_p"),
      messageID: SessionMessage.ID.make("msg_p"),
      prompt: "<recent-context>\n[Assistant tool call]: read({\"path\": \"x\"})\n</recent-context>",
    }
    yield* hooks.trigger("session", "prompt", promptEvent as never)
    expect((promptEvent as Record<string, unknown>).system).toBeUndefined()
    expect((promptEvent as Record<string, unknown>).prompt as string).toContain(
      "historical-summary-only-use-native-tool-calls",
    )

    // compaction decontamination through the real pipeline
    const compEvent = {
      sessionID: Session.ID.make("ses_c"),
      agent: Agent.ID.make("build"),
      model: { providerID: "test", id: "test-model" },
      system: [
        { type: "text", text: "Project instructions: follow the repo style guide." },
        { type: "text", text: "# Your Model\nsome model card" },
      ],
      messages: [],
      options: {},
      tools: { staleTool: { description: "x", input: {} } },
    }
    yield* hooks.trigger("session", "compaction", compEvent as never)
    const sysTexts = (compEvent.system as Array<{ text: string }>).map((p) => p.text)
    expect(sysTexts.some((t) => t.includes("repo style guide"))).toBe(true)
    expect(sysTexts.some((t) => t.startsWith("# Your Model"))).toBe(false)
    expect(Object.keys(compEvent.tools as object).length).toBe(0)

    // root affinity headers through the real pipeline
    const modelEvent = {
      sessionID: Session.ID.make("ses_m"),
      agent: Agent.ID.make("build"),
      model: { providerID: "test", id: "test-model" },
      kind: "primary",
      headers: {} as Record<string, string>,
    }
    yield* hooks.trigger("session", "model.request", modelEvent as never)
    expect(typeof (modelEvent.headers as Record<string, string>)["x-session-affinity"]).toBe("string")
  }),
)

it.live("opencode-harness unload removes tools and hooks, reload restores exactly once", () =>
  Effect.gen(function* () {
    const plugins = yield* Plugin.Service
    const tools = yield* Tool.Service
    const hooks = yield* PluginHooks.Service
    const countHarness = (defs: Array<{ name?: string; id?: string }>) =>
      defs.filter((d) => EXPECTED_TOOLS.includes((d.name ?? d.id) as string)).length
    const scope = yield* Scope.make()
    yield* PluginPromise.fromPromise({
      id: harness.id,
      setup: (ctx: unknown) => harness.setup(ctx, { rootDir: HARNESS_ROOT }),
    })
      .effect(yield* PluginHost.make(plugins))
      .pipe(Effect.provideService(Scope.Scope, scope))
    expect(countHarness((yield* tools.snapshot()).definitions)).toBe(14)
    expect(yield* hooks.has("tool", "execute.before")).toBe(true)
    yield* Scope.close(scope, Exit.void)
    expect(countHarness((yield* tools.snapshot()).definitions)).toBe(0)
    expect(yield* hooks.has("tool", "execute.before")).toBe(false)
    expect(yield* hooks.has("session", "context")).toBe(false)
    // reload in a fresh scope restores everything exactly once
    const scope2 = yield* Scope.make()
    yield* PluginPromise.fromPromise({
      id: harness.id,
      setup: (ctx: unknown) => harness.setup(ctx, { rootDir: HARNESS_ROOT }),
    })
      .effect(yield* PluginHost.make(plugins))
      .pipe(Effect.provideService(Scope.Scope, scope2))
    expect(countHarness((yield* tools.snapshot()).definitions)).toBe(14)
    yield* Scope.close(scope2, Exit.void)
    expect(countHarness((yield* tools.snapshot()).definitions)).toBe(0)
  }),
)

it.live("opencode-harness post-edit receipt matches post-write disk bytes (OH-4.2 ordering)", () =>
  Effect.gen(function* () {
    const plugins = yield* Plugin.Service
    const tools = yield* Tool.Service
    yield* PluginPromise.fromPromise({
      id: harness.id,
      setup: (ctx: unknown) => harness.setup(ctx, { rootDir: HARNESS_ROOT }),
    }).effect(yield* PluginHost.make(plugins))

    // Formatting-sensitive edit through the real host pipeline: unformatted
    // TS becomes formatted TS, and the `<post-edit-anchors>` receipt appended
    // by `execute.after` must equal the bytes read from disk AFTER the write
    // completes — the same ordering the built-in `edit` path relies on after
    // upstream `Formatter.file` runs (the built-in leg runs live below in
    // the OH-4.2 built-in-leg test with the real upstream Formatter.file;
    // this test pins the harness-tool leg of the same ordering invariant).
    const probeName = `oh42-format-probe-${Date.now().toString(36)}.ts`
    const probeRel = probeName
    const probeAbs = join(HARNESS_ROOT, probeName)
    const unformatted = [
      "export function  renderCard( title:string  )  {",
      "return  title;",
      "}",
    ].join("\n")
    const formatted = [
      "export function renderCard(title: string) {",
      "  return title;",
      "}",
    ].join("\n")
    writeFileSync(probeAbs, `${unformatted}\n`, "utf8")
    try {
      const snapshot = yield* tools.snapshot()
      const r = yield* call(snapshot, "file_hash_edit", {
        path: probeRel,
        hunks: unformatted.split("\n").map((line, i) => ({
          startLine: i + 1,
          startHash: computeLineHash(unformatted.split("\n")[i] as string),
          endLine: i + 1,
          endHash: computeLineHash(unformatted.split("\n")[i] as string),
          replacement: formatted.split("\n")[i] ?? "",
        })),
      })
      expect(Exit.isSuccess(r)).toBe(true)
      const body = textOf(r)
      expect(body).toContain("<post-edit-anchors")
      const onDisk = readFileSync(probeAbs, "utf8")
      expect(onDisk).toContain(formatted)
      for (const line of formatted.split("\n")) {
        expect(body).toContain(`${computeLineHash(line)}| ${line}`)
      }
    } finally {
      rmSync(probeAbs, { force: true })
    }
  }),
)

// Test layer for the OH-4.2 built-in leg: the shared PluginTestLayer plus
// the REAL upstream Formatter node (AppNodeBuilder wires location-scoped
// nodes; a bare LayerNode.compile cannot bind @opencode/Location). All other
// nodes and replacements mirror the upstream fixture exactly so harness
// wiring behaves identically to the main suite.
const oh42NpmLayer = Layer.succeed(
  Npm.Service,
  Npm.Service.of({
    add: (name) => Effect.succeed({ directory: "", name }),
    resolve: (name) => Effect.succeed({ directory: "", name }),
    check: () => Effect.succeed(false),
    update: (name) => Effect.succeed({ directory: "", name }),
    which: () => Effect.undefined,
  }),
)

const oh42GenerateLayer = Layer.succeed(Generate.Service, Generate.Service.of({ text: () => Effect.succeed("") }))

const oh42ConfigLayer = Config.testLayer()

const oh42PermissionLayer = Layer.succeed(
  Permission.Service,
  Permission.Service.of({
    close: Effect.void,
    ask: (input) => Effect.succeed({ id: input.id ?? Permission.ID.create(), effect: "ask" }),
    assert: () => Effect.void,
    reply: () => Effect.void,
    get: () => Effect.succeed(undefined),
    forSession: () => Effect.succeed([]),
    list: () => Effect.succeed([]),
  }),
)

const Oh42FormatterLayer = AppNodeBuilder.build(
  LayerNode.group([
    AppProcess.node,
    FileSystem.node,
    FSUtil.node,
    Location.node,
    Npm.node,
    Credential.node,
    Config.node,
    Database.node,
    FileAccess.node,
    Bus.node,
    Form.node,
    Generate.node,
    LayerNodePlatform.httpClient,
    Plugin.node,
    Agent.node,
    AISDK.node,
    Provider.node,
    Model.node,
    Command.node,
    Integration.node,
    KV.node,
    ManagedPolicy.node,
    Mcp.node,
    CoreSession.node,
    PersistentPty.node,
    LocationServiceMap.node,
    Permission.node,
    PluginHooks.node,
    Reference.node,
    Rpc.node,
    Skill.node,
    SkillDiscovery.node,
    Tool.node,
    Vcs.node,
    Watcher.node,
    WebSearch.node,
    Worktree.node,
    WorktreeStrategies.node,
    Formatter.node,
  ]),
  [
    Location.node.replace(tempLocationLayer),
    Npm.node.replace(oh42NpmLayer),
    Config.node.replace(oh42ConfigLayer),
    Mcp.node.replace(emptyMcpLayer),
    Generate.node.replace(oh42GenerateLayer),
    Permission.node.replace(oh42PermissionLayer),
  ],
).pipe(Layer.provideMerge(oh42ConfigLayer))

const itBuiltin = testEffect(Oh42FormatterLayer)

itBuiltin.live("opencode-harness built-in edit receipt matches post-Formatter.file disk bytes (OH-4.2 built-in leg)", () =>
  Effect.gen(function* () {
    const plugins = yield* Plugin.Service
    const tools = yield* Tool.Service
    yield* PluginPromise.fromPromise({
      id: harness.id,
      setup: (ctx: unknown) => harness.setup(ctx, { rootDir: HARNESS_ROOT }),
    }).effect(yield* PluginHost.make(plugins))

    const probeName = `oh42-builtin-probe-${Date.now().toString(36)}.ts`
    const probeAbs = join(HARNESS_ROOT, probeName)
    const oldString = "return  title;"
    const newString = "return  title.trim();"
    const expectedFormatted = [
      "export function renderCard(title: string) {",
      "  return title.trim();",
      "}",
    ]
    writeFileSync(
      probeAbs,
      `${["export function  renderCard( title:string  )  {", oldString, "}"].join("\n")}\n`,
      "utf8",
    )

    // Formatter runtime: the same `bun` running this test (fail-closed when
    // unresolvable — `process.execPath` may point at an npm shim name that
    // cannot spawn, so it is never used here).
    const bunBin = Bun.which("bun")
    if (!bunBin) throw new Error("OH-4.2 probe formatter requires `bun` on PATH (fail-closed)")

    // Deterministic external formatter process: real bytes rewritten on disk
    // through the REAL upstream Formatter.file code path (child-process spawn
    // with $FILE replacement), never an in-test copy.
    const fmtScript = join(tmpdir(), `harness-probe-fmt-${Date.now().toString(36)}.mjs`)
    writeFileSync(
      fmtScript,
      [
        `import { readFileSync, writeFileSync } from "node:fs"`,
        `const target = process.argv[process.argv.length - 1]`,
        `const raw = readFileSync(target, "utf8")`,
        `const out = []`,
        `let depth = 0`,
        `for (const line of raw.split("\\n")) {`,
        `  const trimmed = line.trim().replace(/[ \\t]+/g, " ").replace(/\\(\\s+/g, "(").replace(/\\s+\\)/g, ")").replace(/:(?=\\S)/g, ": ").replace(/,(?=\\S)/g, ", ").replace(/\\)\\s*\\{/g, ") {")`,
        `  if (trimmed === "") continue`,
        `  if (/^\\}/.test(trimmed)) depth = Math.max(0, depth - 1)`,
        `  out.push("  ".repeat(depth) + trimmed)`,
        `  if (/\\{$/.test(trimmed)) depth += 1`,
        `}`,
        `writeFileSync(target, out.join("\\n") + "\\n")`,
        ``,
      ].join("\n"),
      "utf8",
    )
    try {
      const formatter = yield* Formatter.Service
      yield* formatter.transform((editor) => {
        editor.set({
          name: "harness-probe-tsfmt",
          extensions: [".ts"],
          enabled: Effect.succeed([bunBin, fmtScript, "$FILE"]),
        })
      })

      // Built-in `edit` stand-in as a core Effect executor (direct
      // `tools.transform` registration, like upstream's own tool tests):
      // exact oldString→newString disk write, then the REAL upstream
      // Formatter.file, then a disk re-read — mirroring EditTool's
      // write → formatter.file → syncTextBom order.
      yield* tools.transform((editor) =>
        editor.add({
          name: "edit",
          description: "Built-in edit stand-in for the OH-4.2 post-format receipt probe",
          input: {
            type: "object",
            properties: {
              path: { type: "string" },
              oldString: { type: "string" },
              newString: { type: "string" },
            },
            required: ["path", "oldString", "newString"],
            additionalProperties: false,
          },
          options: { codemode: false, permission: "edit" },
          execute: (input: unknown) =>
            Effect.gen(function* () {
              const args = input as { path: string; oldString: string; newString: string }
              const target = join(HARNESS_ROOT, String(args.path))
              const prev = readFileSync(target, "utf8")
              if (!prev.includes(String(args.oldString))) {
                return yield* new Tool.Error({
                  message: `oldString not found in ${String(args.path)}`,
                })
              }
              writeFileSync(
                target,
                prev.replace(String(args.oldString), String(args.newString)),
                "utf8",
              )
              const didFormat: boolean = yield* formatter.file(target)
              if (!didFormat) {
                return yield* new Tool.Error({
                  message: `probe formatter did not run for ${String(args.path)}`,
                })
              }
              return {
                content: [{ type: "text" as const, text: `Edited ${String(args.path)}` }],
              }
            }),
        }),
      )

      const snapshot = yield* tools.snapshot()
      const r = yield* call(snapshot, "edit", { path: probeName, oldString, newString })
      expect(Exit.isSuccess(r)).toBe(true)
      const body = textOf(r)
      expect(body).toContain("<post-edit-anchors")
      const onDisk = readFileSync(probeAbs, "utf8")
      expect(onDisk).toBe(`${expectedFormatted.join("\n")}\n`)
      for (const line of expectedFormatted) {
        expect(body).toContain(`${computeLineHash(line)}| ${line}`)
      }
      for (const stale of [
        "export function  renderCard( title:string  )  {",
        "return  title;",
        "return  title.trim();",
      ]) {
        expect(body).not.toContain(`${computeLineHash(stale)}| ${stale}`)
      }
    } finally {
      rmSync(probeAbs, { force: true })
      rmSync(fmtScript, { force: true })
    }
  }),
)
