# ノートを社内サイトへ登録する

この機能は、原本 `namiyama814/obsidian` の `main` ブランチに、ノート・承認された添付・ID台帳を一つのコミットで登録します。対象Vaultは `main` です。利用者は「利用者の操作」まで読めば使えます。以降はクライアント実装・管理・問題解決の参照用です。通常のビルド・同期は原本を読み取るだけです。

**`main/社内共有/` に置くと、Cloudflare Accessで認証した `@zuikaku.biz` の全メールアドレスが閲覧できます。** ファイルごとの閲覧制限はありません。非共有ノートは自動公開しません。非共有添付はファイルごとの承認がある場合だけコピーし、元添付を残します。

原本登録と本番反映は別です。原本の更新後、officeSystemの同期が成功してから `https://work.zuikaku.biz/docs/<doc_id>` に反映されます。毎時17分に同期予定があり、GitHub側で遅れる場合があります。

## 利用者の操作

普段の操作にターミナルは使いません。次のように依頼してください。

> mainの「企画/提案.md」を社内サイトに公開して。元ノートは残して。

MCPクライアントは次の順に処理します。

1. `read_note` でノートとSHAを取得します。
2. `prepare_publication` を `mode: copy` で呼びます。配置先省略時は `社内共有/提案.md` です。
3. 配置先、会社ドメイン全員が閲覧すること、必要な添付と変更予定を提示します。
4. 利用者がノートの公開と添付の一覧を承認したら、返された `planToken` をそのまま `publish_note` へ渡します。
5. 「原本登録成功」、固定ID、予定URL、原本コミット、次回同期予定を返します。この時点を「本番公開完了」とは表現しません。
6. `get_publication_status` で反映状況を確認します。明示的に「今すぐ同期も起動して」と依頼された場合だけ `trigger_publication_sync` を使います。

元ノートを移す場合は `mode: move` です。移動で他ノートのリンクが壊れる場合は、修正対象を返して停止します。参照元のノートを無断で変更しません。

非共有ノートへの参照、不足・曖昧なリンクがある場合も停止します。参照先を追加公開する代わりに、必要に応じてノートのリンクを削除・修正して再確認してください。非共有ファイルへ閲覧サイトからアクセスできる経路は作りません。

> 社内共有の「提案.md」を「保管/提案.md」へ戻して公開を停止して。

公開停止は `unpublish_note` を二回呼びます。最初は移動先とSHAで予定を確認し、承認後は `planToken` と `confirm: true` だけを渡します。他の公開文書のリンクが壊れる場合は停止します。原本とIDは非共有フォルダで保持し、台帳のIDを廃止します。移動後も解決できるよう、ノート内のリンクを必要な範囲だけ書き換えます。元から解決できない参照やHTMLがある場合は`warnings`に返し、原文を保持して取り下げます。同期成功まで本番に前回の資料が残ります。

**廃止IDは復活できません。** 別文書として新しいIDで再公開する場合は `copy` を使い、過去に別IDを登録していない共有パスを指定してください。台帳に保存された初回パスを別IDへ付け替えることも、既存仕様で禁止されています。

## MCPツールの入力と戻り値

| ツール | OAuth scope | 主な入力 |
| --- | --- | --- |
| `prepare_publication` | `obsidian.read` | `vault`, `path`, `expectedSha`, `mode: move/copy`, `destinationPath?` |
| `publish_note` | `obsidian.read` + `obsidian.write` | `planToken`, `confirm: true`, `approvedAttachments` |
| `get_publication_status` | `obsidian.read` | `vault`と、`path`または`doc_id`の一方 |
| `unpublish_note` | `obsidian.read` + `obsidian.write` | 準備時: `vault`, `path`, `destinationPath`, `expectedSha`。適用時: `planToken`, `confirm: true` |
| `trigger_publication_sync` | `obsidian.read` + `obsidian.write` | `expectedSourceCommit`, `force?`（既定`false`） |

準備の例です。以下の値は説明用で、そのまま適用できません。

```json
{
  "vault": "main",
  "path": "企画/提案.md",
  "expectedSha": "read_noteが返したファイルSHA",
  "mode": "copy"
}
```

準備結果には `ready`、`issues`、`documents`、`attachments`、`linkEdits`、`changes`、`registryChanges`、`revisions`、`audience` が入ります。`attachments` の `approvalRequired: true` が非共有添付のコピー候補です。`doc_id` は適用まで候補であり、原本への発行は確定していません。

問題がある予定は `ready: false`、`planToken: null` です。問題がなければ、30分有効の署名付きトークンを返します。本文はトークンへ入れません。トークンにはパス・SHA・ID候補・予定のハッシュが含まれるため、チャット外へ転載しないでください。

