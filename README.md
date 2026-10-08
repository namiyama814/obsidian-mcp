# obsidian-mcp

ChatGPT から利用する個人用 Remote MCP Server（Cloudflare Workers）。

GitHub の private repository `namiyama814/obsidian` 上の Obsidian Vault を、検索・読み取り・作成・更新・移動・削除できます。ローカル Obsidian / Obsidian Git には直接接続しません。

```
ChatGPT
  → Remote MCP (Cloudflare Workers + OAuth 2.1)
    → GitHub API (Fine-grained PAT)
      → namiyama814/obsidian
        → Obsidian Git (~5分)
          → ローカル Obsidian
```

## アーキテクチャ

同一リポジトリ内の **2 Workers**（`@cloudflare/workers-oauth-provider` v1 split API）:

| Worker | 役割 | 主な URL |
|--------|------|----------|
| `auth-worker` (`obsidian-mcp-auth`) | OAuth Authorization Server + GitHub ログイン | `https://<auth-host>/authorize`, `/oauth/token`, `/.well-known/oauth-authorization-server` |
| `mcp-worker` (`obsidian-mcp`) | MCP Resource Server (`createMcpHandler` + Streamable HTTP) | `https://<mcp-host>/mcp`, `/.well-known/oauth-protected-resource/mcp` |

- Authorization Server → Resource Server のトークン検証は **Service Binding**（`AUTH_SERVER.validateToken`）
- GitHub OAuth は **利用者本人の認証のみ**（`ALLOWED_GITHUB_LOGIN`）
- Vault 操作は別 Secret の **`GITHUB_REPO_TOKEN`**（Fine-grained PAT）

## 手動セットアップ（順番どおり）

### 0. Cloudflare アカウント

複数アカウントがある場合、本リポジトリの `wrangler.jsonc` には個人アカウント
`Namiyama814@gmail.com's Account`（`account_id: 2a1ab8b6a9b36f7f0c4292dce044e0c4`）を指定しています。
別アカウントを使う場合は両 Worker の `account_id` を書き換えてください。

```bash
npx wrangler login
```

現在の workers.dev サブドメインは `namiyama814` です。

### 1. 依存関係

```bash
cd obsidian-mcp
npm install
```

### 2. GitHub Fine-grained Personal Access Token（リポジトリ操作用）

1. GitHub → Settings → Developer settings → Personal access tokens → Fine-grained tokens
2. 対象: **Only select repositories** → `namiyama814/obsidian`
3. Permissions:
   - **Metadata**: Read
   - **Contents**: Read and Write
4. 発行したトークンを控える（後で `GITHUB_REPO_TOKEN` として登録）

> このトークンは GitHub OAuth のユーザートークンとは別物です。

### 3. GitHub OAuth App（ログイン用）— local と production で別 App

#### 3-A. Local development

1. https://github.com/settings/developers → **OAuth Apps** → New OAuth App
2. 設定例:
   - Application name: `Obsidian MCP (local)`
   - Homepage URL: `http://localhost:8787`
   - Authorization callback URL: `http://localhost:8787/callback`
3. Client ID / Client Secret を控える

#### 3-B. Production

1. もう一つ OAuth App を作成
2. 設定例（deploy 後の `workers.dev` に合わせる）:
   - Application name: `Obsidian MCP (production)`
   - Homepage URL: `https://obsidian-mcp-auth.namiyama814.workers.dev`
   - Authorization callback URL: `https://obsidian-mcp-auth.namiyama814.workers.dev/callback`
3. Client ID / Client Secret を控える

別アカウントへデプロイする場合は、そのアカウントの workers.dev サブドメインに置き換えます。

### 4. OAuth 用 KV

このアカウントでは本番用 `OBSIDIAN_MCP_OAUTH_KV` とプレビュー用 `OBSIDIAN_MCP_OAUTH_KV_preview` を作成済みで、ID も `auth-worker/wrangler.jsonc` に設定済みです。別アカウントへデプロイする場合のみ、以下を実行してください。

