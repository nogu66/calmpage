// 組み上がったアプリを起動し、主な流れを自動で確かめる。
// 使い方: npm run build && node scripts/smoke.mjs [LaTeX のフォルダ] [スクリーンショットの出力先]
// フォルダの中身は書き換わるので、渡すときは必ずコピーにすること。省くと examples/sample を一時フォルダに写して使う。
import { _electron as electron } from 'playwright-core'
import { appendFileSync, cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const folder = process.argv[2] ? resolve(process.argv[2]) : join(mkdtempSync(join(tmpdir(), 'calmpage-sample-')), 'sample')
if (!process.argv[2]) cpSync(resolve('examples/sample'), folder, { recursive: true })
const shots = resolve(process.argv[3] ?? mkdtempSync(join(tmpdir(), 'calmpage-shots-')))
mkdirSync(shots, { recursive: true })
const userData = mkdtempSync(join(tmpdir(), 'calmpage-smoke-'))
const results = []
const check = (name, ok, detail = '') => {
  results.push({ name, ok })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`)
}

// 右の柱のエージェント: 本物の代わりに、テスト用の ACP エージェントと zsh を登録しておく
writeFileSync(
  join(userData, 'settings.json'),
  JSON.stringify({
    agents: [
      { id: 'fake', name: 'Fake ACP', kind: 'acp', command: process.execPath, args: [resolve('scripts/fake-acp-agent.mjs')] },
      { id: 'shell', name: 'Shell', kind: 'terminal', command: '/bin/zsh', args: ['-f'] }
    ],
    agent: 'fake'
  })
)

const app = await electron.launch({
  args: ['.'],
  // AI の柱では本物の claude / codex の代わりに zsh を動かす（端末の仕組みだけを確かめる）
  env: { ...process.env, CALMPAGE_OPEN: folder, CALMPAGE_USER_DATA: userData }
})
const page = await app.firstWindow()
const errors = []
page.on('console', (m) => m.type() === 'error' && errors.push(m.text()))
page.on('pageerror', (e) => errors.push(String(e)))
// 表示の範囲だけを狭めると窓の下に空きができるので、窓そのものの大きさを変える
await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1480, 900))

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
const base = file.replace(/\.tex$/, '')
const escaped = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

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
// 組み直すとページの要素が入れ替わるので、位置が取れるまで待つ
const target = page.locator('.page').first()
let box = null
for (let i = 0; i < 20 && !box; i++) {
  box = await target.boundingBox()
  if (!box) await page.waitForTimeout(250)
}
await page.locator('.cm-content').click()
await page.keyboard.press('Meta+ArrowUp')
await target.click({ modifiers: ['Meta'], position: { x: box.width * 0.35, y: box.height * 0.42 } })
await page.waitForTimeout(800)
const line = await page.evaluate(() => {
  const active = document.querySelector('.cm-activeLineGutter')
  return active ? Number(active.textContent) : 0
})
check('PDF → ソース', line > 1, `${await page.locator('#file-name').textContent()}:${line}`)

// 6. 外部での書き換え（AI エージェントの編集を想定）で組み直す。本体以外の .tex があればそれを、なければ本体を書き換える
const others = readdirSync(folder, { recursive: true }).filter((f) => f.endsWith('.tex') && f !== file)
const outside = join(folder, others[0] ?? file)
let built = false
try {
  const before = await page.locator('#status-text').textContent()
  appendFileSync(outside, '\n% external edit\n')
  built = await page
    .waitForFunction(() => document.querySelector('#status').dataset.state === 'building', null, { timeout: 8000 })
    .then(() => true)
    .catch(() => false)
  await waitStatus(['ok', 'warning', 'error'])
  check('外部の変更で再組版', built, `${others[0] ?? file}: ${before}`)
} catch (e) {
  check('外部の変更で再組版', false, String(e))
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

// 8. 右の柱: ACP のエージェント（偽物）と端末のエージェント（zsh）
const thread = '.thread:not([hidden])'
const waitFor = (fn, arg, timeout = 15_000) =>
  page
    .waitForFunction(fn, arg, { timeout })
    .then(() => true)
    .catch(() => false)
const lastAgentText = () => page.evaluate((t) => [...document.querySelectorAll(`${t} .msg-agent`)].pop()?.textContent ?? '', thread)
const send = async (text) => {
  const before = await page.locator(`${thread} .msg-agent`).count()
  await page.locator(`${thread} .composer-input`).fill(text)
  await page.locator(`${thread} .composer-input`).press('Enter')
  return before
}

await clickMenu('AI パネル')
const ready = await waitFor((t) => !!document.querySelector(`${t} .thread-hint`), thread)
let before = await send('hello')
await waitFor(([t, n]) => document.querySelectorAll(`${t} .msg-agent`).length > n && /Received/.test([...document.querySelectorAll(`${t} .msg-agent`)].pop().textContent), [thread, before])
// 返事が届き終わるまで待つ（途中で読むと文字が欠ける）
await page.waitForFunction((t) => document.querySelector(`${t} .composer-send`).dataset.state !== 'stop', thread)
await page.waitForTimeout(300)
const firstReply = await lastAgentText()
const summary = await page.locator(`${thread} .msg-context`).last().textContent()
const tex = escaped(`${base}.tex`)
check('ACP: 文脈を添えて送る', ready && new RegExp(`resource_link \\S*${tex}`).test(firstReply) && new RegExp(`resource_link ${escaped(`${base}.pdf`)}`).test(firstReply) && new RegExp(tex).test(summary), `${firstReply} / 添えたもの: ${summary}`)

await page.locator('#chip-file').click()
const chipOff = await page.locator('#chip-file').getAttribute('aria-pressed')
await page.waitForFunction((t) => !document.querySelector(`${t} .composer-send`).disabled, thread)
before = await send('hello again')
await waitFor(([t, n]) => document.querySelectorAll(`${t} .msg-agent`).length > n && /Received/.test([...document.querySelectorAll(`${t} .msg-agent`)].pop().textContent), [thread, before])
const secondReply = await lastAgentText()
await page.locator('#chip-file').click()
check('ACP: チップを外す', chipOff === 'false' && !new RegExp(`resource_link \\S*${tex}`).test(secondReply), secondReply)

await page.waitForFunction((t) => !document.querySelector(`${t} .composer-send`).disabled, thread)
await send('please edit')
const asked = await waitFor((t) => !!document.querySelector(`${t} .permission-button.allow`), thread)
const diffRows = await page.locator(`${thread} .diff-row`).allTextContents()
await page.screenshot({ path: join(shots, '6-ai.png') })
await page.locator(`${thread} .permission-button.allow`).click()
const edited = await waitFor((t) => document.querySelector(`${t} .tool`)?.dataset.status === 'completed', thread)
const note = join(folder, 'smoke-note.tex')
let written = ''
try {
  written = readFileSync(note, 'utf8')
  unlinkSync(note)
} catch {}
check('ACP: 差分を見て許可し、書き換える', asked && edited && written.startsWith('new line') && diffRows.some((r) => r === 'new line'), `差分 ${JSON.stringify(diffRows)} / 書いた内容 ${JSON.stringify(written)}`)

await page.waitForFunction((t) => !document.querySelector(`${t} .composer-send`).disabled, thread)
await send('slow')
await waitFor((t) => document.querySelector(`${t} .composer-send`).dataset.state === 'stop', thread)
await page.locator(`${thread} .composer-send`).click()
const stopped = await waitFor((t) => [...document.querySelectorAll(`${t} .note-title`)].some((n) => n.textContent === '中断しました'), thread, 8000)
check('ACP: 中断', stopped)

// 端末のエージェントへ切り替える
await page.locator('#agent-picker').click()
await page.locator('#agent-menu .agent-item', { hasText: 'Shell' }).click()
const termText = () => page.evaluate(() => document.querySelector('.ai-term:not([hidden]) .xterm-rows')?.innerText ?? '')
const prompt = await waitFor(() => /%/.test(document.querySelector('.ai-term:not([hidden]) .xterm-rows')?.innerText ?? ''), null)
await page.keyboard.type('echo sumi-$((40+2))')
await page.keyboard.press('Enter')
const echoed = await waitFor(() => /sumi-42/.test(document.querySelector('.ai-term:not([hidden]) .xterm-rows')?.innerText ?? ''), null)
await page.locator('#chip-file').click()
const inserted = await waitFor((name) => (document.querySelector('.ai-term:not([hidden]) .xterm-rows')?.innerText.replace(/\n/g, '') ?? '').split('sumi-42').pop().includes(name), `${base}.tex`, 5000)
check('端末のエージェントに切り替える', prompt && echoed && inserted && (await page.locator('#ai-threads').isHidden()), (await termText()).replace(/\n/g, ' ').slice(-80))


// 戻すと、ACP のスレッドは残っている
await page.locator('#agent-picker').click()
await page.locator('#agent-menu .agent-item', { hasText: 'Fake ACP' }).click()
const replies = await page.locator(`${thread} .msg-agent`).allTextContents()
// 自分の発言は右寄せ、エージェントの返事は左から
const sides = await page.evaluate((t) => {
  const log = document.querySelector(`${t} .thread-log`).getBoundingClientRect()
  const user = document.querySelector(`${t} .msg-user`).getBoundingClientRect()
  const agent = document.querySelector(`${t} .msg-agent`).getBoundingClientRect()
  return { userRight: Math.round(log.right - user.right), userLeft: Math.round(user.left - log.left), agentLeft: Math.round(agent.left - log.left) }
}, thread)
check('自分は右、エージェントは左', sides.userRight < 32 && sides.userLeft > 60 && sides.agentLeft < 32, JSON.stringify(sides))
check(
  'ACP のスレッドが残り、返事が欠けない',
  (await page.locator(`${thread} .msg-user`).count()) === 4 && replies.length === 4 && replies.every((r) => r.startsWith('Received')),
  replies.map((r) => r.slice(0, 24)).join(' / ')
)

// 設定からエージェントを追加・削除する
await page.locator('#open-settings').click()
await page.locator('#agent-form-name').fill('Extra')
await page.locator('#agent-form-command').fill('npx -y "some agent" --acp')
await page.locator('#agent-form button[type="submit"]').click()
await page.waitForTimeout(300)
const added = await page.evaluate(() => [...document.querySelectorAll('#agent-list .agent-row')].map((r) => r.textContent))
const pickerName = await page.locator('#agent-name').textContent()
await page.locator('#agent-list .agent-row', { hasText: 'Extra' }).locator('.agent-remove').click()
await page.waitForTimeout(300)
const remaining = await page.locator('#agent-list .agent-row').count()

// 編集: 行を押すと欄に入り、保存で書き換わる
await page.locator('#agent-list .agent-row', { hasText: 'Shell' }).locator('.agent-row-main').click()
const editingCommand = await page.locator('#agent-form-command').inputValue()
await page.locator('#agent-form-name').fill('Shell (zsh)')
await page.locator('#agent-form-submit').click()
await page.waitForTimeout(300)
const renamed = await page.locator('#agent-list .agent-row', { hasText: 'Shell (zsh)' }).count()
check('エージェントの編集', editingCommand === '/bin/zsh -f' && renamed === 1 && (await page.locator('#agent-list .agent-row').count()) === 2, editingCommand)

// 登録簿から探す（ネットから一覧を読む）
await page.locator('#agent-browse').click()
const listed = await waitFor(() => document.querySelectorAll('#registry-list .registry-row').length > 10, null, 20_000)
const total = await page.locator('#registry-list .registry-row').count()
await page.locator('#registry-search').fill('gemini')
const filtered = await page.locator('#registry-list .registry-row').allTextContents()
check('ACP の登録簿から探す', listed && filtered.length >= 1 && filtered.every((r) => /gemini/i.test(r)), `${total} 件 → 「gemini」で ${filtered.length} 件`)
await page.locator('#agent-browse').click()

// 元に戻す: 最初の 3 つが戻り、自分で足したものは残る
await page.locator('#agent-restore').click()
await page.waitForTimeout(300)
const defaultsBack = await page.evaluate(() => [...document.querySelectorAll('#agent-list .agent-row-name')].map((n) => n.textContent))
check('Claude Code と Codex を元に戻す', defaultsBack.join(',') === 'Claude Code,Codex,Terminal,Fake ACP,Shell (zsh)', defaultsBack.join(', '))
await page.screenshot({ path: join(shots, '9-agents.png') })
await page.keyboard.press('Escape')

// 最初からある Terminal は、利用者のログインシェルを開く
await page.locator('#agent-picker').click()
await page.locator('#agent-menu .agent-item', { hasText: 'Terminal' }).click()
await page.waitForTimeout(1500)
await page.keyboard.type('echo login-$((1+1)) $0')
await page.keyboard.press('Enter')
const login = await waitFor(() => /login-2 -?\S*sh/.test(document.querySelector('.ai-term:not([hidden]) .xterm-rows')?.innerText ?? ''), null, 15_000)
check('Terminal でログインシェルが開く', login, (await termText()).replace(/\n/g, ' ').slice(-60))

check('エージェントの追加と削除', added.length === 3 && added.some((r) => r.includes('npx -y some agent --acp')) && pickerName === 'Extra' && remaining === 2, `${added.join(' | ')} → 残り ${remaining}`)

await clickMenu('AI パネル')
await page.waitForTimeout(200)
if (await page.locator('#ai-col').isVisible()) await clickMenu('AI パネル')
check('⇧⌘L で閉じる', !(await page.locator('#ai-col').isVisible()))
await page.locator('#toggle-ai').click()
const openedByButton = await page.locator('#ai-col').isVisible()
const pressed = await page.locator('#toggle-ai').getAttribute('aria-pressed')
await page.locator('#toggle-ai').click()
check('右上のボタンで開閉', openedByButton && pressed === 'true' && !(await page.locator('#ai-col').isVisible()))

// PDF プレビューを閉じるとエディターが広がり、⌘J（カーソル位置を PDF で表示）で開き直す
const widths = () => page.evaluate(() => ({
  editor: Math.round(document.querySelector('#editor-col').getBoundingClientRect().width),
  preview: Math.round(document.querySelector('#preview-col').getBoundingClientRect().width),
  page: Math.round(document.querySelector('#pdf-scroll .page')?.getBoundingClientRect().width ?? 0),
  pressed: document.querySelector('#toggle-preview').getAttribute('aria-pressed')
}))
const shown = await widths()
await page.locator('#toggle-preview').click()
await page.waitForTimeout(400)
const hiddenPreview = await widths()
await clickMenu('カーソル位置を PDF で表示')
await page.waitForTimeout(800)
const reopened = await widths()
check(
  'PDF プレビューを閉じて開く',
  hiddenPreview.preview === 0 && hiddenPreview.page === shown.page && hiddenPreview.pressed === 'false' && hiddenPreview.editor > shown.editor + 200 && reopened.preview === shown.preview && reopened.pressed === 'true' && Math.abs(reopened.page - shown.page) <= 1,
  `${JSON.stringify(shown)} → ${JSON.stringify(hiddenPreview)} → ${JSON.stringify(reopened)}`
)

// 左上のボタンでファイル一覧を閉じて開く
await page.locator('#toggle-sidebar').click()
const sidebarClosed = await page.evaluate(() => [document.body.classList.contains('no-sidebar'), document.querySelector('#toggle-sidebar').getAttribute('aria-pressed')])
await page.locator('#toggle-sidebar').click()
const sidebarOpened = await page.evaluate(() => [document.body.classList.contains('no-sidebar'), document.querySelector('#toggle-sidebar').getAttribute('aria-pressed')])
check('左上のボタンでファイル一覧を開閉', sidebarClosed.join() === 'true,false' && sidebarOpened.join() === 'false,true', `${sidebarClosed} → ${sidebarOpened}`)

// AI パネルを使わない設定: 入り口（ボタン・メニュー・設定の欄）ごと消え、⇧⌘L でも開かない
await page.locator('#open-settings').click()
await page.locator('#settings-ai').click()
await page.waitForTimeout(300)
const agentsHidden = await page.locator('#settings-agents').isHidden()
await page.keyboard.press('Escape')
const buttonHidden = await page.locator('#toggle-ai').isHidden()
const menuItem = await app.evaluate(({ Menu }) => {
  const find = (items) => { for (const i of items) { if (i.label === 'AI パネル') return i; const s = i.submenu && find(i.submenu.items); if (s) return s } }
  const item = find(Menu.getApplicationMenu().items)
  return item ? { visible: item.visible, enabled: item.enabled } : null
})
await clickMenu('AI パネル')
await page.waitForTimeout(200)
const stillClosed = !(await page.locator('#ai-col').isVisible())
await page.locator('#open-settings').click()
await page.locator('#settings-ai').click()
await page.waitForTimeout(300)
await page.keyboard.press('Escape')
const back = await page.locator('#toggle-ai').isVisible()
check('AI パネルを使わない設定', agentsHidden && buttonHidden && menuItem?.visible === false && stillClosed && back, JSON.stringify({ agentsHidden, buttonHidden, menuItem, stillClosed, back }))

// ---------- 班 4: ファイル操作 ----------
{
  const fs = await import('node:fs')
  const { basename, dirname } = await import('node:path')
  const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='
  const listedPaths = () => page.evaluate(() => [...document.querySelectorAll('#file-list li[data-path]')].map((li) => li.dataset.path))
  const editorText = () => page.evaluate(() => document.querySelector('.cm-content').innerText)
  const fileName = () => page.locator('#file-name').textContent()
  const item = (path) => page.locator(`#file-list li[data-path="${path}"]`)
  // ネイティブのダイアログは開けないので、main の dialog を差し替えて、出た文言を記録する
  const stubMessages = (responses) =>
    app.evaluate(({ dialog }, responses) => {
      globalThis.__messages = []
      dialog.showMessageBox = async (a, b) => {
        globalThis.__messages.push((b ?? a).message)
        return { response: responses.shift() ?? 2, checkboxChecked: false }
      }
    }, responses)
  const messages = () => app.evaluate(() => globalThis.__messages ?? [])
  // 右クリックのメニューも開けないので、出そうとした項目を記録し、名前で押せるようにする
  await app.evaluate(({ Menu }) => {
    Menu.prototype.popup = function () {
      globalThis.__popup = this
    }
  })
  const popupLabels = () => app.evaluate(() => globalThis.__popup?.items.map((i) => i.label) ?? [])
  const clickPopup = (label) => app.evaluate(({ BrowserWindow }, label) => globalThis.__popup.items.find((i) => i.label === label).click(undefined, BrowserWindow.getAllWindows()[0]), label)
  const mainTex = filePath
  await page.locator(`#file-list li[data-path="${mainTex}"]`).click()

  // 1. 画像や .csv / .md も一覧に出す。組んだ PDF（同じ名前の .tex がある）と、中身のないフォルダの扱い
  const figures = join(folder, 'figures')
  fs.mkdirSync(figures, { recursive: true })
  const plot = join(figures, 'plot.png')
  fs.writeFileSync(plot, Buffer.from(PNG, 'base64'))
  const csv = join(folder, 'data.csv')
  fs.writeFileSync(csv, 'x,y\n1,2\n')
  const notes = join(folder, 'notes.md')
  fs.writeFileSync(notes, '# Notes\n')
  const builtPdf = join(folder, `${base}.pdf`)
  const hadPdf = fs.existsSync(builtPdf)
  if (!hadPdf) fs.writeFileSync(builtPdf, '%PDF-1.4\n')
  fs.mkdirSync(join(folder, 'empty-dir'))
  const shownAll = await waitFor(([p, c, n, e]) => {
    const paths = [...document.querySelectorAll('#file-list li[data-path]')].map((li) => li.dataset.path)
    return [p, c, n, e].every((x) => paths.includes(x))
  }, [plot, csv, notes, join(folder, 'empty-dir')], 8000)
  const listed = await listedPaths()
  check('関連ファイルも一覧に出す', shownAll && !listed.includes(builtPdf), listed.map((p) => p.slice(folder.length + 1)).join(', '))
  if (!hadPdf) fs.unlinkSync(builtPdf)

  // 2. .tex 以外のテキストを開いて書ける。外部で変わったら読み直すが、組み直さない
  await item(notes).click()
  await page.waitForFunction(() => document.querySelector('#file-name').textContent === 'notes.md', null, { timeout: 5000 }).catch(() => {})
  const openedMd = (await fileName()) === 'notes.md' && (await editorText()).includes('# Notes')
  await page.evaluate(() => {
    window.__built = false
    new MutationObserver(() => {
      if (document.querySelector('#status').dataset.state === 'building') window.__built = true
    }).observe(document.querySelector('#status'), { attributes: true })
  })
  fs.writeFileSync(notes, '# Notes\n\nChanged outside.\n')
  const reloaded = await waitFor(() => document.querySelector('.cm-content').innerText.includes('Changed outside.'), null, 5000)
  await page.waitForTimeout(1200)
  const builtOnMd = await page.evaluate(() => window.__built)
  check('.md を開いて外部の変更を読み直す（組み直さない）', openedMd && reloaded && !builtOnMd, JSON.stringify({ openedMd, reloaded, builtOnMd }))

  // 3. 画像を押すと Quick Look で見る（エディターの書類はそのまま）
  await app.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0].previewFile = (path) => (globalThis.__quickLook = path)
  })
  await item(plot).click()
  await page.waitForTimeout(300)
  const looked = await app.evaluate(() => globalThis.__quickLook)
  check('画像は Quick Look で見る', looked === plot && (await fileName()) === 'notes.md', looked)

  // 4. エディターに画像を落とすと、図のフォルダに写して figure 環境を入れる（ブラウザから運んだ、パスのない画像）
  await page.evaluate(async (png) => {
    const bytes = Uint8Array.from(atob(png), (c) => c.charCodeAt(0))
    const dt = new DataTransfer()
    dt.items.add(new File([bytes], 'Drop Shot.png', { type: 'image/png' }))
    const line = [...document.querySelectorAll('.cm-line')].pop().getBoundingClientRect()
    const at = { clientX: line.left + 20, clientY: line.top + line.height / 2, bubbles: true, cancelable: true, dataTransfer: dt }
    const target = document.querySelector('.cm-content')
    target.dispatchEvent(new DragEvent('dragover', at))
    target.dispatchEvent(new DragEvent('drop', at))
  }, PNG)
  const dropped = join(figures, 'Drop Shot.png')
  const inserted = await waitFor(() => /\\includegraphics\[width=0\.8\\linewidth\]\{figures\/Drop Shot\.png\}/.test(document.querySelector('.cm-content').innerText), null, 5000)
  const text = await editorText()
  check('エディターへの画像のドロップ', inserted && fs.existsSync(dropped) && /\\label\{fig:drop-shot\}/.test(text) && /\\caption\{\}/.test(text), text.split('\n').slice(-7).join(' / '))
  // プロジェクトの外のファイルは写す（Finder からのドロップと同じ道筋）
  const outsideImage = join(mkdtempSync(join(tmpdir(), 'calmpage-image-')), 'outside.png')
  fs.writeFileSync(outsideImage, Buffer.from(PNG, 'base64'))
  const imported = await page.evaluate((src) => window.sumi.importFile(src), outsideImage)
  const insideAgain = await page.evaluate((src) => window.sumi.importFile(src), plot)
  check('外のファイルは図のフォルダへ写す', imported === join(figures, 'outside.png') && fs.existsSync(imported) && insideAgain === plot, `${imported} / ${insideAgain}`)

  // 5. 閉じるときの保存: 自動コンパイルを切って未保存があれば聞く。キャンセルなら ⌘Q も窓を閉じるのも止まる
  await page.evaluate(() => window.sumi.updateSettings({ auto: false }))
  await page.waitForFunction(() => !document.querySelector('#auto').checked)
  await page.locator('.cm-content').click()
  await page.keyboard.press('Meta+ArrowDown')
  await page.keyboard.type('\nunsaved-edit')
  await page.waitForTimeout(300)
  const dot = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isDocumentEdited())
  await stubMessages([2, 2])
  await app.evaluate(({ app }) => app.quit())
  await page.waitForTimeout(800)
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close())
  await page.waitForTimeout(800)
  const alive = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)
  const asked = await messages()
  check('未保存なら ⌘Q と窓を閉じるで聞き、キャンセルで留まる', dot && alive === 1 && asked.length === 2 && asked.every((m) => m.includes('notes.md')), `点 ${dot} / 窓 ${alive} / ${asked.join(' | ')}`)

  // 「保存」で書き、点が消える。「保存しない」で捨てる
  await stubMessages([0])
  const savedOk = await page.evaluate(() => window.sumi.confirmUnsaved(null))
  const savedText = fs.readFileSync(notes, 'utf8')
  const dotAfterSave = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isDocumentEdited())
  await page.keyboard.type(' discard-me')
  await page.waitForTimeout(200)
  await stubMessages([1])
  const discardOk = await page.evaluate(() => window.sumi.confirmUnsaved(null))
  const afterDiscard = await editorText()
  check(
    '「保存」と「保存しない」',
    savedOk && savedText.includes('unsaved-edit') && !dotAfterSave && discardOk && !fs.readFileSync(notes, 'utf8').includes('discard-me') && !afterDiscard.includes('discard-me'),
    JSON.stringify({ savedOk, dotAfterSave, discardOk })
  )
  // 自動コンパイルなら黙って保存する（入力が止まる前でも）
  await page.evaluate(() => window.sumi.updateSettings({ auto: true }))
  await page.waitForFunction(() => document.querySelector('#auto').checked)
  await stubMessages([])
  await page.keyboard.type(' auto-saved')
  const autoOk = await page.evaluate(() => window.sumi.confirmUnsaved(null))
  check('自動コンパイルなら聞かずに保存', autoOk && (await messages()).length === 0 && fs.readFileSync(notes, 'utf8').includes('auto-saved'))

  // 6. ⌘N で新しいファイル（一覧の中で名前を入れる）
  await item(mainTex).click()
  await waitStatus(['ok', 'warning', 'error'])
  await clickMenu('新規ファイル')
  const input = page.locator('#file-list .name-input')
  await input.waitFor({ timeout: 5000 })
  const suggested = await input.inputValue()
  await page.screenshot({ path: join(shots, 'files-new-file.png') })
  await input.fill('chapter.tex')
  await input.press('Enter')
  const chapter = join(dirname(mainTex), 'chapter.tex')
  await page.waitForFunction(() => document.querySelector('#file-name').textContent.endsWith('chapter.tex'), null, { timeout: 5000 }).catch(() => {})
  check('新規ファイル', suggested === 'untitled.tex' && fs.existsSync(chapter) && (await fileName()).endsWith('chapter.tex'), `${suggested} → ${await fileName()}`)

  // 7. 右クリック → 名前を変更。開いているファイルなら、エディターも新しい名前に移る
  await item(chapter).click({ button: 'right' })
  await page.waitForTimeout(200)
  const labels = await popupLabels()
  await clickPopup('名前を変更…')
  await input.waitFor({ timeout: 5000 })
  await page.keyboard.type('chapter-one')
  await page.keyboard.press('Enter')
  const renamed = join(dirname(chapter), 'chapter-one.tex')
  await item(renamed).waitFor({ timeout: 5000 }).catch(() => {})
  check(
    '右クリックで名前を変更',
    labels.join(',') === '新規ファイル,新規フォルダ,,名前を変更…,ゴミ箱に入れる,,Finder で表示' && fs.existsSync(renamed) && !fs.existsSync(chapter) && (await fileName()).endsWith('chapter-one.tex'),
    `${labels.join(',')} / ${await fileName()}`
  )

  // 8. ゴミ箱に入れる（本物のゴミ箱は使わず消すだけ）。開いていたら別の書類に移る
  await app.evaluate(({ shell }) => {
    shell.trashItem = async (path) => process.getBuiltinModule('node:fs').rmSync(path, { recursive: true })
  })
  await item(renamed).click({ button: 'right' })
  await page.waitForTimeout(200)
  await clickPopup('ゴミ箱に入れる')
  await page.waitForFunction((p) => !document.querySelector(`#file-list li[data-path="${p}"]`), renamed, { timeout: 5000 }).catch(() => {})
  check('ゴミ箱に入れる', !fs.existsSync(renamed) && !(await fileName()).endsWith('chapter-one.tex') && (await fileName()) !== '', await fileName())

  // 9. 新規フォルダ（空でも見出しが出る）と、一覧のフォルダへのドロップ
  await clickMenu('新規フォルダ')
  await input.waitFor({ timeout: 5000 })
  await input.fill('tables')
  await input.press('Enter')
  const tables = join(folder, 'tables')
  const head = await waitFor((p) => !!document.querySelector(`#file-list li.dir[data-path="${p}"]`), tables, 5000)
  await page.evaluate((p) => {
    const dt = new DataTransfer()
    dt.items.add(new File(['a,b\n'], 'table.csv', { type: 'text/csv' }))
    const target = document.querySelector(`#file-list li.dir[data-path="${p}"]`)
    target.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt }))
    target.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt }))
  }, tables)
  const tableCsv = join(tables, 'table.csv')
  const copied = await waitFor((p) => !!document.querySelector(`#file-list li[data-path="${p}"]`), tableCsv, 5000)
  check('新規フォルダとファイル一覧へのドロップ', fs.statSync(tables).isDirectory() && head && copied && fs.existsSync(tableCsv), JSON.stringify({ head, copied }))

  // 10. 新しい書類…: 空でないフォルダは断り、空のフォルダに雛形を置いて開き、コンパイルする
  await clickMenu('新しい書類…')
  const sheet = await page.locator('#templates').isVisible()
  const choices = await page.locator('#templates [data-template]').count()
  await page.screenshot({ path: join(shots, 'files-templates.png') })
  await app.evaluate(({ dialog }, dir) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [dir] })
  }, folder)
  await stubMessages([0])
  await page.locator('#templates [data-template="article"]').click()
  await page.waitForTimeout(800)
  const refused = (await messages()).some((m) => m.includes('空ではありません')) && (await page.locator('#folder-name').textContent()) === basename(folder)
  const fresh = join(mkdtempSync(join(tmpdir(), 'calmpage-new-')), 'paper')
  fs.mkdirSync(fresh)
  await app.evaluate(({ dialog }, dir) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [dir] })
  }, fresh)
  await clickMenu('新しい書類…')
  await page.locator('#templates [data-template="article"]').click()
  await page.waitForFunction((name) => document.querySelector('#folder-name').textContent === name, 'paper', { timeout: 8000 }).catch(() => {})
  const templateState = await waitStatus(['ok', 'warning', 'error'])
  check(
    '新しい書類（雛形）',
    sheet && choices === 6 && refused && fs.existsSync(join(fresh, 'main.tex')) && fs.existsSync(join(fresh, 'references.bib')) && (await fileName()) === 'main.tex' && templateState !== 'error',
    `${choices} 種類 / ${templateState} / ${await page.locator('#status-text').textContent()}`
  )
  await page.screenshot({ path: join(shots, 'files-new-document.png') })

  // 11. 最近使ったもの: 設定に残り、メニューから元のフォルダに戻れる
  const recentMenu = () =>
    app.evaluate(({ Menu }) => {
      const find = (items) => {
        for (const i of items) {
          if (i.label === '最近使ったもの') return i
          const s = i.submenu && find(i.submenu.items)
          if (s) return s
        }
      }
      return find(Menu.getApplicationMenu().items)?.submenu.items.map((i) => i.label) ?? []
    })
  const recent = await recentMenu()
  const stored = JSON.parse(fs.readFileSync(join(userData, 'settings.json'), 'utf8')).recent ?? []
  await clickMenu(basename(folder))
  const back = await waitFor((name) => document.querySelector('#folder-name').textContent === name, basename(folder), 8000)
  await waitStatus(['ok', 'warning', 'error'])
  check('最近使ったもの', recent[0] === 'paper' && recent.includes(basename(folder)) && stored[0] === fresh && stored.includes(folder) && back, `${recent.join(', ')} / ${stored.length} 件`)

  for (const path of [csv, notes, dropped, join(figures, 'outside.png'), plot, tableCsv]) fs.rmSync(path, { force: true })
  for (const dir of [tables, join(folder, 'empty-dir')]) fs.rmSync(dir, { recursive: true, force: true })
}

check('コンソールにエラーなし', errors.length === 0, errors.slice(0, 3).join(' | '))
await page.screenshot({ path: join(shots, '4-final.png') })
await app.close()
writeFileSync(join(shots, 'results.json'), JSON.stringify(results, null, 2))
process.exit(results.every((r) => r.ok) ? 0 : 1)
