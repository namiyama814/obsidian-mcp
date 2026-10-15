import type { GitHubRepoConfig } from "../github/client.ts";
import { createHash } from "node:crypto";

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

// Labels must never contain document paths, query strings, or signed URLs.
function apiOperation(route: string): string {
  if (!route) return "repository.metadata";
  if (route.startsWith("/git/")) {
    const resource = route.split("/")[2];
    if (["ref", "refs", "commits", "trees", "blobs"].includes(resource ?? ""))
      return `git.${resource}`;
  }
  if (route.startsWith("/commits")) return "repository.history";
  if (route.startsWith("/actions/")) return "actions.api";
  return "repository.api";
}

/** Each instance belongs to one MCP request. No cross-user caches or credentials. */
export class PublicationRepository {
  private calls = 0;
  private bytesRead = 0;
  private blobs = new Map<string, Promise<string>>();
  constructor(readonly config: GitHubRepoConfig) {}
  /** Bound the entire response consumption, not only the response headers. */
  private async request<T>(
    url: string | URL,
    init: RequestInit,
    operation: string,
    consume: (response: Response) => Promise<T>,
  ): Promise<T> {
    const started = Date.now();
    let signal: AbortSignal | undefined;
    try {
      signal = AbortSignal.timeout(30000);
      // workerd rejects redirect:"error" before sending any request.
      // manual never forwards credentials; callers explicitly reject 3xx.
      const response = await fetch(url, {
        ...init,
        signal,
        redirect: "manual",
      });
      return await consume(response);
    } catch (error) {
      const timedOut =
        signal?.aborted ||
        (error instanceof Error && error.name === "TimeoutError");
      const subrequestLimit =
        error instanceof Error &&
        /^Too many (subrequests|API requests)\b/.test(error.message);
      const code =
        error instanceof PublicationError
          ? error.code
          : subrequestLimit
            ? "VERIFICATION_LIMIT"
            : timedOut
              ? "GITHUB_TIMEOUT"
              : error instanceof SyntaxError
                ? "GITHUB_INVALID_RESPONSE"
                : "GITHUB_UNAVAILABLE";
      // Raw exception messages can contain tokens, signed URLs or private data.
      const errorName =
        error instanceof PublicationError
          ? "PublicationError"
          : error instanceof TypeError
            ? "TypeError"
            : error instanceof SyntaxError
              ? "SyntaxError"
              : timedOut
                ? "TimeoutError"
                : "Error";
      console.error("publication_github_request_failed", {
        operation,
        method: init.method ?? "GET",
        requestCount: this.calls,
        errorName,
        errorMessage: subrequestLimit
          ? "worker_subrequest_limit"
          : error instanceof TypeError &&
              error.message.startsWith("Invalid redirect value")
            ? "unsupported_redirect_mode"
            : code,
        requestDurationMs: Date.now() - started,
      });
      if (error instanceof PublicationError) throw error;
      throw new PublicationError(
        code,
        subrequestLimit
          ? "Workerの通信回数上限に達しました。検証を省略せず停止しました。"
          : code === "GITHUB_TIMEOUT"
            ? "GitHub APIがタイムアウトしました。変更結果は同じ確認トークンで確認してください。"
            : code === "GITHUB_INVALID_RESPONSE"
              ? "GitHub応答の形式を確認できません。"
              : "GitHub応答を確認できません。",
      );
    }
  }
  private async checkResponse(response: Response, operation: string) {
    if (response.ok) return;
    const status = response.status;
    // Do not log Location, response bodies, headers, or request URLs.
    console.error("publication_github_http_failed", { operation, status });
    try {
      await response.body?.cancel();
    } catch {
      // Preserve the known HTTP status even if discarding the body fails.
    }
    throw new PublicationError(
      status >= 300 && status < 400
        ? "GITHUB_REDIRECT_REJECTED"
        : status === 404
          ? "NOT_FOUND"
          : [401, 403].includes(status)
            ? "PERMISSION_DENIED"
            : status === 429
              ? "GITHUB_RATE_LIMITED"
              : [409, 422].includes(status)
                ? "CONFLICT"
                : "GITHUB_ERROR",
      `GitHub APIに失敗しました (${status})。`,
    );
  }
  async api<T>(route: string, method = "GET", body?: unknown): Promise<T> {
    if (++this.calls > 800)
      throw new PublicationError(
        "VERIFICATION_LIMIT",
        "Git履歴・参照の検証量が上限を超えました。変更していません。",
      );
    if (route && (!route.startsWith("/") || route.startsWith("//")))
      throw new PublicationError("INVALID_PATH", "API route rejected");
    const operation = apiOperation(route);
    return this.request(
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
      },
      operation,
      async (response) => {
        await this.checkResponse(response, operation);
        if (response.status === 204) return undefined as T;
        return (await response.json()) as T;
      },
    );
  }
  async jobLog(jobId: number): Promise<string> {
    if (!Number.isSafeInteger(jobId) || jobId <= 0 || ++this.calls > 800)
      throw new PublicationError(
        "VERIFICATION_LIMIT",
        "同期ログを取得できません。",
      );
    const result = await this.request<string | URL>(
      `https://api.github.com/repos/${encodeURIComponent(this.config.owner)}/${encodeURIComponent(this.config.repo)}/actions/jobs/${jobId}/logs`,
      {
        headers: {
          Authorization: `Bearer ${this.config.token}`,
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2026-03-10",
          "User-Agent": "obsidian-mcp-worker",
        },
      },
      "actions.job_log",
      async (response) => {
        if (response.status === 302) {
          const location = response.headers.get("Location");
          await response.body?.cancel();
          let url: URL | undefined;
          try {
            url = location ? new URL(location) : undefined;
          } catch {
            /* rejected below */
          }
          if (
            !url ||
            url.protocol !== "https:" ||
            url.username ||
            url.password ||
            url.port ||
            !(
              url.hostname.endsWith(".blob.core.windows.net") ||
              url.hostname.endsWith(".actions.githubusercontent.com")
            )
          )
            throw new PublicationError(
              "UNTRUSTED_LOG_URL",
              "同期ログの取得先を検証できません。",
            );
          return url;
        }
        await this.checkResponse(response, "actions.job_log");
        return this.readLog(response);
      },
    );
    if (typeof result === "string") return result;
    // Signed URL only. Never forward the GitHub Authorization header.
    return this.request(result, {}, "actions.signed_log", async (response) => {
      await this.checkResponse(response, "actions.signed_log");
      return this.readLog(response);
    });
  }
  private async readLog(response: Response): Promise<string> {
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
  /** Batch immutable Markdown blobs; every note is still scanned for incoming links.
   * A move across a real vault must fit Workers Free's external request budget.
   * Validate bytes against the snapshot's Git SHA before trusting GraphQL text.
   */
  async prefetchText(snapshot: Snapshot, paths: string[]): Promise<void> {
    const missing = new Map<string, Entry>();
    for (const path of paths) {
      const entry = this.regular(snapshot, path);
      if ((entry.size ?? 0) > 1_000_000)
        throw new PublicationError(
          "VERIFICATION_LIMIT",
          "Markdown・台帳の検証上限は1MBです。",
        );
      if (!this.blobs.has(entry.sha)) missing.set(entry.sha, entry);
    }
    // Small scans use the existing REST API without an extra batching request.
    if (missing.size < 8) return;
    const entries = [...missing.values()];
    for (let start = 0; start < entries.length; start += 20) {
      if (++this.calls > 800)
        throw new PublicationError(
          "VERIFICATION_LIMIT",
          "Git参照の検証量が上限を超えました。",
        );
      const batch = entries.slice(start, start + 20);
      const variables: Record<string, string> = {
        owner: this.config.owner,
        name: this.config.repo,
      };
      batch.forEach((e, i) => {
        variables[`s${i}`] = e.sha;
      });
      const query = `query($owner:String!,$name:String!,${batch.map((_, i) => `$s${i}:GitObjectID!`).join(",")}) {
        repository(owner:$owner,name:$name) {
          ${batch.map((_, i) => `b${i}:object(oid:$s${i}) { __typename oid ... on Blob { byteSize isBinary isTruncated text } }`).join("\n")}
        }
      }`;
      await this.request(
        "https://api.github.com/graphql",
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${this.config.token}`,
            "User-Agent": "obsidian-mcp-worker",
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ query, variables }),
        },
        "git.blobs_batch",
        async (response) => {
          await this.checkResponse(response, "git.blobs_batch");
          type BlobResult = {
            __typename: string;
            oid: string;
            byteSize: number;
            isBinary: boolean | null;
            isTruncated: boolean;
            text: string | null;
          };
          const result = (await response.json()) as {
            errors?: unknown[];
            data?: { repository?: Record<string, BlobResult | null> | null };
          };
          if (result.errors?.length || !result.data?.repository)
            throw new PublicationError(
              "GITHUB_ERROR",
              "GitHubの一括読み取りを確認できません。検証を省略せず停止しました。",
            );
          const verified: [string, string][] = [];
          let bytes = 0;
          for (const [i, entry] of batch.entries()) {
            const blob = result.data.repository[`b${i}`];
            if (
              !blob ||
              blob.__typename !== "Blob" ||
              blob.oid !== entry.sha ||
              blob.isTruncated !== false ||
              blob.isBinary !== false ||
              typeof blob.text !== "string"
            )
              throw new PublicationError(
                "GITHUB_INVALID_RESPONSE",
                "Git blobの完全なテキストを確認できません。",
              );
            const content = Buffer.from(blob.text, "utf8");
            if (content.length > 1_000_000)
              throw new PublicationError(
                "VERIFICATION_LIMIT",
                "Markdown・台帳の検証上限は1MBです。",
              );
            if (
              content.length !== blob.byteSize ||
              (entry.size !== undefined && content.length !== entry.size) ||
              createHash("sha1")
                .update(`blob ${content.length}\0`)
                .update(content)
                .digest("hex") !== entry.sha
            )
              throw new PublicationError(
                "GITHUB_INVALID_RESPONSE",
                "Git blobのサイズ・SHAが原本と一致しません。",
              );
            bytes += content.length;
            verified.push([entry.sha, content.toString("base64")]);
          }
          if (this.bytesRead + bytes > 32 * 1024 * 1024)
            throw new PublicationError(
              "VERIFICATION_LIMIT",
              "Git blobの合計32MiB上限を超えました。",
            );
          this.bytesRead += bytes;
          // Cache only fully verified responses, within this MCP request.
          for (const [sha, content] of verified)
            this.blobs.set(sha, Promise.resolve(content));
        },
      );
    }
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
