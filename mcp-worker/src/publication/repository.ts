import type { GitHubRepoConfig } from "../github/client.ts";

export class PublicationError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly details?: { candidates?: string[] },
  ) {
    super(message);
  }
}
export type Entry = {
  path: string;
  mode: string;
  type: string;
  sha: string;
  size?: number;
};
export type Snapshot = {
  head: string;
  tree: string;
  entries: Map<string, Entry>;
};
export type Change = {
  path: string;
  content?: string;
  sha?: string | null;
  mode?: string;
};
export type HistoryCommit = {
  sha: string;
  commit: { message: string };
  parents: { sha: string }[];
};

/** Each instance belongs to one MCP request. No cross-user caches or credentials. */
export class PublicationRepository {
  private calls = 0;
  private bytesRead = 0;
  private blobs = new Map<string, Promise<string>>();
  constructor(readonly config: GitHubRepoConfig) {}
  async api<T>(route: string, method = "GET", body?: unknown): Promise<T> {
    if (++this.calls > 800)
      throw new PublicationError(
        "VERIFICATION_LIMIT",
        "Git履歴・参照の検証量が上限を超えました。変更していません。",
      );
    if (route && (!route.startsWith("/") || route.startsWith("//")))
      throw new PublicationError("INVALID_PATH", "API route rejected");
    let response: Response;
    try {
      response = await fetch(
        `https://api.github.com/repos/${encodeURIComponent(this.config.owner)}/${encodeURIComponent(this.config.repo)}${route}`,
        {
          method,
          headers: {
            Authorization: `Bearer ${this.config.token}`,
            Accept: "application/vnd.github+json",
            "X-GitHub-Api-Version": "2026-03-10",
            "User-Agent": "obsidian-mcp-worker",
            "Content-Type": "application/json",
          },
          body: body === undefined ? undefined : JSON.stringify(body),
          signal: AbortSignal.timeout(30000),
          redirect: "error",
        },
      );
    } catch {
      throw new PublicationError(
        "GITHUB_UNAVAILABLE",
        "GitHub応答を確認できません。",
      );
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw new PublicationError(
        response.status === 404
          ? "NOT_FOUND"
          : response.status === 403
            ? "PERMISSION_DENIED"
            : [409, 422].includes(response.status)
              ? "CONFLICT"
              : "GITHUB_ERROR",
        `GitHub APIに失敗しました (${response.status})。`,
      );
    }
    if (response.status === 204) return undefined as T;
    return (await response.json()) as T;
  }
  async jobLog(jobId: number): Promise<string> {
    if (!Number.isSafeInteger(jobId) || jobId <= 0 || ++this.calls > 800)
      throw new PublicationError(
        "VERIFICATION_LIMIT",
        "同期ログを取得できません。",
      );
    let response = await fetch(
      `https://api.github.com/repos/${encodeURIComponent(this.config.owner)}/${encodeURIComponent(this.config.repo)}/actions/jobs/${jobId}/logs`,
      {
        headers: {
          Authorization: `Bearer ${this.config.token}`,
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2026-03-10",
          "User-Agent": "obsidian-mcp-worker",
        },
        redirect: "manual",
        signal: AbortSignal.timeout(30000),
      },
    );
    if (response.status === 302) {
      const location = response.headers.get("Location");
      const url = location ? new URL(location) : undefined;
      if (
        !url ||
        url.protocol !== "https:" ||
        url.username ||
        url.password ||
        !(
          url.hostname.endsWith(".blob.core.windows.net") ||
          url.hostname.endsWith(".actions.githubusercontent.com")
        )
      )
        throw new PublicationError(
          "UNTRUSTED_LOG_URL",
          "同期ログの取得先を検証できません。",
        );
      // Signed URL only. Never forward the GitHub Authorization header.
      response = await fetch(url, {
        redirect: "error",
        signal: AbortSignal.timeout(30000),
      });
    }
    if (!response.ok || !response.body)
      throw new PublicationError(
        "LOG_UNAVAILABLE",
        "同期ログを取得できません。",
      );
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let text = "",
      bytes = 0;
    try {
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) break;
        bytes += chunk.value.byteLength;
        if (bytes > 2 * 1024 * 1024)
          throw new PublicationError(
            "VERIFICATION_LIMIT",
            "同期ログが検証上限を超えました。",
          );
        text += decoder.decode(chunk.value, { stream: true });
      }
    } finally {
      await reader.cancel();
    }
    return text + decoder.decode();
  }
  async assertPrivate() {
    const repo = await this.api<{ private: boolean }>("");
    if (!repo.private)
      throw new PublicationError(
        "PUBLIC_REPOSITORY",
        "非公開リポジトリだけを操作できます。",
      );
  }
  async head(branch = this.config.branch) {
    return (
      await this.api<{ object: { sha: string } }>(
        `/git/ref/heads/${encodeURIComponent(branch)}`,
      )
    ).object.sha;
  }
  async snapshot(head?: string): Promise<Snapshot> {
    head ??= await this.head();
    const commit = await this.api<{ tree: { sha: string } }>(
      `/git/commits/${head}`,
    );
    const tree = await this.api<{ truncated: boolean; tree: Entry[] }>(
      `/git/trees/${commit.tree.sha}?recursive=1`,
    );
    if (tree.truncated)
      throw new PublicationError(
        "TREE_TRUNCATED",
        "不完全なGit treeでは安全に検証できません。",
      );
    return {
      head,
      tree: commit.tree.sha,
      entries: new Map(tree.tree.map((e) => [e.path, e])),
    };
  }
  regular(snapshot: Snapshot, path: string): Entry {
    const parts = path.split("/");
    for (let i = 1; i < parts.length; i++) {
      if (snapshot.entries.get(parts.slice(0, i).join("/"))?.type !== "tree")
        throw new PublicationError(
          "INVALID_PATH",
          "親フォルダが通常のGit treeではありません。",
        );
    }
    const entry = snapshot.entries.get(path);
    if (!entry)
      throw new PublicationError("NOT_FOUND", `ファイルがありません: ${path}`);
    if (entry.type !== "blob" || !["100644", "100755"].includes(entry.mode))
      throw new PublicationError(
        "UNSAFE_FILE",
        `通常ファイル以外は禁止です: ${path}`,
      );
    return entry;
  }
  destination(snapshot: Snapshot, path: string, allowExisting = false) {
    if (!allowExisting && snapshot.entries.has(path))
      throw new PublicationError(
        "ALREADY_EXISTS",
        "配置先が存在します。上書きしません。",
      );
    const parts = path.split("/");
    for (let i = 1; i < parts.length; i++) {
      const parent = snapshot.entries.get(parts.slice(0, i).join("/"));
      if (parent && parent.type !== "tree")
        throw new PublicationError(
          "UNSAFE_FILE",
          "配置先の親が通常フォルダではありません。",
        );
    }
  }
  blob(sha: string): Promise<string> {
    let pending = this.blobs.get(sha);
    if (!pending) {
      pending = this.api<{ encoding: string; content: string; size: number }>(
        `/git/blobs/${sha}`,
      ).then((blob) => {
        if (blob.encoding !== "base64" || blob.size > 25 * 1024 * 1024)
          throw new PublicationError(
            "UNSAFE_FILE",
            "添付の形式または25MiB上限を確認できません。",
          );
        this.bytesRead += blob.size;
        if (this.bytesRead > 32 * 1024 * 1024)
          throw new PublicationError(
            "VERIFICATION_LIMIT",
            "一つの処理で読み込むGit blobの合計32MiB上限を超えました。",
          );
        return blob.content.replace(/\s/g, "");
      });
      this.blobs.set(sha, pending);
    }
    return pending;
  }
  async text(snapshot: Snapshot, path: string) {
    const entry = this.regular(snapshot, path);
    if ((entry.size ?? 0) > 1_000_000)
      throw new PublicationError(
        "VERIFICATION_LIMIT",
        "Markdown・台帳の検証上限は1MBです。",
      );
    const bytes = Buffer.from(await this.blob(entry.sha), "base64");
    if (bytes.length > 1_000_000)
      throw new PublicationError(
        "VERIFICATION_LIMIT",
        "Markdown・台帳の検証上限は1MBです。",
      );
    return bytes.toString("utf8");
  }
  async commits(head: string, path?: string): Promise<HistoryCommit[]> {
    const all: HistoryCommit[] = [];
    for (let page = 1; ; page++) {
      const batch = await this.api<HistoryCommit[]>(
        `/commits?sha=${head}&per_page=100&page=${page}${path ? `&path=${encodeURIComponent(path)}` : ""}`,
      );
      all.push(...batch);
      if (batch.length < 100) return all;
    }
  }
  async atomic(
    snapshot: Snapshot,
    changes: Change[],
    marker: string,
  ): Promise<string> {
    if ((await this.head()) !== snapshot.head)
      throw new PublicationError(
        "CONFLICT",
        "ブランチ先頭が変更されました。再確認してください。",
      );
    const treeChanges: {
      path: string;
      mode: string;
      type: string;
      sha: string | null;
    }[] = [];
    for (const change of changes) {
      let sha = change.sha;
      if (change.content !== undefined)
        sha = (
          await this.api<{ sha: string }>("/git/blobs", "POST", {
            content: change.content,
            encoding: "utf-8",
          })
        ).sha;
      if (sha === undefined)
        throw new PublicationError("INVALID_INPUT", "Empty tree change");
      treeChanges.push({
        path: change.path,
        mode: change.mode ?? "100644",
        type: "blob",
        sha,
      });
    }
    const tree = await this.api<{ sha: string }>("/git/trees", "POST", {
      base_tree: snapshot.tree,
      tree: treeChanges,
    });
    const commit = await this.api<{ sha: string }>("/git/commits", "POST", {
      message: `MCP: publication\n\nPublication-Operation: ${marker}`,
      tree: tree.sha,
      parents: [snapshot.head],
    });
    if ((await this.head()) !== snapshot.head)
      throw new PublicationError(
        "CONFLICT",
        "ブランチ先頭が変更されました。再確認してください。",
      );
    try {
      await this.api(
        `/git/refs/heads/${encodeURIComponent(this.config.branch)}`,
        "PATCH",
        { sha: commit.sha, force: false },
      );
    } catch (error) {
      // The ref PATCH may have succeeded despite a lost response. Never issue another ID.
      try {
        const head = await this.head();
        if (
          head === commit.sha ||
          (await this.commits(head)).some((c) => c.sha === commit.sha)
        )
          return commit.sha;
      } catch {
        throw new PublicationError(
          "OUTCOME_UNKNOWN",
          "原本登録の成否を確認できません。同じ確認トークンで再確認してください。",
        );
      }
      throw error;
    }
    return commit.sha;
  }
}
