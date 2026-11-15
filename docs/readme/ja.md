# DishyWarden

**Starlink 端末向けのオープンソース監視ツール** ——
ターミナルのローカル gRPC API に接続し、生の数値をそのまま使える情報に変えて、
何かあれば即座に知らせます。

> データは基本的にあなたの端末に留まります。任意のクラウド通信が運ぶのは
> 匿名のバージョン番号と、**あなたが明示的に許可した**誤検知レポートだけです
> （[プライバシー](#-プライバシー) を参照）。

---

## 📸 スクリーンショット

| ダッシュボード | 遮蔽マップ |
|---|---|
| ![ダッシュボード](docs/screenshots/dashboard.png) | ![遮蔽マップ](docs/screenshots/obstruction.png) |

> 実機セッションからのキャプチャです。モックではありません。

---

## ✨ できること

**リアルタイム監視**

- 電波強度・レイテンシ・パケット損失・スループット・オンライン率 ——
  30 秒ごとにサンプリングし、ローカルの SQLite に保存
- 衛星レーダー: 実際の TLE と SGP4 伝播、極座標プロット、
  通信衛星のビーム指向推定
- 天空遮蔽マップ: WebGL 半球投影で遮蔽空を示し、遮蔽率・遮蔽レベル・
  主な遮蔽方向とその推移を表示
- 整合ビュー: 方位角と仰角による手動調整

**意味のあるアラート**

- **27 個の組み込みルール** —— アンテナオフライン、PoP レイテンシ、
  極端なパケット損失、視野遮蔽、ヒートスロットリング、照準ずれ、
  モータ障害、GNSS 異常、着氷、PoE/電源、ルーターオフライン、
  切断再接続の繰り返し、WiFi 品質、異常気象、アカウント異常、衛星漫游など
- 3 つの配信チャネル: **Telegram**、**Eメール**、**Webhook**
  （テンプレート変数と再利用可能なペイロードテンプレートに対応）
- オフラインキュー: 回線断中のアラートは復旧後にまとめて配信
- プローブ抑止: プローブ障害を原因とするアラートが二重に発火しない

**ネットワークの可視化**

- トレースルートとホップごとの経路マップ
  （Windows の `tracert` 出力は列単位で解析）
- プローブノードは 3 種類 —— **ICMP**、**DNS**、**TLS** ——
  障害がターミナル、ルーター、回線のどこにあるかを切り分け
- Prometheus メトリクスと、Grafana ダッシュボード一式

**位置情報**

- ターミナルの位置は 3 段階でフォールバック: ターミナル GPS →
  ブラウザの位置情報 → IP による概算

**保守しやすい設計**

- UI は 5 言語対応: English、简体中文、日本語、한국어、Tiếng Việt
- 設定は素の JSON、テレメトリとアラートはローカル SQLite

---

## 🚀 クイックスタート

**Node.js 20+** と、接続できるターミナルが必要です。

```bash
git clone %REPO_URL%.git
cd %REPO%
npm install
npm run dev
```

`npm run dev` は Vite 開発サーバと Electron を同時に起動します。ウィンドウは
`http://localhost:5173` のレンダラを読み込みます。**機能確認は Electron ウィンドウで
行ってください** —— ブラウザ版にはモックデータしかありません。

### ターミナルへの接続

DishyWarden はターミナルの**ローカル gRPC API** を使います:

| ポート | トランスポート | 役割 |
|---|---|---|
| `9200` | ネイティブ gRPC | 主系 |
| `9201` | grpc-web | フォールバック — 一部のファームウェアは 9200 に `UNIMPLEMENTED` を返す |

ターミナルは LAN にこの API を公開しないため、通常は同じマシンでターミナルへ
転送する**ローカルブリッジ**（`dishylink` のようなツール）を動かし、
**設定 → ターミナル接続** でアドレスとポートを指定します。フィールド単位の比較は
[`docs/DISH-API-GAPS.md`](docs/DISH-API-GAPS.md)、
応答しない場合は [`docs/DISH-CONNECTIVITY-ISSUES.md`](docs/DISH-CONNECTIVITY-ISSUES.md)
を参照してください。

---

## 🏗️ ソースからのビルド

```bash
npm ci
npm run build          # レンダラ + メインプロセス + electron-builder
npm run build:win      # Windows NSIS インストーラのみ
```

| 成果物 | 備考 |
|---|---|
| `release/` | パッケージ出力（electron-builder の target ディレクトリ） |
| `release/DishyWarden-Setup-<version>.exe` | Windows インストーラ、per-machine（管理者権限が必要）、ガイド付きインストール |

コミット前にこれらのチェックを通してください:

```bash
npx tsc --noEmit -p tsconfig.json
npx tsc --noEmit -p tsconfig.electron.json
npm test               # vitest
npm run lint
```

---

## 📥 リリースのインストール

[リリースページ](%REPO_URL%/releases)から最新の成果物をダウンロードしてください。

| プラットフォーム | ファイル |
|---|---|
| Windows x64 / arm64 | `DishyWarden-Setup-<version>.exe`（NSIS, per-machine） |
| macOS arm64 / x64 | `DishyWarden-<version>-<os>-<arch>.dmg` |

> **ビルドはコード署名をしていません。** Windows では SmartScreen の警告
> （「Windows が PC を保護しました」）が出るので、*詳細情報 → 実行する* を
> クリックしてください。macOS では隔離されるため、`.dmg` を右クリックして
> *開く* を選ぶか、`xattr -dr com.apple.quarantine /Applications/DishyWarden.app`
> を実行してください。各成果物には `sha512` を併記しているので照合してください。

更新は [electron-updater](https://github.com/electron-userland/electron-builder)
がマニフェスト `%FEED_URL%` から配信します。起動時に一度、その後は約 12 時間ごとに
確認し、ネットワークが使えない場合は静かに縮退します。

---

## 📋 必要環境

| | |
|---|---|
| OS | Windows 10+、macOS 11+、Linux (X11) |
| Node.js | 20+（開発時のみ） |
| ランタイム | Electron 33 · React 18 · TypeScript · Vite · Tailwind CSS 4 |
| ストレージ | テレメトリ約 1 MB/日（30 秒サンプリング） |

---

## 🔐 プライバシー

**明示的に許可しない限り、テレメトリはあなたの端末から出ません。**

| データ | 送信先 | タイミング |
|---|---|---|
| テレメトリ・アラート・設定 | ローカル SQLite / ローカル JSON | 常時、あなたの端末の中だけ |
| 更新確認（`upgrade_check` / `upgrade_heartbeat`） | `cloud.dishywarden.com` | 自動 —— 匿名の `client_id`、バージョン、プラットフォーム、IP のみ |
| 誤検知レポート | `cloud.dishywarden.com` | **許可した場合のみ** —— アラート種別・重要度・タイトル・メモ、（保持していれば）座標 |

- `client_id` は端末上で生成されたランダム UUID で、ハードウェア・アカウント・
  ネットワーク識別子からは導出されません。
- 誤検知の送信は**初期状態では無効**で、*設定 → アップデートとフィードバック* から
  いつでも無効化できます。初回送信時は何を送るかを表示して明示的に確認します。
- クラウドサーバがアカウント、通知資格情報（Telegram トークン、webhook URL、
  メールのパスワード）、ファイルパス、ホスト名を受信することは **ありません**。
- サーバ側の保持期間: 更新イベントとフィードバックは 90 日、アクセスログは 14 日。

詳細は **[PRIVACY.md](PRIVACY.md)** をご覧ください。

---

## 🧩 アーキテクチャ

```
src/
├── main/        Electron メインプロセス —— ウィンドウ、IPC、gRPC クライアント、更新
├── core/        ターミナル gRPC クライアント、プローブ、トレースルート、更新、クラウド
├── storage/     SQLite 永続化（テレメトリ + アラート）と設定
├── alerting/    ルールエンジン、通知ディスパッチ、オフラインキュー
├── collector/   30 秒サンプリングループ
├── prometheus/  メトリクス出力 + Grafana ダッシュボード
└── renderer/    React UI（ダッシュボード、アラート、遮蔽、衛星、整合、設定）
```

貢献者が知っておくべき層の境界:

- `src/storage/types.ts` はネイティブモジュールを import してはいけません ——
  レンダラがそれを import します
- `src/main/**`、`src/core/**`、`src/storage/**` の変更には Electron の再起動が
  必要、レンダラの変更はホットリロードされます
- 新しい UI 文字列には 5 言語すべてが必要で、i18n のキー集合テストが検査します

---

## 📚 その他のドキュメント

| ドキュメント | 内容 |
|---|---|
| [`docs/DISH-API-GAPS.md`](docs/DISH-API-GAPS.md) | `dishylink` とのフィールド単位の比較（ポート名、応答形状、既知の障害） |
| [`docs/DISH-CONNECTIVITY-ISSUES.md`](docs/DISH-CONNECTIVITY-ISSUES.md) | ターミナルが応答しなくなった理由と切り分け方 |
| [`docs/VERIFY-DISH.md`](docs/VERIFY-DISH.md) | 実機の Windows での遠隔検証手順 |
| [`docs/WINDOWS-BUILD.md`](docs/WINDOWS-BUILD.md) | Windows でのパッケージング |
| [`docs/CLOUD-UPGRADE.md`](docs/CLOUD-UPGRADE.md) | 更新マニフェストの契約とリリース方法 |

## 🛠️ 貢献する

Issue と Pull Request を歓迎します —— 開発環境・コミット規約・リリース手順は
[CONTRIBUTING.md](CONTRIBUTING.md) を参照してください。

## 📄 ライセンス

[MIT](LICENSE) © %YEAR% DishyWarden contributors
