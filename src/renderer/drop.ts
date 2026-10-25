// 画像のドロップ。エディターに落とすとフォルダに写して figure 環境を入れ、ファイル一覧に落とすとフォルダに写す。
import { EditorView } from '@codemirror/view'
import { isImage } from '../shared/paths'

type ImageDropHandler = (view: EditorView, files: File[], pos: number) => void

let handler: ImageDropHandler | null = null

// 写す処理（main とのやりとり）は main.ts が受け持つ。ここでは受け口を用意するだけ
export function onImageDrop(h: ImageDropHandler): void {
  handler = h
}

// フォルダは写さない（中身を確かめずに丸ごと写すと重すぎるため）
export function droppedFiles(data: DataTransfer | null): File[] {
  if (!data) return []
  const items = [...data.items]
  return [...data.files].filter((file, i) => !items[i]?.webkitGetAsEntry?.()?.isDirectory)
}

function hasFiles(data: DataTransfer | null): boolean {
  return !!data && [...data.types].includes('Files')
}

export const imageDrop = EditorView.domEventHandlers({
  dragover(e) {
    if (!hasFiles(e.dataTransfer)) return false
    e.preventDefault()
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy'
    return false
  },
  drop(e, view) {
    const files = droppedFiles(e.dataTransfer).filter((f) => isImage(f.name))
    if (!files.length || !handler) return false
    e.preventDefault()
    const pos = view.posAtCoords({ x: e.clientX, y: e.clientY }) ?? view.state.selection.main.head
    handler(view, files, pos)
    return true
  }
})

function label(path: string): string {
  const name = path.slice(path.lastIndexOf('/') + 1).replace(/\.[^.]+$/, '')
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'figure'
}

export function figureSnippet(ref: string): string {
  const include = /\.svg$/i.test(ref) ? `\\includesvg[width=0.8\\linewidth]{${ref}}` : `\\includegraphics[width=0.8\\linewidth]{${ref}}`
  return ['\\begin{figure}[htbp]', '  \\centering', `  ${include}`, '  \\caption{}', `  \\label{fig:${label(ref)}}`, '\\end{figure}'].join('\n')
}

// 落とした行が空ならそこへ、文があればその行のあとへ入れ、最初の \caption{} の中にカーソルを置く
export function insertFigures(view: EditorView, pos: number, refs: string[]): void {
  if (!refs.length) return
  const line = view.state.doc.lineAt(Math.min(pos, view.state.doc.length))
  const blank = line.text.trim() === ''
  const body = refs.map(figureSnippet).join('\n\n')
  const insert = blank ? body : `\n${body}`
  const from = blank ? line.from : line.to
  const caption = from + insert.indexOf('\\caption{') + '\\caption{'.length
  view.dispatch({
    changes: { from, to: line.to, insert },
    selection: { anchor: caption },
    scrollIntoView: true,
    userEvent: 'input.drop'
  })
  view.focus()
}

// エディターの外（ファイル一覧のすき間など）に落としても、窓がそのファイルを開きに行かないように
export function guardWindowDrop(): void {
  document.addEventListener('dragover', (e) => {
    if (hasFiles(e.dataTransfer)) e.preventDefault()
  })
  document.addEventListener('drop', (e) => e.preventDefault())
}
