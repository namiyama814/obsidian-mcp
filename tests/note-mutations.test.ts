import { afterEach, describe, expect, it, vi } from "vitest";
import { GitHubObsidianClient } from "../mcp-worker/src/github/client.ts";

const config = { token: "test", owner: "owner", repo: "repo", branch: "feature/notes" };
const client = () => new GitHubObsidianClient(config);
const response = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status });
const source = { path: "main/old.md", type: "blob", mode: "100644", sha: "blob" };
const move = { vault: "main", path: "old.md", destinationPath: "folder/新規.md", expectedSha: "blob" };
function mockMove(extra: object[] = [], options: { truncated?: boolean; publishStatus?: number } = {}) {
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    if (url.includes("/git/ref/heads/feature/notes")) return response({ object: { sha: "head" } });
    if (url.endsWith("/git/commits/head")) return response({ tree: { sha: "base" } });
    if (url.includes("/git/trees/base?")) return response({ truncated: options.truncated ?? false, tree: [
      { path: "main", type: "tree" }, { path: "other", type: "tree" }, source, ...extra,
    ] });
    if (init?.method === "POST" && url.endsWith("/git/trees")) return response({ sha: "new-tree" });
    if (init?.method === "POST" && url.endsWith("/git/commits")) return response({ sha: "new-commit" });
    if (init?.method === "PATCH") return response({}, options.publishStatus ?? 200);
    throw new Error(`Unexpected request: ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe("note moves", () => {
  it.each([undefined, "other"])("moves atomically to vault %s and preserves blob bytes", async (destinationVault) => {
    const fetchMock = mockMove();
    const result = await client().moveNote({ ...move, destinationVault, commitMessage: "Move note" });
    expect(result).toMatchObject({ ok: true, destinationVault: destinationVault ?? "main", sha: "blob", commitSha: "new-commit" });
    const writes = fetchMock.mock.calls.filter(([, init]) => init?.method);
    expect(writes.map(([, init]) => init?.method)).toEqual(["POST", "POST", "PATCH"]);
    expect(JSON.parse(String(writes[0]?.[1]?.body))).toEqual({ base_tree: "base", tree: [
      { path: "main/old.md", type: "blob", mode: "100644", sha: null },
      { path: `${destinationVault ?? "main"}/folder/新規.md`, type: "blob", mode: "100644", sha: "blob" },
    ] });
    expect(JSON.parse(String(writes[1]?.[1]?.body))).toEqual({ message: "Move note", tree: "new-tree", parents: ["head"] });
    expect(JSON.parse(String(writes[2]?.[1]?.body))).toEqual({ sha: "new-commit", force: false });
  });
  it.each(["blob", "tree"])("refuses existing destination %s", async (type) => {
    const fetchMock = mockMove([{ path: "main/folder/新規.md", type }]);
    expect(await client().moveNote(move)).toMatchObject({ ok: false, error: "ALREADY_EXISTS" });
    expect(fetchMock.mock.calls.every(([, init]) => !init?.method)).toBe(true);
  });
  it("rejects stale SHA, missing source/vault, invalid parent and incomplete tree without writes", async () => {
    for (const [input, extra, options, error] of [
      [{ ...move, expectedSha: "stale" }, [], {}, "CONFLICT"],
      [{ ...move, path: "missing.md" }, [], {}, "NOT_FOUND"],
      [{ ...move, destinationVault: "missing" }, [], {}, "INVALID_VAULT"],
      [move, [{ path: "main/folder", type: "blob" }], {}, "NOT_A_DIRECTORY"],
      [move, [], { truncated: true }, "TREE_TRUNCATED"],
    ] as const) {
      const fetchMock = mockMove([...extra], options);
      expect(await client().moveNote(input)).toMatchObject({ ok: false, error });
      expect(fetchMock.mock.calls.every(([, init]) => !init?.method)).toBe(true);
    }
  });
  it.each([409, 422])("returns CONFLICT if publishing fails with %s", async (publishStatus) => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    mockMove([], { publishStatus });
    expect(await client().moveNote(move)).toMatchObject({ ok: false, error: "CONFLICT" });
  });
  it("rejects identical paths and unsafe inputs before network access", async () => {
    const fetchMock = vi.fn(); vi.stubGlobal("fetch", fetchMock);
    for (const input of [
      { ...move, destinationPath: "old.md" },
      { ...move, destinationPath: "../note.md" },
      { ...move, destinationPath: "note.txt" },
      { ...move, destinationVault: ".git" },
    ]) expect((await client().moveNote(input)).ok).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("note deletion", () => {
  function mockDelete(status = 200, exists = true) {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.includes("/contents/main?")) return response([]);
      if (init?.method === "DELETE") return response({ commit: { sha: "deleted-commit" } }, status);
      return response(exists ? { type: "file", sha: "blob" } : {}, exists ? 200 : 404);
    });
    vi.stubGlobal("fetch", fetchMock); return fetchMock;
  }
  it("deletes using current SHA and configured branch", async () => {
    const fetchMock = mockDelete();
    expect(await client().deleteNote({ vault: "main", path: "old.md", expectedSha: "blob" })).toMatchObject({ ok: true, deleted: true, commitSha: "deleted-commit" });
    const call = fetchMock.mock.calls.find(([, init]) => init?.method === "DELETE");
    expect(JSON.parse(String(call?.[1]?.body))).toEqual({ sha: "blob", branch: "feature/notes", message: "MCP: delete main/old.md" });
  });
  it("refuses stale reads and missing notes without deletion", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    for (const exists of [true, false]) {
      const fetchMock = mockDelete(200, exists);
      expect(await client().deleteNote({ vault: "main", path: "old.md", expectedSha: "stale" })).toMatchObject({ ok: false, error: exists ? "CONFLICT" : "NOT_FOUND" });
      expect(fetchMock.mock.calls.every(([, init]) => !init?.method)).toBe(true);
    }
  });
  it("reports a concurrent delete/edit conflict", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {}); mockDelete(409);
    expect(await client().deleteNote({ vault: "main", path: "old.md" })).toMatchObject({ ok: false, error: "CONFLICT" });
  });
  it("rejects traversal and non-Markdown before fetching", async () => {
    const fetchMock = vi.fn(); vi.stubGlobal("fetch", fetchMock);
    for (const path of ["../note.md", "note.txt"]) expect((await client().deleteNote({ vault: "main", path })).ok).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
