import { basicSetup } from 'codemirror'
import { indentWithTab } from '@codemirror/commands'
import { lintGutter, setDiagnostics, type Diagnostic as CmDiagnostic } from '@codemirror/lint'
import { EditorState, Transaction, type Extension } from '@codemirror/state'
import { EditorView, keymap } from '@codemirror/view'
import { imageDrop } from './drop'

// 色分け・補完・スペルチェックなど LaTeX の支えは latex/ にあり、Writing.extension() で受け取る。

const theme = EditorView.theme({
  '&': { height: '100%', backgroundColor: 'var(--card)', color: 'var(--text)' },
  '&.cm-focused': { outline: 'none' },
  '.cm-scroller': { fontFamily: 'var(--font-mono)', fontSize: '13.5px', lineHeight: '1.7' },
  '.cm-content': { padding: '14px 0 40vh', caretColor: 'var(--accent)' },
  '.cm-line': { padding: '0 22px 0 10px' },
  '.cm-gutters': { backgroundColor: 'var(--card)', color: 'var(--faint)', border: 'none', paddingLeft: '8px' },
  '.cm-activeLineGutter': { backgroundColor: 'transparent', color: 'var(--text)' },
  '.cm-activeLine': { backgroundColor: 'var(--active-line)' },
  '.cm-cursor': { borderLeftColor: 'var(--accent)', borderLeftWidth: '2px' },
  '&.cm-focused .cm-selectionBackground, .cm-selectionBackground, ::selection': {
    backgroundColor: 'var(--selection) !important'
  },
  '.cm-foldGutter span': { color: 'var(--faint)' },
  '.cm-matchingBracket': { backgroundColor: 'var(--hover)', outline: '1px solid var(--faint)' },
  '.cm-searchMatch': { backgroundColor: 'var(--selection)' },
  '.cm-panels': { backgroundColor: 'var(--raised)', color: 'var(--text)', borderColor: 'var(--border)' },
  '.cm-tooltip': { backgroundColor: 'var(--raised)', color: 'var(--text)', border: '1px solid var(--border)', borderRadius: '6px' },
  '.cm-lintRange-error': { backgroundImage: 'none', textDecoration: 'underline wavy var(--accent) 1px', textUnderlineOffset: '3px' },
  '.cm-lintRange-warning': { backgroundImage: 'none', textDecoration: 'underline dotted var(--accent) 1px', textUnderlineOffset: '3px' },
  '.cm-lintRange-info': { backgroundImage: 'none' }
})

export interface LineDiagnostic {
  line: number
  severity: 'error' | 'warning' | 'info'
  message: string
}

interface Doc {
  state: EditorState
  saved: string
}

export class Editor {
  readonly view: EditorView
  private docs = new Map<string, Doc>()
  path: string | null = null

  constructor(
    parent: HTMLElement,
    private onEdit: () => void,
    private onSelect: () => void = () => {},
    private support: Extension[] = []
  ) {
    this.view = new EditorView({ parent, state: this.createState('') })
  }

  private extensions(): Extension[] {
    return [
      basicSetup,
      keymap.of([indentWithTab]),
      this.support,
      EditorView.lineWrapping,
      lintGutter(),
      imageDrop,
      theme,
      // 外部変更の読み直し（userEvent なし）では呼ばない。
      EditorView.updateListener.of((u) => {
        if (u.transactions.some((tr) => tr.docChanged && tr.annotation(Transaction.userEvent) !== undefined)) this.onEdit()
        if (u.selectionSet) this.onSelect()
      })
    ]
  }

  private createState(text: string): EditorState {
    return EditorState.create({ doc: text, extensions: this.extensions() })
  }

  open(path: string, text: string): void {
    this.stash()
    let doc = this.docs.get(path)
    if (!doc) {
      doc = { state: this.createState(text), saved: text }
      this.docs.set(path, doc)
    }
    this.path = path
    this.view.setState(doc.state)
    this.view.focus()
  }

  private stash(): void {
    if (this.path) {
      const doc = this.docs.get(this.path)
      if (doc) doc.state = this.view.state
    }
  }

  text(): string {
    return this.view.state.doc.toString()
  }

  // 開いたことのあるファイルの、保存前を含む今の内容。開いていなければ null
  textOf(path: string): string | null {
    if (path === this.path) return this.text()
    return this.docs.get(path)?.state.doc.toString() ?? null
  }

  isDirty(path = this.path): boolean {
    if (!path) return false
    const doc = this.docs.get(path)
    if (!doc) return false
    const current = path === this.path ? this.text() : doc.state.doc.toString()
    return current !== doc.saved
  }

  markSaved(path: string, text: string): void {
    const doc = this.docs.get(path)
    if (doc) doc.saved = text
  }

  // 外部で書き換えられたファイルを読み直す。未保存の変更がある場合は上書きしない。
  reloadFromDisk(path: string, text: string): boolean {
    const doc = this.docs.get(path)
    if (!doc) return false
    if (this.isDirty(path)) return false
    if (path === this.path) {
      const current = this.view.state
      if (current.doc.toString() !== text) {
        const head = Math.min(current.selection.main.head, text.length)
        this.view.dispatch({ changes: { from: 0, to: current.doc.length, insert: text }, selection: { anchor: head } })
      }
    } else {
      doc.state = this.createState(text)
    }
    doc.saved = text
    return true
  }

