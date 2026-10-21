// 画面とメニューの文言。英語が標準で、設定から日本語に切り替えられる。
// 日本語では「組版」が伝わりにくいので「コンパイル」と書く。

export type Lang = 'en' | 'ja'
export const LANGS: Lang[] = ['en', 'ja']

type Params = Record<string, string | number>
type Entry = string | ((p: Params) => string)

const en = {
  'status.idle': 'Idle',
  'status.compiling': 'Compiling…',
  'status.done': 'Done · {s}s',
  'status.warnings': (p: Params) => `${p.n} ${p.n === 1 ? 'warning' : 'warnings'} · ${p.s}s`,
  'status.errors': (p: Params) => `${p.n} ${p.n === 1 ? 'error' : 'errors'}`,
  'status.cannotCompile': 'Cannot compile',
  'status.noRoot': 'No root file',

  'problem.noRoot': 'No root .tex file includes {file}. Add “% !TEX root = main.tex” at the top to choose one.',
  'problem.document': 'Document',
  'problems.title': (p: Params) => `Problems (${p.n})`,
  'problems.none': 'No problems',
  'problems.close': 'Close (⇧⌘M)',

  'title.unsaved': 'Unsaved',
  'auto.label': 'Auto compile',
  'auto.hint': 'Save and compile when you stop typing',
  'welcome.body': 'Open a LaTeX folder to write on the left and see the PDF on the right.',
  'welcome.open': 'Open Folder',
  'divider.hint': 'Drag to resize',
  'pdf.hint': '⌘-click to jump to the source · ⌘J to show the cursor in the PDF',
  'pdf.compiling': 'Compiling {file}…',
  'pdf.none': 'No PDF',

  'settings.button': 'Settings',
  'settings.title': 'Settings',
  'settings.close': 'Done',
  'settings.general': 'General',
  'settings.language': 'Language',
  'settings.autoCompile': 'Auto compile',
  'settings.autoCompileHint': 'Save and compile 1.2 seconds after you stop typing.',
  'settings.appearance': 'Appearance',
  'settings.theme': 'Brightness',
  'settings.palette': 'Color',
  'theme.system': 'System',
  'theme.light': 'Light',
  'theme.dark': 'Dark',
  'palette.paper': 'Paper',
  'palette.moss': 'Moss',
  'palette.sand': 'Sand',

  'menu.about': 'About Sumi',
  'menu.settings': 'Settings…',
  'menu.services': 'Services',
  'menu.hide': 'Hide Sumi',
  'menu.hideOthers': 'Hide Others',
  'menu.showAll': 'Show All',
  'menu.quit': 'Quit Sumi',
  'menu.file': 'File',
  'menu.openFolder': 'Open Folder…',
  'menu.saveCompile': 'Save and Compile',
  'menu.compile': 'Compile',
  'menu.openPdf': 'Open PDF in Preview',
  'menu.edit': 'Edit',
  'menu.cut': 'Cut',
  'menu.copy': 'Copy',
  'menu.paste': 'Paste',
  'menu.selectAll': 'Select All',
  'menu.view': 'View',
  'menu.forwardSync': 'Show Cursor in PDF',
  'menu.sidebar': 'File List',
  'menu.problems': 'Problems',
  'menu.zoomIn': 'Zoom In PDF',
  'menu.zoomOut': 'Zoom Out PDF',
  'menu.zoomReset': 'Fit PDF to Width',
  'menu.theme': 'Brightness',
  'menu.palette': 'Color',
  'menu.devTools': 'Developer Tools',
  'menu.window': 'Window',
  'menu.minimize': 'Minimize',
  'menu.zoom': 'Zoom',
  'menu.front': 'Bring All to Front',

  'build.overfull': 'Overfull box ({amount})',
  'build.noPages': 'No pages of output.',
  'build.noLatexmk': 'Cannot start latexmk: {detail}'
} satisfies Record<string, Entry>

export type Key = keyof typeof en

