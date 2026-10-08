import {
  OAuthResourceServer,
  type AuthorizationServerBinding,
  type OAuthResourceContext,
} from "@cloudflare/workers-oauth-provider";
import { createMcpHandler } from "agents/mcp/server";
import type { AuthProps } from "../../shared/src/scopes.ts";
import { REQUIRED_SCOPES } from "../../shared/src/scopes.ts";
import { GitHubObsidianClient } from "./github/client.ts";
import { createObsidianMcpServer } from "./mcp-server.ts";

/**
 * Verified OAuth context symbol shared with agents createMcpHandler.
 * @see agents/mcp/server auth-context
 */
const VERIFIED_OAUTH_CONTEXT = Symbol.for(
  "cloudflare.workers-oauth-provider.verified-context.v1",
);

export interface Env {
  AUTH_SERVER: AuthorizationServerBinding<AuthProps>;
  GITHUB_REPO_TOKEN: string;
  GITHUB_OWNER: string;
  GITHUB_REPO: string;
  GITHUB_BRANCH: string;
  /** Canonical MCP resource URL, e.g. https://obsidian-mcp.<account>.workers.dev/mcp */
  MCP_RESOURCE_URL: string;
  /** Authorization server issuer, e.g. https://obsidian-mcp-auth.<account>.workers.dev */
  AUTH_ISSUER: string;
}

function attachVerifiedContext(
  ctx: OAuthResourceContext<AuthProps>,
): void {
  const auth = ctx.auth;
  const props = ctx.props as unknown as Record<string, unknown>;
  Object.assign(ctx, {
    [VERIFIED_OAUTH_CONTEXT]: {
      version: 1,
      token: auth.token,
      clientId: auth.clientId ?? "unknown",
      scopes: [...auth.scope],
      ...(auth.expiresAt !== undefined ? { expiresAt: auth.expiresAt } : {}),
      resource: auth.audience,
      props,
    },
  });
}

function createResourceServer(env: Env) {
  const resource = env.MCP_RESOURCE_URL;
  const issuer = env.AUTH_ISSUER;

  return new OAuthResourceServer<Env, AuthProps>({
    resourceMetadata: {
      resource,
      authorization_servers: [issuer],
      resource_name: "Obsidian MCP",
    },
    requiredScopes: [...REQUIRED_SCOPES],
    validateToken: (e) => e.AUTH_SERVER.validateToken,
    handler: {
      async fetch(request, handlerEnv, ctx) {
        const url = new URL(request.url);
        console.log("mcp_request", {
          method: request.method,
          path: url.pathname,
          user: ctx.props?.githubLogin,
          scopes: ctx.auth.scope,
        });

        attachVerifiedContext(ctx);

        const client = new GitHubObsidianClient({
          token: handlerEnv.GITHUB_REPO_TOKEN,
          owner: handlerEnv.GITHUB_OWNER,
          repo: handlerEnv.GITHUB_REPO,
          branch: handlerEnv.GITHUB_BRANCH,
        });

        const resourceMetadataUrl = new URL(
          "/.well-known/oauth-protected-resource/mcp",
          resource,
        ).toString();

        if (request.method === "POST") {
          void request
            .clone()
            .json()
            .then((body) => {
              if (
                body &&
                typeof body === "object" &&
                "method" in body &&
                typeof (body as { method: unknown }).method === "string"
              ) {
                const method = (body as { method: string }).method;
                if (method === "initialize") {
                  console.log("mcp_initialize", {
                    user: ctx.props?.githubLogin,
                  });
                } else if (method === "tools/list") {
                  console.log("mcp_tools_list", {
                    user: ctx.props?.githubLogin,
                  });
                }
              }
            })
            .catch(() => {
              /* ignore non-JSON bodies */
            });
        }

        const handler = createMcpHandler(
          () =>
            createObsidianMcpServer({
              client,
              resourceMetadataUrl,
            }),
          {
            route: "/mcp",
            onerror: (error) => {
              console.error("mcp_handler_error", {
                message: error.message,
              });
            },
          },
        );

        return handler(request, handlerEnv, ctx as unknown as ExecutionContext);
      },
    },
  });
}

export default {
  async fetch(
    request: Request,
    env: Env,
    ctx: ExecutionContext,
  ): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/health") {
      return Response.json({ status: "ok" });
    }

    // OAuthResourceServer serves metadata for this path-based resource at
    // /.well-known/oauth-protected-resource/mcp.

    return createResourceServer(env).fetch(request, env, ctx);
  },
} satisfies ExportedHandler<Env>;
