import { describe, expect, it, vi, afterEach } from "vitest";
import { GitHubObsidianClient } from "../mcp-worker/src/github/client.ts";

const config = {
  token: "test-token",
  owner: "namiyama814",
  repo: "obsidian",
  branch: "main",
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("GitHubObsidianClient", () => {
  it("lists vaults and skips .obsidian", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        expect(url).toContain("/contents/");
        return jsonResponse([
          { type: "dir", name: "main", path: "main", sha: "1" },
          { type: "dir", name: "anzdrop", path: "anzdrop", sha: "2" },
          { type: "dir", name: ".obsidian", path: ".obsidian", sha: "3" },
          { type: "file", name: "README.md", path: "README.md", sha: "4", size: 1 },
        ]);
      }),
    );

    const client = new GitHubObsidianClient(config);
    const result = await client.listVaults();
    expect(result).toEqual({ ok: true, vaults: ["anzdrop", "main"] });
  });

  it("create_note refuses overwrite", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.endsWith("/contents/main") || url.includes("/contents/main?")) {
          return jsonResponse({ type: "dir", name: "main", path: "main", sha: "v" });
        }
        if (url.includes("/contents/main/exists.md")) {
          return jsonResponse({
            type: "file",
            name: "exists.md",
            path: "main/exists.md",
            sha: "abc",
            size: 3,
            content: btoa("hi"),
            encoding: "base64",
            download_url: null,
          });
        }
        return jsonResponse({ message: "not found" }, 404);
      }),
    );

    const client = new GitHubObsidianClient(config);
    const result = await client.createNote({
      vault: "main",
      path: "exists.md",
      content: "x",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe("ALREADY_EXISTS");
      expect(result.currentSha).toBe("abc");
    }
  });

  it("update_note returns CONFLICT on expectedSha mismatch", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes("/contents/main?") || url.endsWith("/contents/main")) {
          return jsonResponse({ type: "dir", name: "main", path: "main", sha: "v" });
        }
        return jsonResponse({
          type: "file",
          name: "note.md",
          path: "main/note.md",
          sha: "current-sha",
          size: 4,
          content: btoa("body"),
          encoding: "base64",
          download_url: null,
        });
      }),
    );

    const client = new GitHubObsidianClient(config);
    const result = await client.updateNote({
      vault: "main",
      path: "note.md",
      content: "new",
      expectedSha: "stale-sha",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe("CONFLICT");
      expect(result.currentSha).toBe("current-sha");
    }
  });

  it("list_notes accepts a vault directory (GitHub returns an array)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes("/branches/")) {
          return jsonResponse({ commit: { sha: "tree-sha" } });
        }
        if (url.includes("/git/trees/")) {
          return jsonResponse({
            sha: "tree-sha",
            truncated: false,
            tree: [
              {
                path: "main/hello.md",
                type: "blob",
                sha: "n1",
                size: 5,
              },
            ],
          });
        }
        // Directory lookup returns an array, not { type: "dir" }.
        if (url.includes("/contents/main?")) {
          return jsonResponse([
            {
              type: "file",
              name: "hello.md",
              path: "main/hello.md",
              sha: "n1",
              size: 5,
            },
          ]);
        }
        return jsonResponse({ message: "not found" }, 404);
      }),
    );

    const client = new GitHubObsidianClient(config);
    const result = await client.listNotes({ vault: "main" });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.vault).toBe("main");
      expect(result.notes).toEqual([
        { path: "hello.md", sha: "n1", size: 5 },
      ]);
    }
  });

  it("rejects path traversal before calling GitHub", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const client = new GitHubObsidianClient(config);
    const result = await client.readNote({
      vault: "main",
      path: "../secret.md",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe("PATH_TRAVERSAL");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
