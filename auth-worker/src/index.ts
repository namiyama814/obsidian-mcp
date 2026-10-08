import {
  AuthorizationError,
  CimdFetchError,
  OAuthAuthorizationServer,
  authorizationErrorRedirect,
  type AuthRequest,
  type ConsentDescription,
} from "@cloudflare/workers-oauth-provider";
import { WorkerEntrypoint } from "cloudflare:workers";
import { escapeHtml } from "../../shared/src/html.ts";
import {
  SCOPES_SUPPORTED,
  type AuthProps,
} from "../../shared/src/scopes.ts";

export interface Env {
  OAUTH_KV: KVNamespace;
  GITHUB_CLIENT_ID: string;
  GITHUB_CLIENT_SECRET: string;
  ALLOWED_GITHUB_LOGIN: string;
  /** Canonical issuer URL, e.g. https://obsidian-mcp-auth.<account>.workers.dev */
  AUTH_ISSUER: string;
  /** MCP resource URL this AS issues tokens for */
  MCP_RESOURCE_URL: string;
  /** Optional HMAC secret for remembering consent (32+ chars) */
  CONSENT_SECRET?: string;
}

type UpstreamData = {
  verifier: string;
};

function createAuthorizationServer(env: Env) {
  return new OAuthAuthorizationServer<Env>({
    issuer: env.AUTH_ISSUER,
    resources: [env.MCP_RESOURCE_URL],
    scopesSupported: [...SCOPES_SUPPORTED],
    clientIdMetadataDocumentEnabled: true,
    clientRegistrationEndpoint: "/oauth/register",
    onError: (error) => {
      console.error("oauth_failure", {
        category: error.internal?.category,
        reason: error.internal?.reason,
        code: error.code,
        status: error.status,
      });
    },
    allowPrivateUseRedirectUris: true,
  });
}

function consentPageHtml(details: ConsentDescription, handle: string): string {
  const name = escapeHtml(details.clientName);
  const origin = details.clientDomain
    ? `Published by <strong>${escapeHtml(details.clientDomain)}</strong>.`
    : "This app registered itself; its name is not verified.";
  const scopes = details.scope
    .map(
      (scope) =>
        `<label style="display:block;margin:0.35rem 0"><input type="checkbox" name="scope" value="${escapeHtml(scope)}" checked> ${escapeHtml(scope)}</label>`,
    )
    .join("");

  return `<!doctype html>
<html lang="en">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Authorize ${name}</title>
<style>
  body{font-family:system-ui,-apple-system,sans-serif;max-width:36rem;margin:2rem auto;padding:0 1rem;line-height:1.5;color:#111}
  .warn{background:#fff3cd;border:1px solid #ffecb5;padding:0.75rem;border-radius:6px}
  button{margin-right:0.5rem;padding:0.5rem 1rem;cursor:pointer}
</style>
<h1>Allow ${name} to access Obsidian MCP?</h1>
<p>${origin} Access tokens will be sent to <strong>${escapeHtml(details.redirectHost)}</strong>.</p>
${details.redirectIsLoopback ? '<p class="warn"><strong>This sends access to an app on your computer.</strong> Continue only if you started this sign-in yourself.</p>' : ""}
<p>You will sign in with GitHub next. Only the allowlisted GitHub account can complete login. Repository access uses a separate server-side token — your GitHub OAuth token is not used to read or write notes.</p>
<form method="post">
  <input type="hidden" name="handle" value="${escapeHtml(handle)}">
  <fieldset>
    <legend>Scopes</legend>
    ${scopes}
  </fieldset>
  <p style="margin-top:1.25rem">
    <button name="decision" value="approve" type="submit">Allow</button>
    <button name="decision" value="deny" type="submit">Deny</button>
  </p>
</form>
</html>`;
}

function errorPage(message: string, status = 400): Response {
  return new Response(escapeHtml(message), {
    status,
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "X-Frame-Options": "DENY",
      "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'",
    },
  });
}