  // ---------- ファイル操作（閉じるときの保存、名前の変更、ゴミ箱） ----------

  dirtyPaths(): string[] {
    return [...this.docs.keys()].filter((path) => this.isDirty(path))
  }

  // 「保存しない」を選んだとき: 保存してある内容に戻す
  revert(path: string): void {
    const doc = this.docs.get(path)
    if (!doc) return
    if (path === this.path) this.view.dispatch({ changes: { from: 0, to: this.view.state.doc.length, insert: doc.saved } })
    else doc.state = this.createState(doc.saved)
  }

  // ファイルかフォルダの名前が変わった。中にある書類も含めて、開いている状態を新しいパスへ移す
  rename(from: string, to: string): void {
    const moved = (p: string): string | null => (p === from ? to : p.startsWith(from + '/') ? to + p.slice(from.length) : null)
    for (const [path, doc] of [...this.docs]) {
      const next = moved(path)
      if (!next) continue
      this.docs.delete(path)
      this.docs.set(next, doc)
    }
    if (this.path) this.path = moved(this.path) ?? this.path
  }

  // ゴミ箱に入れたファイル（フォルダならその中のもの）を忘れる。開いていたら空の画面にする
  discard(target: string): void {
    const inside = (p: string): boolean => p === target || p.startsWith(target + '/')
    for (const path of [...this.docs.keys()]) if (inside(path)) this.docs.delete(path)
    if (this.path && inside(this.path)) {
      this.path = null
      this.view.setState(this.createState(''))
    }
  }

  // 選択している行の範囲。行頭で終わる選択はその行を含めない。
  selectionLines(): { from: number; to: number } | null {
    const { from, to, empty } = this.view.state.selection.main
    if (empty) return null
    const doc = this.view.state.doc
    const last = doc.lineAt(to)
    const end = last.from === to && to > from ? last.number - 1 : last.number
    return { from: doc.lineAt(from).number, to: end }
  }

  selectionText(): string {
    const { from, to } = this.view.state.selection.main
    return this.view.state.sliceDoc(from, to)
  }

  cursor(): { line: number; column: number } {
    const head = this.view.state.selection.main.head
    const line = this.view.state.doc.lineAt(head)
    return { line: line.number, column: head - line.from + 1 }
  }

  goToLine(line: number): void {
    const doc = this.view.state.doc
    const target = doc.line(Math.min(Math.max(1, line), doc.lines))
    this.view.dispatch({
      selection: { anchor: target.from },
      effects: EditorView.scrollIntoView(target.from, { y: 'center' })
    })
    this.view.focus()
  }

  showDiagnostics(items: LineDiagnostic[]): void {
    const doc = this.view.state.doc
    const diagnostics: CmDiagnostic[] = items
      .filter((d) => d.line >= 1 && d.line <= doc.lines)
      .map((d) => {
        const line = doc.line(d.line)
        return { from: line.from, to: line.to, severity: d.severity, message: d.message }
      })
    this.view.dispatch(setDiagnostics(this.view.state, diagnostics))
  }

  // ---------- タブ・検索・履歴 ----------

  // 一度でも開いて、中身を持っているファイル
  loadedPaths(): string[] {
    return [...this.docs.keys()]
  }

  // タブを閉じたファイルを docs から外す。今のファイルなら、何も書けない空の画面にする
  close(path: string): void {
    this.docs.delete(path)
    if (path !== this.path) return
    this.path = null
    this.view.setState(EditorState.create({ extensions: [this.extensions(), EditorState.readOnly.of(true), EditorView.editable.of(false)] }))
  }

  // 置換や「この版に戻す」で中身を差し替える。取り消せるよう利用者の編集として扱い、変わった所だけを書き換える
  replaceText(path: string, text: string): boolean {
    const doc = this.docs.get(path)
    if (!doc) return false
    const state = path === this.path ? this.view.state : doc.state
    const old = state.doc.toString()
    if (old === text) return true
    let from = 0
    while (from < old.length && from < text.length && old[from] === text[from]) from++
    let end = 0
    while (end < old.length - from && end < text.length - from && old[old.length - 1 - end] === text[text.length - 1 - end]) end++
    const spec = { changes: { from, to: old.length - end, insert: text.slice(from, text.length - end) }, userEvent: 'input.replace' }
    if (path === this.path) this.view.dispatch(spec)
    else doc.state = state.update(spec).state
    return true
  }

  selectMatch(line: number, column: number, length: number): void {
    const doc = this.view.state.doc
    if (line < 1 || line > doc.lines) return
    const from = Math.min(doc.line(line).from + column, doc.length)
    const to = Math.min(from + length, doc.length)
    this.view.dispatch({ selection: { anchor: from, head: to }, effects: EditorView.scrollIntoView(from, { y: 'center' }) })
    this.view.focus()
  }
}
