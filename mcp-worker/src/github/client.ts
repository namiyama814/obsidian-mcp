import {
  isVaultDirectoryName,
  normalizeNotePath,
  PathValidationError,
  toRepoPath,
  toVaultSubdir,
  validateVaultName,
} from "../../../shared/src/paths.ts";
import { fail, ok, type ToolResult } from "../../../shared/src/response.ts";

export type GitHubRepoConfig = {
  token: string;
  owner: string;
  repo: string;
  branch: string;
};

type GitHubContentFile = {
  type: "file";
  name: string;
  path: string;
  sha: string;
  size: number;
  content?: string;
  encoding?: string;
  download_url: string | null;
  html_url?: string;
};

type GitHubContentDir = {
  type: "dir";
  name: string;
  path: string;
  sha: string;
};

type GitHubContentEntry = GitHubContentFile | GitHubContentDir | {
  type: string;
  name: string;
  path: string;
  sha: string;
};

type GitTreeEntry = {
  path?: string;
  mode?: string;
  type?: string;
  sha?: string;
  size?: number;
  url?: string;
};

type GitTreeResponse = {
  sha: string;
  truncated: boolean;
  tree: GitTreeEntry[];
};

type CommitInfo = {
  sha: string;
  message: string;
  author?: { name?: string; date?: string };
  committer?: { name?: string; date?: string };
};

export class GitHubApiError extends Error {
  readonly status: number;
  readonly body: string;

  constructor(status: number, body: string, message: string) {
    super(message);
    this.name = "GitHubApiError";
    this.status = status;
    this.body = body;
  }
}

export class GitHubObsidianClient {
  readonly config: GitHubRepoConfig;

  constructor(config: GitHubRepoConfig) {
    this.config = config;
  }

  private get apiBase(): string {
    return `https://api.github.com/repos/${this.config.owner}/${this.config.repo}`;
  }

  private headers(extra?: HeadersInit): Headers {
    const headers = new Headers(extra);
    headers.set("Accept", "application/vnd.github+json");
    headers.set("Authorization", `Bearer ${this.config.token}`);
    headers.set("X-GitHub-Api-Version", "2022-11-28");
    headers.set("User-Agent", "obsidian-mcp-worker");
    return headers;
  }

  private async request<T>(
    path: string,
    init?: RequestInit,
  ): Promise<{ data: T; status: number; headers: Headers }> {
    const url = path.startsWith("https://") ? path : `${this.apiBase}${path}`;
    let response: Response;
    try {
      response = await fetch(url, {
        ...init,
        headers: this.headers(init?.headers),
      });
    } catch (error) {
      console.error("github_api_failure", {
        path: path.replace(/https:\/\/api\.github\.com/, ""),
        error: error instanceof Error ? error.message : "fetch_failed",
      });
      throw new GitHubApiError(0, "", "GitHub API request failed.");
    }

    const bodyText = await response.text();
    if (!response.ok) {
      console.error("github_api_failure", {
        path: path.replace(/https:\/\/api\.github\.com/, ""),
        status: response.status,
      });
      throw new GitHubApiError(
        response.status,
        bodyText.slice(0, 500),
        `GitHub API error (${response.status}).`,
      );
    }

    const data = (bodyText ? JSON.parse(bodyText) : null) as T;
    return { data, status: response.status, headers: response.headers };
  }

  async listVaults(): Promise<ToolResult> {
    try {
      const { data } = await this.request<GitHubContentEntry[]>(
        `/contents/?ref=${encodeURIComponent(this.config.branch)}`,
      );
      if (!Array.isArray(data)) {
        return fail("UNEXPECTED", "Repository root is not a directory listing.");
      }
      const vaults = data
        .filter((entry) => entry.type === "dir" && isVaultDirectoryName(entry.name))
        .map((entry) => entry.name)
        .sort((a, b) => a.localeCompare(b));
      return ok({ vaults });
    } catch (error) {
      return this.mapError(error);
    }
  }

