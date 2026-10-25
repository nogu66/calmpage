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

// ---------- 班 5: 検索・タブ・履歴 ----------
// エディターの中身は、表示していない行も含めて CodeMirror から読む
const cmText = () => page.evaluate(() => document.querySelector('.cm-content').cmTile.root.view.state.doc.toString())
const cmSelected = () => page.evaluate(() => {
  const { state } = document.querySelector('.cm-content').cmTile.root.view
  return state.sliceDoc(state.selection.main.from, state.selection.main.to)
})
const tabPaths = () => page.evaluate(() => [...document.querySelectorAll('#tabs .tab')].map((t) => t.dataset.path))
const activeTab = () => page.evaluate(() => document.querySelector('#tabs .tab.active')?.dataset.path ?? null)
const sources = readdirSync(folder, { recursive: true }).filter((f) => /\.(tex|bib|cls|sty|bst)$/.test(f)).map((f) => join(folder, f))
const expectCount = (re) => {
  let n = 0
  let files = 0
  for (const f of sources) {
    const k = (readFileSync(f, 'utf8').match(re) ?? []).length
    n += k
    if (k) files++
  }
  return `${files} ファイルに ${n} 件`
}
const searchStatus = () => page.locator('#search .search-status').textContent()
const waitSearch = (text) => waitFor((t) => document.querySelector('#search .search-status')?.textContent === t, text, 8000)
const model = join(folder, 'sections/model.tex')
const intro = join(folder, 'sections/introduction.tex')
const fileItem = (path) => page.locator(`#file-list li[data-path="${path}"]`)
const exists = (path) => {
  try {
    readFileSync(path)
    return true
  } catch {
    return false
  }
}

// フォルダ内の検索: ⇧⌘F（編集メニュー）でサイドバーが検索に替わり、結果はファイルごとにまとまる
await fileItem(filePath).click()
await waitStatus(['ok', 'warning', 'error'])
await clickMenu('フォルダ内を検索')
const searchOpen = await page.evaluate(() => ({
  search: !!document.querySelector('#search').offsetParent,
  files: !!document.querySelector('#file-list').offsetParent,
  focused: document.activeElement?.classList.contains('search-input') ?? false
}))
const query = page.locator('#search .search-input').first()
await query.fill('ink')
const plain = await waitSearch(expectCount(/ink/gi))
const groups = await page.evaluate(() => [...document.querySelectorAll('#search .search-group')].map((g) => [g.querySelector('.search-file').dataset.path, g.querySelectorAll('.search-hit').length]))
await page.screenshot({ path: join(shots, '12-search.png') })
check('フォルダ内を検索: ⇧⌘F で開き、ファイルごとにまとめる', searchOpen.search && !searchOpen.files && searchOpen.focused && plain && groups.length >= 2, `${JSON.stringify(searchOpen)} / ${await searchStatus()} / ${groups.map(([p, n]) => `${p.slice(folder.length + 1)}:${n}`).join(' ')}`)

