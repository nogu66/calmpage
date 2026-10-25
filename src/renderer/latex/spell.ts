import type { CompletionSource } from '@codemirror/autocomplete'
import { syntaxTree } from '@codemirror/language'
import { RangeSetBuilder, StateEffect } from '@codemirror/state'
import { Decoration, EditorView, ViewPlugin, type DecorationSet, type ViewUpdate } from '@codemirror/view'

// 本文の英単語だけを macOS のスペルチェッカーで調べる。
// 命令・数式・コメント・ラベルやパスなどの引数は字句解析で印が付いているので、印のない所（本文）だけを見る。

export interface SpellApi {
  misspelled: (word: string) => boolean
  suggestions: (word: string) => string[]
  menu: (word: string, suggestions: string[]) => Promise<{ replace?: string; learned?: boolean } | null>
}

const refresh = StateEffect.define<null>()
const cache = new Map<string, boolean>()
const mark = Decoration.mark({ class: 'cm-misspelled' })
const WORD = /[A-Za-z]+(?:'[A-Za-z]+)*/g

export class Spell {
  enabled = true
  private views = new Set<EditorView>()

  constructor(private api: SpellApi) {}

  setEnabled(on: boolean): void {
    if (this.enabled === on) return
    this.enabled = on
    this.redraw()
  }

  private redraw(): void {
    for (const view of this.views) view.dispatch({ effects: refresh.of(null) })
  }

  misspelled(word: string): boolean {
    let hit = cache.get(word)
    if (hit === undefined) {
      try {
        hit = this.api.misspelled(word)
      } catch {
        hit = false
      }
      cache.set(word, hit)
    }
    return hit
  }

  // 略語（すべて大文字）や数字と続く語（2D など）は調べない
  private checkable(text: string, from: number, to: number, word: string): boolean {
    if (word.length < 2 || word === word.toUpperCase()) return false
    const before = text[from - 1] ?? ''
    const after = text[to] ?? ''
    return !/[0-9_@\\]/.test(before) && !/[0-9_@]/.test(after)
  }

  decorations(view: EditorView): DecorationSet {
    const builder = new RangeSetBuilder<Decoration>()
    if (!this.enabled) return builder.finish()
    const { state } = view
    const tree = syntaxTree(state)
    const sel = state.selection.main
    for (const range of view.visibleRanges) {
      const from = state.doc.lineAt(range.from).from
      const to = Math.min(state.doc.lineAt(range.to).to, tree.length)
      if (to <= from) continue
      // 印の付いた字句のすき間が本文
      const gaps: [number, number][] = []
      let pos = from
      tree.iterate({
        from,
        to,
        enter: (node) => {
          if (node.type.isTop) return
          if (node.from > pos) gaps.push([pos, node.from])
          pos = Math.max(pos, node.to)
          return false
        }
      })
      if (pos < to) gaps.push([pos, to])
      const text = state.sliceDoc(from, to)
      for (const [a, b] of gaps) {
        const part = text.slice(a - from, b - from)
        for (const m of part.matchAll(WORD)) {
          const start = a + (m.index ?? 0)
          const end = start + m[0].length
          // 打っている途中の語は、打ち終わるまで印を付けない
          if (sel.empty && sel.head === end) continue
          if (!this.checkable(text, start - from, end - from, m[0])) continue
          if (this.misspelled(m[0])) builder.add(start, end, mark)
        }
      }
    }
    return builder.finish()
  }

  plugin() {
    const spell = this
    return ViewPlugin.fromClass(
      class {
        decorations: DecorationSet
        constructor(readonly view: EditorView) {
          spell.views.add(view)
          this.decorations = spell.decorations(view)
        }
        update(u: ViewUpdate): void {
          if (u.docChanged || u.viewportChanged || u.selectionSet || syntaxTree(u.startState) !== syntaxTree(u.state) || u.transactions.some((tr) => tr.effects.some((e) => e.is(refresh)))) {
            this.decorations = spell.decorations(u.view)
          }
        }
        destroy(): void {
          spell.views.delete(this.view)
        }
      },
      {
        decorations: (v) => v.decorations,
        eventHandlers: {
          contextmenu(e) {
            return spell.contextMenu(this.view, this.decorations, e)
          }
        }
      }
    )
  }

  // 誤りの上で右クリックすると、候補と「辞書に追加」を macOS のメニューで出す
  private contextMenu(view: EditorView, decorations: DecorationSet, e: MouseEvent): boolean {
    const pos = view.posAtCoords({ x: e.clientX, y: e.clientY })
    if (pos === null) return false
    let hit: { from: number; to: number } | null = null
    decorations.between(pos, pos, (from, to) => {
      hit = { from, to }
      return false
    })
    if (!hit) return false
    const { from, to } = hit as { from: number; to: number }
    e.preventDefault()
    const word = view.state.sliceDoc(from, to)
    const suggestions = this.api.suggestions(word)
    void this.api.menu(word, suggestions).then((choice) => {
      if (choice?.replace && view.state.sliceDoc(from, to) === word) {
        view.dispatch({ changes: { from, to, insert: choice.replace }, userEvent: 'input.spell' })
        view.focus()
      }
      if (choice?.learned) {
        cache.delete(word)
        this.redraw()
      }
    })
    return true
  }

  // ⌃Space で、誤った語の直後なら言い換えの候補を出す
  completion(): CompletionSource {
    return (cx) => {
      if (!this.enabled || !cx.explicit) return null
      const m = cx.matchBefore(/[A-Za-z]+(?:'[A-Za-z]+)*/)
      if (!m || m.from === m.to) return null
      const node = syntaxTree(cx.state).resolveInner(m.from, 1)
      if (!node.type.isTop || !this.misspelled(m.text)) return null
      const options = this.api.suggestions(m.text).map((label) => ({ label, type: 'text' }))
      return options.length ? { from: m.from, options, filter: false } : null
    }
  }
}

export const spellTheme = EditorView.baseTheme({
  '.cm-misspelled': { textDecoration: 'underline dotted var(--muted) 1.5px', textUnderlineOffset: '3px' }
})
