/** Scopes the authorization server can grant. */
export const SCOPES_SUPPORTED = [
  "obsidian.read",
  "obsidian.write",
  "offline_access",
] as const;

export type SupportedScope = (typeof SCOPES_SUPPORTED)[number];

export const READ_SCOPE = "obsidian.read" as const;
export const WRITE_SCOPE = "obsidian.write" as const;

/** Baseline scope required for any MCP access (advertised on the resource). */
export const REQUIRED_SCOPES = [READ_SCOPE] as const;

export type AuthProps = {
  githubLogin: string;
  githubId: string;
};
