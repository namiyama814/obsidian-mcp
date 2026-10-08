import { afterEach, expect, it, vi } from "vitest";
import { GitHubObsidianClient } from "../mcp-worker/src/github/client.ts";
import { createObsidianMcpServer } from "../mcp-worker/src/mcp-server.ts";

const { registerTool } = vi.hoisted(() => ({ registerTool: vi.fn() }));
vi.mock("@modelcontextprotocol/server", () => ({
  McpServer: class { registerTool = registerTool; },
}));
afterEach(() => { vi.clearAllMocks(); vi.restoreAllMocks(); });

it.each(["move_note", "delete_note"])("%s requires read and write scopes and exposes destructive metadata", async (name) => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  const client = new GitHubObsidianClient({ token: "test", owner: "owner", repo: "repo", branch: "main" });
  const mutation = vi.spyOn(client, name === "move_note" ? "moveNote" : "deleteNote").mockResolvedValue({ ok: true });
  createObsidianMcpServer({ client, resourceMetadataUrl: "https://example.com/metadata" });
  const tool = registerTool.mock.calls.find(([toolName]) => toolName === name);
  expect(tool).toBeDefined();
  const [, config, handler] = tool!;
  expect(config.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: true });
  expect(config._meta.securitySchemes[0].scopes).toEqual(["obsidian.read", "obsidian.write"]);
  const args = { vault: "main", path: "note.md", ...(name === "move_note" ? { destinationPath: "moved.md" } : {}) };
  expect(config.inputSchema.safeParse(args).success).toBe(true);
  for (const scopes of [[], ["obsidian.read"], ["obsidian.write"]]) {
    const result = await handler(args, { http: { authInfo: { scopes } } });
    expect(result.structuredContent.error).toBe("INSUFFICIENT_SCOPE");
  }
  expect(mutation).not.toHaveBeenCalled();
  const result = await handler(args, { http: { authInfo: { scopes: ["obsidian.read", "obsidian.write"] } } });
  expect(result.structuredContent).toEqual({ ok: true });
  expect(mutation).toHaveBeenCalledExactlyOnceWith(args);
});
