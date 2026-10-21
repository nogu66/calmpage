// 組み上がったアプリを起動し、主な流れを自動で確かめる。
// 使い方: npm run build && node scripts/smoke.mjs <LaTeX のフォルダ> <スクリーンショットの出力先>
// フォルダの中身は書き換わるので、必ずコピーを渡すこと。
import { _electron as electron } from 'playwright-core'
import { appendFileSync, mkdtempSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const folder = resolve(process.argv[2] ?? '')
const shots = resolve(process.argv[3] ?? '.')
const userData = mkdtempSync(join(tmpdir(), 'sumi-smoke-'))
const results = []
const check = (name, ok, detail = '') => {
  results.push({ name, ok })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`)
}

const app = await electron.launch({
  args: ['.'],
  env: { ...process.env, SUMI_OPEN: folder, SUMI_USER_DATA: userData }
})
const page = await app.firstWindow()
const errors = []
page.on('console', (m) => m.type() === 'error' && errors.push(m.text()))
page.on('pageerror', (e) => errors.push(String(e)))
await page.setViewportSize({ width: 1480, height: 900 }).catch(() => {})

const status = () => page.locator('#status').getAttribute('data-state')
const waitStatus = async (states, timeout = 90_000) => {
  await page.waitForFunction(
    (s) => s.includes(document.querySelector('#status').dataset.state),
    states,
    { timeout }
  )
  return status()
}
const clickMenu = (label) =>
  app.evaluate(({ Menu, BrowserWindow }, label) => {
    const find = (items) => {
      for (const item of items) {
        if (item.label === label) return item
        const sub = item.submenu && find(item.submenu.items)
        if (sub) return sub
      }
    }
    find(Menu.getApplicationMenu().items)?.click(undefined, BrowserWindow.getAllWindows()[0])
  }, label)

// 1. 開いた直後に組版され、PDF が表示される
let state = await waitStatus(['ok', 'warning', 'error'])
await page.waitForSelector('.page canvas', { timeout: 30_000 }).catch(() => {})
const pages = await page.locator('.page').count()
const canvases = await page.locator('.page canvas').count()
check('初回の組版', state !== 'error', `${state} / ${await page.locator('#status-text').textContent()}`)
check('PDF の表示', pages > 0 && canvases > 0, `${pages} ページ, 描画 ${canvases}`)
check('処理系の表示', (await page.locator('#engine').textContent()) !== '', await page.locator('#engine').textContent())
await page.screenshot({ path: join(shots, '1-open.png') })

const file = await page.locator('#file-name').textContent()
const filePath = join(folder, file)

// 2. 誤りを入れると自動組版でエラーが出る
const begin = readFileSync(filePath, 'utf8').split('\n').findIndex((l) => l.includes('\\begin{document}')) + 1
await page.locator('.cm-content').click()
await page.keyboard.press('Meta+ArrowUp')
for (let i = 0; i < begin; i++) await page.keyboard.press('ArrowDown')
await page.keyboard.press('End')
await page.keyboard.type('\n\\undefinedmacroxyz ')
await page.waitForFunction(() => document.querySelector('#status').dataset.state === 'building', null, { timeout: 10_000 }).catch(() => {})
state = await waitStatus(['ok', 'warning', 'error'])
const problem = await page.locator('#problem-list li.error').first().textContent().catch(() => '')
check('エラーの検出', state === 'error' && /Undefined control sequence/.test(problem), problem)
check('エディターのエラー表示', (await page.locator('.cm-lintRange-error').count()) > 0)
await page.screenshot({ path: join(shots, '2-error.png') })

// 3. 元に戻すとエラーが消える
await page.keyboard.press('Meta+z')
await page.keyboard.press('Meta+z')
await page.keyboard.press('Meta+z')
await page.waitForTimeout(300)
const restored = (await page.evaluate(() => document.querySelector('.cm-content').innerText)).includes('undefinedmacroxyz') === false
if (!restored) await clickMenu('Save and Compile')
await page.waitForFunction(() => document.querySelector('#status').dataset.state === 'building', null, { timeout: 10_000 }).catch(() => {})
state = await waitStatus(['ok', 'warning', 'error'])
check('元に戻して再組版', state !== 'error' && !readFileSync(filePath, 'utf8').includes('undefinedmacroxyz'), state)

// 4. ⌘J: カーソル位置を PDF で表示
await clickMenu('Show Cursor in PDF')
const mark = await page.waitForSelector('.sync-mark', { timeout: 5000 }).then(() => true).catch(() => false)
check('ソース → PDF', mark)
await page.screenshot({ path: join(shots, '3-forward.png') })

// 5. ⌘クリック: PDF からソースへ
const target = page.locator('.page').first()
const box = await target.boundingBox()
await page.locator('.cm-content').click()
await page.keyboard.press('Meta+ArrowUp')
await target.click({ modifiers: ['Meta'], position: { x: box.width * 0.35, y: box.height * 0.42 } })
await page.waitForTimeout(800)
const line = await page.evaluate(() => {
  const active = document.querySelector('.cm-activeLineGutter')
  return active ? Number(active.textContent) : 0
})
check('PDF → ソース', line > 1, `${await page.locator('#file-name').textContent()}:${line}`)

// 6. 外部での書き換え（AI エージェントの編集を想定）で組み直す
const profile = join(folder, 'tex', 'profile.tex')
let built = false
try {
  readFileSync(profile)
  const before = await page.locator('#status-text').textContent()
  appendFileSync(profile, '\n% external edit\n')
  built = await page
    .waitForFunction(() => document.querySelector('#status').dataset.state === 'building', null, { timeout: 8000 })
    .then(() => true)
    .catch(() => false)
  await waitStatus(['ok', 'warning', 'error'])
  check('外部の変更で再組版', built, before)
} catch {
  check('外部の変更で再組版', false, 'tex/profile.tex がない')
}

// 6b. 別の書類に切り替えたら、前の書類の PDF はすぐ消え、新しい PDF に替わる
const other = join(folder, 'smoke-other.tex')
writeFileSync(other, '\\documentclass{article}\n\\begin{document}\nOther document.\n\\end{document}\n')
const otherItem = page.locator(`#file-list li[data-path="${other}"]`)
await otherItem.waitFor({ timeout: 8000 })
await waitStatus(['ok', 'warning', 'error'])
await otherItem.click()
await page.waitForFunction(() => document.querySelector('#status').dataset.state === 'building', null, { timeout: 8000 }).catch(() => {})
const cleared = await page.evaluate(() => ({
  pages: document.querySelectorAll('#pdf-scroll .page').length,
  note: document.querySelector('#pdf-note').hidden ? '' : document.querySelector('#pdf-note').textContent
}))
await waitStatus(['ok', 'warning', 'error'])
await page.waitForTimeout(500)
const switched = await page.evaluate(() => ({
  pages: document.querySelectorAll('#pdf-scroll .page').length,
  noteHidden: document.querySelector('#pdf-note').hidden
}))
check(
  '別の書類で前の PDF を消す',
  cleared.pages === 0 && /smoke-other/.test(cleared.note) && switched.pages === 1 && switched.noteHidden,
  `切替直後 ${cleared.pages} ページ「${cleared.note}」→ 完了後 ${switched.pages} ページ`
)
await page.locator(`#file-list li[data-path="${filePath}"]`).click()
await page.waitForFunction(() => document.querySelector('#status').dataset.state === 'building', null, { timeout: 8000 }).catch(() => {})
await waitStatus(['ok', 'warning', 'error'])
unlinkSync(other)

// 7. 左下の設定ボタン → 言語と配色の切り替え
await page.locator('#open-settings').click()
const sheetOpen = await page.locator('#settings').isVisible()
const englishStatus = await page.locator('#status-text').textContent()
await page.locator('[data-setting="language"] button[data-value="ja"]').click()
await page.waitForTimeout(300)
const japaneseStatus = await page.locator('#status-text').textContent()
const menuJa = await app.evaluate(({ Menu }) => Menu.getApplicationMenu().items.map((i) => i.label).join(' / '))
check('設定画面が開く', sheetOpen)
check('日本語に切り替え', /完了|警告|エラー/.test(japaneseStatus) && menuJa.includes('ファイル'), `${englishStatus} → ${japaneseStatus} / ${menuJa}`)
await page.locator('[data-setting="palette"] button[data-value="moss"]').click()
await page.waitForTimeout(200)
check('配色の切り替え', (await page.evaluate(() => document.documentElement.dataset.palette)) === 'moss')
await page.screenshot({ path: join(shots, '5-settings.png') })
await page.keyboard.press('Escape')
check('Esc で閉じる', !(await page.locator('#settings').isVisible()))

check('コンソールにエラーなし', errors.length === 0, errors.slice(0, 3).join(' | '))
await page.screenshot({ path: join(shots, '4-final.png') })
await app.close()
writeFileSync(join(shots, 'results.json'), JSON.stringify(results, null, 2))
process.exit(results.every((r) => r.ok) ? 0 : 1)
