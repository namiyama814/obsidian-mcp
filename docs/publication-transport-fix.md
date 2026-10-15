# 公開時のGitHub通信障害を修正した記録

2026年10月15日、公開用クライアントの通信障害を修正し、既存の本番Workerへ反映した。本番MCPで `mode: "move"` の準備・登録に成功し、移動元の削除、移動先への配置、ID台帳の登録が一つのコミットで完了したことを確認した。本番サイトの同期完了は、専用トークンが未設定のため確認していない。

## 通信前の例外と通信回数上限をそれぞれ確認した

最初の失敗は `PublicationRepository.api()` の `redirect: "error"` が原因だった。ローカルのworkerdでは次のTypeErrorを再現した。

```text
Invalid redirect value, must be one of "follow" or "manual"
```

同じGitHub URL、APIバージョン `2026-03-10`、`AbortSignal.timeout(30000)` で、`manual` に変更するとHTTP 200になった。診断ログだけを追加した本番Workerでも、最初のリポジトリ情報取得で `operation: repository.metadata`、`errorName: TypeError`、`errorMessage: unsupported_redirect_mode`、所要時間0msを確認した。HTTP応答やGitHubへの権限不足による失敗ではなかった。

これを直すと、状態確認はGitHubアクセスを通過した。一方、移動準備では別の失敗が発生した。全ノートへの参照を検証する処理が、Markdownを1件ずつ取得していたため、60件ある実際のVaultで通信回数上限に達していた。本番ログは `operation: git.blobs`、`requestCount: 50`、`errorMessage: worker_subrequest_limit` を示した。認証処理にも通信があるため、このカウンターはWorker全体の通信回数とは一致しない。

Cloudflareの[サブリクエスト上限](https://developers.cloudflare.com/workers/platform/limits/#subrequests)では、Freeプランの外部通信は1呼び出し50件までとなっている。課金プランや上限設定は変更していない。

## 検証を保ったまま通信をまとめた

`repository.ts` の通信を共通処理へまとめ、`redirect: "manual"` を使う。通常APIの3xxは明示的に拒否する。Actionsログの302だけは従来の許可ホストを検証し、別リクエストで取得する。この取得にはGitHub認証ヘッダーを付けず、さらに返された3xxも拒否する。

`content.ts` のノート読み込みは、8件以上の未取得blobがある場合に20件ずつGraphQLで取得する。指定するのはスナップショット内の不変なGit SHAであり、ブランチ先頭の可変パスは使わない。全ノートを従来どおり検証し、本文の欠落・切り詰め・バイナリ判定・サイズ違い・Git blob SHA違いがあれば停止する。1MBの文書上限と合計32MiBの取得上限も維持した。キャッシュはMCPの1リクエスト内だけで使用する。

GraphQLの[Blob仕様](https://docs.github.com/en/graphql/reference/git#blob)にある `oid`、`byteSize`、`isBinary`、`isTruncated`、`text` を使用する。接続先は固定の `https://api.github.com/graphql` で、既存の原本リポジトリ用認証を使う。権限やSecretは変更していない。

タイムアウトは `GITHUB_TIMEOUT`、通常の通信失敗は従来の `GITHUB_UNAVAILABLE` として区別する。HTTP 401・403は `PERMISSION_DENIED`、404は `NOT_FOUND`、409・422は `CONFLICT`、429は `GITHUB_RATE_LIMITED`、500などは `GITHUB_ERROR` となる。応答の完全性を確認できない場合は `GITHUB_INVALID_RESPONSE`、3xxは `GITHUB_REDIRECT_REJECTED`、Workerの通信回数上限は `VERIFICATION_LIMIT` とする。

診断ログには、操作の分類、HTTPメソッド、通信回数、例外の分類、所要時間、HTTPステータスを残す。例外の生メッセージ、本文、URL、クエリ、認証ヘッダーは残さない。

## 本番MCPで移動と台帳登録まで確認した

`npm run typecheck` は成功し、`npm test` は14ファイル・154件すべて成功した。追加テストでは通信失敗、タイムアウト、HTTPエラー、リダイレクト、ログへの秘密情報混入、GraphQL応答の改変・欠落・切り詰めを検証した。実際のworkerdでリクエストを構築するテストと、60件の架空ノートを全件検証しつつ50回未満の通信で準備・適用するテストも通った。最後のバッチに壊れる参照を置くと、公開を拒否することを確認した。

専用の非公開テストリポジトリで `PUBLICATION_LIVE_TEST=1 npm run test:publication:live` を実行し、一括読み取りを含む準備、固定ID・添付・台帳・削除の一括登録、同一トークンの再試行、公開停止を確認した。テストの変更先は専用ブランチだけであり、本番文書や本番台帳をテスト目的で変更していない。実際のVaultの60件も読み取り専用で取得し、すべてサイズとSHAを検証できた。

最終版の本番Workerバージョンは `7473d66f-fde4-4579-86c8-c56685c3b46b`。既存アカウントの `obsidian-mcp` にデプロイし、既存のOAuth、サービスバインディング、Secretを維持した。デプロイ直後の初回呼び出しでは直前の通信回数上限エラーが返ったが、その後の準備と登録は成功した。この初回応答の理由は未確認であり、反映遅延とは断定していない。

本番では問題・添付・リンク変更がいずれもないプランを確認し、利用者が依頼した移動・登録を公開専用ツールで実行した。通常の移動や直接のGitHub書き込みによる迂回は行っていない。元の契約書本文は固定IDの追加以外に変更していない。監査用の本文・署名付きプランはこの記録に含めない。

## サイトの同期確認には専用トークンが必要

`OFFICE_GITHUB_TOKEN` は未設定のままである。登録は成功したが、MCPの状態確認は `registration: registered`、`reason: OFFICE_TOKEN_NOT_CONFIGURED` を返す。本番サイトへの反映済みとは判断していない。手動同期も起動していない。

専用トークンを設定する場合は、既存の管理手順に従い、officeSystemだけを対象にContentsの読み取りと、必要なActionsの権限を付与する。値は安全な入力で `wrangler secret put OFFICE_GITHUB_TOKEN -c mcp-worker/wrangler.jsonc` に登録する。他のトークンを転用しない。設定後は `get_publication_status` で成功状態と原本の一致を確認する。

履歴やVaultがさらに増えた場合は、既存の取得量・通信回数上限で停止し得る。今回は検証を減らしたり上限を引き上げたりせず、実際の60件のVaultを処理できることを確認した。