```bash
npx wrangler kv namespace create OAUTH_KV
npx wrangler kv namespace create OAUTH_KV --preview
```

出力された `id` を `auth-worker/wrangler.jsonc` の `kv_namespaces` に記入:

- `id` → production
- `preview_id` → preview / local

### 5. wrangler.jsonc の URL

このアカウント向けの値は設定済みです。別アカウントへデプロイする場合は両方の `wrangler.jsonc` で次を書き換えます:

- `AUTH_ISSUER` = `https://obsidian-mcp-auth.namiyama814.workers.dev`
- `MCP_RESOURCE_URL` = `https://obsidian-mcp.namiyama814.workers.dev/mcp`

`mcp-worker` の Service Binding は既に `service: "obsidian-mcp-auth"` です（auth を先に deploy）。

### 6. Secrets / Vars 登録（production）

auth-worker:

```bash
npx wrangler secret put GITHUB_CLIENT_ID -c auth-worker/wrangler.jsonc
npx wrangler secret put GITHUB_CLIENT_SECRET -c auth-worker/wrangler.jsonc
npx wrangler secret put CONSENT_SECRET -c auth-worker/wrangler.jsonc
# CONSENT_SECRET は 32 文字以上推奨:
# openssl rand -hex 32
```

mcp-worker:

```bash
npx wrangler secret put GITHUB_REPO_TOKEN -c mcp-worker/wrangler.jsonc
```

vars（デフォルトは wrangler.jsonc に記載済み、必要なら上書き）:

| Name | Default | Worker |
|------|---------|--------|
| `GITHUB_OWNER` | `namiyama814` | mcp |
| `GITHUB_REPO` | `obsidian` | mcp |
| `GITHUB_BRANCH` | `main` | mcp |
| `ALLOWED_GITHUB_LOGIN` | `namiyama814` | auth |
| `AUTH_ISSUER` | （手順 5） | 両方 |
| `MCP_RESOURCE_URL` | （手順 5） | 両方 |

### 7. Deploy（auth → mcp の順）

```bash
npm run deploy:auth
npm run deploy:mcp
```

Deploy 後の MCP URL:

```text
https://obsidian-mcp.namiyama814.workers.dev/mcp
```

Auth issuer:

```text
https://obsidian-mcp-auth.namiyama814.workers.dev
```

### 8. ローカル開発用 `.dev.vars`

```bash
cp auth-worker/.dev.vars.example auth-worker/.dev.vars
cp mcp-worker/.dev.vars.example mcp-worker/.dev.vars
# それぞれ編集して local OAuth App / GITHUB_REPO_TOKEN を入れる
```

ローカル起動（Service Binding 付き）:

```bash
npm run dev
# または個別:
# npm run dev:auth   # :8787
# npm run dev:mcp    # :8788
```

ローカル MCP: `http://localhost:8788/mcp`

ローカル Auth: `http://localhost:8787`

### 9. テスト

```bash
npm test
npm run typecheck
```

手動スモーク:

1. `GET https://<mcp-host>/health` → `{ "status": "ok" }`
2. `GET https://<mcp-host>/.well-known/oauth-protected-resource/mcp`
3. `GET https://<auth-host>/.well-known/oauth-authorization-server`（`scopes_supported` に `offline_access` があること）
4. 未認証で `POST /mcp` → `401` + `WWW-Authenticate`（`resource_metadata`）
5. MCP Inspector / ChatGPT で OAuth → `tools/list` → `read_note`

### 10. MCP Inspector

```bash
npx @modelcontextprotocol/inspector@latest
```

1. Transport: **Streamable HTTP**
2. URL: `https://obsidian-mcp.namiyama814.workers.dev/mcp`
3. OAuth フローを実行（GitHub で `namiyama814` のみ許可）
4. `List Tools` → `read_note` を実行

### 11. ChatGPT への登録

