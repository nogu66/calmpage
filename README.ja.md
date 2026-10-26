<p align="center">
  <img src="build/icon.png" width="112" alt="Calmpage のアイコン" />
</p>

<h1 align="center">Calmpage</h1>

<p align="center">
  静かな LaTeX エディター（macOS）。左で書いて、右で PDF を見る。1 つの画面で。
</p>

<p align="center">
  <a href="https://github.com/nogu66/calmpage/actions/workflows/ci.yml"><img src="https://github.com/nogu66/calmpage/actions/workflows/ci.yml/badge.svg" alt="CI" /></a>
  <img src="https://img.shields.io/badge/platform-macOS-lightgrey" alt="macOS" />
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-lightgrey" alt="MIT License" /></a>
</p>

<p align="center">
  <a href="README.md">English</a> · 日本語
</p>

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/images/calmpage-dark.png" />
    <img src="docs/images/calmpage-light.png" width="920" alt="左に LaTeX のソース、右にコンパイルした PDF を並べた Calmpage の画面" />
  </picture>
</p>

> [!NOTE]
> Calmpage はまだ開発の初期段階です。macOS で動き、Apple シリコンで確認しています。

## なぜ Calmpage か

Calmpage は、書くことの邪魔をしない LaTeX エディターです。名前のとおり、落ち着いて書ける一枚の紙を目指しています。

- **手元の TeX のまま。** 今ある `latexmk` でコンパイルし、`.latexmkrc` にも従うので、今のプロジェクトがそのまま動きます。Calmpage 自体は何もアップロードしません。
- **1 つの窓で、設定なしに。** フォルダを開けば書き始められます。打つたびに PDF が追いかけ、SyncTeX で行き来できます。
- **AI は使いたい人だけ。** Claude Code や Codex など好きなエージェントに、開いている書類を文脈として渡して頼めます。使わないなら AI パネルを切れば、ないものとして扱えます。

## できること

<p align="center">
  <img src="docs/images/calmpage-typing.gif" width="800" alt="左で題名を書き足すと、少しして右の PDF の題名も変わる" />
</p>

- エディターと PDF を横に並べて表示。コンパイルし直してもちらつかず、スクロール位置も保つ
- *自動コンパイル*: 入力が 1.2 秒止まったら保存してコンパイル
- エラーはエディターと「問題」の一覧に出る。BibTeX と Biber のメッセージも、`.bib` の行に結び付けて出す
- 「問題」の欄で「ログ」に切り替えると、`.log` と `latexmk` の出力をそのまま読める。末尾から表示し、検索もできる
- 長いコンパイルは ⌘. で止められる。中間ファイルは「ファイル」メニューから消せる
- 補完: 命令、環境（`\end` まで入る）、プロジェクト全体の `\ref` のラベルと `\cite` の文献、ファイルや画像のパス、`\newcommand` で定義した命令
- サイドバーに書類全体のアウトライン（`\input` と `\include` をたどる）
- 数式の控えめな色分け、環境と節の折りたたみ、環境の中の字下げ
- 本文の英単語のスペルチェック（macOS のスペルチェッカー。命令・数式・ラベル・コメントは除く）
- 単語数と文字数（ファイル・選択範囲・書類全体）
- SyncTeX の行き来: ⌘J でカーソル位置を PDF で示し、PDF を ⌘ クリックするとソースへ
- PDF ビューアーとしての基本: リンク（目次・`\ref`・`\cite`・URL）をたどる、文字を選んでコピー、PDF 内の検索、ページ番号、幅に合わせる・ページ全体・見開きの切り替え
- ダークモードで PDF を反転して暗く読める（設定で入れる。既定は切）
- `% !TEX root`・`% !TEX program`・`.latexmkrc`・処理系の自動選択に対応した、複数ファイルの書類
- `.bib`・`.sty`・`.cls` を保存すると、それを使っている書類をコンパイルし直す
- ほかのエディターやエージェントがファイルを変えると、読み直してコンパイルし直す
- 書いたものを失わない: 終了する・窓を閉じる・フォルダを替える前に、未保存の変更を書き込む。保存できなかったときや *自動コンパイル* を切っているときは、いつもの「保存 / 保存しない / キャンセル」を出す
- ファイル一覧の右クリックかファイルのメニューで、新規ファイル・新規フォルダ・名前の変更・ゴミ箱に入れる・Finder で表示
- 画像やほかの関連ファイル（`.csv`・`.md`・`.bbx`・`.dtx` など）も一覧に出る。テキストはエディターで開き、画像と PDF は Quick Look で見る
- エディターに画像を落とすと、プロジェクトに写して（`figures/` か、今ある画像のフォルダへ）`figure` 環境を入れる。ファイル一覧に落とすと、そのフォルダに写す
- 雛形から新しい書類を作れる: 英語の論文、日本語の論文（LuaLaTeX か upLaTeX）、beamer のスライド、レポート、手紙
- 最近開いたフォルダは、ファイル → 最近使ったもの から
- 複数のウインドウを同時に開ける。ウインドウごとに別のフォルダを開き、コンパイル・変更の見張り・エージェントもそれぞれで動く。終了したときに開いていたウインドウは、ファイル・タブ・位置ごと次の起動で戻る
- フォルダ内の検索と置換。大文字小文字の区別・単語単位・正規表現を選べる
- 開いたファイルはタブで並び、次にフォルダを開いたときに戻る
- ローカルの履歴: 保存のたびに版が残り、今の内容と比べて戻せる（Git は要らない）
- 明るさはライト・ダーク・システム、配色は紙・苔・砂の 3 つ
- 画面は英語と日本語

