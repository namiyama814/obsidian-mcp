/** Opt-in integration test. Only ever writes fabricated data to the exact dedicated private repository. */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/server";
import { createObsidianMcpServer } from "../mcp-worker/src/mcp-server.ts";
import { GitHubObsidianClient } from "../mcp-worker/src/github/client.ts";
import { PublicationRepository } from "../mcp-worker/src/publication/repository.ts";
import { PublicationService } from "../mcp-worker/src/publication/service.ts";

const owner = "namiyama814",
  repo = "obsidian-mcp-publication-test";
if (process.env.PUBLICATION_LIVE_TEST !== "1")
  throw new Error(
    "Set PUBLICATION_LIVE_TEST=1 to opt in to dedicated dummy repository writes.",
  );
// Read credential via stdin-safe process API; never print it, put it on argv or write it to disk.
const token =
  process.env.PUBLICATION_TEST_TOKEN ??
  execFileSync("gh", ["auth", "token"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
const config = { owner, repo, branch: "main", token };
const github = new PublicationRepository(config);
await github.assertPrivate();
let head: string;
try {
  head = await github.head();
} catch {
  // Bootstrap empty test repo. This is fixture setup, not the publication transaction.
  await github.api("/contents/README.md", "PUT", {
    message: "Initialize dummy publication test repository",
    branch: "main",
    content: Buffer.from(
      "# Dummy Obsidian publication tests\nNo real documents.\n",
    ).toString("base64"),
  });
  head = await github.head();
}
const branch = `publication-test-${Date.now()}`;
await github.api("/git/refs", "POST", {
  ref: `refs/heads/${branch}`,
  sha: head,
});
config.branch = branch;
const snap = await github.snapshot();
const note =
  "---\ntitle: ダミー資料\n# preserve this comment\nprivate_property: test-only\n---\n\n# 架空の資料\n\n![架空画像](dummy.png)\n\n`[[公開しない文字列]]`\n";
const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2ZJsAAAAASUVORK5CYII=",
  "base64",
);
const blob = await github.api<{ sha: string }>("/git/blobs", "POST", {
  encoding: "base64",
  content: Buffer.from(png).toString("base64"),
});
await github.atomic(
  snap,
  [
    { path: "main/Dummy.md", content: note },
    { path: "main/dummy.png", sha: blob.sha },
  ],
  "dummy-fixture-setup",
);
const options = {
  source: config,
  planSecret: Buffer.from(randomBytes(32)).toString("base64url"),
};
let requestId = 0;
async function rpc(
  method: string,
  params: Record<string, unknown>,
  scopes = ["obsidian.read", "obsidian.write"],
) {
  const server = createObsidianMcpServer({
    client: new GitHubObsidianClient(config),
    publication: new PublicationService(options),
    resourceMetadataUrl:
      "https://dummy.local/.well-known/oauth-protected-resource/mcp",
  });
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  await server.connect(transport);
  try {
    const response = await transport.handleRequest(
      new Request("https://dummy.local/mcp", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
          "MCP-Protocol-Version": "2025-11-25",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: ++requestId,
          method,
          params,
        }),
      }),
      {
        authInfo: {
          token: "verified-test-context",
          clientId: "dummy-test",
          scopes,
        },
      },
    );
    const body = (await response.json()) as {
      result?: {
        structuredContent?: Record<string, unknown>;
        tools?: { name: string; inputSchema: { type: string } }[];
      };
      error?: unknown;
    };
    assert.equal(response.status, 200, JSON.stringify(body));
    assert.equal(body.error, undefined, JSON.stringify(body));
    return body.result!;
  } finally {
    await server.close();
  }
}
async function call(
  name: string,
  args: Record<string, unknown>,
  scopes?: string[],
) {
  return (await rpc("tools/call", { name, arguments: args }, scopes))
    .structuredContent!;
}
// Reuse the exact signed plan after a transient API failure; never prepare another ID.
async function callConfirmed(name: string, args: Record<string, unknown>) {
  for (let attempt = 1; ; attempt++) {
    const result = await call(name, args);
    const transient =
      result.error === "GITHUB_UNAVAILABLE" ||
      result.error === "OUTCOME_UNKNOWN" ||
      (result.error === "GITHUB_ERROR" &&
        /\(5\d\d\)/.test(String(result.message)));
    if (result.ok || !transient || attempt >= 3) return result;
    console.log("publication_test_retry", { attempt, error: result.error });
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
}
const tools = (await rpc("tools/list", {})).tools!;
assert(tools.some((t) => t.name === "publish_note"));
assert(
  tools.every((t) => t.inputSchema.type === "object"),
  "Every MCP input schema must be an object",
);
const current = await github.snapshot();
const sha = github.regular(current, "main/Dummy.md").sha;
const prep = await call("prepare_publication", {
  vault: "main",
  path: "Dummy.md",
  expectedSha: sha,
  mode: "move",
});
assert.equal(prep.ok, true, JSON.stringify(prep));
assert.equal(prep.ready, true, JSON.stringify(prep));
assert.equal(
  await github.head(),
  current.head,
  "Preparation must be read-only",
);
assert.equal(
  (
    await call(
      "publish_note",
      {
        planToken: prep.planToken,
        confirm: true,
        approvedAttachments: ["dummy.png"],
      },
      ["obsidian.read"],
    )
  ).error,
  "INSUFFICIENT_SCOPE",
);
const published = await callConfirmed("publish_note", {
  planToken: prep.planToken,
  confirm: true,
  approvedAttachments: ["dummy.png"],
});
assert.equal(published.ok, true, JSON.stringify(published));
const publishedHead = await github.head();
assert.equal(publishedHead, published.sourceCommit);
const commit = await github.api<{
  parents: { sha: string }[];
  files: { filename: string; previous_filename?: string; status: string }[];
}>(`/commits/${publishedHead}`);
assert.deepEqual(
  commit.parents.map((p) => p.sha),
  [current.head],
);
assert.deepEqual(
  commit.files
    .flatMap((f) => [
      f.filename,
      ...(f.previous_filename ? [f.previous_filename] : []),
    ])
    .sort(),
  [
    "main/.docs-id-registry.json",
    "main/Dummy.md",
    "main/社内共有/Dummy.md",
    "main/社内共有/dummy.png",
  ].sort(),
);
const replay = await callConfirmed("publish_note", {
  planToken: prep.planToken,
  confirm: true,
  approvedAttachments: ["dummy.png"],
});
assert.equal(replay.replayed, true);
assert.equal(replay.doc_id, published.doc_id);
assert.equal(await github.head(), publishedHead);
const registered = await github.snapshot();
assert(!registered.entries.has("main/Dummy.md"));
assert(registered.entries.has("main/dummy.png"));
const content = await github.text(registered, "main/社内共有/Dummy.md");
assert(content.includes("# preserve this comment"));
assert(content.includes("`[[公開しない文字列]]`"));
const ledger = JSON.parse(
  await github.text(registered, "main/.docs-id-registry.json"),
);
assert.deepEqual(ledger.ids[published.doc_id as string], {
  path: "社内共有/Dummy.md",
  retired: false,
});
const stop = await call("unpublish_note", {
  vault: "main",
  path: "社内共有/Dummy.md",
  destinationPath: "Archive/Dummy.md",
  expectedSha: github.regular(registered, "main/社内共有/Dummy.md").sha,
});
assert.equal(stop.ready, true, JSON.stringify(stop));
const stopped = await callConfirmed("unpublish_note", {
  planToken: stop.planToken,
  confirm: true,
});
assert.equal(stopped.ok, true, JSON.stringify(stopped));
console.log(
  JSON.stringify(
    {
      repository: `${owner}/${repo}`,
      branch,
      publicationCommit: publishedHead,
      doc_id: published.doc_id,
      stopCommit: stopped.sourceCommit,
      checks: [
        "MCP tools/list",
        "scope enforcement",
        "read-only prepare",
        "note + binary attachment + registry + deletion in one commit",
        "same-token retry",
        "frontmatter/comments/code preserved",
        "atomic unpublication",
      ],
      limitations: [
        "OAuth verified middleware context is injected in this local transport test; production OAuth login and Worker deployment are not tested.",
        "No officeSystem workflow is dispatched.",
      ],
    },
    null,
    2,
  ),
);