async function sha256Base64Url(value: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  const bytes = new Uint8Array(digest);
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function githubAuthorizeUrl(input: {
  clientId: string;
  redirectUri: string;
  state: string;
  codeChallenge: string;
}): string {
  const url = new URL("https://github.com/login/oauth/authorize");
  url.searchParams.set("client_id", input.clientId);
  url.searchParams.set("redirect_uri", input.redirectUri);
  url.searchParams.set("scope", "read:user");
  url.searchParams.set("state", input.state);
  url.searchParams.set("code_challenge", input.codeChallenge);
  url.searchParams.set("code_challenge_method", "S256");
  return url.toString();
}

async function exchangeGithubCode(input: {
  code: string;
  redirectUri: string;
  clientId: string;
  clientSecret: string;
  codeVerifier: string;
}): Promise<{ accessToken: string }> {
  const response = await fetch("https://github.com/login/oauth/access_token", {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      client_id: input.clientId,
      client_secret: input.clientSecret,
      code: input.code,
      redirect_uri: input.redirectUri,
      code_verifier: input.codeVerifier,
    }),
  });
  const data = (await response.json()) as {
    access_token?: string;
    error?: string;
    error_description?: string;
  };
  if (!response.ok || !data.access_token) {
    console.error("oauth_failure", {
      stage: "github_token_exchange",
      error: data.error,
    });
    throw new Error(data.error_description || "GitHub token exchange failed");
  }
  return { accessToken: data.access_token };
}

