export type OkResult<T extends Record<string, unknown>> = { ok: true } & T;

export type FailResult = {
  ok: false;
  error: string;
  message: string;
  currentSha?: string;
};

export type ToolResult = OkResult<Record<string, unknown>> | FailResult;

export function ok<T extends Record<string, unknown>>(data: T): OkResult<T> {
  return { ok: true, ...data };
}

export function fail(
  error: string,
  message: string,
  extra?: { currentSha?: string },
): FailResult {
  return {
    ok: false,
    error,
    message,
    ...extra,
  };
}

export function jsonToolResult(result: ToolResult): {
  content: Array<{ type: "text"; text: string }>;
  structuredContent: ToolResult;
  isError: boolean;
} {
  return {
    content: [{ type: "text", text: JSON.stringify(result) }],
    structuredContent: result,
    isError: !result.ok,
  };
}
