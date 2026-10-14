import { afterEach, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { PublicationService } from "../mcp-worker/src/publication/service.ts";
import {
  digestFiles,
  checkoutSourceCommit,
} from "../mcp-worker/src/publication/state.ts";
import { FakeGitHub, blobSha } from "./publication-fixture.ts";
const config = {
  owner: "dummy",
  repo: "private",
  branch: "main",
  token: "dummy",
};
const A = "ABcdEFghIJkl",
  B = "BCdeFGhiJKlm";
const s = () =>
  new PublicationService({
    source: config,
    office: config,
    planSecret: "a-test-only-signing-secret-32-characters",
  });
let fake: FakeGitHub;
function fixture() {
  fake = new FakeGitHub({
    "main/社内共有/A.md": `---\ndoc_id: ${A}\n---\n![image](image.png)\n`,
    "main/社内共有/image.png": "dummy",
    "main/.docs-id-registry.json": JSON.stringify({
      version: 1,
      ids: { [A]: { path: "社内共有/A.md", retired: false } },
    }),
  });
  fake.install();
}
function state(
  docs: Record<string, string> = { [A]: "社内共有/A.md" },
  retiredIds: string[] = [],
  sourceCommit = fake.refs.get("main")!,
) {
  const snapshot = fake.trees.get(fake.commits.get(sourceCommit)!.tree)!;
  const read = (p: string) =>
    new Uint8Array(
      fake.blobs.get(snapshot.find((e) => e.path === `main/${p}`)!.sha)!,
    );
  const markdown = snapshot
    .filter(
      (e) => e.path.startsWith("main/社内共有/") && e.path.endsWith(".md"),
    )
    .map((e) => ({ path: e.path.slice(5), bytes: read(e.path.slice(5)) }));
  const attachments = snapshot.some((e) => e.path === "main/社内共有/image.png")
    ? ["社内共有/image.png"]
    : [];
  fake.seed(
    {
      "state.json": JSON.stringify({
        version: 1,
        sourceCommit,
        workerVersion: "verified-worker-version",
        markdownHash: digestFiles(markdown),
        contentHash: digestFiles([
          ...markdown,
          ...attachments.map((p) => ({ path: p, bytes: read(p) })),
        ]),
        registryHash: createHash("sha256")
          .update(read(".docs-id-registry.json"))
          .digest("hex"),
        codeHash: "d".repeat(64),
        docs,
        attachments,
        retiredIds,
      }),
    },
    "success",
    "deploy-state",
  );
}
afterEach(() => vi.unstubAllGlobals());
it("recognizes published content despite unrelated source commits, then attachment-only updates", async () => {
  fixture();
  state();
  expect(await s().status({ vault: "main", doc_id: A })).toMatchObject({
    ok: true,
    status: "公開済み",
  });
  fake.modify({ "main/Private.md": "unrelated" });
  expect(await s().status({ vault: "main", doc_id: A })).toMatchObject({
    ok: true,
    status: "公開済み",
  });
  fake.modify({ "main/社内共有/image.png": "new image" });
  expect(
    await s().status({ vault: "main", path: "社内共有/A.md" }),
  ).toMatchObject({ ok: true, status: "更新待ち" });
});
it("distinguishes unregistered and publication pending with existing success evidence", async () => {
  fixture();
  const current = fake.files();
  fake = new FakeGitHub({
    "main/.docs-id-registry.json": '{\"version\":1,\"ids\":{}}',
  });
  fake.install();
  fake.seed(
    { "main/.docs-id-registry.json": '{\"version\":1,\"ids\":{}}' },
    "empty shared",
  );
  const empty = fake.refs.get("main")!;
  state({}, [], empty);
  fake.seed(current, "publish");
  expect(await s().status({ vault: "main", doc_id: A })).toMatchObject({
    ok: true,
    status: "公開待ち",
  });
  expect(await s().status({ vault: "main", doc_id: B })).toMatchObject({
    ok: true,
    status: "未登録",
  });
});
it("distinguishes stop pending and stopped with retired identity retained outside shared", async () => {
  fixture();
  const source = fake.refs.get("main")!;
  state();
  const files = fake.files();
  const note = files["main/社内共有/A.md"]!;
  delete files["main/社内共有/A.md"];
  files["main/Archive/A.md"] = note;
  files["main/.docs-id-registry.json"] = JSON.stringify({
    version: 1,
    ids: { [A]: { path: "社内共有/A.md", retired: true } },
  });
  fake.seed(files, "retire");
  expect(await s().status({ vault: "main", doc_id: A })).toMatchObject({
    ok: true,
    status: "公開停止待ち",
  });
  state({}, [A]);
  expect(
    await s().status({ vault: "main", path: "Archive/A.md" }),
  ).toMatchObject({ ok: true, status: "公開停止済み" });
});
it("rejects corrupt state or mismatched source-ID evidence instead of guessing", async () => {
  fixture();
  state({ [A]: "社内共有/Wrong.md" });
  expect(await s().status({ vault: "main", doc_id: A })).toMatchObject({
    ok: true,
    status: "状態を確認できない",
  });
  fake.seed({ "state.json": '{"version":1}' }, "corrupt", "deploy-state");
  expect(await s().status({ vault: "main", doc_id: A })).toMatchObject({
    ok: true,
    status: "状態を確認できない",
  });
});
it("does not treat an Access 302 as deployment success and does not fetch production URL", async () => {
  fixture();
  const original = fake.fetch;
  const urls: string[] = [];
  vi.stubGlobal("fetch", async (i: string, init?: RequestInit) => {
    urls.push(String(i));
    return original(i, init);
  });
  expect(await s().status({ vault: "main", doc_id: A })).toMatchObject({
    ok: true,
    status: "状態を確認できない",
  });
  expect(urls.every((u) => u.startsWith("https://api.github.com/"))).toBe(true);
});
it("classifies only a proven matching-source failure; unrelated workflow failures remain supplemental", async () => {
  fixture();
  state();
  fake.modify({ "main/社内共有/image.png": "updated" });
  const current = fake.refs.get("main")!;
  const real = fake.fetch;
  const start = "2026-10-15T01:00:00Z",
    end = "2026-10-15T01:01:00Z";
  let source = current;
  vi.stubGlobal(
    "fetch",
    async (input: string | URL | Request, init?: RequestInit) => {
      const u = String(input);
      if (u.includes("/actions/workflows/sync.yml/runs?"))
        return Response.json({
          workflow_runs: [
            {
              id: 10,
              html_url: "https://github.com/dummy/run/10",
              conclusion: "failure",
              status: "completed",
            },
          ],
        });
      if (u.endsWith("/actions/runs/10/jobs?per_page=100"))
        return Response.json({
          jobs: [
            {
              id: 20,
              steps: [
                {
                  name: "Checkout Obsidian read-only",
                  conclusion: "success",
                  started_at: start,
                  completed_at: end,
                },
              ],
            },
          ],
        });
      if (u.endsWith("/actions/jobs/20/logs"))
        return new Response(
          `2026-10-15T01:00:20Z [command]/usr/bin/git log -1 --format=%H\n2026-10-15T01:00:21Z ${source}\n`,
        );
      return real(input, init);
    },
  );
  expect(await s().status({ vault: "main", doc_id: A })).toMatchObject({
    ok: true,
    status: "同期失敗",
    syncObservation: { sourceCommit: current },
  });
  source = "0".repeat(40);
  expect(await s().status({ vault: "main", doc_id: A })).toMatchObject({
    ok: true,
    status: "更新待ち",
    syncObservation: { conclusion: "failure" },
  });
});
it("does not accept SHA-like content outside the successful source checkout step", () => {
  const hash = "a".repeat(40);
  expect(
    checkoutSourceCommit(
      `2026-10-15T02:00:00Z git log -1 --format=%H\n2026-10-15T02:00:01Z ${hash}`,
      "2026-10-15T01:00:00Z",
      "2026-10-15T01:01:00Z",
    ),
  ).toBeUndefined();
});
it("rejects forged success hashes even when IDs and source commit match", async () => {
  fixture();
  state();
  const files = fake.files("deploy-state");
  const v = JSON.parse(files["state.json"]!);
  v.contentHash = "0".repeat(64);
  fake.seed({ "state.json": JSON.stringify(v) }, "bad-hash", "deploy-state");
  expect(await s().status({ vault: "main", doc_id: A })).toMatchObject({
    ok: true,
    status: "状態を確認できない",
    reason: "INVALID_STATE",
  });
});
