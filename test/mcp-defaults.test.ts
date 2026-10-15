import { describe, expect, test } from "bun:test";
import { getRecommendedMcpConfig } from "../src/ui-auditor/mcp-defaults";

describe("getRecommendedMcpConfig", () => {
  test("returns exactly the lsp-mcp-server and fallow-mcp blocks", () => {
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

  test("returns a fresh object on every call", () => {
    const first = getRecommendedMcpConfig();
    const second = getRecommendedMcpConfig();
    expect(first).toEqual(second);
    expect(first).not.toBe(second);
    expect(first.mcpServers).not.toBe(second.mcpServers);
  });
});
