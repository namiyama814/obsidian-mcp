import { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { READ_SCOPE, WRITE_SCOPE } from "../../shared/src/scopes.ts";
import { fail, jsonToolResult, type ToolResult } from "../../shared/src/response.ts";
import type { GitHubObsidianClient } from "./github/client.ts";

type AuthInfoLike = {
  scopes?: string[];
};

type ToolExtra = {
  http?: { authInfo?: AuthInfoLike };
};

function hasScope(extra: ToolExtra | undefined, scope: string): boolean {
  const scopes = extra?.http?.authInfo?.scopes ?? [];
  return scopes.includes(scope);
}

function scopeDenied(
  missing: string[],
  resourceMetadataUrl: string,
): ReturnType<typeof jsonToolResult> {
  const result = fail(
    "INSUFFICIENT_SCOPE",
    `Missing required OAuth scope(s): ${missing.join(", ")}`,
  );
  return {
    ...jsonToolResult(result),
    // OpenAI Custom MCP: trigger step-up / re-auth UI
    _meta: {
      "mcp/www_authenticate": [
        `Bearer resource_metadata="${resourceMetadataUrl}", error="insufficient_scope", error_description="Missing scope ${missing.join(" ")}", scope="${missing.join(" ")}"`,
      ],
    },
  } as ReturnType<typeof jsonToolResult> & {
    _meta: Record<string, unknown>;
  };
}

function logToolCall(name: string, args: Record<string, unknown>): void {
  // Never log note body / tokens.
  const safe: Record<string, unknown> = { tool: name };
  for (const [key, value] of Object.entries(args)) {
    if (key === "content") {
      safe.contentLength =
        typeof value === "string" ? value.length : undefined;
      continue;
    }
    safe[key] = value;
  }
  console.log("mcp_tool_call", safe);
}

export type CreateObsidianMcpServerOptions = {
  client: GitHubObsidianClient;
  resourceMetadataUrl: string;
};

export function createObsidianMcpServer(
  options: CreateObsidianMcpServerOptions,
): McpServer {
  const { client, resourceMetadataUrl } = options;
  const server = new McpServer({
    name: "obsidian-mcp",
    version: "1.0.0",
  });

  const requireRead = (extra: ToolExtra | undefined) => {
    if (!hasScope(extra, READ_SCOPE)) {
      return scopeDenied([READ_SCOPE], resourceMetadataUrl);
    }
    return null;
  };

  const requireWrite = (extra: ToolExtra | undefined) => {
    const missing = [READ_SCOPE, WRITE_SCOPE].filter((s) => !hasScope(extra, s));
    if (missing.length > 0) {
      return scopeDenied(
        missing.length === 2 ? [READ_SCOPE, WRITE_SCOPE] : missing,
        resourceMetadataUrl,
      );
    }
    return null;
  };

  const run = async (
    name: string,
    args: Record<string, unknown>,
    extra: ToolExtra | undefined,
    needed: "read" | "write",
    fn: () => Promise<ToolResult>,
  ) => {
    logToolCall(name, args);
    const denied =
      needed === "read" ? requireRead(extra) : requireWrite(extra);
    if (denied) return denied;
    const result = await fn();
    return jsonToolResult(result);
  };

  server.registerTool(
    "list_vaults",
    {
      title: "List Obsidian vaults",
      description:
        "READ-ONLY. List top-level Obsidian vault directories in the connected GitHub repository. Does not include .obsidian or other hidden directories. Requires OAuth scope obsidian.read.",
      inputSchema: z.object({}),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
      _meta: {
        securitySchemes: [{ type: "oauth2", scopes: [READ_SCOPE] }],
      },
    },
    async (_args, extra) =>
      run("list_vaults", {}, extra as ToolExtra, "read", () =>
        client.listVaults(),
      ),
  );

  server.registerTool(
    "list_notes",
    {
      title: "List notes in a vault",
      description:
        "READ-ONLY. List Markdown (.md) notes inside a vault. Optional path limits listing to a subdirectory. recursive defaults to true. Requires OAuth scope obsidian.read.",
      inputSchema: z.object({
        vault: z
          .string()
          .describe('Vault name (top-level directory), e.g. "main"'),
        path: z
          .string()
          .optional()
          .describe("Optional subdirectory inside the vault"),
        recursive: z
          .boolean()
          .optional()
          .describe("If true (default), list notes recursively"),
      }),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
      _meta: {
        securitySchemes: [{ type: "oauth2", scopes: [READ_SCOPE] }],
      },
    },
    async (args, extra) =>
      run("list_notes", args, extra as ToolExtra, "read", () =>
        client.listNotes(args),
      ),
  );

  server.registerTool(
    "read_note",
    {
      title: "Read a Markdown note",
      description:
        "READ-ONLY. Read one Markdown note from a vault. Returns content, sha (needed for safe updates), and last commit metadata when available. Requires OAuth scope obsidian.read. Always pass the returned sha as expectedSha when updating or appending.",
      inputSchema: z.object({
        vault: z.string().describe('Vault name, e.g. "main"'),
        path: z
          .string()
          .describe('Note path inside the vault, e.g. "Projects/test.md"'),
      }),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
      _meta: {
        securitySchemes: [{ type: "oauth2", scopes: [READ_SCOPE] }],
      },
    },
    async (args, extra) =>
      run("read_note", args, extra as ToolExtra, "read", () =>
        client.readNote(args),
      ),
  );

  server.registerTool(
    "search_notes",
    {
      title: "Search Markdown notes",
      description:
        "READ-ONLY. Search Markdown note filenames and bodies. Returns matched snippets and one-based line numbers. Supports Japanese queries. Optional folder, tags (all required), and inclusive Git commit date filters use a bounded scan. Continue with nextScanOffset when truncated. Optionally limit to one vault. Uses GitHub Code Search when available, otherwise a bounded tree scan (not unbounded full-repo download). Requires OAuth scope obsidian.read.",
      inputSchema: z.object({
        query: z.string().min(1).describe("Literal search text (Japanese or English)"),
        folder: z.string().optional().describe("Vault-relative folder, includes descendants"),
        tags: z.array(z.string().min(1)).max(20).optional().describe("All tags must match; inline and frontmatter tags, optional # prefix"),
        updatedAfter: z.iso.datetime({ offset: true }).optional().describe("Inclusive Git commit timestamp lower bound (ISO 8601 with timezone)"),
        updatedBefore: z.iso.datetime({ offset: true }).optional().describe("Inclusive Git commit timestamp upper bound (ISO 8601 with timezone)"),
        scanOffset: z.number().int().min(0).optional().describe("Continue bounded tree scan with previous nextScanOffset"),
        vault: z
          .string()
          .optional()
          .describe("Optional vault to restrict the search"),
        limit: z
          .number()
          .int()
          .min(1)
          .max(50)
          .optional()
          .describe("Max results (default 20, max 50)"),
      }),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
      _meta: {
        securitySchemes: [{ type: "oauth2", scopes: [READ_SCOPE] }],
      },
    },
    async (args, extra) =>
      run("search_notes", args, extra as ToolExtra, "read", () =>
        client.searchNotes(args),
      ),
  );

  server.registerTool("read_notes", {
    title: "Read multiple Markdown notes",
    description: "READ-ONLY. Read 1 to 20 notes, including content, SHA and commit metadata. Results preserve request order and individual errors. Requires obsidian.read.",
    inputSchema: z.object({ notes: z.array(z.object({ vault: z.string(), path: z.string() })).min(1).max(20) }),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    _meta: { securitySchemes: [{ type: "oauth2", scopes: [READ_SCOPE] }] },
  }, async (args, extra) => run("read_notes", args, extra as ToolExtra, "read", () => client.readNotes(args)));

  server.registerTool("get_backlinks", {
    title: "Find incoming links to a note",
    description: "READ-ONLY. Find wikilinks and inline Markdown links (including embeds) to a note within its vault. Returns snippets and line numbers. Ignores fenced/inline code and ambiguous basename links. Scan at most 80 files; continue with nextScanOffset when truncated. Requires obsidian.read.",
    inputSchema: z.object({ vault: z.string(), path: z.string(), limit: z.number().int().min(1).max(50).optional(), scanOffset: z.number().int().min(0).optional() }),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    _meta: { securitySchemes: [{ type: "oauth2", scopes: [READ_SCOPE] }] },
  }, async (args, extra) => run("get_backlinks", args, extra as ToolExtra, "read", () => client.getBacklinks(args)));

  server.registerTool("update_note_section", {
    title: "Replace a heading section",
    description: "WRITE. Replace the body beneath an ATX (#) or Setext heading, including subsections, until the next heading at the same or higher level. Keeps the selected heading. Exact heading title without #; occurrence resolves duplicates. Requires expectedSha from read_note, obsidian.read and obsidian.write.",
    inputSchema: z.object({ vault: z.string(), path: z.string(), heading: z.string().min(1), content: z.string(), expectedSha: z.string().min(1), occurrence: z.number().int().min(1).optional(), commitMessage: z.string().optional() }),
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    _meta: { securitySchemes: [{ type: "oauth2", scopes: [READ_SCOPE, WRITE_SCOPE] }] },
  }, async (args, extra) => run("update_note_section", args, extra as ToolExtra, "write", () => client.updateNoteSection(args)));

  server.registerTool(
    "create_note",
    {
      title: "Create a Markdown note",
      description:
        "WRITE. Create a new Markdown (.md) note in a vault via GitHub commit on the configured branch. Fails with ALREADY_EXISTS if the path already exists (never overwrites). Requires OAuth scope obsidian.write. Prefer update_note or append_note for existing files.",
      inputSchema: z.object({
        vault: z.string().describe('Vault name, e.g. "main"'),
        path: z
          .string()
          .describe('New note path ending in .md, e.g. "Inbox/idea.md"'),
        content: z.string().describe("Full Markdown content for the new note"),
        commitMessage: z
          .string()
          .optional()
          .describe("Optional Git commit message"),
      }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
      _meta: {
        securitySchemes: [{ type: "oauth2", scopes: [WRITE_SCOPE] }],
      },
    },
    async (args, extra) =>
      run("create_note", args, extra as ToolExtra, "write", () =>
        client.createNote(args),
      ),
  );

  server.registerTool(
    "update_note",
    {
      title: "Update a Markdown note",
      description:
        "WRITE. Replace the full content of an existing Markdown note. Pass expectedSha from the latest read_note to prevent overwriting concurrent edits; mismatches return CONFLICT. Requires OAuth scope obsidian.write. Does not create new files.",
      inputSchema: z.object({
        vault: z.string().describe('Vault name, e.g. "main"'),
        path: z.string().describe("Existing note path ending in .md"),
        content: z.string().describe("Full replacement Markdown content"),
        expectedSha: z
          .string()
          .optional()
          .describe("SHA from read_note; required for safe concurrent edits"),
        commitMessage: z
          .string()
          .optional()
          .describe("Optional Git commit message"),
      }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: false,
      },
      _meta: {
        securitySchemes: [{ type: "oauth2", scopes: [WRITE_SCOPE] }],
      },
    },
    async (args, extra) =>
      run("update_note", args, extra as ToolExtra, "write", () =>
        client.updateNote(args),
      ),
  );

  server.registerTool(
    "append_note",
    {
      title: "Append to a Markdown note",
      description:
        "WRITE. Append text to the end of an existing Markdown note. Re-reads and verifies SHA before committing to avoid conflicts. Pass expectedSha from read_note when available. Requires OAuth scope obsidian.write.",
      inputSchema: z.object({
        vault: z.string().describe('Vault name, e.g. "main"'),
        path: z.string().describe("Existing note path ending in .md"),
        content: z.string().describe("Text to append to the end of the note"),
        expectedSha: z
          .string()
          .optional()
          .describe("SHA from read_note; recommended for safe concurrent edits"),
        commitMessage: z
          .string()
          .optional()
          .describe("Optional Git commit message"),
      }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
      _meta: {
        securitySchemes: [{ type: "oauth2", scopes: [WRITE_SCOPE] }],
      },
    },
    async (args, extra) =>
      run("append_note", args, extra as ToolExtra, "write", () =>
        client.appendNote(args),
      ),
  );

  server.registerTool(
    "move_note",
    {
      title: "Move or rename a Markdown note",
      description: "WRITE. Atomically move or rename an existing Markdown note, optionally to another existing vault. Never overwrites a destination. Pass expectedSha from read_note to detect stale content. Does not rewrite links in other notes. Requires obsidian.read and obsidian.write.",
      inputSchema: z.object({
        vault: z.string().describe("Source vault name"),
        path: z.string().describe("Source note path ending in .md"),
        destinationPath: z.string().describe("Destination vault-relative path ending in .md"),
        destinationVault: z.string().optional().describe("Destination vault; defaults to source vault"),
        expectedSha: z.string().min(1).optional().describe("SHA from the latest read_note"),
        commitMessage: z.string().optional().describe("Optional Git commit message"),
      }),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
      _meta: { securitySchemes: [{ type: "oauth2", scopes: [READ_SCOPE, WRITE_SCOPE] }] },
    },
    async (args, extra) => run("move_note", args, extra as ToolExtra, "write", () => client.moveNote(args)),
  );

  server.registerTool(
    "delete_note",
    {
      title: "Delete a Markdown note",
      description: "WRITE. Delete an existing Markdown note from the repository in a Git commit. Pass expectedSha from read_note to detect stale content; the current SHA is always checked by GitHub when deleting. Requires obsidian.read and obsidian.write.",
      inputSchema: z.object({
        vault: z.string().describe("Vault name"),
        path: z.string().describe("Existing note path ending in .md"),
        expectedSha: z.string().min(1).optional().describe("SHA from the latest read_note"),
        commitMessage: z.string().optional().describe("Optional Git commit message"),
      }),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
      _meta: { securitySchemes: [{ type: "oauth2", scopes: [READ_SCOPE, WRITE_SCOPE] }] },
    },
    async (args, extra) => run("delete_note", args, extra as ToolExtra, "write", () => client.deleteNote(args)),
  );

  return server;
}
