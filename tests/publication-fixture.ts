import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { vi } from "vitest";
import type {
  Entry,
  Change,
} from "../mcp-worker/src/publication/repository.ts";
const sha = (s: string) => createHash("sha1").update(s).digest("hex");
export const blobSha = (content: Buffer | string) =>
  createHash("sha1")
    .update(`blob ${Buffer.byteLength(content)}\0`)
    .update(content)
    .digest("hex");
type Commit = {
  sha: string;
  tree: string;
  parents: { sha: string }[];
  commit: { message: string };
  changed: string[];
};
export class FakeGitHub {
  blobs = new Map<string, Buffer>();
  trees = new Map<string, Entry[]>();
  commits = new Map<string, Commit>();
  refs = new Map<string, string>();
  calls: { route: string; method: string; body: unknown }[] = [];
  failAt?: string;
  lostPatch = false;
  count = 0;
  dispatchDenied = false;
  constructor(
    files: Record<string, string | Buffer> = { "main/Private.md": "# Dummy\n" },
  ) {
    this.seed(files);
  }
  seed(
    files: Record<string, string | Buffer>,
    message = "seed",
    branch = "main",
  ) {
    const entries: Entry[] = [];
    for (const [path, content] of Object.entries(files)) {
      const bytes = Buffer.from(content);
      const id = blobSha(bytes);
      this.blobs.set(id, bytes);
      entries.push({
        path,
        mode: "100644",
        type: "blob",
        sha: id,
        size: bytes.length,
      });
    }
    const tree = this.tree(entries);
    const parents = this.refs.has(branch)
      ? [{ sha: this.refs.get(branch)! }]
      : [];
    const old = parents.length
      ? (this.trees.get(this.commits.get(parents[0]!.sha)!.tree) ?? [])
      : [];
    const changed = [
      ...new Set([...old.map((e) => e.path), ...Object.keys(files)]),
    ].filter(
      (p) =>
        old.find((e) => e.path === p)?.sha !==
        entries.find((e) => e.path === p)?.sha,
    );
    const id = sha(`commit ${++this.count} ${tree}`);
    this.commits.set(id, {
      sha: id,
      tree,
      parents,
      commit: { message },
      changed,
    });
    this.refs.set(branch, id);
    return id;
  }
  tree(entries: Entry[]) {
    const map = new Map(
      entries.filter((e) => e.type !== "tree").map((e) => [e.path, e]),
    );
    for (const entry of [...map.values()]) {
      const parts = entry.path.split("/");
      for (let i = 1; i < parts.length; i++) {
        const p = parts.slice(0, i).join("/");
        if (!map.has(p))
          map.set(p, { path: p, type: "tree", mode: "040000", sha: sha(p) });
      }
    }
    const all = [...map.values()].sort((a, b) => a.path.localeCompare(b.path));
    const id = sha(JSON.stringify(all));
    this.trees.set(id, all);
    return id;
  }
  files(branch = "main") {
    const c = this.commits.get(this.refs.get(branch)!)!;
    return Object.fromEntries(
      this.trees
        .get(c.tree)!
        .filter((e) => e.type === "blob")
        .map((e) => [e.path, this.blobs.get(e.sha)!.toString()]),
    );
  }
  modify(files: Record<string, string>, message = "external") {
    return this.seed({ ...this.files(), ...files }, message);
  }
  install() {
    vi.stubGlobal("fetch", this.fetch);
  }
  fetch = async (
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    const url = new URL(String(input));
    const route =
      decodeURIComponent(url.pathname.replace(/^\/repos\/[^/]+\/[^/]+/, "")) +
      url.search;
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    this.calls.push({ route, method, body });
    if (this.failAt === `${method} ${route.split("?")[0]}`)
      return Response.json({ error: "injected" }, { status: 500 });
    if (route === "") return Response.json({ private: true });
    const ref = route.match(/^\/git\/refs?\/heads\/(.+)$/);
    if (ref) {
      if (method === "GET")
        return this.refs.has(ref[1]!)
          ? Response.json({ object: { sha: this.refs.get(ref[1]!) } })
          : Response.json({}, { status: 404 });
      if (method === "PATCH") {
        const commit = this.commits.get(body.sha)!;
        if (
          body.force !== false ||
          commit.parents[0]?.sha !== this.refs.get(ref[1]!)
        )
          return Response.json({}, { status: 422 });
        this.refs.set(ref[1]!, body.sha);
        if (this.lostPatch) {
          this.lostPatch = false;
          throw new Error("lost response");
        }
        return Response.json({ object: { sha: body.sha } });
      }
    }
    if (route.startsWith("/git/commits/") && method === "GET") {
      const c = this.commits.get(route.split("/").pop()!);
      return c
        ? Response.json({ ...c, tree: { sha: c.tree } })
        : Response.json({}, { status: 404 });
    }
    if (route.startsWith("/git/trees/") && method === "GET")
      return Response.json({
        truncated: false,
        tree: this.trees.get(route.split("/").pop()!.split("?")[0]!),
      });
    if (route.startsWith("/git/blobs/") && method === "GET") {
      const b = this.blobs.get(route.split("/").pop()!)!;
      return Response.json({
        encoding: "base64",
        content: Buffer.from(b).toString("base64"),
        size: b.length,
      });
    }
    if (route.startsWith("/commits?")) {
      const all: Commit[] = [];
      let current = url.searchParams.get("sha")!;
      while (this.commits.has(current)) {
        const c = this.commits.get(current)!;
        const prefix = url.searchParams.get("path");
        if (
          !prefix ||
          c.changed.some((p) => p === prefix || p.startsWith(prefix + "/"))
        )
          all.push(c);
        current = c.parents[0]?.sha ?? "";
      }
      const page = Number(url.searchParams.get("page") ?? "1");
      return Response.json(all.slice((page - 1) * 100, page * 100));
    }
    if (route === "/git/blobs" && method === "POST") {
      const bytes = Buffer.from(
        body.content,
        body.encoding === "base64" ? "base64" : "utf8",
      );
      const id = blobSha(bytes);
      this.blobs.set(id, bytes);
      return Response.json({ sha: id });
    }
    if (route === "/git/trees" && method === "POST") {
      const entries = new Map(
        (this.trees.get(body.base_tree) ?? [])
          .filter((e) => e.type !== "tree")
          .map((e) => [e.path, e]),
      );
      for (const e of body.tree as Entry[]) {
        if (e.sha === null) entries.delete(e.path);
        else entries.set(e.path, { ...e, size: this.blobs.get(e.sha)?.length });
      }
      return Response.json({ sha: this.tree([...entries.values()]) });
    }
    if (route === "/git/commits" && method === "POST") {
      const id = sha(`commit ${++this.count} ${body.tree}`);
      const old = this.trees.get(this.commits.get(body.parents[0])!.tree)!;
      const now = this.trees.get(body.tree)!;
      const changed = [...new Set([...old, ...now].map((e) => e.path))].filter(
        (p) =>
          old.find((e) => e.path === p)?.sha !==
          now.find((e) => e.path === p)?.sha,
      );
      this.commits.set(id, {
        sha: id,
        tree: body.tree,
        parents: body.parents.map((sha: string) => ({ sha })),
        commit: { message: body.message },
        changed,
      });
      return Response.json({ sha: id });
    }
    if (route === "/actions/workflows/sync.yml/dispatches")
      return this.dispatchDenied
        ? Response.json({}, { status: 403 })
        : Response.json({
            workflow_run_id: 42,
            html_url: "https://github.com/example/run/42",
          });
    throw new Error(`unhandled fake route ${method} ${route}`);
  };
}
