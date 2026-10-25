// 「新しい書類…」の雛形。?raw で読み込むので、本体の JS に文字列として入り、組み立てたアプリにも含まれる。
import { mkdir, readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import article from './article/main.tex?raw'
import beamer from './beamer/main.tex?raw'
import jsarticle from './jsarticle/main.tex?raw'
import letter from './letter/main.tex?raw'
import ltjsarticle from './ltjsarticle/main.tex?raw'
import report from './report/main.tex?raw'
import bib from './references.bib?raw'
import bibJa from './references-ja.bib?raw'

export const TEMPLATE_IDS = ['article', 'ltjsarticle', 'jsarticle', 'beamer', 'report', 'letter'] as const
export type TemplateId = (typeof TEMPLATE_IDS)[number]

const FILES: Record<TemplateId, Record<string, string>> = {
  article: { 'main.tex': article, 'references.bib': bib },
  ltjsarticle: { 'main.tex': ltjsarticle, 'references.bib': bibJa },
  jsarticle: { 'main.tex': jsarticle, 'references.bib': bibJa },
  beamer: { 'main.tex': beamer },
  report: { 'main.tex': report, 'references.bib': bib },
  letter: { 'main.tex': letter }
}

// 隠しファイル（.DS_Store など）だけなら空とみなす
export async function isEmptyFolder(dir: string): Promise<boolean> {
  const names = await readdir(dir).catch(() => null)
  return names !== null && names.every((n) => n.startsWith('.'))
}

// 雛形を置き、開くファイル（main.tex）を返す
export async function writeTemplate(id: TemplateId, dir: string): Promise<string> {
  await mkdir(dir, { recursive: true })
  for (const [name, text] of Object.entries(FILES[id])) await writeFile(join(dir, name), text, { flag: 'wx' })
  return join(dir, 'main.tex')
}
