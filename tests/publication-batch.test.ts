import { afterEach, expect, it, vi } from "vitest";
import { PublicationRepository } from "../mcp-worker/src/publication/repository.ts";
import { FakeGitHub } from "./publication-fixture.ts";
import { loadNotes } from "../mcp-worker/src/publication/content.ts";
const config = {
  owner: "dummy",
  repo: "private",
  branch: "main",
  token: "secret-token",
};
function fixture() {
  const files = Object.fromEntries(
    Array.from({ length: 25 }, (_, i) => [
      `main/Notes/${i}.md`,
      `# 架空ノート ${i}\r\nUnicode 📝\r\n`,
    ]),
  );
  const fake = new FakeGitHub(files);
  fake.install();
  return { fake, repo: new PublicationRepository(config) };
}
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
it("batches by immutable SHA, verifies exact UTF-8 bytes and reuses only request-local cache", async () => {
  const { fake, repo } = fixture();
  const snapshot = await repo.snapshot();
  expect((await loadNotes(repo, snapshot, "main", false)).length).toBe(25);
  const count = fake.calls.length;
  expect(fake.calls.filter((c) => c.route === "/graphql").length).toBe(2);
  expect(
    fake.calls.filter((c) => c.route.startsWith("/git/blobs/")).length,
  ).toBe(0);
  expect(
    (await loadNotes(repo, snapshot, "main", false))[0]!.content,
  ).toContain("📝\r\n");
  expect(fake.calls.length).toBe(count);
  await loadNotes(new PublicationRepository(config), snapshot, "main", false);
  expect(fake.calls.length).toBe(count + 2);
});
it.each([
  "truncated",
  "binary",
  "missing",
  "wrong_sha",
  "wrong_bytes",
  "changed_text",
  "partial_error",
])(
  "fails closed on %s batch data without caching partial success",
  async (kind) => {
    const { fake, repo } = fixture();
    const snapshot = await repo.snapshot();
    const paths = [...snapshot.entries.keys()].filter((p) => p.endsWith(".md"));
    vi.spyOn(console, "error").mockImplementation(() => {});
    const fetcher = vi.fn(
      async (input: string | URL | Request, init?: RequestInit) => {
        const response = await fake.fetch(input, init);
        if (String(input) !== "https://api.github.com/graphql") return response;
        const body = (await response.json()) as {
          errors?: unknown[];
          data: { repository: Record<string, Record<string, unknown>> };
        };
        const blob = body.data.repository.b1!;
        if (kind === "truncated") blob.isTruncated = true;
        if (kind === "binary") {
          blob.isBinary = true;
          blob.text = null;
        }
        if (kind === "missing") delete body.data.repository.b1;
        if (kind === "wrong_sha") blob.oid = "0".repeat(40);
        if (kind === "wrong_bytes") blob.byteSize = 0;
        if (kind === "changed_text")
          blob.text = String(blob.text).replace("架空", "別物");
        if (kind === "partial_error")
          body.errors = [{ message: "secret-token private response" }];
        return Response.json(body);
      },
    );
    vi.stubGlobal("fetch", fetcher);
    await expect(repo.prefetchText(snapshot, paths)).rejects.toMatchObject({
      code:
        kind === "partial_error" ? "GITHUB_ERROR" : "GITHUB_INVALID_RESPONSE",
    });
    expect(JSON.stringify(vi.mocked(console.error).mock.calls)).not.toContain(
      "secret-token",
    );
    // Even b0, preceding the invalid b1, must not have entered the cache.
    await repo.text(snapshot, paths[0]!);
    expect(fake.calls.at(-1)!.route).toMatch(/^\/git\/blobs\//);
  },
);
it("rejects oversized files and symlinks before any batch request", async () => {
  const { fake, repo } = fixture();
  const snapshot = await repo.snapshot();
  const paths = [...snapshot.entries.keys()].filter((p) => p.endsWith(".md"));
  const entry = snapshot.entries.get(paths[0]!)!;
  const count = fake.calls.length;
  entry.size = 1_000_001;
  await expect(repo.prefetchText(snapshot, paths)).rejects.toMatchObject({
    code: "VERIFICATION_LIMIT",
  });
  entry.size = 10;
  entry.mode = "120000";
  await expect(repo.prefetchText(snapshot, paths)).rejects.toMatchObject({
    code: "UNSAFE_FILE",
  });
  expect(fake.calls.length).toBe(count);
});