  async listNotes(input: {
    vault: string;
    path?: string;
    recursive?: boolean;
  }): Promise<ToolResult> {
    try {
      const vault = validateVaultName(input.vault);
      const prefix = toVaultSubdir(vault, input.path);
      await this.assertVaultExists(vault);

      const recursive = input.recursive !== false;
      if (recursive) {
        const notes = await this.listMarkdownViaTree(prefix);
        return ok({ vault, path: input.path ?? "", recursive: true, notes });
      }

      const { data } = await this.request<GitHubContentEntry[]>(
        `/contents/${encodeURIComponent(prefix).replace(/%2F/g, "/")}?ref=${encodeURIComponent(this.config.branch)}`,
      );
      if (!Array.isArray(data)) {
        return fail("NOT_A_DIRECTORY", "The given path is not a directory.");
      }
      const notes = data
        .filter((entry) => entry.type === "file" && entry.name.toLowerCase().endsWith(".md"))
        .map((entry) => ({
          path: entry.path.slice(vault.length + 1),
          name: entry.name,
          sha: entry.sha,
          size: "size" in entry && typeof entry.size === "number" ? entry.size : undefined,
        }));
      return ok({ vault, path: input.path ?? "", recursive: false, notes });
    } catch (error) {
      return this.mapError(error);
    }
  }

  async readNote(input: { vault: string; path: string }): Promise<ToolResult> {
    try {
      const vault = validateVaultName(input.vault);
      const notePath = normalizeNotePath(input.path);
      const repoPath = toRepoPath(vault, notePath);
      await this.assertVaultExists(vault);
      const file = await this.getFile(repoPath);
      if (!file) {
        return fail("NOT_FOUND", `Note not found: ${vault}/${notePath}`);
      }
      const content = decodeFileContent(file);
      const commit = await this.latestCommitForPath(repoPath);
      return ok({
        vault,
        path: notePath,
        content,
        sha: file.sha,
        size: file.size,
        htmlUrl: file.html_url,
        lastCommit: commit
          ? {
              sha: commit.sha,
              message: commit.message,
              author: commit.author?.name,
              date: commit.author?.date ?? commit.committer?.date,
            }
          : undefined,
      });
    } catch (error) {
      return this.mapError(error);
    }
  }

  async searchNotes(input: {
    query: string;
    vault?: string;
    limit?: number;
  }): Promise<ToolResult> {
    try {
      const query = input.query?.trim();
      if (!query) {
        return fail("INVALID_QUERY", "query is required.");
      }
      const limit = Math.min(Math.max(input.limit ?? 20, 1), 50);
      let vault: string | undefined;
      if (input.vault) {
        vault = validateVaultName(input.vault);
        await this.assertVaultExists(vault);
      }

      const codeSearch = await this.tryCodeSearch(query, vault, limit);
      if (codeSearch) {
        return ok({
          query,
          vault: vault ?? null,
          method: "code_search",
          count: codeSearch.length,
          results: codeSearch,
        });
      }

      const local = await this.localSearch(query, vault, limit);
      return ok({
        query,
        vault: vault ?? null,
        method: "tree_scan",
        count: local.length,
        results: local,
      });
    } catch (error) {
      return this.mapError(error);
    }
  }

  async createNote(input: {
    vault: string;
    path: string;
    content: string;
    commitMessage?: string;
  }): Promise<ToolResult> {
    try {
      const vault = validateVaultName(input.vault);
      const notePath = normalizeNotePath(input.path);
      const repoPath = toRepoPath(vault, notePath);
      await this.assertVaultExists(vault);

      const existing = await this.getFile(repoPath);
      if (existing) {
        return fail("ALREADY_EXISTS", `Note already exists: ${vault}/${notePath}`, {
          currentSha: existing.sha,
        });
      }

      const message =
        input.commitMessage?.trim() || `MCP: create ${vault}/${notePath}`;
      const created = await this.putFile({
        path: repoPath,
        content: input.content,
        message,
      });
      return ok({
        vault,
        path: notePath,
        sha: created.content.sha,
        commitSha: created.commit.sha,
        htmlUrl: created.content.html_url,
      });
    } catch (error) {
      return this.mapError(error);
    }
  }

