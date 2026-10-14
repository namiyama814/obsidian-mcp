import { afterEach, expect, it, vi } from "vitest";
import { GitHubObsidianClient } from "../mcp-worker/src/github/client.ts";
import { PublicationRepository } from "../mcp-worker/src/publication/repository.ts";
const config = {
  owner: "dummy",
  repo: "private",
  branch: "main",
  token: "credential-never-forward",
};
const id = "ABcdEFghIJkl";
function fixture() {
  const calls: { method: string; url: string }[] = [];
  vi.stubGlobal(
    "fetch",
    async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input),
        method = init?.method ?? "GET";
      calls.push({ method, url });
      if (method === "PUT")
        return Response.json({
          content: { sha: "next" },
          commit: { sha: "commit" },
        });
      if (url.includes("/contents/main?")) return Response.json([]);
      return Response.json({
        type: "file",
        sha: "current",
        size: 100,
        content: Buffer.from(`---\ndoc_id: ${id}\n---\nbody`).toString(
          "base64",
        ),
        encoding: "base64",
        download_url: null,
      });
    },
  );
  return { client: new GitHubObsidianClient(config), calls };
}
afterEach(() => vi.unstubAllGlobals());
it("routes generic shared create, move and delete through publication tools without mutation", async () => {
  const { client, calls } = fixture();
  expect(
    await client.createNote({
      vault: "main",
      path: "社内共有/A.md",
      content: "body",
    }),
  ).toMatchObject({ ok: false, error: "PUBLICATION_REQUIRED" });
  expect(
    await client.deleteNote({ vault: "main", path: "社内共有/A.md" }),
  ).toMatchObject({ ok: false, error: "PUBLICATION_REQUIRED" });
  expect(
    await client.moveNote({
      vault: "main",
      path: "A.md",
      destinationPath: "社内共有/A.md",
    }),
  ).toMatchObject({ ok: false, error: "PUBLICATION_REQUIRED" });
  expect(
    await client.moveNote({
      vault: "main",
      path: "社内共有/A.md",
      destinationPath: "Archive/A.md",
    }),
  ).toMatchObject({ ok: false, error: "PUBLICATION_REQUIRED" });
  expect(calls.every((c) => c.method === "GET")).toBe(true);
});
it("rejects doc_id replacement/removal in updates but allows body updates preserving ID", async () => {
  const { client, calls } = fixture();
  for (const content of ["body", "---\ndoc_id: BCdeFGhiJKlm\n---\nbody"])
    expect(
      await client.updateNote({
        vault: "main",
        path: "社内共有/A.md",
        content,
        expectedSha: "current",
      }),
    ).toMatchObject({ ok: false, error: "ID_IMMUTABLE" });
  expect(calls.every((c) => c.method === "GET")).toBe(true);
  expect(
    await client.updateNote({
      vault: "main",
      path: "社内共有/A.md",
      content: `---\ndoc_id: ${id}\n---\nupdated`,
      expectedSha: "current",
    }),
  ).toMatchObject({ ok: true });
});
it("does not forward GitHub credentials when downloading redirected workflow logs", async () => {
  const requests: { url: string; headers: Headers }[] = [];
  vi.stubGlobal(
    "fetch",
    async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      requests.push({ url, headers: new Headers(init?.headers) });
      return url.startsWith("https://api.github.com/")
        ? new Response(null, {
            status: 302,
            headers: {
              Location: "https://test.blob.core.windows.net/log?sig=dummy",
            },
          })
        : new Response("only dummy log");
    },
  );
  expect(await new PublicationRepository(config).jobLog(1)).toBe(
    "only dummy log",
  );
  expect(requests[0]!.headers.get("Authorization")).toBe(
    `Bearer ${config.token}`,
  );
  expect(requests[1]!.headers.get("Authorization")).toBeNull();
});
it("rejects untrusted log redirects without leaking credentials to them", async () => {
  const fetch = vi.fn().mockResolvedValue(
    new Response(null, {
      status: 302,
      headers: { Location: "https://attacker.example/log" },
    }),
  );
  vi.stubGlobal("fetch", fetch);
  await expect(new PublicationRepository(config).jobLog(1)).rejects.toThrow(
    "取得先",
  );
  expect(fetch).toHaveBeenCalledOnce();
});
