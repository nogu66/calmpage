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
| 保存して組版 | ⌘S（「自動組版」が有効なら、入力が 1.2 秒止まると自動） |
| 組版だけ | ⌘R |
| カーソル位置を PDF で表示 | ⌘J |
| PDF からソースへ | PDF を ⌘ クリック |
| ファイル一覧 / 問題の一覧 | ⌘B / ⇧⌘M |
| PDF の拡大・縮小・幅に合わせる | ⌘= / ⌘- / ⌘0 |
| テーマ（システム / ライト / ダーク） | 表示 → テーマ |
| PDF をプレビュー.app で開く | ⇧⌘O |

## 組版の決まり

- 本体の決め方: `% !TEX root = …` → `\documentclass` があればそのファイル → 前回組んだ本体が読み込んでいるファイル（.fls の記録）→ `\input` で読み込んでいる本体を探す。
- `.latexmkrc` があるフォルダは、その設定（処理系・出力先・TEXINPUTS）に従う。
- 無いフォルダは処理系を自動で選び（ltjs* / luatexja → LuaLaTeX、jsarticle 系 → upLaTeX、fontspec → XeLaTeX、日本語を含む → LuaLaTeX、それ以外 → pdfLaTeX）、中間ファイルは `~/Library/Application Support/sumi/build/` に出す。
- 行番号の無い警告（フォントの拡大率の報告など）は「情報」に下げ、状態表示に数えない。

## 作り

- `src/main/build.ts` — latexmk の実行、ログの解析、SyncTeX
- `src/main/files.ts` — ファイル一覧と外部変更の監視（ほかのエディターや AI が書き換えたら読み直して組み直す）
- `src/renderer/editor.ts` — CodeMirror 6
- `src/renderer/preview.ts` — pdf.js。見えているページを描き終えてから差し替えるので、組み直してもちらつかない
- `scripts/smoke.mjs` — playwright-core で起動して主な流れを確かめる（`node scripts/smoke.mjs <フォルダのコピー> <画像の出力先>`）

## 次の段階

Claude Code / Codex の組み込み（端末の埋め込み、今のファイル・選択範囲・エラー・PDF のページを AI に渡す MCP サーバー）。