  async updateNote(input: {
    vault: string;
    path: string;
    content: string;
    expectedSha?: string;
    commitMessage?: string;
  }): Promise<ToolResult> {
    try {
      const vault = validateVaultName(input.vault);
      const notePath = normalizeNotePath(input.path);
      const repoPath = toRepoPath(vault, notePath);
      await this.assertVaultExists(vault);
      const current = await this.getFile(repoPath);
      if (!current) {
        return fail("NOT_FOUND", `Note not found: ${vault}/${notePath}`);
      }

      if (input.expectedSha && input.expectedSha !== current.sha) {
        return fail("CONFLICT", "The note changed after it was read.", {
          currentSha: current.sha,
        });
      }

      const message =
        input.commitMessage?.trim() || `MCP: update ${vault}/${notePath}`;
      try {
        const updated = await this.putFile({
          path: repoPath,
          content: input.content,
          message,
          sha: current.sha,
        });
        return ok({
          vault,
          path: notePath,
          sha: updated.content.sha,
          commitSha: updated.commit.sha,
          htmlUrl: updated.content.html_url,
        });
      } catch (error) {
        if (error instanceof GitHubApiError && error.status === 409) {
          const latest = await this.getFile(repoPath);
          return fail("CONFLICT", "The note changed after it was read.", {
            currentSha: latest?.sha ?? current.sha,
          });
        }
        throw error;
      }
    } catch (error) {
      return this.mapError(error);
    }
  }

  async appendNote(input: {
    vault: string;
    path: string;
    content: string;
    expectedSha?: string;
    commitMessage?: string;
  }): Promise<ToolResult> {
    try {
      const vault = validateVaultName(input.vault);
      const notePath = normalizeNotePath(input.path);
      const repoPath = toRepoPath(vault, notePath);
      await this.assertVaultExists(vault);
      const current = await this.getFile(repoPath);
      if (!current) {
        return fail("NOT_FOUND", `Note not found: ${vault}/${notePath}`);
      }

      if (input.expectedSha && input.expectedSha !== current.sha) {
        return fail("CONFLICT", "The note changed after it was read.", {
          currentSha: current.sha,
        });
      }

      const existingContent = decodeFileContent(current);
      const separator =
        existingContent.length === 0 || existingContent.endsWith("\n")
          ? ""
          : "\n";
      const nextContent = `${existingContent}${separator}${input.content}`;
      const message =
        input.commitMessage?.trim() || `MCP: append ${vault}/${notePath}`;

      // Re-check SHA immediately before write.
      const latest = await this.getFile(repoPath);
      if (!latest) {
        return fail("NOT_FOUND", `Note not found: ${vault}/${notePath}`);
      }
      if (latest.sha !== current.sha) {
        return fail("CONFLICT", "The note changed after it was read.", {
          currentSha: latest.sha,
        });
      }
      if (input.expectedSha && input.expectedSha !== latest.sha) {
        return fail("CONFLICT", "The note changed after it was read.", {
          currentSha: latest.sha,
        });
      }

      try {
        const updated = await this.putFile({
          path: repoPath,
          content: nextContent,
          message,
          sha: latest.sha,
        });
        return ok({
          vault,
          path: notePath,
          sha: updated.content.sha,
          commitSha: updated.commit.sha,
          htmlUrl: updated.content.html_url,
        });
      } catch (error) {
        if (error instanceof GitHubApiError && error.status === 409) {
          const again = await this.getFile(repoPath);
          return fail("CONFLICT", "The note changed after it was read.", {
            currentSha: again?.sha ?? latest.sha,
          });
        }
        throw error;
      }
    } catch (error) {
      return this.mapError(error);
    }
  }