const opt = (name) => page.locator(`#search .search-opt[data-opt="${name}"]`)
await opt('caseSensitive').click()
await query.fill('Ink')
const cased = await waitSearch(expectCount(/Ink/g))
await opt('caseSensitive').click()
await opt('wholeWord').click()
const word = await waitSearch(expectCount(/(?<!\w)(?:Ink)(?!\w)/gi))
await opt('wholeWord').click()
await opt('regex').click()
await query.fill('\\\\(sub)?section\\{')
const regex = await waitSearch(expectCount(/\\(sub)?section\{/gi))
await query.fill('(')
const invalid = await waitSearch('正規表現が正しくありません')
await opt('regex').click()
check('検索: 大文字小文字・単語単位・正規表現', cased && word && regex && invalid, await searchStatus())

// 結果を押すと、そのファイルのその場所へ移る
await query.fill('capillary')
await waitSearch(expectCount(/capillary/gi))
const hit = page.locator('#search .search-hit').first()
const hitPath = await hit.getAttribute('data-path')
await hit.click()
await page.waitForTimeout(500)
const selected = await cmSelected()
check('検索: 結果を押してその行へ移る', (await activeTab()) === hitPath && /^capillary$/i.test(selected), `${hitPath?.slice(folder.length + 1)} / 選択「${selected}」`)

// すべて置換: 確かめてから、開いているファイルはエディターで、開いていないファイルはディスクで書き換える
const sa = join(folder, 'smoke-search-a.tex')
const sb = join(folder, 'smoke-search-b.tex')
writeFileSync(sa, 'zqx-alpha zqx-beta\n')
writeFileSync(sb, 'zqx-gamma\n')
await page.locator('#search .search-close').click()
await fileItem(sa).waitFor({ timeout: 8000 })
await fileItem(sb).waitFor({ timeout: 8000 })
await fileItem(sa).click()
await waitStatus(['ok', 'warning', 'error'])
await page.evaluate(() => {
  window.__changed = []
  window.sumi.onFileChanged((p) => window.__changed.push(p))
})
await app.evaluate(({ dialog }) => {
  globalThis.__answers = [1, 0] // 1 回目は「キャンセル」、2 回目は「すべて置換」
  globalThis.__asked = []
  dialog.showMessageBox = async (_win, options) => {
    globalThis.__asked.push(options.message)
    return { response: globalThis.__answers.shift() ?? 1, checkboxChecked: false }
  }
})
await clickMenu('フォルダ内を検索')
await query.fill('zqx-')
await waitSearch('2 ファイルに 3 件')
await page.locator('#search .search-input').nth(1).fill('qq-')
await page.locator('#search .search-replace-all').click()
await page.waitForTimeout(500)
const cancelled = (await cmText()) === 'zqx-alpha zqx-beta\n' && readFileSync(sb, 'utf8') === 'zqx-gamma\n'
await page.locator('#search .search-replace-all').click()
const replacedNote = await waitSearch('3 か所を置換しました')
await page.waitForTimeout(1500)
const confirmAsks = await app.evaluate(() => globalThis.__asked)
const changedEvents = await page.evaluate(() => window.__changed)
const editorA = await cmText()
const diskA = readFileSync(sa, 'utf8')
const diskB = readFileSync(sb, 'utf8')
check(
  'すべて置換: 確認し、開いているファイルはエディターで、ほかはディスクで',
  cancelled && replacedNote && confirmAsks.length === 2 && confirmAsks[1] === '2 ファイルの 3 か所を置換しますか？' && editorA === 'qq-alpha qq-beta\n' && diskA === editorA && diskB === 'qq-gamma\n',
  `キャンセル ${cancelled} / 確認 ${JSON.stringify(confirmAsks)} / エディター ${JSON.stringify(editorA)} / a ${JSON.stringify(diskA)} / b ${JSON.stringify(diskB)}`
)
check('すべて置換: 自分の書き込みを外部の変更と取り違えない', !changedEvents.includes(sb), JSON.stringify(changedEvents.map((p) => p.slice(folder.length + 1))))
await page.keyboard.press('Escape')
await clickMenu('フォルダ内を検索')
await clickMenu('フォルダ内を検索')
check('検索を閉じてファイル一覧に戻る', !(await page.evaluate(() => !!document.querySelector('#search').offsetParent)) && (await fileItem(filePath).isVisible()))

// タブ: 開いたファイルが並び、本体の書類には印が付く
await clickMenu('タブを閉じる') // smoke-search-a.tex
unlinkSync(sa)
unlinkSync(sb)
await fileItem(filePath).click()
await fileItem(intro).click()
await fileItem(model).click()
await waitStatus(['ok', 'warning', 'error'])
let tabs = await tabPaths()
const rootTab = await page.evaluate(() => document.querySelector('#tabs .tab.root')?.dataset.path ?? null)
check('タブ: 開いたファイルが並び、本体に印', tabs.includes(filePath) && tabs.includes(intro) && tabs.includes(model) && (await activeTab()) === model && rootTab === filePath, `${tabs.map((p) => p.slice(folder.length + 1)).join(', ')} / 本体 ${rootTab?.slice(folder.length + 1)}`)

// 未保存の印を付け、⌘W で保存してから閉じる（自動保存より先に閉じる）
const modelBefore = readFileSync(model, 'utf8')
await page.locator('.cm-content').click()
await page.keyboard.press('Meta+ArrowDown')
await page.keyboard.type('\n% tab-close-marker')
const dirtyMark = await page.locator('#tabs .tab.active.dirty').count()
await clickMenu('タブを閉じる')
await page.waitForTimeout(400)
const savedOnClose = readFileSync(model, 'utf8').includes('tab-close-marker')
tabs = await tabPaths()
const afterClose = await activeTab()
check('タブ: 未保存の印と、⌘W で保存してから閉じる', dirtyMark === 1 && savedOnClose && !tabs.includes(model) && afterClose !== null && (await page.locator('#file-name').textContent()) === afterClose.slice(folder.length + 1), `印 ${dirtyMark} / 保存 ${savedOnClose} / 次 ${afterClose?.slice(folder.length + 1)}`)
writeFileSync(model, modelBefore)
await page.waitForTimeout(300)

// ⌃Tab・⇧⌘[・⇧⌘]・メニューで移る
await fileItem(model).click()
await fileItem(intro).click()
await waitStatus(['ok', 'warning', 'error'])
// 消えたファイル（smoke-other.tex）のタブは、移ろうとしたときに外れるので数に入れない
tabs = (await tabPaths()).filter(exists)
const start = await activeTab()
const at = (i) => tabs[(tabs.indexOf(start) + i + tabs.length) % tabs.length]
const moves = []
await page.locator('.cm-content').click()
for (const key of ['Control+Tab', 'Meta+Shift+BracketLeft', 'Meta+Shift+BracketLeft', 'Meta+Shift+BracketRight', 'Control+Shift+Tab']) {
  await page.keyboard.press(key)
  await page.waitForTimeout(400)
  moves.push(await activeTab())
}
await clickMenu('次のタブを表示')
await page.waitForTimeout(400)
moves.push(await activeTab())
const expected = [at(1), at(0), at(-1), at(0), at(-1), at(0)]
check('タブ: ⌃Tab・⇧⌘[ ⇧⌘]・メニューで移る', JSON.stringify(moves) === JSON.stringify(expected), moves.map((p) => p?.slice(folder.length + 1)).join(' → '))

// 中クリックで閉じる（今のタブはそのまま）
const victim = tabs.find((p) => p !== start && p !== filePath) ?? tabs.find((p) => p !== start)
await page.locator(`#tabs .tab[data-path="${victim}"]`).click({ button: 'middle' })
await page.waitForTimeout(300)
tabs = await tabPaths()
check('タブ: 中クリックで閉じる', !tabs.includes(victim) && (await activeTab()) === start, victim.slice(folder.length + 1))

// 履歴: 保存のたびに版が残り、差分を見て戻せる。同じ内容は残さない
await fileItem(filePath).click()
await waitStatus(['ok', 'warning', 'error'])
const historyDir = join(userData, 'history')
const versionsBefore = await page.evaluate((p) => window.sumi.listVersions(p), filePath)
const disk = readFileSync(filePath, 'utf8')
await page.evaluate(([p, t]) => window.sumi.writeFile(p, t).then(() => window.sumi.writeFile(p, t)), [filePath, disk])
const versionsSame = await page.evaluate((p) => window.sumi.listVersions(p), filePath)
check('履歴: 保存のたびに版が残り、同じ内容は残さない', versionsBefore.length >= 3 && versionsSame.length === versionsBefore.length && readdirSync(historyDir).length >= 1, `${versionsBefore.length} 版 → 同じ内容を 2 回保存して ${versionsSame.length} 版`)

// 印を書き足して保存し、履歴から 1 つ前の版（印のない版）に戻す
await page.locator('.cm-content').click()
await page.keyboard.press('Meta+ArrowDown')
await page.keyboard.type('\n% history-marker')
await clickMenu('保存してコンパイル')
await waitStatus(['ok', 'warning', 'error'])
await clickMenu('ファイルの履歴…')
const historyShown = await waitFor(() => !document.querySelector('#history').hidden && document.querySelectorAll('#history .history-item').length > 0, null, 5000)
const items = await page.locator('#history .history-item').count()
const firstDiff = await page.locator('#history .history-diff .diff-row.add, #history .history-diff .diff-row.del').count()
await page.screenshot({ path: join(shots, '10-history.png') })
const previous = page.locator('#history .history-item[aria-selected="true"]')
const oldestId = await previous.getAttribute('data-id')
await previous.click()
const oldText = await page.evaluate(([p, id]) => window.sumi.readVersion(p, id), [filePath, oldestId])
await page.locator('#history .history-restore').click()
await page.waitForTimeout(300)
const restoredText = await cmText()
const closedHistory = await page.locator('#history').isHidden()
await page.waitForFunction(() => document.querySelector('#status').dataset.state === 'building', null, { timeout: 8000 }).catch(() => {})
await waitStatus(['ok', 'warning', 'error'])
const fresh = process.argv[2] ? true : oldText === readFileSync(resolve('examples/sample/main.tex'), 'utf8')
check(
  '履歴: 版の一覧と差分を見て、この版に戻す',
  historyShown && items === versionsSame.length + 1 && firstDiff > 0 && restoredText === oldText && closedHistory && readFileSync(filePath, 'utf8') === oldText && fresh,
  `${items} 版 / 差分 ${firstDiff} 行 / 戻した版 ${oldestId} / 最初の内容 ${fresh}`
)

// タブの並びは設定に残り、開き直すと戻る
tabs = await tabPaths()
await page.waitForTimeout(300)
const storedTabs = JSON.parse(readFileSync(join(userData, 'settings.json'), 'utf8')).tabs ?? []
await page.reload()
await page.waitForSelector('#tabs .tab', { timeout: 10_000 }).catch(() => {})
await waitStatus(['ok', 'warning', 'error'])
const reopenedTabs = await tabPaths()
check(
  'タブ: 並びを設定に残し、開き直すと戻る',
  JSON.stringify(storedTabs) === JSON.stringify(tabs) && JSON.stringify(reopenedTabs) === JSON.stringify(tabs.filter(exists)) && (await activeTab()) === filePath,
  `${reopenedTabs.map((p) => p.slice(folder.length + 1)).join(', ')}`
)
await page.screenshot({ path: join(shots, '11-tabs.png') })

check('コンソールにエラーなし', errors.length === 0, errors.slice(0, 3).join(' | '))
await page.screenshot({ path: join(shots, '4-final.png') })
await app.close()
writeFileSync(join(shots, 'results.json'), JSON.stringify(results, null, 2))
process.exit(results.every((r) => r.ok) ? 0 : 1)