const ja: Record<Key, Entry> = {
  'status.idle': '待機中',
  'status.compiling': 'コンパイル中…',
  'status.done': '完了 · {s}秒',
  'status.warnings': '警告 {n} 件 · {s}秒',
  'status.errors': 'エラー {n} 件',
  'status.cannotCompile': 'コンパイルできません',
  'status.noRoot': '本体が見つかりません',

  'problem.noRoot': '{file} を読み込んでいる本体の .tex が見つかりません。先頭に「% !TEX root = 本体.tex」と書くと指定できます。',
  'problem.document': '文書全体',
  'problems.title': '問題 {n} 件',
  'problems.none': '問題はありません',
  'problems.close': '閉じる (⇧⌘M)',

  'title.unsaved': '未保存',
  'auto.label': '自動コンパイル',
  'auto.hint': '入力が止まったら自動で保存してコンパイルする',
  'welcome.body': 'LaTeX のフォルダを開くと、左で書いて右で PDF を確認できます。',
  'welcome.open': 'フォルダを開く',
  'divider.hint': 'ドラッグで幅を変える',
  'pdf.hint': '⌘ クリックでソースへ　⌘J でカーソル位置を表示',
  'pdf.compiling': '{file} をコンパイル中…',
  'pdf.none': 'PDF はありません',

  'settings.button': '設定',
  'settings.title': '設定',
  'settings.close': '閉じる',
  'settings.general': '一般',
  'settings.language': '言語',
  'settings.autoCompile': '自動コンパイル',
  'settings.autoCompileHint': '入力が 1.2 秒止まったら、保存してコンパイルします。',
  'settings.appearance': '見た目',
  'settings.theme': '明るさ',
  'settings.palette': '配色',
  'theme.system': 'システム',
  'theme.light': 'ライト',
  'theme.dark': 'ダーク',
  'palette.paper': '紙',
  'palette.moss': '苔',
  'palette.sand': '砂',

  'menu.about': 'Sumi について',
  'menu.settings': '設定…',
  'menu.services': 'サービス',
  'menu.hide': 'Sumi を隠す',
  'menu.hideOthers': 'ほかを隠す',
  'menu.showAll': 'すべてを表示',
  'menu.quit': 'Sumi を終了',
  'menu.file': 'ファイル',
  'menu.openFolder': 'フォルダを開く…',
  'menu.saveCompile': '保存してコンパイル',
  'menu.compile': 'コンパイル',
  'menu.openPdf': 'PDF をプレビュー.app で開く',
  'menu.edit': '編集',
  'menu.cut': 'カット',
  'menu.copy': 'コピー',
  'menu.paste': 'ペースト',
  'menu.selectAll': 'すべてを選択',
  'menu.view': '表示',
  'menu.forwardSync': 'カーソル位置を PDF で表示',
  'menu.sidebar': 'ファイル一覧',
  'menu.problems': '問題の一覧',
  'menu.zoomIn': 'PDF を拡大',
  'menu.zoomOut': 'PDF を縮小',
  'menu.zoomReset': 'PDF を幅に合わせる',
  'menu.theme': '明るさ',
  'menu.palette': '配色',
  'menu.devTools': '開発者ツール',
  'menu.window': 'ウインドウ',
  'menu.minimize': 'しまう',
  'menu.zoom': '拡大/縮小',
  'menu.front': 'すべてを手前に移動',

  'build.overfull': 'はみ出し ({amount})',
  'build.noPages': 'PDF が 1 ページも出力されませんでした',
  'build.noLatexmk': 'latexmk を起動できません: {detail}'
}

const DICTS: Record<Lang, Record<Key, Entry>> = { en, ja }

export function t(lang: Lang, key: Key, params: Params = {}): string {
  const entry = (DICTS[lang] ?? en)[key]
  if (typeof entry === 'function') return entry(params)
  return entry.replace(/\{(\w+)\}/g, (_, name: string) => String(params[name] ?? ''))
}
