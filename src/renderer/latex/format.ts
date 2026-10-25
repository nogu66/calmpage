import { redo, toggleComment, undo } from '@codemirror/commands'
import { findNext, findPrevious, gotoLine, openSearchPanel } from '@codemirror/search'
import { EditorSelection } from '@codemirror/state'
import { EditorView, keymap } from '@codemirror/view'
import { inMath } from './complete'

// 太字・斜体などで囲む。選択があれば囲み（すでに同じ命令で囲まれていれば外す）、なければ {} の中にカーソルを置く。
// 数式の中では \mathbf などに替える。

export type Format = 'bold' | 'italic' | 'emph' | 'typewriter'

const TEXT: Record<Format, string> = { bold: 'textbf', italic: 'textit', emph: 'emph', typewriter: 'texttt' }
const MATH: Record<Format, string> = { bold: 'mathbf', italic: 'mathit', emph: 'mathit', typewriter: 'mathtt' }

export function wrap(view: EditorView, format: Format): boolean {
  const { state } = view
  const name = inMath(state, state.selection.main.from) ? MATH[format] : TEXT[format]
  const open = `\\${name}{`
  view.dispatch(
    state.changeByRange((range) => {
      if (range.empty) {
        return { changes: { from: range.from, insert: `${open}}` }, range: EditorSelection.cursor(range.from + open.length) }
      }
      const wrapped = state.sliceDoc(range.from - open.length, range.from) === open && state.sliceDoc(range.to, range.to + 1) === '}'
      if (wrapped) {
        return {
          changes: [{ from: range.from - open.length, to: range.from }, { from: range.to, to: range.to + 1 }],
          range: EditorSelection.range(range.from - open.length, range.to - open.length)
        }
      }
      return {
        changes: [{ from: range.from, insert: open }, { from: range.to, insert: '}' }],
        range: EditorSelection.range(range.from + open.length, range.to + open.length)
      }
    }),
    { userEvent: 'input.format', scrollIntoView: true }
  )
  return true
}

export const formatKeys = keymap.of([
  { key: 'Shift-Mod-b', run: (v) => wrap(v, 'bold') },
  { key: 'Mod-i', run: (v) => wrap(v, 'italic') },
  { key: 'Shift-Mod-i', run: (v) => wrap(v, 'emph') }
])

// 入力欄（AI パネルなど）にいるときは、取り消し・やり直しをその欄に任せる
function otherField(view: EditorView): boolean {
  const el = document.activeElement as HTMLElement | null
  if (!el || view.contentDOM.contains(el)) return false
  return el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el.isContentEditable
}

// 編集メニューから届いたコマンド。扱ったら true
export function runEditCommand(view: EditorView, command: string): boolean {
  const formats: Record<string, Format> = { bold: 'bold', italic: 'italic', emph: 'emph', typewriter: 'typewriter' }
  if (command === 'undo' || command === 'redo') {
    if (otherField(view)) document.execCommand(command)
    else (command === 'undo' ? undo : redo)(view)
    return true
  }
  const run: Record<string, (v: EditorView) => boolean> = {
    find: openSearchPanel,
    replace: (v) => {
      openSearchPanel(v)
      const field = v.dom.querySelector<HTMLInputElement>('.cm-search input[name=replace]')
      field?.focus()
      field?.select()
      return true
    },
    'find-next': findNext,
    'find-previous': findPrevious,
    'go-to-line': gotoLine,
    'toggle-comment': toggleComment
  }
  if (command in formats) {
    if (otherField(view)) return true
    view.focus()
    return wrap(view, formats[command])
  }
  const fn = run[command]
  if (!fn) return false
  view.focus()
  fn(view)
  return true
}
