# CI と検査の共通ルール

yoshinani-dev の全リポジトリに適用する。各リポジトリの AGENTS.md / CLAUDE.md には、このルールの要点とそのリポジトリでのコマンドを書く。食い違ったときはこのファイルを正とする。

## 原則

**GitHub Actions では検査を実行しない。テスト・リント・型・ビルドなどの検査は、すべてローカルで行う。**

2026年10月、検査用の Actions の使用時間が無料枠（月2,000分）の8倍を超え、超過分が課金された。PR と main で同じ検査を二重に回したり、ブラウザ E2E や網羅テストを PR のたびに回したりしていたことが原因だった。

## 各リポジトリに用意するもの

| コマンド           | 内容                                                                                              | いつ実行するか                                                                   |
| ------------------ | ------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| `pnpm verify`      | フォーマット・リント・型・単体テストなど。手元の `.env` や外部サービスなしで動くものだけにする    | `git push` のたびに自動で実行される（pre-push フック）。失敗すると push できない |
| `pnpm verify:full` | `verify` に加えて、ビルド・DB を使う検査・E2E・重い回帰テストなど、そのリポジトリで必要なもの全部 | PR をマージする前。リリース・配布の前                                            |

- pre-push フックは `.githooks/pre-push`（husky を使うリポジトリは `.husky/pre-push`）に置き、`pnpm install` 時に自動で有効になる
- クローン済みの環境でフックが有効になっていなければ、`pnpm install` を一度実行する
- `verify` は `.env` や本番の値がなくても動くようにする。単体テストが DB を必要とするリポジトリでは、Docker の使い捨て Postgres をスクリプトで起動して使う（ローカル開発用の DB は使わない）
- 必要なツール（Docker、Playwright のブラウザ、Shopify CLI など）は各リポジトリの AGENTS.md に書く

## ルール

1. **Actions に検査用のワークフローを追加しない。** Actions に置いてよいのは次のものだけ
   - PR の自動アサイン・ラベル付けなど、数秒で終わる処理（`ubuntu-slim` を使う）
   - デプロイ・リリース・パッケージ公開
   - 手動実行（`workflow_dispatch`）だけのもの
2. **push の前に `pnpm verify` を通す。** フックが自動で実行する。フックを飛ばす `git push --no-verify` は緊急時だけにして、使ったら PR にその理由を書く
3. **マージの前に `pnpm verify:full` を通す。** 結果を PR の「テスト項目」に書く。レビューする人は、その記載を確認してから承認する
4. **Dependabot の PR も同じ。** Actions では検査しないので、ブランチをチェックアウトして `pnpm verify:full` を通してからマージする。自動マージは使わない
5. **Chromatic などの外部サービスでの確認は、必要なときにローカルから実行する。**（例: UI を変えたとき `pnpm --filter @repo/ui chromatic`、トークンは `CHROMATIC_PROJECT_TOKEN` で渡す）
6. **Dependabot の更新頻度は月1回にする。** セキュリティ更新は頻度の設定に関係なく随時届く
7. **AI エージェント（Claude Code・Codex など）にも同じルールを適用する。** エージェントが PR を作るときも `pnpm verify:full` を実行し、結果を PR に書く

## 新しいリポジトリを作るとき

- `verify` と `verify:full` を package.json に用意する
- `.githooks/pre-push` を置き、`"prepare": "git config core.hooksPath .githooks || true"` を package.json に入れる（既存リポジトリの `.githooks/pre-push` をそのままコピーしてよい）
- AGENTS.md に「CI と検査」の節を入れる（既存リポジトリの節をコピーしてコマンドだけ書き換える）
- `.github/dependabot.yml` の `interval` は `monthly` にする

## 請求の確認

- 請求と使用量: https://github.com/organizations/yoshinani-dev/settings/billing
- Actions には予算の上限とアラートを設定しておく（Budgets and alerts）
