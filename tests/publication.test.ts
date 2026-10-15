import { afterEach, expect, it, vi } from "vitest";
import {
  PublicationService,
  nextSync,
} from "../mcp-worker/src/publication/service.ts";
import {
  frontmatter,
  references,
  resolve,
  safePath,
  withId,
  identityKey,
  registry,
} from "../mcp-worker/src/publication/content.ts";
import { validateLedgerHistory } from "../mcp-worker/src/publication/history.ts";
import { PublicationRepository } from "../mcp-worker/src/publication/repository.ts";
import { FakeGitHub, blobSha } from "./publication-fixture.ts";
const ID = "ABcdEFghIJkl";
const config = {
  owner: "dummy",
  repo: "private",
  branch: "main",
  token: "test-credential",
};
const service = (office = false) =>
  new PublicationService({
    source: config,
    planSecret: "test-signing-key-with-more-than-32-characters",
    office: office ? config : undefined,
  });
const args = (path = "Private.md", extra = {}) => ({
  vault: "main",
  path,
  expectedSha: blobSha(fake.files()[`main/${path}`]!),
  mode: "move" as const,
  ...extra,
});
let fake: FakeGitHub;
function setup(files?: Record<string, string | Buffer>) {
  fake = new FakeGitHub(files);
  fake.install();
  return service();
}
async function prepared(s = service(), input = args()) {
  const p = await s.prepare(input);
  expect(p.ok).toBe(true);
  if (!p.ok) throw Error();
  return p;
}
async function apply(s = service(), p?: Awaited<ReturnType<typeof prepared>>) {
  p ??= await prepared(s);
  return s.publish({
    planToken: String(p.planToken),
    confirm: true,
    approvedAttachments: (
      p.attachments as { source: string; approvalRequired: boolean }[]
    )
      .filter((a) => a.approvalRequired)
      .map((a) => a.source),
  });
}
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
it("publishes note, binary attachment and compatible registry in one commit, preserving source attachment and comments", async () => {
  const content =
    "---\ntitle: Dummy\n# keep comment\ntags: [internal]\n---\n\n![dummy](image.png)\n`[[Missing]]`\n";
  const s = setup({
    "main/Private.md": content,
    "main/image.png": Buffer.from([0, 255, 12, 34]),
  });
  const initial = fake.refs.get("main");
  const p = await prepared(s);
  expect(p.audience).toContain("全メールアドレス");
  expect(fake.refs.get("main")).toBe(initial);
  expect(
    await s.publish({ planToken: String(p.planToken), confirm: true }),
  ).toMatchObject({ ok: false, error: "ATTACHMENT_APPROVAL_REQUIRED" });
  const result = await apply(s, p);
  expect(result).toMatchObject({ ok: true, registration: "原本登録成功" });
  const files = fake.files();
  expect(files["main/Private.md"]).toBeUndefined();
  expect(files["main/image.png"]).toBeDefined();
  expect(files["main/社内共有/image.png"]).toBe(files["main/image.png"]);
  expect(files["main/社内共有/Private.md"]).toContain("# keep comment");
  expect(files["main/社内共有/Private.md"]).toContain("`[[Missing]]`");
  const ledger = JSON.parse(files["main/.docs-id-registry.json"]!);
  expect(ledger).toEqual({
    version: 1,
    ids: {
      [String(result.ok && result.doc_id)]: {
        path: "社内共有/Private.md",
        retired: false,
      },
    },
  });
  expect(String(result.ok && result.doc_id)).toMatch(/^[\w-]{12}$/);
  expect(fake.calls.filter((c) => c.method === "PATCH")).toHaveLength(1);
  expect(
    fake.calls.filter((c) => c.method === "PUT" || c.method === "DELETE"),
  ).toHaveLength(0);
  const again = await apply(s, p);
  expect(again).toMatchObject({
    ok: true,
    replayed: true,
    doc_id: result.ok && result.doc_id,
    sourceCommit: result.ok && result.sourceCommit,
  });
});
it("copies as a new document, preserving original and existing 21-character ID", async () => {
  const old = "AbCdEfGhIjKlMnOpQrStU";
  const s = setup({
    "main/社内共有/Old.md": `---\ndoc_id: ${old}\n---\nbody\n`,
    "main/.docs-id-registry.json": JSON.stringify({
      version: 1,
      ids: { [old]: { path: "社内共有/Old.md", retired: false } },
    }),
  });
  const p = await prepared(
    s,
    args("社内共有/Old.md", {
      mode: "copy",
      destinationPath: "社内共有/Copy.md",
    }),
  );
  const r = await apply(s, p);
  expect(r.ok && r.doc_id).not.toBe(old);
  expect(fake.files()["main/社内共有/Old.md"]).toContain(old);
  expect(
    Object.keys(JSON.parse(fake.files()["main/.docs-id-registry.json"]!).ids),
  ).toHaveLength(2);
});
it("keeps IDs and immutable registry paths on multiple moves and records reviewed transitions", async () => {
  const s = setup({
    "main/社内共有/Old.md": `---\ndoc_id: ${ID}\n---\nbody\n`,
    "main/.docs-id-registry.json": JSON.stringify({
      version: 1,
      ids: { [ID]: { path: "社内共有/Old.md", retired: false } },
    }),
  });
  const p = await prepared(
    s,
    args("社内共有/Old.md", { destinationPath: "社内共有/New.md" }),
  );
  expect(await apply(s, p)).toMatchObject({ ok: true, doc_id: ID });
  const p2 = await prepared(
    s,
    args("社内共有/New.md", { destinationPath: "社内共有/Final.md" }),
  );
  expect(await apply(s, p2)).toMatchObject({ ok: true, doc_id: ID });
  const ledger = JSON.parse(fake.files()["main/.docs-id-registry.json"]!);
  expect(ledger.ids[ID].path).toBe("社内共有/Old.md");
  expect(ledger.reviewedMoves[ID]).toContain(
    "社内共有/New.md -> 社内共有/Final.md",
  );
});
it("unpublishes preserving original and retires ID; refuses same-ID republication", async () => {
  const s = setup();
  const r = await apply(s);
  expect(r.ok).toBe(true);
  const p = await s.unpublish({
    ...args("社内共有/Private.md"),
    destinationPath: "Archive/Private.md",
  });
  expect(p.ok).toBe(true);
  expect(p.ok && p.ready).toBe(true);
  const stopped = await s.unpublish({
    planToken: String(p.ok && p.planToken),
    confirm: true,
  });
  expect(stopped.ok).toBe(true);
  expect(fake.files()["main/Archive/Private.md"]).toContain(
    String(r.ok && r.doc_id),
  );
  expect(
    JSON.parse(fake.files()["main/.docs-id-registry.json"]!).ids[
      String(r.ok && r.doc_id)
    ].retired,
  ).toBe(true);
  expect(await s.prepare(args("Archive/Private.md"))).toMatchObject({
    ok: false,
    error: "EXISTING_PRIVATE_ID",
  });
});
it.each([
  "POST /git/blobs",
  "POST /git/trees",
  "POST /git/commits",
  "PATCH /git/refs/heads/main",
])("failure at %s never advances the branch", async (failure) => {
  const s = setup();
  const p = await prepared(s);
  const old = fake.refs.get("main");
  fake.failAt = failure;
  expect((await apply(s, p)).ok).toBe(false);
  expect(fake.refs.get("main")).toBe(old);
  fake.failAt = undefined;
  expect((await apply(s, p)).ok).toBe(true);
});
it("recovers from successful PATCH with lost response without reissuing an ID", async () => {
  const s = setup();
  const p = await prepared(s);
  fake.lostPatch = true;
  const r = await apply(s, p);
  expect(r.ok).toBe(true);
  expect(await apply(s, p)).toMatchObject({
    ok: true,
    replayed: true,
    doc_id: r.ok && r.doc_id,
  });
});
it.each(["main/Private.md", "main/.docs-id-registry.json", "main/Other.md"])(
  "detects source, registry or unrelated branch conflict at %s",
  async (p) => {
    const s = setup();
    const plan = await prepared(s);
    fake.modify({
      [p]: p.endsWith(".json") ? '{"version":1,"ids":{}}' : "changed",
    });
    expect(await apply(s, plan)).toMatchObject({
      ok: false,
      error: "CONFLICT",
    });
  },
);
it("requires matching source SHA before producing a plan", async () => {
  const s = setup();
  expect(await s.prepare({ ...args(), expectedSha: "stale" })).toMatchObject({
    ok: false,
    error: "CONFLICT",
  });
});
it("rejects tampered, wrong-action and expired plans, and unsigned arbitrary inputs", async () => {
  const s = setup();
  const p = await prepared(s);
  expect(
    await s.publish({ planToken: String(p.planToken) + "x", confirm: true }),
  ).toMatchObject({ ok: false, error: "INVALID_PLAN" });
  expect(
    await s.unpublish({ planToken: String(p.planToken), confirm: true }),
  ).toMatchObject({ ok: false, error: "INVALID_PLAN" });
  const now = Date.now();
  vi.spyOn(Date, "now").mockReturnValue(now + 31 * 60000);
  expect(await apply(s, p)).toMatchObject({ ok: false, error: "PLAN_EXPIRED" });
});
it.each([
  "../secret.md",
  "%2e%2e/secret.md",
  "%252e%252e/secret.md",
  "/main/x.md",
  "a\\b.md",
  "a/.hidden.md",
  "a//b.md",
])("rejects unsafe input path %s", (p) =>
  expect(() => safePath(p, true)).toThrow(),
);
it.each([
  "[[Secret]]",
  "[[Absent]]",
  "[[Same]]",
  "[bad](%2e%2e/secret.md)",
  "<div>secret</div>",
  "![external](https://example.com/a.png)",
])("blocks unsafe/unresolved reference %s without a token", async (link) => {
  const s = setup({
    "main/Private.md": link,
    "main/Secret.md": "secret",
    "main/a/Same.md": "a",
    "main/b/Same.md": "b",
  });
  const p = await prepared(s);
  expect(p.ready).toBe(false);
  expect(p.planToken).toBeNull();
});
it("moves neither attachments nor notes on preparation and stops when incoming private links break", async () => {
  const s = setup({
    "main/Private.md": "body",
    "main/Referer.md": "[note](Private.md)",
  });
  const p = await prepared(s);
  expect(p.ready).toBe(false);
  expect(p.issues).toContainEqual(
    expect.objectContaining({
      code: "BROKEN_INCOMING_LINK",
      path: "Referer.md",
    }),
  );
  expect(fake.files()["main/Private.md"]).toBe("body");
});
it("stops unpublication if another public note links to it", async () => {
  const b = "BCdeFGhiJKlm";
  const s = setup({
    "main/社内共有/A.md": `---\ndoc_id: ${ID}\n---\nbody`,
    "main/社内共有/B.md": `---\ndoc_id: ${b}\n---\n[[A]]`,
    "main/.docs-id-registry.json": JSON.stringify({
      version: 1,
      ids: {
        [ID]: { path: "社内共有/A.md", retired: false },
        [b]: { path: "社内共有/B.md", retired: false },
      },
    }),
  });
  const p = await s.unpublish({
    ...args("社内共有/A.md"),
    destinationPath: "Archive/A.md",
  });
  expect(p.ok && p.ready).toBe(false);
  expect(p.ok && p.planToken).toBeNull();
});
it.each(["wrong", "ABcdEFghIJkl", "abCDefGHIjKL"])(
  "rejects invalid/duplicate/case-folded IDs (%s)",
  async (id) => {
    const s = setup({
      "main/社内共有/A.md": `---\ndoc_id: ${ID}\n---\nbody`,
      "main/社内共有/B.md": `---\ndoc_id: ${id}\n---\nbody`,
      "main/.docs-id-registry.json": JSON.stringify({
        version: 1,
        ids: { [ID]: { path: "社内共有/A.md", retired: false } },
      }),
    });
    expect((await s.prepare(args("社内共有/A.md"))).ok).toBe(false);
  },
);
it("detects ID change and deletion/reuse between syncs from Git history", async () => {
  const ledger = {
    version: 1,
    ids: { [ID]: { path: "社内共有/A.md", retired: false } },
  };
  const s = setup({
    "main/社内共有/A.md": `---\ndoc_id: ${ID}\n---\nbody`,
    "main/.docs-id-registry.json": JSON.stringify(ledger),
  });
  fake.seed(
    {
      "main/.docs-id-registry.json": JSON.stringify(ledger),
      "main/Private.md": "x",
    },
    "delete",
  );
  fake.modify(
    { "main/社内共有/A.md": `---\ndoc_id: ${ID}\n---\nbody` },
    "reuse",
  );
  expect(await s.prepare(args("社内共有/A.md"))).toMatchObject({
    ok: false,
    error: "RETIRED_ID",
  });
});
it("rejects append-only registry history changes", () => {
  const before = {
    version: 1 as const,
    ids: { [ID]: { path: "社内共有/A.md", retired: true } },
    reviewedChanges: ["a".repeat(64)],
    reviewedMoves: { [ID]: ["社内共有/A.md -> 社内共有/B.md"] },
  };
  expect(() =>
    validateLedgerHistory(before, {
      ...before,
      ids: { [ID]: { path: "社内共有/A.md", retired: false } },
    }),
  ).toThrow();
  expect(() =>
    validateLedgerHistory(before, { ...before, reviewedChanges: [] }),
  ).toThrow();
  expect(() =>
    validateLedgerHistory(before, { ...before, reviewedMoves: {} }),
  ).toThrow();
});
it("retains YAML comments, body and CRLF and excludes code refs", () => {
  const body =
    "---\r\n# comment\r\ntitle: Dummy\r\n---\r\n\r\n`[[Secret]]`\r\n```md\r\n[secret](../Secret.md)\r\n```\r\n[ok][id]\r\n\r\n[id]: image.png\r\n";
  const result = withId(body, ID);
  expect(result).toContain("# comment\r\n");
  expect(frontmatter(result).body).toBe(frontmatter(body).body);
  expect(references(body)).toHaveLength(1);
});
it("uses exact identityChangeKey and JST schedule", () => {
  expect(identityKey({ [ID]: "社内共有/A.md" }, {})).toMatch(/^[a-f0-9]{64}$/);
  expect(nextSync(new Date("2026-10-14T12:16:59Z"))).toBe(
    "2026-10-14T21:17:00.000+09:00",
  );
  expect(nextSync(new Date("2026-10-14T12:17:00Z"))).toBe(
    "2026-10-14T22:17:00.000+09:00",
  );
});
it("rejects symlinks and truncated trees", async () => {
  const s = setup();
  const head = fake.commits.get(fake.refs.get("main")!)!;
  fake.trees.get(head.tree)!.find((e) => e.path === "main/Private.md")!.mode =
    "120000";
  expect(await s.prepare(args())).toMatchObject({
    ok: false,
    error: "UNSAFE_FILE",
  });
  const repo = new PublicationRepository(config);
  const original = fake.fetch;
  vi.stubGlobal("fetch", async (i: string, init?: RequestInit) =>
    String(i).includes("/git/trees/")
      ? Response.json({ truncated: true, tree: [] })
      : original(i, init),
  );
  await expect(repo.snapshot()).rejects.toThrow("不完全");
});
it("supports workflow dispatch separately, defaults false and reports missing/denied permission", async () => {
  setup();
  const head = fake.refs.get("main")!;
  expect(await service().trigger({ expectedSourceCommit: head })).toMatchObject(
    {
      ok: true,
      synchronization: {
        started: false,
        reason: "OFFICE_TOKEN_NOT_CONFIGURED",
      },
    },
  );
  expect(
    await service(true).trigger({ expectedSourceCommit: head }),
  ).toMatchObject({
    ok: true,
    synchronization: { started: true, force: false },
  });
  fake.dispatchDenied = true;
  expect(
    await service(true).trigger({ expectedSourceCommit: head }),
  ).toMatchObject({
    ok: true,
    synchronization: { started: false, reason: "PERMISSION_DENIED" },
  });
});
it("reports missing deploy-state as uncertainty, preserving registration evidence", async () => {
  const s = setup();
  const r = await apply(s);
  expect(
    await s.status({ vault: "main", doc_id: String(r.ok && r.doc_id) }),
  ).toMatchObject({
    ok: true,
    status: "状態を確認できない",
    registration: "registered",
  });
});
it("does not publish unused attachment definitions and preserves plain external autolinks", async () => {
  const s = setup({
    "main/Private.md": "https://example.com\n\n[unused]: secret.pdf\n",
    "main/secret.pdf": "private unused",
  });
  const p = await prepared(s);
  expect(p.ready).toBe(true);
  expect(p.attachments).toEqual([]);
  expect((await apply(s, p)).ok).toBe(true);
  expect(fake.files()["main/社内共有/secret.pdf"]).toBeUndefined();
});
it("encodes spaces and Japanese attachment names without changing code or private originals", async () => {
  const s = setup({
    "main/Private.md": "[file](<添付 資料.pdf>)\n`[file](<添付 資料.pdf>)`\n",
    "main/添付 資料.pdf": "dummy",
  });
  const p = await prepared(s);
  expect(p.ready).toBe(true);
  expect((await apply(s, p)).ok).toBe(true);
  const content = fake.files()["main/社内共有/Private.md"]!;
  expect(content).toContain("<%E6%B7%BB%E4%BB%98%20%E8%B3%87%E6%96%99.pdf>");
  expect(content).toContain("`[file](<添付 資料.pdf>)`");
});
it("rejects missing definitions and escaped wiki mismatches safely", async () => {
  const s = setup({ "main/Private.md": "[file][missing]\n" });
  expect((await prepared(s)).ready).toBe(false);
  expect(() => references("&#91;&#91;Secret]]")).toThrow();
});
it("rejects ID changes in history and current documents", async () => {
  const b = "BCdeFGhiJKlm";
  const s = setup({
    "main/社内共有/A.md": `---\ndoc_id: ${ID}\n---\nbody`,
    "main/.docs-id-registry.json": JSON.stringify({
      version: 1,
      ids: { [ID]: { path: "社内共有/A.md", retired: false } },
    }),
  });
  fake.modify({ "main/社内共有/A.md": `---\ndoc_id: ${b}\n---\nbody` });
  expect(await s.prepare(args("社内共有/A.md"))).toMatchObject({
    ok: false,
    error: "ID_CHANGED",
  });
});
it("fails closed for unsupported Vaults and forged old-hash state", async () => {
  const s = setup();
  expect(await s.prepare({ ...args(), vault: "other" })).toMatchObject({
    ok: false,
    error: "INVALID_VAULT",
  });
});
it("detects a ref race immediately before final mutation and does not overwrite the competing commit", async () => {
  const s = setup();
  const p = await prepared(s);
  const real = fake.fetch;
  let changed = false;
  vi.stubGlobal(
    "fetch",
    async (input: string | URL | Request, init?: RequestInit) => {
      if (
        String(input).endsWith("/git/commits") &&
        init?.method === "POST" &&
        !changed
      ) {
        const response = await real(input, init);
        fake.modify({ "main/Other.md": "concurrent" });
        changed = true;
        return response;
      }
      return real(input, init);
    },
  );
  const r = await apply(s, p);
  expect(r).toMatchObject({ ok: false, error: "CONFLICT" });
  expect(fake.files()["main/Other.md"]).toBe("concurrent");
  expect(fake.files()["main/Private.md"]).toBeDefined();
});
it("preserves outgoing attachment references when the stopped note moves into another folder", async () => {
  const s = setup({
    "main/Private.md": "![image](image.png)",
    "main/image.png": "dummy",
  });
  await apply(s);
  const p = await s.unpublish({
    ...args("社内共有/Private.md"),
    destinationPath: "Archive/Private.md",
  });
  expect(p.ok && p.ready).toBe(true);
  expect(
    (
      await s.unpublish({
        planToken: String(p.ok && p.planToken),
        confirm: true,
      })
    ).ok,
  ).toBe(true);
  expect(fake.files()["main/Archive/Private.md"]).toContain(
    "../%E7%A4%BE%E5%86%85%E5%85%B1%E6%9C%89/image.png",
  );
});
it("stops when attachment approvals exceed the signed plan and does not permit cross-repository tokens", async () => {
  const s = setup();
  const p = await prepared(s);
  expect(
    await s.publish({
      planToken: String(p.planToken),
      confirm: true,
      approvedAttachments: ["extra-private.pdf"],
    }),
  ).toMatchObject({ ok: false, error: "ATTACHMENT_APPROVAL_REQUIRED" });
  const other = new PublicationService({
    source: { ...config, repo: "different" },
    planSecret: "test-signing-key-with-more-than-32-characters",
  });
  expect(
    await other.publish({ planToken: String(p.planToken), confirm: true }),
  ).toMatchObject({ ok: false, error: "INVALID_PLAN" });
});
it("reports dispatch response loss as unknown, separately from source registration", async () => {
  setup();
  const real = fake.fetch;
  vi.stubGlobal(
    "fetch",
    async (input: string | URL | Request, init?: RequestInit) => {
      if (String(input).endsWith("/dispatches")) throw Error("lost response");
      return real(input, init);
    },
  );
  expect(
    await service(true).trigger({
      expectedSourceCommit: fake.refs.get("main")!,
    }),
  ).toMatchObject({
    ok: true,
    sourceRegistration: "unchanged",
    synchronization: { started: null, reason: "DISPATCH_OUTCOME_UNKNOWN" },
  });
});
it("does not resolve shared references into hidden folders skipped by officeSystem", async () => {
  const s = setup({
    "main/Private.md": "![[secret.png]]",
    "main/社内共有/.hidden/secret.png": "hidden dummy",
  });
  const p = await prepared(s);
  expect(p.ready).toBe(false);
  expect(p.issues).toContainEqual(
    expect.objectContaining({ code: "UNSAFE_FILE" }),
  );
});
it("preserves compatible reviewed-move strings containing arrows within file names", () => {
  const raw = {
    version: 1,
    ids: { [ID]: { path: "社内共有/A -> B.md", retired: false } },
    reviewedMoves: { [ID]: ["社内共有/A -> B.md -> 社内共有/C.md"] },
  };
  expect(registry(JSON.stringify(raw))).toEqual(raw);
});
it("blocks a move when a private incoming link is ambiguous and could reference the source", async () => {
  const s = setup({
    "main/Private.md": "body",
    "main/other/Private.md": "other",
    "main/Referer.md": "[[Private]]",
  });
  const p = await prepared(s);
  expect(p.ready).toBe(false);
  expect(p.issues).toContainEqual(
    expect.objectContaining({
      code: "AMBIGUOUS_INCOMING_LINK",
      path: "Referer.md",
    }),
  );
});
it("can withdraw a note containing pre-existing unsafe HTML while preserving its private original", async () => {
  const s = setup({
    "main/社内共有/A.md": `---\ndoc_id: ${ID}\n---\n<div>dummy unsafe content</div>`,
    "main/.docs-id-registry.json": JSON.stringify({
      version: 1,
      ids: { [ID]: { path: "社内共有/A.md", retired: false } },
    }),
  });
  const p = await s.unpublish({
    ...args("社内共有/A.md"),
    destinationPath: "Archive/A.md",
  });
  expect(p.ok && p.ready).toBe(true);
  expect(p.ok && p.warnings).toContainEqual(
    expect.objectContaining({ code: "UNSAFE_CONTENT" }),
  );
  expect(
    (
      await s.unpublish({
        planToken: String(p.ok && p.planToken),
        confirm: true,
      })
    ).ok,
  ).toBe(true);
  expect(fake.files()["main/Archive/A.md"]).toContain(
    "<div>dummy unsafe content</div>",
  );
});
it("rejects malformed and encoded block fragments before registration", () => {
  expect(() =>
    resolve(
      { target: "#%E0", wiki: true, image: false, start: 0, end: 0 },
      "Private.md",
      [],
    ),
  ).toThrow();
  expect(() =>
    resolve(
      { target: "#%5Eblock", wiki: true, image: false, start: 0, end: 0 },
      "Private.md",
      [],
    ),
  ).toThrow();
});

