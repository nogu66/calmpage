# Sumi

LaTeX の編集と PDF プレビューを 1 つの画面で行う Mac アプリ（Electron）。
組版は手元の TeX Live（latexmk）をそのまま使う。

## 使い方

```bash
npm install
npm run dev      # 開発（ホットリロード）
npm run build    # out/ に組み立て
npm start        # 組み立てたものを起動
npm run dist     # release/mac-arm64/Sumi.app を作る
```

| 操作 | キー |
| --- | --- |
| フォルダ（または .tex）を開く | ⌘O |
| 保存して組版 | ⌘S（「Auto compile」が有効なら、入力が 1.2 秒止まると自動） |
| 組版だけ | ⌘R |
| カーソル位置を PDF で表示 | ⌘J |
| PDF からソースへ | PDF を ⌘ クリック |
| ファイル一覧 / 問題の一覧 | ⌘B / ⇧⌘M |
| AI の柱（Claude Code / Codex）を開く・閉じる | ⇧⌘L、またはタイトルバー右端のボタン |
| PDF の拡大・縮小・幅に合わせる | ⌘= / ⌘- / ⌘0 |
| 設定（言語・Auto compile・明るさ・配色） | ⌘, または左下の歯車 |
| 明るさ（System / Light / Dark）・配色（Paper〈標準〉/ Moss / Sand） | 設定、または View メニュー |
| PDF をプレビュー.app で開く | ⇧⌘O |

表示は英語が標準。設定の Language で日本語に切り替えられる（文言は `src/shared/i18n.ts`）。

## AI の柱（⇧⌘L、またはタイトルバー右端のボタン）

Zed と同じく、好きなエージェントを呼び出せる。柱の上の名前（例: Claude Code ▾）から切り替える。
AI を使わない人のために、設定の「AI パネル」を切ると、ボタン・メニュー・設定の欄ごと消える。入れたままでも、エージェントはパネルを開くまで起動しない。

- **ACP のエージェント**（Agent Client Protocol）は Sumi の会話画面で動く。最初から入っているのは Claude Code と Codex だけ（npx で ACP の登録簿と同じ版を起動し、手元の CLI のログインをそのまま使う）。ほかは必要なときに設定の登録簿から足す。
  - 上のチップ（ファイルと選択行・エラー・PDF のページ）は、送るたびに添える。押すと外せる（点線になる）。
  - 書き換えの前に、差分と「許可 / やめる」を出す。書き換わったファイルはエディターが読み直して組み直す。
  - 自分の発言は右の吹き出し、エージェントの返事と作業は左に流れる。
  - Enter で送る（日本語の変換中は送らない）、Shift+Enter で改行、Esc で中断。右上の鉛筆で新しいスレッド。
- **端末のエージェント**（ACP に対応していない CLI）は、本物の端末ごと動かす。チップを押すと参照を入力欄に貼り込む。
- エージェントの追加・編集・削除は設定の「エージェント」で行う。ACP の登録簿（cdn.agentclientprotocol.com/registry）から探して追加でき、専用のアプリが要るものはこの Mac に入っているときだけ追加できる。
- Finder から起動しても動くよう、PATH や API キーはログインシェル（`$SHELL -ilc`）から一度だけ読み取る。
- 作業フォルダは開いているフォルダ。フォルダを替えると、動いているエージェントは止めて開き直す。

## 組版の決まり

- 本体の決め方: `% !TEX root = …` → `\documentclass` があればそのファイル → 前回組んだ本体が読み込んでいるファイル（.fls の記録）→ `\input` で読み込んでいる本体を探す。
- `.latexmkrc` があるフォルダは、その設定（処理系・出力先・TEXINPUTS）に従う。
- 無いフォルダは処理系を自動で選び（ltjs* / luatexja → LuaLaTeX、jsarticle 系 → upLaTeX、fontspec → XeLaTeX、日本語を含む → LuaLaTeX、それ以外 → pdfLaTeX）、中間ファイルは `~/Library/Application Support/sumi/build/` に出す。
- 本体が別の書類に変わったら、前の書類の PDF はすぐ消し、新しい PDF ができるまで「Compiling …」とだけ出す。同じ本体の分割ファイルに移るときは PDF を残す。
- 行番号の無い警告（フォントの拡大率の報告など）は「情報」に下げ、状態表示に数えない。

## 作り

- `src/main/build.ts` — latexmk の実行、ログの解析、SyncTeX
- `src/main/files.ts` — ファイル一覧と外部変更の監視（ほかのエディターや AI が書き換えたら読み直して組み直す）
- `src/renderer/editor.ts` — CodeMirror 6
- `src/main/acp.ts` — ACP のエージェントを子プロセスで起動し、会話・許可の確認・ファイルの読み書きを中継する
- `src/main/terminals.ts` — 端末のエージェントを node-pty で起動する
- `src/main/registry.ts` — ACP の登録簿を読み、追加できるエージェントの一覧にする
- `src/shared/agents.ts` — エージェントの設定の形と、最初から入っている 3 つ
- `src/renderer/thread.ts` — ACP の会話画面（返事・道具の実行・差分・許可・計画）
- `src/renderer/terminal.ts` — 端末のエージェントの画面（xterm.js）。配色に合わせて色を替える
- `scripts/fake-acp-agent.mjs` — 自動テスト用の ACP エージェント
- `scripts/icon.mjs` — `build/icon.svg`（アイコンの元）から `build/icon.icns`・`build/icon.png` と、SNS 用の画像（`build/brand/`）を書き出す（`node scripts/icon.mjs`）
- `src/renderer/preview.ts` — pdf.js。見えているページを描き終えてから差し替えるので、組み直してもちらつかない
- `scripts/smoke.mjs` — playwright-core で起動して主な流れを確かめる（`node scripts/smoke.mjs <フォルダのコピー> <画像の出力先>`）

## 次の段階

- モデルや動き方（mode）の切り替えを柱の上に出す（ACP の config option）
- ⌘K: 選択範囲の下に小窓を出し、差分を見て反映 / やめるを選ぶ短い直し