```json
{
  "planToken": "prepare_publicationが返した値",
  "confirm": true,
  "approvedAttachments": ["添付/図.png"]
}
```

`approvedAttachments` は承認したコピー元のVault相対パスです。予定された非共有添付の一覧と完全に一致させます。添付がなければ `[]` です。承認したものだけを選んで予定の残りを黙って省くことはしません。不要な添付はノートの参照を修正してから再準備します。

新規公開は共有フォルダ直下へ配置します。共有済みノートを `move` で確認し、配置先を省略した場合は現在位置を維持します。明示的な `destinationPath` で共有配下のサブフォルダも指定できます。ファイルやフォルダへの上書きは拒否します。

公開済み文書の更新は、既存の `update_note`、`append_note`、`update_note_section` で行えます。`doc_id`の削除・変更は拒否します。共有文書の新規作成・移動・削除は、公開用ツールを使ってください。

適用の成功結果は `doc_id`、`url`、`sourceCommit`、`registration`、`nextSyncAt`、`synchronization` を返します。URLは同期後の予定URLです。同期起動は独立した操作であり、失敗しても原本登録を取り消しません。

## 状態と競合への対処

| `status` | 意味 |
| --- | --- |
| 未登録 | 有効な登録がなく、成功状態にも対象IDがない |
| 公開待ち | 原本に登録され、成功状態にはまだ対象IDがない |
| 公開済み | 成功状態の原本コミット・ID対応・ハッシュを検証でき、現在の対象ノートと参照先・添付が一致する |
| 更新待ち | 成功状態があるが、対象のノート・参照先・添付に変更がある |
| 公開停止待ち | 原本で廃止済みだが、前回の成功状態には資料が残る |
| 公開停止済み | 原本で廃止済みで、成功状態にも廃止が反映されている |
| 同期失敗 | 対象原本コミットを取得したことが証明できる同期が失敗し、対象の反映が待機している |
| 状態を確認できない | 権限、状態ファイル、履歴、整合性などの証拠が不足している |

状態確認ではofficeSystemの `deploy-state/state.json`、そこに記録された原本コミット、ID対応表、Markdown・添付・台帳の成功ハッシュを検証します。無関係な非共有ノートの更新だけでは「更新待ち」にしません。未認証のAccess 302や、ワークフローの起動受付だけで公開済みとは判断しません。

同期の失敗を資料へ関連付ける際は、成功した `Checkout Obsidian read-only` ステップの時間範囲内で、`git log -1 --format=%H` が出力した完全なSHAを確認します。ログ本文は応答・アプリログに出しません。最新同期が失敗していても原本コミットとの対応を証明できない場合は、`syncObservation`へ同期全体の結果を添え、資料の同期失敗とは断定しません。

| 結果・エラー | 対処 |
| --- | --- |
| `CONFLICT` | 原本・台帳・添付・ブランチ先頭・参照した成功状態を読み直し、予定を再確認する |
| `PLAN_EXPIRED` | 30分を超えたため、再準備する |
| `ATTACHMENT_APPROVAL_REQUIRED` | コピー候補と承認パスを確認する |
| `BROKEN_INCOMING_LINK` | 返された参照元リンクを修正し、再準備する |
| `OUTCOME_UNKNOWN`・通信切断 | **同じ`planToken`で再確認する。新しい予定・IDを作らない** |
| `VERIFICATION_LIMIT`・`TREE_TRUNCATED` | 検証を省略せず停止する。管理者が履歴・データ量とWorkerの制限を確認する |
| `GITHUB_TIMEOUT`・`GITHUB_UNAVAILABLE` | タイムアウト・通信失敗。適用中に発生した場合は同じ`planToken`で成否を確認する |
| `GITHUB_REDIRECT_REJECTED` | APIが3xxを返した。自動追従はせず、管理者が移転先と設定を確認する |
| `GITHUB_RATE_LIMITED` | HTTP 429。時間を置き、適用の再確認には同じ`planToken`を使用する |
| `GITHUB_INVALID_RESPONSE` | 応答のJSON、本文の完全性、サイズ、Git SHAを確認できないため停止した |
| `DISPATCH_OUTCOME_UNKNOWN` | 起動が受け付けられた可能性があるため自動再実行せず、Actionsを確認する |

再実行では、コミットの操作識別子を検索し、成功済みなら同じID・コミットを返します。期限切れやブランチ変更より先に成功済み操作を確認するため、成功直後の応答喪失でもIDを再発行しません。

## 管理者の初回設定

利用者のGitHubログイン、許可アカウント制限、MCP OAuth scopeは既存のものを使います。新しいCloudflareアカウントやストレージは不要です。

