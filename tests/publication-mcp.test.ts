import { afterEach, expect, it, vi } from "vitest";
import { createObsidianMcpServer } from "../mcp-worker/src/mcp-server.ts";
import { GitHubObsidianClient } from "../mcp-worker/src/github/client.ts";
import { PublicationService } from "../mcp-worker/src/publication/service.ts";
const { registerTool } = vi.hoisted(() => ({ registerTool: vi.fn() }));
vi.mock("@modelcontextprotocol/server", () => ({
  McpServer: class {
    registerTool = registerTool;
  },
}));
afterEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
});
it.each([
  "prepare_publication",
  "publish_note",
  "get_publication_status",
  "unpublish_note",
  "trigger_publication_sync",
])("%s checks scopes and never logs confirmation tokens", async (name) => {
  const config = {
    owner: "dummy",
    repo: "private",
    branch: "main",
    token: "secret",
  };
  const publication = new PublicationService({ source: config });
  const method =
    name === "prepare_publication"
      ? "prepare"
      : name === "publish_note"
        ? "publish"
        : name === "get_publication_status"
          ? "status"
          : name === "unpublish_note"
            ? "unpublish"
            : "trigger";
  const call = vi.spyOn(publication, method).mockResolvedValue({ ok: true });
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  createObsidianMcpServer({
    client: new GitHubObsidianClient(config),
    publication,
    resourceMetadataUrl: "https://dummy/metadata",
  });
  const [, schema, handler] = registerTool.mock.calls.find(
    (c) => c[0] === name,
  )!;
  const read = ["prepare_publication", "get_publication_status"].includes(name);
  expect(schema.annotations.readOnlyHint).toBe(read);
  const args = {
    vault: "main",
    path: "Dummy.md",
    planToken: "secret-plan-token",
    confirm: true,
    content: "private-body",
  };
  expect(
    (
      await handler(args, {
        http: { authInfo: { scopes: read ? [] : ["obsidian.read"] } },
      })
    ).structuredContent.error,
  ).toBe("INSUFFICIENT_SCOPE");
  expect(call).not.toHaveBeenCalled();
  await handler(args, {
    http: { authInfo: { scopes: ["obsidian.read", "obsidian.write"] } },
  });
  expect(call).toHaveBeenCalledOnce();
  expect(JSON.stringify(log.mock.calls)).not.toContain("secret-plan-token");
  expect(JSON.stringify(log.mock.calls)).not.toContain("private-body");
});
it("exposes object schemas and validates the two mutually exclusive stop phases", () => {
  createObsidianMcpServer({
    client: new GitHubObsidianClient({
      owner: "dummy",
      repo: "private",
      branch: "main",
      token: "secret",
    }),
    resourceMetadataUrl: "https://dummy/metadata",
  });
  const [, config] = registerTool.mock.calls.find(
    (c) => c[0] === "unpublish_note",
  )!;
  expect(
    config.inputSchema.safeParse({
      vault: "main",
      path: "社内共有/A.md",
      destinationPath: "Archive/A.md",
      expectedSha: "sha",
    }).success,
  ).toBe(true);
  expect(
    config.inputSchema.safeParse({ planToken: "token", confirm: true }).success,
  ).toBe(true);
  for (const args of [
    {},
    { planToken: "token" },
    { planToken: "token", confirm: true, path: "different.md" },
  ])
    expect(config.inputSchema.safeParse(args).success).toBe(false);
});
