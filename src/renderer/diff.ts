import { diffLines } from 'diff'

// 行ごとの差分（見た目は AI パネルの差分と同じ）。変わっていない行は前後 context 行だけ残して畳む。
export function renderDiff(oldText: string, newText: string, opts: { title: string; context: number; maxRows: number; more: (n: number) => string }): HTMLElement {
  const box = document.createElement('div')
  box.className = 'diff'
  const head = document.createElement('div')
  head.className = 'diff-path'
  head.textContent = opts.title
  box.append(head)
  const parts = diffLines(oldText, newText)
  let rows = 0
  let hidden = 0
  const row = (cls: string, text: string): void => {
    if (rows >= opts.maxRows) {
      hidden++
      return
    }
    rows++
    const el = document.createElement('div')
    el.className = `diff-row ${cls}`
    el.textContent = text || ' '
    box.append(el)
  }
  parts.forEach((part, i) => {
    const lines = part.value.replace(/\n$/, '').split('\n')
    if (part.added) for (const l of lines) row('add', l)
    else if (part.removed) for (const l of lines) row('del', l)
    else {
      const head = i === 0 ? [] : lines.slice(0, opts.context)
      const tail = i === parts.length - 1 ? [] : lines.slice(-opts.context)
      if (head.length + tail.length >= lines.length) for (const l of lines) row('same', l)
      else {
        for (const l of head) row('same', l)
        row('gap', '⋯')
        for (const l of tail) row('same', l)
      }
    }
  })
  if (hidden) {
    const more = document.createElement('div')
    more.className = 'diff-more'
    more.textContent = opts.more(hidden)
    box.append(more)
  }
  return box
}

// 一覧に添える「+3 −1」。大きなファイルでは時間がかかるので数えない
export function diffStat(oldText: string, newText: string): { added: number; removed: number } | null {
  if (oldText.length + newText.length > 400_000) return null
  let added = 0
  let removed = 0
  for (const part of diffLines(oldText, newText)) {
    if (part.added) added += part.count ?? 0
    else if (part.removed) removed += part.count ?? 0
  }
  return { added, removed }
}
