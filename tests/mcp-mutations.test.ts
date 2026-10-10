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

it.each(['read_notes', 'get_backlinks', 'update_note_section'])("%s exposes validated schemas and enforces required scopes", async (name) => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  const client = new GitHubObsidianClient({ token: 'test', owner: 'owner', repo: 'repo', branch: 'main' });
  const method = name === 'read_notes' ? 'readNotes' : name === 'get_backlinks' ? 'getBacklinks' : 'updateNoteSection';
  const call = vi.spyOn(client, method).mockResolvedValue({ ok: true });
  createObsidianMcpServer({ client, resourceMetadataUrl: 'https://example.com/metadata' });
  const [, config, handler] = registerTool.mock.calls.find(([toolName]) => toolName === name)!;
  const writing = name === 'update_note_section';
  const scopes = writing ? ['obsidian.read', 'obsidian.write'] : ['obsidian.read'];
  const args = name === 'read_notes' ? { notes: [{ vault: 'main', path: 'note.md' }] } : {
    vault: 'main', path: 'note.md', ...(writing ? { heading: 'Decisions', content: 'new', expectedSha: 'current' } : {}),
  };
  expect(config.inputSchema.safeParse(args).success).toBe(true);
  expect(config._meta.securitySchemes[0].scopes).toEqual(scopes);
  expect(config.annotations.readOnlyHint).toBe(!writing);
  expect((await handler(args, { http: { authInfo: { scopes: [] } } })).structuredContent.error).toBe('INSUFFICIENT_SCOPE');
  if (writing) {
    for (const scope of ['obsidian.read', 'obsidian.write']) {
      expect((await handler(args, { http: { authInfo: { scopes: [scope] } } })).structuredContent.error).toBe('INSUFFICIENT_SCOPE');
    }
    expect(config.inputSchema.safeParse({ ...args, expectedSha: undefined }).success).toBe(false);
  }
  expect(call).not.toHaveBeenCalled();
  expect((await handler(args, { http: { authInfo: { scopes } } })).structuredContent.ok).toBe(true);
  expect(call).toHaveBeenCalledExactlyOnceWith(args);
});

it('search schema accepts filters and rejects unbounded limits and invalid timestamps', () => {
  const client = new GitHubObsidianClient({ token: 'test', owner: 'owner', repo: 'repo', branch: 'main' });
  createObsidianMcpServer({ client, resourceMetadataUrl: 'https://example.com/metadata' });
  const [, config] = registerTool.mock.calls.find(([name]) => name === 'search_notes')!;
  expect(config.inputSchema.safeParse({ query: '会議', folder: 'Projects', tags: ['仕事'], updatedAfter: '2026-10-01T00:00:00+09:00', scanOffset: 80 }).success).toBe(true);
  for (const invalid of [{ limit: 51 }, { updatedAfter: 'yesterday' }, { scanOffset: -1 }, { tags: [''] }]) {
    expect(config.inputSchema.safeParse({ query: 'x', ...invalid }).success).toBe(false);
  }
});
