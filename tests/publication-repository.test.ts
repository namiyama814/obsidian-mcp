import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { PublicationRepository } from "../mcp-worker/src/publication/repository.ts";
const config = {
  owner: "dummy",
  repo: "private",
  branch: "main",
  token: "secret-token",
};
const repo = () => new PublicationRepository(config);
beforeEach(() => vi.spyOn(console, "error").mockImplementation(() => {}));
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
});
it("sends authenticated requests with manual redirects and parses JSON / 204", async () => {
  const fetcher = vi
    .fn()
    .mockResolvedValueOnce(Response.json({ private: true }))
    .mockResolvedValueOnce(new Response(null, { status: 204 }));
  vi.stubGlobal("fetch", fetcher);
  await expect(repo().api("")).resolves.toEqual({ private: true });
  await expect(
    repo().api("/actions/workflows/sync.yml/dispatches", "POST", {}),
  ).resolves.toBeUndefined();
  expect(fetcher.mock.calls[0]![1]).toMatchObject({
    redirect: "manual",
    headers: { Authorization: "Bearer secret-token" },
  });
  expect(fetcher.mock.calls[0]![1].signal).toBeInstanceOf(AbortSignal);
});
it.each([
  [401, "PERMISSION_DENIED"],
  [403, "PERMISSION_DENIED"],
  [404, "NOT_FOUND"],
  [409, "CONFLICT"],
  [422, "CONFLICT"],
  [429, "GITHUB_RATE_LIMITED"],
  [500, "GITHUB_ERROR"],
])("maps HTTP %i", async (status, code) => {
  vi.stubGlobal(
    "fetch",
    vi
      .fn()
      .mockResolvedValue(
        new Response("private response", { status: Number(status) }),
      ),
  );
  await expect(repo().api("")).rejects.toMatchObject({ code });
  expect(console.error).toHaveBeenCalledWith("publication_github_http_failed", {
    operation: "repository.metadata",
    status,
  });
});
it.each([301, 302, 303, 307, 308])(
  "rejects HTTP %i without following even same-host redirects",
  async (status) => {
    const fetcher = vi.fn().mockResolvedValue(
      new Response(null, {
        status,
        headers: { Location: "https://evil.example/?token=secret" },
      }),
    );
    vi.stubGlobal("fetch", fetcher);
    await expect(repo().api("")).rejects.toMatchObject({
      code: "GITHUB_REDIRECT_REJECTED",
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher.mock.calls[0]![1].redirect).toBe("manual");
  },
);
it("classifies an expired request signal as a timeout", async () => {
  const signal = AbortSignal.abort(new DOMException("timeout", "TimeoutError"));
  const timeout = vi.spyOn(AbortSignal, "timeout").mockReturnValue(signal);
  vi.stubGlobal("fetch", vi.fn().mockRejectedValue(signal.reason));
  await expect(repo().api("")).rejects.toMatchObject({
    code: "GITHUB_TIMEOUT",
  });
  expect(timeout).toHaveBeenCalledWith(30000);
});
it("handles network failure without logging raw exceptions, query strings or bodies", async () => {
  vi.stubGlobal(
    "fetch",
    vi
      .fn()
      .mockRejectedValue(
        new TypeError(
          "Bearer secret-token https://private/?signature=secret contract-body",
        ),
      ),
  );
  await expect(
    repo().api("/commits?path=private-note&signature=secret", "POST", {
      content: "contract-body",
    }),
  ).rejects.toMatchObject({ code: "GITHUB_UNAVAILABLE" });
  const logs = JSON.stringify(vi.mocked(console.error).mock.calls);
  for (const secret of [
    "secret-token",
    "signature",
    "contract-body",
    "private-note",
    "Authorization",
  ])
    expect(logs).not.toContain(secret);
  expect(console.error).toHaveBeenCalledWith(
    "publication_github_request_failed",
    expect.objectContaining({
      operation: "repository.history",
      errorName: "TypeError",
      errorMessage: "GITHUB_UNAVAILABLE",
      requestDurationMs: expect.any(Number),
    }),
  );
});
it("classifies malformed JSON and response body failures", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue(new Response("invalid json")),
  );
  await expect(repo().api("")).rejects.toMatchObject({
    code: "GITHUB_INVALID_RESPONSE",
  });
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => {
        throw new DOMException("secret", "TimeoutError");
      },
    }),
  );
  await expect(repo().api("")).rejects.toMatchObject({
    code: "GITHUB_TIMEOUT",
  });
});
it("does not follow a second redirect from a signed workflow log URL", async () => {
  const fetcher = vi
    .fn()
    .mockResolvedValueOnce(
      new Response(null, {
        status: 302,
        headers: {
          Location: "https://logs.blob.core.windows.net/log?sig=secret",
        },
      }),
    )
    .mockResolvedValueOnce(
      new Response(null, {
        status: 302,
        headers: { Location: "https://evil.example/" },
      }),
    );
  vi.stubGlobal("fetch", fetcher);
  await expect(repo().jobLog(1)).rejects.toMatchObject({
    code: "GITHUB_REDIRECT_REJECTED",
  });
  expect(fetcher).toHaveBeenCalledTimes(2);
  expect(fetcher.mock.calls[1]![1]).toMatchObject({ redirect: "manual" });
  expect(fetcher.mock.calls[1]![1].headers).toBeUndefined();
  expect(JSON.stringify(vi.mocked(console.error).mock.calls)).not.toContain(
    "sig=",
  );
});
it.each([
  "https://logs.blob.core.windows.net.evil.example/x",
  "http://logs.blob.core.windows.net/x",
  "https://user:pass@logs.blob.core.windows.net/x",
  "https://logs.blob.core.windows.net:8443/x",
  "invalid",
])("rejects untrusted log URL %s", async (Location) => {
  const fetcher = vi
    .fn()
    .mockResolvedValue(
      new Response(null, { status: 302, headers: { Location } }),
    );
  vi.stubGlobal("fetch", fetcher);
  await expect(repo().jobLog(1)).rejects.toMatchObject({
    code: "UNTRUSTED_LOG_URL",
  });
  expect(fetcher).toHaveBeenCalledTimes(1);
});

it("reports Workers subrequest exhaustion distinctly without raw messages", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockRejectedValue(new Error("Too many subrequests.")),
  );
  await expect(repo().api("")).rejects.toMatchObject({
    code: "VERIFICATION_LIMIT",
  });
  expect(console.error).toHaveBeenCalledWith(
    "publication_github_request_failed",
    expect.objectContaining({
      errorMessage: "worker_subrequest_limit",
      requestCount: 1,
    }),
  );
});