  async deleteNote(input: {
    vault: string;
    path: string;
    expectedSha?: string;
    commitMessage?: string;
  }): Promise<ToolResult> {
    try {
      const vault = validateVaultName(input.vault);
      const path = normalizeNotePath(input.path);
      const repoPath = toRepoPath(vault, path);
      await this.assertVaultExists(vault);
      const current = await this.getFile(repoPath);
      if (!current) return fail("NOT_FOUND", `Note not found: ${repoPath}`);
      if (input.expectedSha && input.expectedSha !== current.sha) {
        return fail("CONFLICT", "The note changed after it was read.", {
          currentSha: current.sha,
        });
      }
      const { data } = await this.request<{ commit: { sha: string } }>(
        `/contents/${encodeURIComponent(repoPath).replace(/%2F/g, "/")}`,
        {
          method: "DELETE",
          body: JSON.stringify({
            branch: this.config.branch,
            sha: current.sha,
            message: input.commitMessage?.trim() || `MCP: delete ${repoPath}`,
          }),
        },
      );
      return ok({ vault, path, deleted: true, sha: current.sha, commitSha: data.commit.sha });
    } catch (error) {
      return this.mapError(error);
    }
  }

  async moveNote(input: {
    vault: string;
    path: string;
    destinationPath: string;
    destinationVault?: string;
    expectedSha?: string;
    commitMessage?: string;
  }): Promise<ToolResult> {
    try {
      const vault = validateVaultName(input.vault);
      const path = normalizeNotePath(input.path);
      const destinationVault = validateVaultName(input.destinationVault ?? vault);
      const destinationPath = normalizeNotePath(input.destinationPath);
      const source = toRepoPath(vault, path);
      const destination = toRepoPath(destinationVault, destinationPath);
      if (source === destination) return fail("INVALID_PATH", "Source and destination must differ.");

      // All checks use one immutable snapshot; publish both changes together.
      const branch = encodeURIComponent(this.config.branch).replace(/%2F/g, "/");
      const { data: ref } = await this.request<{ object: { sha: string } }>(`/git/ref/heads/${branch}`);
      const head = ref.object.sha;
      const { data: commit } = await this.request<{ tree: { sha: string } }>(`/git/commits/${head}`);
      const { data: tree } = await this.request<GitTreeResponse>(`/git/trees/${commit.tree.sha}?recursive=1`);
      if (tree.truncated) return fail("TREE_TRUNCATED", "Cannot safely move a note with an incomplete repository tree.");
      const entries = new Map(tree.tree.map((entry) => [entry.path, entry]));
      for (const name of new Set([vault, destinationVault])) {
        if (entries.get(name)?.type !== "tree") return fail("INVALID_VAULT", `Vault not found: ${name}`);
      }
      const current = entries.get(source);
      if (!current || current.type !== "blob") return fail("NOT_FOUND", `Note not found: ${source}`);
      if (!current.sha || (current.mode !== "100644" && current.mode !== "100755")) {
        return fail("INVALID_PATH", "Only regular Markdown files can be moved.");
      }
      if (input.expectedSha && input.expectedSha !== current.sha) {
        return fail("CONFLICT", "The note changed after it was read.", { currentSha: current.sha });
      }
      if (entries.has(destination)) return fail("ALREADY_EXISTS", `Destination already exists: ${destination}`);
      const parts = destination.split("/");
      for (let i = 1; i < parts.length; i += 1) {
        const parent = entries.get(parts.slice(0, i).join("/"));
        if (parent && parent.type !== "tree") return fail("NOT_A_DIRECTORY", "Destination parent is not a directory.");
      }
      const { data: nextTree } = await this.request<{ sha: string }>("/git/trees", {
        method: "POST",
        body: JSON.stringify({
          base_tree: commit.tree.sha,
          tree: [
            { path: source, mode: current.mode, type: "blob", sha: null },
            { path: destination, mode: current.mode, type: "blob", sha: current.sha },
          ],
        }),
      });
      const { data: nextCommit } = await this.request<{ sha: string }>("/git/commits", {
        method: "POST",
        body: JSON.stringify({
          message: input.commitMessage?.trim() || `MCP: move ${source} to ${destination}`,
          tree: nextTree.sha,
          parents: [head],
        }),
      });
      try {
        await this.request(`/git/refs/heads/${branch}`, {
          method: "PATCH",
          body: JSON.stringify({ sha: nextCommit.sha, force: false }),
        });
      } catch (error) {
        // GitHub uses 422 for a rejected non-fast-forward ref update.
        if (error instanceof GitHubApiError && (error.status === 409 || error.status === 422)) {
          return fail("CONFLICT", "The branch changed or rejected the move. Read the note again before retrying.");
        }
        throw error;
      }
      return ok({ vault, path, destinationVault, destinationPath, sha: current.sha, commitSha: nextCommit.sha });
    } catch (error) {
      return this.mapError(error);
    }
  }

