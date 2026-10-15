/**
 * `src/ui-auditor/mcp-defaults.ts` — Recommended MCP server defaults.
 *
 * Wave 2 helper per Report `01a` (re-exported from `src/index.ts` in Wave 3):
 * generates the recommended `mcpServers` block pairing `lsp-mcp-server`
 * (launched via `bunx`) with `fallow-mcp` (launched via
 * `npx --yes --package fallow`). No other servers are included; dashboard,
 * daemon, scheduler, VCS-automation, and literature-review features are out
 * of scope for this single-session plugin (see `AGENTS.md`) and receive no
 * block here.
 */

export interface McpServerEntry {
  command: string;
  args: string[];
  env?: Record<string, string>;
}

export interface RecommendedMcpConfig {
  mcpServers: {
    "lsp-mcp-server": McpServerEntry;
    "fallow-mcp": McpServerEntry;
  };
}

/**
 * Build a fresh recommended MCP config object on every call (callers may
 * freely mutate the result without affecting later calls).
 */
export function getRecommendedMcpConfig(): RecommendedMcpConfig {
  return {
    mcpServers: {
      "lsp-mcp-server": {
        command: "bunx",
        args: ["lsp-mcp-server"],
      },
      "fallow-mcp": {
        command: "npx",
        args: ["--yes", "--package", "fallow", "fallow-mcp"],
      },
    },
  };
}
