import { describe, expect, it } from "vitest";
import {
  isVaultDirectoryName,
  normalizeNotePath,
  PathValidationError,
  toRepoPath,
  validateVaultName,
} from "../shared/src/paths.ts";

describe("path security", () => {
  it("accepts normal vault names", () => {
    expect(isVaultDirectoryName("main")).toBe(true);
    expect(isVaultDirectoryName("anzdrop")).toBe(true);
  });

  it("rejects system / hidden directories as vaults", () => {
    expect(isVaultDirectoryName(".obsidian")).toBe(false);
    expect(isVaultDirectoryName(".git")).toBe(false);
    expect(isVaultDirectoryName("..")).toBe(false);
  });

  it("rejects path traversal", () => {
    expect(() => normalizeNotePath("../secret.md")).toThrow(PathValidationError);
    expect(() => normalizeNotePath("a/../../b.md")).toThrow(PathValidationError);
    expect(() => normalizeNotePath("/etc/passwd.md")).toThrow(PathValidationError);
    expect(() => toRepoPath("main", "../x.md")).toThrow(PathValidationError);
  });

  it("rejects non-markdown writes", () => {
    expect(() => normalizeNotePath("note.txt")).toThrow(/Markdown/);
  });

  it("normalizes valid note paths", () => {
    expect(normalizeNotePath("Projects/test.md")).toBe("Projects/test.md");
    expect(toRepoPath("main", "Projects/test.md")).toBe("main/Projects/test.md");
  });

  it("validates vault names", () => {
    expect(validateVaultName("main")).toBe("main");
    expect(() => validateVaultName(".obsidian")).toThrow(PathValidationError);
  });
});
