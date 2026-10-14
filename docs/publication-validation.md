# 社内公開機能の検証記録

検証日: 2026年10月15日（JST）。実資料の公開と本番の同期起動は行っていません。本番MCP Workerのリリース結果は末尾に記載します。

## 自動テスト

`npm run typecheck`、`npm test`（11ファイル・119テスト）、`git diff --check`が成功しました。型チェックには管理者用の統合テストスクリプトも含めています。

検証対象は次のとおりです。

- 新規公開、コピー、21文字の既存ID、連続する改名・移動、共有済みノートの本文更新、公開停止、同じ予定の再実行。
- YAML項目・コメント・本文・CRLF、コード内のリンク文字列、通常リンク・参照リンク・Wikiリンク、添付名の空白・日本語。
- ID不正・重複・大文字小文字の衝突・ID変更・削除後の再利用、台帳の履歴削除・書換え、廃止IDの復活。
- 原本SHA、台帳、無関係なファイル更新を含むブランチ競合、ref更新直前の競合、blob/tree/commit/refの失敗、ref更新後の応答喪失。
- 非共有ノートへの参照、未承認・余分な添付、不要なリンク定義、壊れる参照元、曖昧・不足したリンク、エンコードによるパストラバーサル、隠しフォルダ、シンボリックリンク、不完全tree。
- 八つの資料状態、添付だけの更新、無関係な原本更新、成功状態の欠落・ID対応不整合・ハッシュ不整合、同期と原本SHAの対応を確認できない場合。
- OAuth scope、署名改ざん・期限切れ・別操作・別リポジトリのトークン、確認トークンと本文のログ除外。
- 同期起動の既定force=false、権限不足、受付応答の喪失、GitHub認証ヘッダーをログ配布先へ転送しないこと、不正な配布先への転送拒否。

`wrangler deploy --dry-run`でもMCP Workerのバンドルに成功しました。dry-runは本番Workerを更新しません。

## ダミーの非公開リポジトリでの実MCP検証

対象は [namiyama814/obsidian-mcp-publication-test](https://github.com/namiyama814/obsidian-mcp-publication-test) です。公開範囲を確認してから、架空ノートと1ピクセルのダミーPNGだけを使いました。

| 項目 | 証拠 |
| --- | --- |
| テストブランチ | `publication-test-1792020878938` |
| 公開登録 | [dcf0a985d499c8bf8d3ff00839fbc13e7b4e66a2](https://github.com/namiyama814/obsidian-mcp-publication-test/commit/dcf0a985d499c8bf8d3ff00839fbc13e7b4e66a2) |
| 公開停止登録 | [c857e581064f68dc37fa25f745fd33499d226105](https://github.com/namiyama814/obsidian-mcp-publication-test/commit/c857e581064f68dc37fa25f745fd33499d226105) |
| 発行ID | `alyieA9uN5gb`（テスト用。社内サイトには登録していない） |

ローカルのStreamable HTTP MCPサーバーへJSON-RPCの`tools/list`・`tools/call`を送り、外向きGitHub通信は実APIを使いました。

- 準備操作で原本のブランチ先頭が変わらないことを確認しました。
- 読取scopeだけの公開要求が拒否されることを確認しました。
- 公開コミットの親が準備時の先頭と一致し、Markdown・PNG・JSON台帳・元ノートの削除が同じコミットに含まれることを確認しました。GitHubが改名として返す場合も、`previous_filename`とtreeの両方で元パス削除を確認しています。
- 元添付を保持し、Frontmatterのコメント・本文のコード文字列が維持されることを確認しました。
- 同じ確認トークンを再実行しても、同じID・コミットが返り、ブランチ先頭が増えないことを確認しました。
- 公開停止をMCPから実行し、非共有フォルダへの移動と台帳の廃止を登録しました。

最終実行は成功しました。その前の一度の実行ではGitHub APIの500で停止したため、検証スクリプトに同じ確認トークンでの一時障害の再確認を追加しました。再確認のために新しいIDや予定は発行しません。

この検証では、HTTP transportに検証済みOAuthコンテキストを注入しています。GitHubログインから本番OAuth認可までの一連の操作を再検証したものではありません。

## officeSystemの既存実装との互換性

officeSystemのローカルコミット `d2d2b20e19136306a6ce541ffb242503cf6d86ff` にある `scripts/content.ts` を変更せずに使用しました。

ダミーリポジトリを一時cloneし、公開登録コミットと停止コミットを順にcheckoutして`extract`を実行しました。結果は成功です。

- 公開時はノート1件・参照添付1件を抽出できました。
- 台帳のGit履歴、文書IDのGit履歴、共有範囲と参照を既存コードで検証できました。
- ステージングに原本だけのFrontmatter項目が入らないことを確認しました。
- 前回の成功snapshotを渡した停止後の抽出では、公開ノート・添付が0件になり、旧IDが`retiredIds`へ入りました。

officeSystem、原本 `namiyama814/obsidian`、Cloudflare Accessの設定や認証情報は変更していません。

## 未実施と運用上の制約

- 本番MCP Workerのデプロイと`PUBLICATION_PLAN_SECRET`の設定は完了しました。`OFFICE_GITHUB_TOKEN`は未設定です。状態取得は確認不能、手動同期は未設定として返し、原本登録後は毎時17分の同期を待ちます。権限の設定方法は [利用手順](publication.md#管理者の初回設定) に記載しました。
- 本番の`deploy-state`を使った実資料の資料単位判定、本番`sync.yml`のdispatch、実ユーザーのAccess PINログインは未検証です。状態とdispatchは模擬GitHub応答で検証しています。
- 実GitHub検証はローカルMCP transportから行いました。本番Workerの起動・ヘルスチェック・未認証拒否は確認済みですが、本番OAuth接続後の新ツールの実行は別途確認が必要です。
- API呼出し・読込サイズ・履歴の検証上限があります。上限超過時は検証を省略せず停止します。巨大Vaultでの性能測定は未実施です。
- 既存依存の`agents@0.26.0`系列に、`npm audit --omit=dev`でhigh 3件が報告されます。該当する`agents`・MCP client・SDKのバージョンは元のlockfileと同じです。この機能追加では互換性を伴うSDK更新を行っていません。

## 本番MCP Workerのリリース

2026年10月15日（JST）、ユーザーの依頼によりGitHubへのpushと本番デプロイを実行しました。

- ソース: [cfd192f](https://github.com/namiyama814/obsidian-mcp/commit/cfd192f) を`main`へpushしました。
- Worker: `obsidian-mcp`。バージョンIDは`d35695f9-c886-4074-890e-2dc8beb197c7`です。
- エンドポイント: `https://obsidian-mcp.namiyama814.workers.dev/mcp`。
- 新規のランダムな`PUBLICATION_PLAN_SECRET`をSecretへ登録しました。値はソース・ログ・チャットへ出していません。既存の原本用トークンは維持しています。
- デプロイ前の119テスト・型チェックが成功し、Workerの起動時間は50msでした。
- 本番で`/health`の200と`status: ok`、OAuth保護リソースメタデータの200、未認証`tools/list`の401とBearer認証要求を確認しました。
- `OFFICE_GITHUB_TOKEN`はWorkerにも実行環境にもないため登録していません。既存のGitHub CLI用認証をofficeSystem専用トークンとして転用していません。

実資料への操作、officeSystemの本番同期起動、Cloudflare Accessや閲覧サイトの変更は行っていません。