## 入れ方

Apple シリコンの Mac（macOS 12 以降）で動きます。

[Homebrew](https://brew.sh) で入れる場合:

```bash
brew install --cask nogu66/tap/calmpage
```

インストール用のスクリプトでも入れられます（`/Applications` に `Calmpage.app` を置きます）:

```bash
curl -fsSL https://raw.githubusercontent.com/nogu66/calmpage/main/install.sh | bash
```

更新も同じです。`brew upgrade --cask calmpage` か、スクリプトをもう一度実行してください。

[最新のリリース](https://github.com/nogu66/calmpage/releases/latest) から `.dmg` を落として入れることもできます。ただ、まだ Apple の公証を受けていないので、落とした `.dmg` のアプリは初回に macOS に止められます。一度開こうとしてから、**システム設定 → プライバシーとセキュリティ** で **このまま開く** を押してください。Homebrew とスクリプトなら、この手順は要りません。

### 自分でビルドする

[Node.js](https://nodejs.org) 22 以上が要ります。

```bash
git clone https://github.com/nogu66/calmpage.git
cd calmpage
npm install
npm run dist      # release/mac-arm64/Calmpage.app ができる
```

### TeX

書類のコンパイルには、`latexmk` と `synctex` を含む TeX（[MacTeX](https://www.tug.org/mactex/) など。`brew install --cask mactex-no-gui` で入ります）が要ります。TeX は `/Library/TeX/texbin` から、ほかの道具はログインシェルの `PATH` から探すので、Finder から開いても動きます。

## 使い方

⌘O でフォルダ（または `.tex` ファイル）を開くと、本体の書類を見つけてコンパイルします。試すなら、複数のファイルに分けた短い論文の [`examples/sample`](examples/sample) を開いてください。

| 操作 | キー |
| --- | --- |
| フォルダや `.tex` を開く | ⌘O |
| 新規ファイル | ⌘N |
| 雛形から新しい書類 | ⇧⌘N |
| 新規フォルダ | ⌥⌘N |
| 新規ウインドウ | ⌃⌘N |
| ウインドウを閉じる | ⇧⌘W |
| 名前の変更・ゴミ箱・Finder で表示 | ファイル一覧で右クリック |
| 保存してコンパイル | ⌘S（*自動コンパイル* なら自動） |
| コンパイル | ⌘R |
| コンパイルを中止 | ⌘.、または長くかかっているときにステータスの横に出る「中止」 |
| 中間ファイルを消す | ファイル → 中間ファイルを消す |
| カーソル位置を PDF で示す | ⌘J |
| PDF からソースへ飛ぶ | PDF を ⌘ クリック |
| ファイル一覧 | ⌘B、またはタイトルバー左のボタン |
| 問題の一覧と生のログ | ⇧⌘M（「ログ」で切り替え） |
| フォルダ内を検索・置換 | ⇧⌘F |
| タブを閉じる（未保存なら保存してから） | ⌘W、タブの × か中クリック |
| 次 / 前のタブ | ⌃Tab / ⌃⇧Tab、または ⇧⌘] / ⇧⌘[ |
| ファイルの履歴 | ファイル → ファイルの履歴… |
| PDF プレビューの表示 / 非表示 | ⇧⌘P、またはタイトルバー右のボタン |
| AI パネル | ⇧⌘L、またはタイトルバー右端のボタン |
| PDF の拡大 / 縮小 / 幅に合わせる | トラックパッドのピンチか ⌘ + スクロール、または ⌘= / ⌘- / ⌘0 |
| PDF 内を検索 | ⌥⇧⌘F、または PDF を選んでいるときの ⌘F（⏎ で次、⇧⏎ で前） |
| 前 / 次のページ | PDF を選んでいるときの ← / →。PDF の上の帯にページ番号を入れても移れる |
| PDF のリンクをたどる | クリック（⌘ クリックは今までどおりソースへ） |
| 設定 | ⌘, または左下の歯車 |
| PDF をプレビュー.app で開く | ⇧⌘O |
| 太字 / 斜体 / 強調 | ⇧⌘B / ⌘I / ⇧⌘I |
| コメントの付け外し | ⌘/ |
| 補完を出す | ⌃Space（綴りの誤りなら言い換えの候補） |
| 検索 / 置換 | ⌘F / ⌥⌘F |
| 次を検索 / 前を検索 | ⌘G / ⇧⌘G |
| 行へ移動 | ⌥⌘G |

### コンパイルの決まり

- **本体の書類。** `% !TEX root = …` を最優先します。なければ `\documentclass` のあるファイルはそれ自身が本体です。それもなければ、前回そのファイルを読み込んでいた本体（BibTeX や Biber が読んだ `.bib` も含む）を使うか、そのファイルを `\input` している書類を探します（`.bib`・`.sty`・`.cls` なら `\bibliography`・`\addbibresource`・`\usepackage`・`\documentclass`）。どの書類のものか分からない `.bib`・`.sty`・`.cls` は、今の本体でコンパイルします。
- **処理系。** 次の順に、先に当てはまったものを使います。
  1. 本体の先頭近くの `% !TEX program = xelatex`（TeXShop の `% !TEX TS-program = xelatex` も可）。`pdflatex`・`xelatex`・`lualatex`・`uplatex`・`platex` が使えます。書類そのものに書いた指定なので最優先にし、`.latexmkrc` の処理系より先に効きます（`.latexmkrc` のほかの設定はそのまま効きます）。
  2. フォルダの `.latexmkrc`。
  3. **設定 → 既定の処理系**（「自動」以外のとき）。
  4. 自動: `ltjs*` のクラス・`luatexja`・日本語を含む書類は LuaLaTeX、`js*` のクラスは upLaTeX、`fontspec` は XeLaTeX、それ以外は pdfLaTeX。
- **`.latexmkrc` があれば**、その設定（処理系・出力先・`TEXINPUTS`）どおりにコンパイルします。
- **なければ** 中間ファイルを `~/Library/Application Support/Calmpage/build/` に出すので、フォルダは散らかりません。
- **shell-escape** は既定で切ってあります。書類から任意のプログラムを動かせるようになるので、**設定 → shell-escape を許す** は信頼できる書類のときだけ入れてください。`minted` 3 は入れなくても動き（TeX Live が制限付きの実行を許しているため）、キャッシュの `_minted` は中間ファイルと同じ場所に置かれます。
- **中間ファイルを消す** は、コンパイルと同じ出力先・処理系で `latexmk -c` を実行します（`.latexmkrc` にも従います）。PDF と SyncTeX のデータは残し、`.bbl` は元の `.bib` があるときだけ消します。Calmpage の出力先にある `minted` のキャッシュも消します。

## AI パネル

AI パネルは使わなくてもかまいません。⇧⌘L かタイトルバー右端のボタンで開きます。AI を使わないなら **設定 → AI パネル** を切ってください。ボタン・メニュー・エージェントの設定ごと消えます。入れたままでも、パネルを開くまでエージェントは起動しません。

<!-- ここに画面写真を置く: AI パネルで差分と「許可 / やめる」が出ているところ -->

- **[ACP](https://agentclientprotocol.com) のエージェントなら何でも。** Agent Client Protocol に対応したエージェントは、Zed と同じように Calmpage の会話画面で動きます。Claude Code と Codex は最初から入っていて、手元の `claude` / `codex` のログイン（または `ANTHROPIC_API_KEY` / `OPENAI_API_KEY`）をそのまま使います。ほかは柱の **+ → エージェントを追加…** で、[ACP の登録簿](https://agentclientprotocol.com/get-started/registry)から検索して ⏎ を押せば、足して新しいタブで開きます。一覧は「すぐ使える」（追加済みのものと、`npx` や Mac に入っているプログラムで動くもの）と「インストールが要る」のタブに分かれています。専用のプログラムで配られるもの（goose や Kimi CLI など）は、Calmpage が取ってきて入れます。`npx` や `uvx` で動くものはそのまま足します。同じ一覧は **設定 → エージェント** にもあり、コマンドを自分で指定して足すこともできます。
- **送るたびに文脈を添える。** 上のチップで、今のファイルと選択行、コンパイルのエラー、見ている PDF のページを添えます。押すと外せます。
- **書き換えには必ず許可が要る。** エージェントがファイルを変える前に、差分と *許可* / *やめる* を出します。変わったファイルは読み直して、コンパイルし直します。
- **本物の端末も。** *Terminal* を選ぶと、開いているフォルダでいつものログインシェルが開きます。そこで `claude` を起動すれば、Claude Code のコマンドがすべて使えます。ACP に対応していないエージェントも、端末のエージェントとして足せます。

## プライバシー

- Calmpage は利用状況を集めず、あなたや書類についての情報をどこにも送りません。
- 書類は、あなたの Mac の上で、あなたの TeX でコンパイルします。
- AI エージェントは手元で、あなた自身のアカウントで動きます。エージェントが提供元に何を送るかは、そのエージェントと提供元の決まりによります。
- Calmpage 自体がネットにつなぐのは、ACP の登録簿とそのアイコンを読むとき（AI パネルかエージェントの設定を開いたとき）と、選んだエージェントを入れるときだけです。最初から入っているエージェントは `npx` で取得するので、そのとき npm の登録簿に接続します。

## よくある質問

**Overleaf と何が違う？**
Overleaf はブラウザで動き、サーバーでコンパイルします。Calmpage は Mac のアプリで、手元の TeX でコンパイルし、ファイルは自分のディスクに置いたままです。

**AI がないと使えない？**
使えます。**設定 → AI パネル** を切れば、PDF のプレビュー付きのエディターとして使えます。

**Windows や Linux では動く？**
まだです。Electron で作っているので移すことはできますが、今確かめているのは macOS だけです。

**どの処理系に対応している？**
`latexmk` で動くものなら何でも使えます。pdfLaTeX・XeLaTeX・LuaLaTeX・upLaTeX・pLaTeX のほか、`.latexmkrc` で指定したものも動きます。

## 参加するには

不具合の報告、アイデア、プルリクエストを歓迎します。ビルド・テスト・言語の足し方は [CONTRIBUTING.md](CONTRIBUTING.md) にあります。

## ライセンス

[MIT](LICENSE)