  private async assertVaultExists(vault: string): Promise<void> {
    try {
      // GitHub Contents API returns an array for directories, a single object for files.
      const { data } = await this.request<GitHubContentEntry | GitHubContentEntry[]>(
        `/contents/${encodeURIComponent(vault)}?ref=${encodeURIComponent(this.config.branch)}`,
      );
      const isDirectory =
        Array.isArray(data) ||
        (!!data && !Array.isArray(data) && data.type === "dir");
      if (!isDirectory) {
        throw new PathValidationError("INVALID_VAULT", `Vault not found: ${vault}`);
      }
    } catch (error) {
      if (error instanceof GitHubApiError && error.status === 404) {
        throw new PathValidationError("INVALID_VAULT", `Vault not found: ${vault}`);
      }
      throw error;
    }
  }

  private async getFile(repoPath: string): Promise<GitHubContentFile | null> {
    try {
      const { data } = await this.request<GitHubContentFile>(
        `/contents/${encodeURIComponent(repoPath).replace(/%2F/g, "/")}?ref=${encodeURIComponent(this.config.branch)}`,
      );
      if (!data || data.type !== "file") return null;
      return data;
    } catch (error) {
      if (error instanceof GitHubApiError && error.status === 404) return null;
      throw error;
    }
  }

  private async putFile(input: {
    path: string;
    content: string;
    message: string;
    sha?: string;
  }): Promise<{
    content: { sha: string; html_url?: string };
    commit: { sha: string };
  }> {
    const body: Record<string, string> = {
      message: input.message,
      content: encodeBase64Utf8(input.content),
      branch: this.config.branch,
    };
    if (input.sha) body.sha = input.sha;

    const { data } = await this.request<{
      content: { sha: string; html_url?: string };
      commit: { sha: string };
    }>(
      `/contents/${encodeURIComponent(input.path).replace(/%2F/g, "/")}`,
      {
        method: "PUT",
        body: JSON.stringify(body),
      },
    );
    return data;
  }

  private async latestCommitForPath(repoPath: string): Promise<CommitInfo | null> {
    try {
      const { data } = await this.request<CommitInfo[]>(
        `/commits?path=${encodeURIComponent(repoPath)}&sha=${encodeURIComponent(this.config.branch)}&per_page=1`,
      );
      return Array.isArray(data) && data[0] ? data[0] : null;
    } catch {
      return null;
    }
  }

  private async listMarkdownViaTree(prefix: string): Promise<
    Array<{ path: string; sha?: string; size?: number }>
  > {
    const { data } = await this.request<{ commit: { sha: string } }>(
      `/branches/${encodeURIComponent(this.config.branch)}`,
    );
    const treeSha = data.commit.sha;
    const { data: tree } = await this.request<GitTreeResponse>(
      `/git/trees/${treeSha}?recursive=1`,
    );
    if (tree.truncated) {
      console.error("github_api_failure", { reason: "tree_truncated" });
    }
    const vault = prefix.split("/")[0] ?? "";
    return tree.tree
      .filter(
        (entry) =>
          entry.type === "blob" &&
          typeof entry.path === "string" &&
          entry.path.startsWith(`${prefix}/`) &&
          entry.path.toLowerCase().endsWith(".md"),
      )
      .map((entry) => ({
        path: (entry.path as string).slice(vault.length + 1),
        sha: entry.sha,
        size: entry.size,
      }))
      .sort((a, b) => a.path.localeCompare(b.path));
  }

