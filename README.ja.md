# Agent Vault

[English](README.md) | [한국어](README.ko.md) | **日本語** | [简体中文](README.zh-CN.md)

[![skills.sh](https://skills.sh/b/jung-geun/agent-vault)](https://skills.sh/jung-geun/agent-vault)

**エージェントや開発環境が変わっても、ユーザー・プロジェクト・業務の知識を引き継いで活用するためのメモリハーネスです。**

会話をただ保存するのではなく、知識の意味・関係・条件・導出の根拠を記録し、新しい証拠に応じて段階的に改善します。特定のハーネスに依存しないよう、スキル、MCP サーバー、CLI を提供しており、Claude Code・Codex・Cursor・OMP など、スキルと MCP をサポートする環境に接続できます。OMP は対応環境の一つであり、必須ではありません。

## インストール

Node.js 24 LTS を推奨します。次のコマンドの実行時に、使用するエージェントを選択してください。

```sh
npx skills add jung-geun/agent-vault -g
```

`-g` はユーザー全体へのグローバルインストールです。インストール元には npm パッケージ名ではなく、GitHub リポジトリ名 `jung-geun/agent-vault` を指定します。

インストール後は、エージェントのスキル呼び出し機能を使うか、チャットで **「agent-vault スキルでこのプロジェクトをセットアップして」** と依頼してください。セットアップやメモリの利用のために、ターミナルで `npx` を繰り返し実行する必要はありません。

## 主な機能

- **文脈の維持:** ユーザーの好み、プロジェクトの決定、作業状態を保存し、次のタスクで呼び出します。
- **メモリの分離:** グローバル・プロジェクト・ロールごとにスコープを分け、短期の作業状態と長期の知識を区別します。
- **根拠に基づく改善:** ユーザーの訂正を再検討のシグナルとして扱い、既存の知識と新しい証拠を比較します。根拠が不十分な場合は更新を保留します。
- **タスク境界での整理:** 利用回数や経過期間はレビューを予約するだけです。実行中のタスクを中断せず、正常終了時やアイドル時に、レビュー済みの変更を適用します。
- **選べるストレージ:** ドキュメントと短期メモリは Markdown ファイルのままです。長期メモリとレビュー履歴は、追加パッケージ不要の SQLite が既定です。設定で PostgreSQL または MySQL/MariaDB も選べます。
- **週次記録:** 知識・ログ・引き継ぎを、日付・曜日ごとに `YYYY-WW.md` 一つにまとめます。月曜日を過ぎても進行中のタスクは開始した業務週に残ります。設定したデータベースでは日付やキーワードで検索できます。
- **ユーザー persona:** 質問・コーディング・業務指示・業務時間のパターンを根拠とともに管理し、応答や質問の仕方を調整します。現在の依頼が常に優先され、観察結果を事実や権限として扱うことはありません。
- **任意のチーム共有:** 明示的に設定したチームストアのみを使用し、個人のメモリを自動的に共有することはありません。
- **ランク付き想起とヘルスチェック:** `agent-vault recall` は外部検索サービスを使わず、タスクの説明に合うメモリをキーワードで順位付けします。任意の自動想起は Claude Code と Codex のプロンプトに背景情報としてのみ追加され、指示としては扱われません。`agent-vault status` は件数、レビューキュー、問題ごとの対処方法を報告します。
- **正規表現・類似度・ローカル埋め込み検索:** 検索は `regex` と `similar` のモードに対応し、上位 5 件（最大 10 件）を返します。`similar` は、自分のマシンで動く小さな埋め込みモデル（Ollama または LM Studio、ループバックのみ）があればそれを使い、なければ文字の類似度で動作するため、モデルがなくても使えます。埋め込みを行うのは `similar` で検索したときだけです。日本語など英語以外のメモには、英語専用モデルではなく多言語モデル（例: `granite-embedding:278m`）を使ってください。

## 使い方

以下は **エージェントに送る依頼** です。ターミナルのコマンドではなく、`/agent-vault` のような呼び出し構文は、その環境がサポートしている場合にのみ使用します。

| 依頼の例 | 動作 |
| --- | --- |
| `agent-vault setup` | 現在のプロジェクトと保管庫を設定し、使用している環境でローカル MCP 接続を行います。 |
| `agent-vault install` | インストール済みスキルの MCP 接続を登録または修復します。 |
| `agent-vault status` | スキル・MCP・プロジェクト・タスク hooks の接続状態を確認します。 |
| `agent-vault recall 先週のデプロイの決定` | 日付やキーワードで記録を探し、根拠とともに回答します。 |
| `agent-vault remember 今回の決定とその理由` | 作業状態または長期知識として区別して記録します。 |
| `agent-vault review 以前の記録と結果が違う` | 既存の根拠と新しい証拠を比較して再検討します。 |
| `agent-vault persona 自分の応答の好みを見せて` | 適用中の好みと、レビュー待ちの観察を表示します。 |
| `agent-vault config 週次 Markdown は 3 か月保持、業務開始は 09:00` | 指定された保持期間と業務時間の設定を適用します。 |

### MCP は内部の仕組みです

**スキルはエージェントへのコマンドの案内であり、保存・検索・レビューはローカル MCP サーバーが担当します。** エージェントがインストール済みバンドルの CLI で初期設定を行い、ハーネスは同じバンドルの MCP サーバーを Node で起動します。ユーザーが毎回実行したり、パッケージを再ダウンロードしたりする仕組みではありません。

初回の接続に権限の承認やエージェントの再起動が必要な環境では、その旨を一度だけ案内します。MCP や hooks を自動登録できない環境では、必要な手順と制限を説明し、接続されていない状態を完了として扱うことはありません。

### オプション: SQL ストレージ

SQLite に追加の npm パッケージや設定は不要です。SQL を使用する場合は、保管庫ごとに専用の空のデータベースを用意してください。PostgreSQL 14 以降（UTF-8）、MySQL 8.0.17 以降、MariaDB 10.6 以降に対応します。データベースユーザーには、読み書きとテーブル・インデックス・トリガー・ルーチンの作成権限が必要です。インストール済みの `bin/` と `lib/` があるディレクトリに、選んだドライバーだけをインストールしてください。

```sh
npm install --prefix /absolute/path/to/agent-vault --no-save --no-package-lock pg@8
# MySQL または MariaDB を使う場合:
npm install --prefix /absolute/path/to/agent-vault --no-save --no-package-lock mysql2@3
```

`AGENT_VAULT_DB_DRIVER` に `postgres`、`mysql`、`mariadb` のいずれかを指定します。接続 URL は `AGENT_VAULT_DB_URL` または `AGENT_VAULT_DB_URL_FILE` で渡してください。ドライバーと、環境変数名または認証情報ファイルのパスだけを設定に保存することもできます。

```sh
vault-cli config --db-driver postgres --db-url-file /absolute/private/path/vault-dsn
```

認証情報ファイルには接続 URL を一つだけ記載し、所有者以外のアクセスを禁止してください。URL 自体をコマンド引数や保管庫の設定に入れないでください。CLI、MCP サーバー、すべての hooks で同じ設定を使います。ローカル以外のネットワークではサーバーを検証する TLS を使ってください。PostgreSQL は `sslmode=verify-full`、MySQL/MariaDB は `ssl=true` を指定します。詳しくは[ストレージの仕様](spec.md#1b-storage-configuration-and-cutover)を参照してください。

既存の SQLite データベースを移行するには、書き込みを行うプロセスを停止し、SQLite ファイルがあるホストで次を実行します。

```sh
vault-cli memory migrate-db --path /absolute/path/to/vault --dry-run
vault-cli memory migrate-db --path /absolute/path/to/vault
vault-cli memory diagnose --path /absolute/path/to/vault
```

最初のコマンドは移行先に接続せず、テーブルごとの件数を表示します。コピー先には空の SQL データベースが必要です。元の SQLite と Markdown ファイルは変更されません。元のファイルをバックアップとして残し、SQL 設定でクライアントを再起動してください。

チーム SQL は別途有効にし、専用データベースを使います。`vault-cli config --team-db-driver postgres|mysql|mariadb --team-id <id>` で設定します。既存のチームファイルは `memory migrate-db --team --from-sqlite <path>` でコピーできます。

### メモリはタスク境界で更新します

業務週は月曜日から日曜日までで、進行中のタスクは週が変わっても元の週を維持します。Markdown は設定した **1〜6 か月** だけ保持し、データベースの記録は引き続き検索できます。

persona とレビュー済みのメモリ変更は、正常なタスク終了後のアイドル時に反映します。hooks がない環境では、作業の終了後に `agent-vault maintain` を依頼できます。既存の日次ファイルは `agent-vault migrate` で取り込み、元ファイルの削除には別途、明示的な依頼が必要です。

### hooks が動作するタイミングとツールごとの役割

OMP、Claude Code、Codex では、hooks がプロンプト送信時にタスクを開始し、ユーザーの指示とファイルを編集したターンを記録し、エージェントの終了時にタスクを閉じます。エージェントに `agent-vault install` を依頼すると設定され、Claude Code と Codex では `vault-cli hooks install --host claude|codex` が実行されます。Codex ではその後 `/hooks` で hooks を一度確認して信頼する必要があります。メンテナンスと persona の更新は、タスクが正常に完了し、他のタスクが進行中でないときにのみ実行されます。Cursor などそれ以外の環境には hooks はインストールされず、代わりに `agent-vault maintain` を依頼します。正確なイベントとタイミング、すべての MCP ツール、実際に検証した範囲、失敗時の動作は **[spec.md](spec.md)** を参照してください。

詳細なツール仕様は [SKILL.md](SKILL.md) を参照してください。公式の [Skills のカスタマイズ](https://www.skills.sh/docs/customize) はリポジトリの紹介ページに適用されるものであり、実行中のエージェントのコマンドや hooks を代わりに登録するものではありません。
