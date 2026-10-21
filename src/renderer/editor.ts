import { basicSetup } from 'codemirror'
import { indentWithTab } from '@codemirror/commands'
import { HighlightStyle, StreamLanguage, syntaxHighlighting } from '@codemirror/language'
import { stex } from '@codemirror/legacy-modes/mode/stex'
import { lintGutter, setDiagnostics, type Diagnostic as CmDiagnostic } from '@codemirror/lint'
import { EditorState, Transaction, type Extension } from '@codemirror/state'
import { EditorView, keymap } from '@codemirror/view'
import { tags as t } from '@lezer/highlight'

// 色分けは控えめに: 命令は差し色（紙では太字の墨）、コメントは灰色、括弧は薄く、それ以外は本文の色。
const latexHighlight = HighlightStyle.define([
  { tag: t.tagName, color: 'var(--syntax-command)', fontWeight: 'var(--syntax-weight)' },
  { tag: t.comment, color: 'var(--muted)' },
  { tag: t.bracket, color: 'var(--faint)' },
  { tag: t.invalid, color: 'var(--syntax-command)', textDecoration: 'underline wavy' }
])

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
    private onSelect: () => void = () => {}
  ) {
    this.view = new EditorView({ parent, state: this.createState('') })
  }

  private extensions(): Extension[] {
    return [
      basicSetup,
      keymap.of([indentWithTab]),
      StreamLanguage.define(stex),
      syntaxHighlighting(latexHighlight),
      EditorView.lineWrapping,
      lintGutter(),
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
}