  private async tryCodeSearch(
    query: string,
    vault: string | undefined,
    limit: number,
  ): Promise<Array<{
    vault: string;
    path: string;
    name: string;
    htmlUrl?: string;
    score?: number;
  }> | null> {
    const qParts = [
      query,
      `repo:${this.config.owner}/${this.config.repo}`,
      "extension:md",
    ];
    if (vault) qParts.push(`path:${vault}`);

    const url =
      `https://api.github.com/search/code?q=${encodeURIComponent(qParts.join(" "))}&per_page=${limit}`;
    try {
      const { data } = await this.request<{
        items?: Array<{
          name: string;
          path: string;
          html_url?: string;
          score?: number;
        }>;
      }>(url);
      const items = data.items ?? [];
      return items
        .map((item) => {
          const slash = item.path.indexOf("/");
          if (slash <= 0) return null;
          const itemVault = item.path.slice(0, slash);
          if (!isVaultDirectoryName(itemVault)) return null;
          if (vault && itemVault !== vault) return null;
          return {
            vault: itemVault,
            path: item.path.slice(slash + 1),
            name: item.name,
            htmlUrl: item.html_url,
            score: item.score,
          };
        })
        .filter((x): x is NonNullable<typeof x> => x !== null);
    } catch (error) {
      if (error instanceof GitHubApiError) {
        console.error("github_api_failure", {
          reason: "code_search_unavailable",
          status: error.status,
        });
        return null;
      }
      throw error;
    }
  }

  private async localSearch(
    query: string,
    vault: string | undefined,
    limit: number,
  ): Promise<
    Array<{
      vault: string;
      path: string;
      name: string;
      match: "filename" | "content";
      snippet?: string;
    }>
  > {
    const lower = query.toLowerCase();
    const prefixes = vault
      ? [vault]
      : (await this.listVaultNames());

    const results: Array<{
      vault: string;
      path: string;
      name: string;
      match: "filename" | "content";
      snippet?: string;
    }> = [];

    const maxFilesToScan = 80;
    let scanned = 0;

    for (const v of prefixes) {
      const notes = await this.listMarkdownViaTree(v);
      for (const note of notes) {
        if (results.length >= limit) return results;
        const name = note.path.split("/").pop() ?? note.path;
        if (note.path.toLowerCase().includes(lower) || name.toLowerCase().includes(lower)) {
          results.push({ vault: v, path: note.path, name, match: "filename" });
          continue;
        }
        if (scanned >= maxFilesToScan) continue;
        scanned += 1;
        const file = await this.getFile(`${v}/${note.path}`);
        if (!file) continue;
        const content = decodeFileContent(file);
        const idx = content.toLowerCase().indexOf(lower);
        if (idx >= 0) {
          const start = Math.max(0, idx - 40);
          const end = Math.min(content.length, idx + query.length + 40);
          results.push({
            vault: v,
            path: note.path,
            name,
            match: "content",
            snippet: content.slice(start, end),
          });
        }
      }
    }
    return results;
  }

  private async listVaultNames(): Promise<string[]> {
    const listed = await this.listVaults();
    if (!listed.ok) return [];
    return (listed.vaults as string[]) ?? [];
  }

  private mapError(error: unknown): ToolResult {
    if (error instanceof PathValidationError) {
      return fail(error.code, error.message);
    }
    if (error instanceof GitHubApiError) {
      if (error.status === 404) return fail("NOT_FOUND", "Resource not found on GitHub.");
      if (error.status === 409) {
        return fail("CONFLICT", "GitHub reported a conflict while writing the note.");
      }
      if (error.status === 403 || error.status === 429) {
        return fail("RATE_LIMITED", "GitHub API rate limit or permission error.");
      }
      return fail("GITHUB_ERROR", error.message);
    }
    console.error("github_api_failure", {
      error: error instanceof Error ? error.message : "unknown",
    });
    return fail("INTERNAL", "Unexpected error while talking to GitHub.");
  }
}

function decodeFileContent(file: GitHubContentFile): string {
  if (!file.content) return "";
  const encoding = file.encoding ?? "base64";
  if (encoding !== "base64") {
    throw new GitHubApiError(0, "", `Unsupported content encoding: ${encoding}`);
  }
  return decodeBase64Utf8(file.content.replace(/\n/g, ""));
}

function encodeBase64Utf8(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function decodeBase64Utf8(b64: string): string {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}
