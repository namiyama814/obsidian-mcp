import { describe, expect, it } from "vitest";
import { fail, ok, jsonToolResult } from "../shared/src/response.ts";

describe("tool responses", () => {
  it("shapes success and failure payloads", () => {
    expect(ok({ vault: "main", path: "a.md", sha: "1" })).toEqual({
      ok: true,
      vault: "main",
      path: "a.md",
      sha: "1",
    });
    expect(fail("CONFLICT", "The note changed after it was read.", { currentSha: "x" })).toEqual({
      ok: false,
      error: "CONFLICT",
      message: "The note changed after it was read.",
      currentSha: "x",
    });
  });

  it("marks failures as isError for MCP", () => {
    const result = jsonToolResult(fail("NOT_FOUND", "missing"));
    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content[0]!.text).ok).toBe(false);
  });
});
