/**
 * Live OpenCode V2 host test. Copied into `packages/core/test/plugin/` of an
 * `anomalyco/opencode` checkout by `scripts/host-test/run.sh` and run with the
 * upstream `PluginTestLayer` fixture, so the harness is loaded through the
 * real promise-plugin adapter and tool registry (not a mock).
 */
import { expect } from "bun:test"
import { Agent } from "@opencode/core/agent"
import { Plugin } from "@opencode/core/plugin"
import { PluginHost } from "@opencode/core/plugin/host"
import { PluginPromise } from "@opencode/core/plugin/promise"
import { Tool } from "@opencode/core/tool"
import { Session } from "@opencode/schema/session"
import { SessionMessage } from "@opencode/schema/session-message"
import { Effect, Exit } from "effect"
import { testEffect } from "../lib/effect"
import { PluginTestLayer } from "./fixture"

const HARNESS_ROOT = process.env.HARNESS_ROOT
if (!HARNESS_ROOT) throw new Error("HARNESS_ROOT must point at the opencode-harness checkout")
const harness = (await import(`${HARNESS_ROOT}/src/index.ts`)).default

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

const it = testEffect(PluginTestLayer)

it.live("opencode-harness registers every tool in the real OpenCode V2 host and unloads cleanly", () =>
  Effect.gen(function* () {
    const plugins = yield* Plugin.Service
    const tools = yield* Tool.Service
    yield* PluginPromise.fromPromise({
      id: harness.id,
      setup: (ctx: unknown) => harness.setup(ctx, { rootDir: HARNESS_ROOT }),
    }).effect(yield* PluginHost.make(plugins))

    const snapshot = yield* tools.snapshot()
    const names = snapshot.definitions.map((d: { name?: string; id?: string }) => d.name ?? d.id)
    for (const name of EXPECTED_TOOLS) expect(names).toContain(name)

    const result = yield* snapshot
      .execute({
        sessionID: Session.ID.make("ses_harness_host"),
        agent: Agent.ID.make("build"),
        messageID: SessionMessage.ID.make("msg_harness_host"),
        call: { type: "tool-call", id: "call_harness_host", name: "file_hash_read", input: { path: "package.json", limit: 2 } },
      })
      .pipe(Effect.exit)
    expect(Exit.isSuccess(result)).toBe(true)
    expect(JSON.stringify(Exit.isSuccess(result) ? result.value : null)).toContain("@heretek-ai/opencode-harness")
  }),
)