1. ChatGPT → Settings → 開発者向け機能 / Plugins（環境により名称が異なります）
2. **Create custom MCP server**
3. Server URL: `https://obsidian-mcp.namiyama814.workers.dev/mcp`
4. Authentication: **OAuth**
5. ChatGPT が `/.well-known/oauth-protected-resource/mcp` → Authorization Server Metadata を discovery します（CIMD / DCR 対応）
6. ブラウザで GitHub ログインし、許可アカウントで同意

## MCP Tools

| Tool | Scope | 説明 |
|------|-------|------|
| `list_vaults` | `obsidian.read` | トップレベル Vault 一覧（`.obsidian` 除外） |
| `list_notes` | `obsidian.read` | Vault 内 `.md` 一覧 |
| `read_note` | `obsidian.read` | ノート本文 + `sha` + commit 情報 |
| `search_notes` | `obsidian.read` | ファイル名・本文検索（日本語可） |
| `create_note` | `obsidian.write` | 新規作成（既存はエラー） |
| `update_note` | `obsidian.write` | 全文更新（`expectedSha` 不一致は `CONFLICT`） |
| `move_note` | `obsidian.read` + `obsidian.write` | ノートの移動・改名（上書き禁止、1コミット） |
| `delete_note` | `obsidian.read` + `obsidian.write` | ノート削除（SHA で競合確認） |
| `append_note` | `obsidian.write` | 末尾追記（SHA 再確認） |

`move_note` は `vault`、`path`、`destinationPath` を指定します。`destinationVault` を省略すると同じ Vault 内で移動・改名します。移動先の Vault は既存のものに限り、既存ファイル・ディレクトリへの上書きは拒否します。追加と削除を1コミットで反映し、ブランチの競合時には `CONFLICT` を返します。ノート内リンクや他のノートからのリンクは書き換えません。リポジトリの tree が大きすぎて取得結果が省略された場合は、安全のため `TREE_TRUNCATED` で中止します。

`delete_note` は `vault`、`path` を指定してノートを削除します。削除はGit履歴に残ります。両ツールとも `expectedSha`（直近の `read_note` の SHA）と `commitMessage` を任意指定できます。`expectedSha` が現在のノートと異なる場合は `CONFLICT` を返します。

## セキュリティメモ

- Path traversal（`../`）、絶対パス、`.git` 脱出を拒否
- 書き込み対象は原則 `.md` のみ
- OAuth access / refresh / `GITHUB_REPO_TOKEN` / Client Secret / Authorization ヘッダ / ノート本文はログに出しません
- GitHub OAuth トークンは identity 確認後に破棄し、リポジトリ操作には使いません

## ライブラリ

- `agents`（`createMcpHandler` / Streamable HTTP）
- `@modelcontextprotocol/server` v2
- `@cloudflare/workers-oauth-provider` v1（`OAuthAuthorizationServer` + `OAuthResourceServer`）
- `zod`

## トラブルシュート

| 症状 | 確認 |
|------|------|
| OAuth discovery 失敗 | `AUTH_ISSUER` / `MCP_RESOURCE_URL` が実 URL と一致しているか |
| Service Binding エラー | auth-worker を先に deploy したか、`service` 名が `obsidian-mcp-auth` か |
| 他の GitHub ユーザーが入れる | `ALLOWED_GITHUB_LOGIN` |
| Code Search が空 | Fine-grained PAT の Contents 権限。フォールバックの tree scan が使われます |
| ChatGPT が OAuth UI を出さない | `/mcp` の 401 `WWW-Authenticate` と `/.well-known/oauth-protected-resource/mcp` |

## GitHub Secret の設定

Worker と KV はデプロイ済みです。Production 用 GitHub OAuth App の `GITHUB_CLIENT_ID` と `GITHUB_CLIENT_SECRET`、`CONSENT_SECRET` は auth-worker に、`GITHUB_REPO_TOKEN` は mcp-worker に設定済みです。GitHub API で `namiyama814/obsidian` の読み取りは確認済みです。

トークンをローテーションしたら、同じ名前で `wrangler secret put` を実行して Worker の Secret を更新してください。OAuth ログインから MCP ツール実行までの手動テストは別途必要です。