async function fetchGithubUser(accessToken: string): Promise<{
  id: number;
  login: string;
}> {
  const response = await fetch("https://api.github.com/user", {
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${accessToken}`,
      "User-Agent": "obsidian-mcp-auth",
      "X-GitHub-Api-Version": "2022-11-28",
    },
  });
  if (!response.ok) {
    console.error("oauth_failure", {
      stage: "github_user",
      status: response.status,
    });
    throw new Error("Failed to fetch GitHub user");
  }
  const data = (await response.json()) as { id: number; login: string };
  return { id: data.id, login: data.login };
}

async function handleAuthorize(
  request: Request,
  env: Env,
  authorizationServer: OAuthAuthorizationServer<Env>,
): Promise<Response> {
  const oauth = authorizationServer.getOAuthApi(env);

  if (request.method === "GET") {
    let oauthRequest: AuthRequest;
    try {
      oauthRequest = await oauth.parseAuthRequest(request);
    } catch (error) {
      return handleAuthError(error);
    }

    try {
      const details = await oauth.describeConsent(oauthRequest);
      const remember =
        env.CONSENT_SECRET && env.CONSENT_SECRET.length >= 32
          ? { secret: env.CONSENT_SECRET }
          : undefined;

      if (remember && (await oauth.isConsentRemembered(request, oauthRequest, remember))) {
        return startGithubUpstream(request, env, authorizationServer, oauthRequest);
      }

      const consent = await oauth.beginConsent(oauthRequest);
      consent.headers.set("Content-Type", "text/html; charset=utf-8");
      return new Response(consentPageHtml(details, consent.handle), {
        headers: consent.headers,
      });
    } catch (error) {
      return handleAuthError(error);
    }
  }

  if (request.method === "POST") {
    try {
      const form = await request.formData();
      const handle = String(form.get("handle") ?? "");
      if (form.get("decision") !== "approve") {
        const denied = await oauth.denyConsent(request, handle);
        return new Response(null, { status: 302, headers: denied.headers });
      }

      const approved = await oauth.approveConsent(request, handle, {
        scope: form.getAll("scope").map(String),
        ...(env.CONSENT_SECRET && env.CONSENT_SECRET.length >= 32
          ? { remember: { secret: env.CONSENT_SECRET } }
          : {}),
      });

      return startGithubUpstream(
        request,
        env,
        authorizationServer,
        approved.request,
        approved.headers,
      );
    } catch (error) {
      return handleAuthError(error);
    }
  }

  return new Response("Method Not Allowed", { status: 405 });
}

async function startGithubUpstream(
  _request: Request,
  env: Env,
  authorizationServer: OAuthAuthorizationServer<Env>,
  oauthRequest: AuthRequest,
  headers?: Headers,
): Promise<Response> {
  const oauth = authorizationServer.getOAuthApi(env);
  const verifier = crypto.randomUUID() + crypto.randomUUID();
  const codeChallenge = await sha256Base64Url(verifier);
  const { state, headers: upstreamHeaders } = await oauth.beginUpstream(
    oauthRequest,
    {
      data: { verifier } satisfies UpstreamData,
      headers,
    },
  );

  const redirectUri = new URL("/callback", env.AUTH_ISSUER).toString();
  upstreamHeaders.set(
    "Location",
    githubAuthorizeUrl({
      clientId: env.GITHUB_CLIENT_ID,
      redirectUri,
      state,
      codeChallenge,
    }),
  );
  return new Response(null, { status: 302, headers: upstreamHeaders });
}

async function handleCallback(
  request: Request,
  env: Env,
  authorizationServer: OAuthAuthorizationServer<Env>,
): Promise<Response> {
  const oauth = authorizationServer.getOAuthApi(env);
  const url = new URL(request.url);

  let resumed: Awaited<ReturnType<typeof oauth.finishUpstream<UpstreamData>>>;
  try {
    resumed = await oauth.finishUpstream<UpstreamData>(request);
  } catch (error) {
    return handleAuthError(error);
  }

  if (url.searchParams.get("error")) {
    console.error("oauth_failure", {
      stage: "github_callback",
      error: url.searchParams.get("error"),
    });
    resumed.headers.set(
      "Location",
      authorizationErrorRedirect(resumed.request, "access_denied"),
    );
    return new Response(null, { status: 302, headers: resumed.headers });
  }

  const code = url.searchParams.get("code");
  if (!code) {
    return errorPage("Missing authorization code from GitHub.");
  }

  try {
    const redirectUri = new URL("/callback", env.AUTH_ISSUER).toString();
    const { accessToken } = await exchangeGithubCode({
      code,
      redirectUri,
      clientId: env.GITHUB_CLIENT_ID,
      clientSecret: env.GITHUB_CLIENT_SECRET,
      codeVerifier: resumed.data.verifier,
    });

    const user = await fetchGithubUser(accessToken);
    // Intentionally discard GitHub access token — identity only.
    const allowed = (env.ALLOWED_GITHUB_LOGIN || "namiyama814").toLowerCase();
    if (user.login.toLowerCase() !== allowed) {
      console.error("oauth_failure", {
        stage: "allowlist",
        login: user.login,
      });
      resumed.headers.set(
        "Location",
        authorizationErrorRedirect(
          resumed.request,
          "access_denied",
          "This GitHub account is not allowed to use this MCP server.",
        ),
      );
      return new Response(null, { status: 302, headers: resumed.headers });
    }

    const props: AuthProps = {
      githubLogin: user.login,
      githubId: String(user.id),
    };

    const { redirectTo } = await oauth.completeAuthorization({
      request: resumed.request,
      userId: `github-${user.id}`,
      metadata: { githubLogin: user.login },
      scope: resumed.request.scope.filter((scope) =>
        (SCOPES_SUPPORTED as readonly string[]).includes(scope),
      ),
      props,
    });

    resumed.headers.set("Location", redirectTo);
    return new Response(null, { status: 302, headers: resumed.headers });
  } catch (error) {
    console.error("oauth_failure", {
      stage: "callback_complete",
      error: error instanceof Error ? error.message : "unknown",
    });
    return errorPage("GitHub login failed. Please try again.", 500);
  }
}

function handleAuthError(error: unknown): Response {
  if (error instanceof AuthorizationError && error.redirectTo) {
    return Response.redirect(error.redirectTo, 302);
  }
  if (error instanceof AuthorizationError) {
    console.error("oauth_failure", {
      stage: "authorization",
      code: error.code,
      description: error.description,
    });
    return errorPage(error.description || "Authorization request invalid.");
  }
  if (error instanceof CimdFetchError) {
    console.error("oauth_failure", {
      stage: "cimd",
      reason: error.reason,
    });
    return errorPage("This app could not be verified.");
  }
  throw error;
}

export default class AuthWorker extends WorkerEntrypoint<Env> {
  private get authorizationServer() {
    return createAuthorizationServer(this.env);
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const authorizationServer = this.authorizationServer;

    if (url.pathname === "/health") {
      return Response.json({ status: "ok" });
    }

    if (url.pathname === "/authorize") {
      return handleAuthorize(request, this.env, authorizationServer);
    }

    if (url.pathname === "/callback") {
      return handleCallback(request, this.env, authorizationServer);
    }

    return authorizationServer.fetch(request, this.env, this.ctx);
  }

  /** Called by mcp-worker over Service Binding. */
  validateToken(resource: string, token: string) {
    return this.authorizationServer.validateToken(resource, token, this.env);
  }
}