Cloudflare Dashboardの **Workers & Pages → obsidian-mcp → Settings → Variables and Secrets** で次を設定します。値はSecretとして保存し、ソース・Issue・チャットへ貼り付けないでください。

| Secret | 必要な権限・内容 |
| --- | --- |
| `GITHUB_REPO_TOKEN` | 既存の原本専用Fine-grained PAT。`namiyama814/obsidian`のContents読取・書込、Metadata読取。JSON台帳にも同じContents権限を使う |
| `PUBLICATION_PLAN_SECRET` | パスワードマネージャー等で作る32文字以上のランダムな秘密値。確認トークンのHMAC-SHA-256署名用 |
| `OFFICE_GITHUB_TOKEN` | 任意。Resource owner `zuikakuedit`、対象を`officeSystem`だけに限定した別のFine-grained PAT。Contents読取、Actions書込、Metadata読取 |

状態取得だけなら `OFFICE_GITHUB_TOKEN` のActionsは読取でも使えます。手動同期はActions書込がないと失敗し、毎時17分を待つ結果を返します。Secret自体がなければ公開の原本登録はできますが、本番状態は「状態を確認できない」、手動同期は未設定として返します。

officeSystemが持つ `OBSIDIAN_READ_TOKEN` の権限は広げません。officeSystemのCloudflareトークンをこのMCPへ設定する必要もありません。

設定後、管理者が通常のリリース手順でMCP Workerをデプロイし、クライアントのツール一覧を更新してください。署名Secretを交換すると、未適用の古い確認トークンは無効になります。適用済み操作を再確認する際も署名検証が必要なので、応答不明の操作を確認してから交換してください。

## 検証方法と制約

`npm test` と `npm run typecheck` で通常テストと統合スクリプトの型を確認します。実GitHub検証は `scripts/test-publication-live.ts` です。`PUBLICATION_LIVE_TEST=1` を指定した場合だけ、固定の非公開リポジトリ `namiyama814/obsidian-mcp-publication-test` に架空資料を登録します。実資料のリポジトリを引数で渡す機能はありません。毎回専用ブランチを作り、検証コミットを残します。

管理者用の実行例です。

```sh
PUBLICATION_LIVE_TEST=1 npm run test:publication:live

PUBLICATION_LIVE_TEST=1 \
OFFICE_SYSTEM_PATH=/path/to/officeSystem \
PUBLICATION_TEST_COMMIT=<実GitHub検証の公開コミット> \
PUBLICATION_STOP_COMMIT=<実GitHub検証の停止コミット> \
npm run test:publication:office
```

GitHub認証は `PUBLICATION_TEST_TOKEN`、または既存の`gh`認証から取得します。値は標準出力・引数・ファイルへ出しません。officeSystem互換テストはダミー原本を一時cloneし、既存の`extract`・台帳履歴・文書履歴の実装をそのまま使います。作業ディレクトリは終了時に削除します。

次の制約があります。

- Markdown・台帳は1ファイル1MB、添付は25MiBまで検証します。一つの原本RepositoryクライアントにつきGit blobの読込合計32MiB、API呼出し800回を上限とし、超過や履歴欠落は停止します。WorkerプランやGitHub側の制限が先に適用される場合もあります。
- 移動時の参照確認ではVaultの通常Markdownを走査します。検証できないFrontmatter・構文や大きすぎるノートがある場合、部分確認で進めません。
- 添付は共有フォルダ直下へコピーします。同名の別添付、既存の配置先、曖昧なWikiリンクは停止します。本文やコードの一括再整形はしません。
- 生HTML、SVG、外部画像、ObsidianブロックID参照、原文位置を特定できないエスケープ・実体参照を含むリンクは停止します。ノート全文の埋め込みはofficeSystem同様に閲覧リンク扱いです。
- 同期ログは最新実行・100件未満のジョブ・2MiBまでを確認します。ログの取得権限不足、期限切れ、形式変更などで資料と対応できなければ、その制約を返します。
- 成功状態は最後の検証済みデプロイを示します。現在のAccess設定や実ユーザーのPINログインをMCPから検査するものではありません。
- ローカル実MCP通信テストでは検証済みOAuthコンテキストを注入します。本番OAuthのログイン、Workerへの本番デプロイ、会社ドメインでの閲覧、本番の手動同期は別途確認が必要です。

実行結果と検証コミットは [検証記録](publication-validation.md) に記載します。

用語: Vaultはノートを置くフォルダ、Frontmatterはノート先頭のYAML、doc_idは固定URLの識別子、deploy-stateは検証済みデプロイの成功記録です。解決しない問題は、このリポジトリの管理者へエラー名とコミットSHAを伝えてください。ノート本文やSecretは問い合わせに添付しません。

最終更新: 2026年10月15日。
