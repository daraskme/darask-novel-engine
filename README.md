# Darask Novel Engine

`scenario.txt` を置くだけで動く、超シンプルなノベルゲームエンジンです。
ビルド不要・依存ライブラリなしの HTML/CSS/JS で完結し、
ブラウザでも、Electron でビルドした **Windows 用 exe** でも動きます。

## 遊び方 / 起動方法

### ブラウザで動かす

フォルダでローカルサーバーを立てて `index.html` を開きます。

```
python -m http.server 8000
# → http://localhost:8000 を開く
```

`index.html` をダブルクリックで直接開いた場合はブラウザの制限で自動読み込みが
できないため、ファイル選択(ドラッグ&ドロップ可・複数選択可)画面が出ます。

### exe で動かす (ウィンドウアプリ)

Node.js が入っていれば:

```
npm install
npm run start   # そのままウィンドウで起動
npm run dist    # dist/ にポータブル exe を生成
```

生成された exe は**ダブルクリックするだけ**でウィンドウが開きます。
さらに、**exe と同じフォルダに `scenario.txt`(や `bg/` `bgm/` などのフォルダ)を
置くと、同梱シナリオより優先して読み込まれます**。exe を配布して
テキストを差し替えるだけでゲームを変えられます。

## シナリオの書き方 (scenario.txt)

```
キャラA:こんにちは
キャラB:やあ、元気?
セリフの形式でない行は、そのまま地の文として表示されます。

@bg school.jpg      ← 背景を変える
@bgm main.mp3       ← BGM を流す
@se chime.mp3       ← 効果音を鳴らす
@cg event01.jpg     ← 一枚絵(CG)を表示。ギャラリーに自動登録される
```

### 基本ルール

| 記法 | 意味 |
|---|---|
| `名前:セリフ` | セリフ(コロンは半角 `:` / 全角 `:` どちらでも可。名前は12文字以内・空白なし) |
| それ以外の行 | 地の文 |
| 空行 | 無視 |
| `#` `;` `//` で始まる行 | コメント(無視) |

### 選択肢と分岐

`選択肢` とだけ書いた行の直後の行が、そのまま選択肢になります
(空行または `@` コマンドでブロック終了)。

```
選択肢
手伝ってもらう -> 好感度+1
自分でやると断る -> 意地=true
アオイを推薦する -> 好感度+1, route_b.txt
くじ引きで決めよう
```

`->` の後ろに効果をカンマ区切りで書けます(なくてもOK):

| 効果 | 意味 |
|---|---|
| `フラグ名+1` / `フラグ名-1` | 数値フラグを増減 |
| `フラグ名=true` / `フラグ名=false` | 真偽値フラグを設定 |
| `フラグ名=3` | 数値を直接設定 |
| `ファイル名.txt` | 指定のテキストファイルに続きを移す |

数字キー 1〜9 でも選択できます。

### @コマンド一覧

| コマンド | 説明 |
|---|---|
| `@title タイトル` | ゲームタイトルを設定 |
| `@bg ファイル名` | 背景画像を変更(`bg/` フォルダ) |
| `@cg ファイル名` | CG(一枚絵)を表示 + ギャラリー登録(`cg/` フォルダ) |
| `@cg off` | CG を消す |
| `@bgm ファイル名` | BGM をループ再生(`bgm/` フォルダ) |
| `@bgm stop` | BGM を停止 |
| `@se ファイル名` | 効果音を再生(`se/` フォルダ) |
| `@scene シーン名` | シーンの区切り。到達すると「シーン鑑賞」から再生可能に |
| `@wait ミリ秒` | 指定時間待つ(例: `@wait 1000`) |
| `@set フラグ名+1` | 選択肢と同じ書式でフラグを直接操作 |
| `@jump ファイル.txt` | 別のシナリオファイルへ移動 |
| `@if 条件 ファイル.txt` | 条件を満たしたら別ファイルへ移動 |

`@if` の条件には `>=` `<=` `>` `<` `==` `!=` が使えます:

```
@if 好感度>=2 ending_good.txt
@if 意地==true route_stubborn.txt
@jump ending_normal.txt
```

画像・音声ファイルが存在しない場合もエラーにならず、画像はファイル名入りの
プレースホルダが自動生成され、音声はスキップされます。
**アセットが1つもなくてもサンプルがそのまま動きます。**

## フォルダ構成

```
index.html / style.css / engine.js   ← エンジン本体
scenario.txt                          ← エントリーポイント(ここから始まる)
route_a.txt, ending_good.txt, ...     ← 分岐先のシナリオ(自由に追加)
bg/  cg/  bgm/  se/                   ← 画像・音声アセット
electron/                             ← exe 化用ランチャー
.github/workflows/                    ← CI/CD (Cloudflare Pages + exe ビルド)
```

## デフォルトショートカットキー

| キー | 機能 |
|---|---|
| Enter / Space / クリック | 読み進める |
| Ctrl(押しっぱなし) | スキップ |
| A | オートモード切替 |
| H / 右クリック | メッセージウィンドウ非表示 |
| B / ホイール上 | バックログ |
| F | フルスクリーン |
| S | クイックセーブ |
| L | クイックロード |
| Esc | メニュー / 戻る |
| 1〜9 | 選択肢を選ぶ |

キーは**設定画面から自由に変更**できます(ブラウザ/アプリ内に保存)。

## 機能

- **CGギャラリー** — `@cg` の一枚絵を自動登録。未見は「?」表示
- **シーン鑑賞モード** — `@scene` 到達で解放。その時点のフラグ・背景・BGMごと復元して再生
- **選択肢・フラグ・複数ファイル分岐** — 数値/真偽値フラグ、`@if`/`@jump`
- **セーブ/ロード** — クイックセーブ(タイトルの「つづきから」に対応)
- **バックログ / オート / スキップ / 文字速度・音量設定**

進行状況はすべて localStorage に保存されます。

## CI/CD (Cloudflare Pages + exe 自動ビルド)

GitHub に push すると自動で動く2つのワークフローを同梱しています。

### Web 版の自動デプロイ ([deploy-pages.yml](.github/workflows/deploy-pages.yml))

`main` に push するたびに Cloudflare Pages へデプロイします。事前準備:

1. Cloudflare ダッシュボード → **Workers & Pages** → Pages プロジェクト
   `darask-novel-engine` を作成(Direct Upload)
2. GitHub リポジトリの **Settings → Secrets and variables → Actions** に登録:
   - `CLOUDFLARE_API_TOKEN`(Cloudflare Pages 編集権限のトークン)
   - `CLOUDFLARE_ACCOUNT_ID`

※ GitHub Actions を使わず、Cloudflare Pages の「Git 連携」でこのリポジトリを
直接接続してもOKです(ビルドコマンドなし・出力ディレクトリ `/` を指定)。

### Windows exe の自動ビルド ([build-windows.yml](.github/workflows/build-windows.yml))

`v1.0.0` のようなタグを push すると、ポータブル exe をビルドして
GitHub Release に自動添付します(手動実行も可)。

```
git tag v1.0.0
git push origin v1.0.0
```

### ローカルで exe をビルドするときの注意

Windows で `npm run dist` が「Cannot create symbolic link」で失敗する場合は、
**設定 → 開発者向け → 開発者モード** を有効にするか、管理者権限で実行してください
(electron-builder が署名ツールを展開する際にシンボリックリンクを作るため)。
