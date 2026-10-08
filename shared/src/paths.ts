const VAULT_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const HIDDEN_OR_SYSTEM = new Set([".obsidian", ".git", ".github", ".trash"]);

export type PathErrorCode =
  | "INVALID_VAULT"
  | "INVALID_PATH"
  | "PATH_TRAVERSAL"
  | "NOT_MARKDOWN";

export class PathValidationError extends Error {
  readonly code: PathErrorCode;

  constructor(code: PathErrorCode, message: string) {
    super(message);
    this.name = "PathValidationError";
    this.code = code;
  }
}

/** True when a root-level directory name is a usable Obsidian vault. */
export function isVaultDirectoryName(name: string): boolean {
  if (!name || name === "." || name === "..") return false;
  if (name.startsWith(".")) return false;
  if (HIDDEN_OR_SYSTEM.has(name.toLowerCase())) return false;
  return VAULT_NAME_RE.test(name);
}

function rejectTraversal(segment: string): void {
  if (
    segment === "" ||
    segment === "." ||
    segment === ".." ||
    segment.includes("\0")
  ) {
    throw new PathValidationError(
      "PATH_TRAVERSAL",
      "Path traversal or empty segments are not allowed.",
    );
  }
}

/**
 * Normalize a vault-relative path.
 * Rejects absolute paths, `..`, `.git`, and backslashes used as separators.
 */
export function normalizeNotePath(
  path: string,
  options?: { requireMarkdown?: boolean },
): string {
  if (typeof path !== "string" || path.trim() === "") {
    throw new PathValidationError("INVALID_PATH", "Path is required.");
  }

  const raw = path.trim().replace(/\\/g, "/");
  if (raw.startsWith("/") || raw.startsWith("~") || /^[A-Za-z]:/.test(raw)) {
    throw new PathValidationError(
      "INVALID_PATH",
      "Absolute paths are not allowed.",
    );
  }
  if (raw.includes("://")) {
    throw new PathValidationError("INVALID_PATH", "URLs are not allowed.");
  }

  const parts = raw.split("/").filter((p) => p !== "");
  if (parts.length === 0) {
    throw new PathValidationError("INVALID_PATH", "Path is required.");
  }

  for (const part of parts) {
    rejectTraversal(part);
    if (part === ".git" || part.toLowerCase() === ".git") {
      throw new PathValidationError(
        "PATH_TRAVERSAL",
        ".git paths are not allowed.",
      );
    }
    if (part === ".." || part.includes("..")) {
      throw new PathValidationError(
        "PATH_TRAVERSAL",
        "Path traversal is not allowed.",
      );
    }
  }

  const normalized = parts.join("/");
  if (normalized.includes("..")) {
    throw new PathValidationError(
      "PATH_TRAVERSAL",
      "Path traversal is not allowed.",
    );
  }

  if (options?.requireMarkdown !== false) {
    if (!normalized.toLowerCase().endsWith(".md")) {
      throw new PathValidationError(
        "NOT_MARKDOWN",
        "Only Markdown (.md) notes are allowed.",
      );
    }
  }

  return normalized;
}

export function validateVaultName(vault: string): string {
  if (typeof vault !== "string" || !isVaultDirectoryName(vault.trim())) {
    throw new PathValidationError(
      "INVALID_VAULT",
      "Vault must be an existing top-level directory name (not .obsidian or hidden).",
    );
  }
  return vault.trim();
}

/** Build `vault/note/path.md` for the GitHub Contents API. */
export function toRepoPath(vault: string, notePath: string): string {
  const v = validateVaultName(vault);
  const p = normalizeNotePath(notePath);
  return `${v}/${p}`;
}

/** Optional directory prefix inside a vault for listing. */
export function toVaultSubdir(vault: string, subpath?: string): string {
  const v = validateVaultName(vault);
  if (!subpath || subpath.trim() === "" || subpath.trim() === ".") {
    return v;
  }
  const normalized = normalizeNotePath(subpath, { requireMarkdown: false });
  return `${v}/${normalized}`;
}