it("moves across a 60-note vault within 50 requests while preserving registration and status checks", async () => {
  const files: Record<string, string> = {
    "main/Private.md": "# Dummy source\n",
  };
  for (let i = 0; i < 60; i++)
    files[`main/Notes/${i}.md`] = `# Fabricated note ${i}\n`;
  const s = setup(files);
  const p = await prepared(s);
  expect(p.ready).toBe(true);
  expect(fake.calls.length).toBeLessThan(50);
  expect(fake.calls.some((c) => c.route === "/graphql")).toBe(true);
  fake.calls.length = 0;
  const result = await apply(s, p);
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error("Publication failed");
  expect(fake.calls.length).toBeLessThan(50);
  expect(fake.files()["main/Private.md"]).toBeUndefined();
  expect(fake.files()["main/社内共有/Private.md"]).toBeDefined();
  const ledger = registry(String(fake.files()["main/.docs-id-registry.json"]));
  expect(ledger.ids[String(result.doc_id)]?.path).toBe("社内共有/Private.md");
  expect(
    await s.status({ vault: "main", doc_id: String(result.doc_id) }),
  ).toMatchObject({
    ok: true,
    registration: "registered",
    reason: "OFFICE_TOKEN_NOT_CONFIGURED",
  });
});
it("still blocks a broken incoming link in the final batch of a large private vault", async () => {
  const files: Record<string, string> = {
    "main/Private.md": "# Dummy source\n",
  };
  for (let i = 0; i < 60; i++)
    files[`main/Notes/${i}.md`] = `# Fabricated ${i}\n`;
  files["main/Notes/59.md"] += "\n[source](../Private.md)\n";
  const s = setup(files);
  const head = fake.refs.get("main");
  const p = await prepared(s);
  expect(p).toMatchObject({
    ready: false,
    planToken: null,
    issues: expect.arrayContaining([
      expect.objectContaining({
        code: "BROKEN_INCOMING_LINK",
        path: "Notes/59.md",
      }),
    ]),
  });
  expect(fake.refs.get("main")).toBe(head);
  expect(fake.calls.length).toBeLessThan(50);
});
