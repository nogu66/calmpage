// 組み上がったアプリを起動し、主な流れを自動で確かめる。
// 使い方: npm run build && node scripts/smoke.mjs [LaTeX のフォルダ] [スクリーンショットの出力先]
// フォルダの中身は書き換わるので、渡すときは必ずコピーにすること。省くと examples/sample を一時フォルダに写して使う。
import { _electron as electron } from 'playwright-core'
import { appendFileSync, cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { existsSync, rmSync, statSync } from 'node:fs'

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

// 「+」から端末のエージェントのタブを開く
const openTab = async (name) => {
  await page.locator('#new-tab').click()
  await page.locator('#agent-menu .agent-item', { hasText: name }).click()
}
const tabNames = () => page.locator('#ai-tabs .ai-tab-main').allTextContents()
await openTab('Shell')
const termText = () => page.evaluate(() => document.querySelector('.ai-term:not([hidden]) .xterm-rows')?.innerText ?? '')
const prompt = await waitFor(() => /%/.test(document.querySelector('.ai-term:not([hidden]) .xterm-rows')?.innerText ?? ''), null)
await page.keyboard.type('echo sumi-$((40+2))')
await page.keyboard.press('Enter')
const echoed = await waitFor(() => /sumi-42/.test(document.querySelector('.ai-term:not([hidden]) .xterm-rows')?.innerText ?? ''), null)
await page.locator('#chip-file').click()
const inserted = await waitFor((name) => (document.querySelector('.ai-term:not([hidden]) .xterm-rows')?.innerText.replace(/\n/g, '') ?? '').split('sumi-42').pop().includes(name), `${base}.tex`, 5000)
check('端末のエージェントに切り替える', prompt && echoed && inserted && (await page.locator('#ai-threads').isHidden()), (await termText()).replace(/\n/g, ' ').slice(-80))


// タブを戻すと、ACP のスレッドは残っている
await page.locator('#ai-tabs .ai-tab-main', { hasText: /^Fake ACP$/ }).click()
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

// 同じエージェントをもう 1 本開く: 別のセッションになり、返事は自分のタブにだけ届く
await openTab('Fake ACP')
const freshReady = await waitFor((t) => !!document.querySelector(`${t} .thread-hint`), thread)
const freshEmpty = (await page.locator(`${thread} .msg-user`).count()) === 0
before = await send('hello from tab 2')
await waitFor(([t, n]) => document.querySelectorAll(`${t} .msg-agent`).length > n && /Received/.test([...document.querySelectorAll(`${t} .msg-agent`)].pop().textContent), [thread, before])
const secondTabReply = await lastAgentText()
await page.locator('#ai-tabs .ai-tab-main', { hasText: /^Fake ACP$/ }).click()
const firstTabCount = await page.locator(`${thread} .msg-agent`).count()
check(
  '同じ ACP のエージェントを 2 本開く',
  freshReady && freshEmpty && /^Received/.test(secondTabReply) && firstTabCount === 4,
  `${(await tabNames()).join(' | ')} / 1 本目の返事 ${firstTabCount} 件`
)

// 端末も 2 本目を開き、× で閉じると隣のタブへ移る
await openTab('Shell')
const shellTwo = await waitFor(() => /%/.test(document.querySelector('.ai-term:not([hidden]) .xterm-rows')?.innerText ?? ''), null)
const namesBefore = await tabNames()
await page.locator('#ai-tabs .ai-tab', { hasText: 'Shell 2' }).locator('.ai-tab-close').click()
const namesAfter = await tabNames()
const activeAfter = await page.locator('#ai-tabs .ai-tab.active .ai-tab-main').textContent()
check(
  '端末を 2 本開いて閉じる',
  shellTwo && namesBefore.join(',') === 'Fake ACP,Shell,Fake ACP 2,Shell 2' && namesAfter.join(',') === 'Fake ACP,Shell,Fake ACP 2' && activeAfter === 'Fake ACP 2',
  `${namesBefore.join(',')} → ${namesAfter.join(',')}（選択: ${activeAfter}）`
)
await page.locator('#ai-tabs .ai-tab', { hasText: 'Fake ACP 2' }).locator('.ai-tab-close').click()
await page.locator('#ai-tabs .ai-tab-main', { hasText: /^Fake ACP$/ }).click()

// 設定からエージェントを追加・削除する（手で書く欄は畳んであり、リンクで開く）
await page.locator('#open-settings').click()
await page.locator('#agent-custom-open').click()
await page.locator('#agent-form-name').fill('Extra')
await page.locator('#agent-form-command').fill('npx -y "some agent" --acp')
await page.locator('#agent-form button[type="submit"]').click()
await page.waitForTimeout(300)
const added = await page.evaluate(() => [...document.querySelectorAll('#agent-list .agent-row')].map((r) => r.textContent))
const menuNames = await page.locator('#agent-menu .agent-item').allTextContents()
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

// 登録簿から探す（ネットから一覧を読む。設定には最初から出ている）
const listed = await waitFor(() => document.querySelectorAll('#settings-picker .picker-row').length > 10, null, 20_000)
const total = await page.locator('#settings-picker .picker-row').count()
await page.locator('#settings-picker .picker-search').fill('gemini')
const filtered = await page.locator('#settings-picker .picker-row').allTextContents()
check('ACP の登録簿から探す', listed && filtered.length >= 1 && filtered.every((r) => /gemini/i.test(r)), `${total} 件 → 「gemini」で ${filtered.length} 件`)
await page.locator('#settings-picker .picker-search').fill('')

// 元に戻す: 最初の 3 つが戻り、自分で足したものは残る
await page.locator('#agent-restore').click()
await page.waitForTimeout(300)
const defaultsBack = await page.evaluate(() => [...document.querySelectorAll('#agent-list .agent-row-name')].map((n) => n.textContent))
check('Claude Code と Codex を元に戻す', defaultsBack.join(',') === 'Claude Code,Codex,Terminal,Fake ACP,Shell (zsh)', defaultsBack.join(', '))
await page.screenshot({ path: join(shots, '9-agents.png') })
await page.keyboard.press('Escape')

// 最初からある Terminal は、利用者のログインシェルを開く
await openTab('Terminal')
await page.waitForTimeout(1500)
await page.keyboard.type('echo login-$((1+1)) $0')
await page.keyboard.press('Enter')
const login = await waitFor(() => /login-2 -?\S*sh/.test(document.querySelector('.ai-term:not([hidden]) .xterm-rows')?.innerText ?? ''), null, 15_000)
check('Terminal でログインシェルが開く', login, (await termText()).replace(/\n/g, ' ').slice(-60))

check('エージェントの追加と削除', added.length === 3 && added.some((r) => r.includes('npx -y some agent --acp')) && menuNames.some((n) => n.startsWith('Extra')) && remaining === 2, `${added.join(' | ')} → 残り ${remaining}`)

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

// ---------- 班 3: PDF ----------
const pdfScrollTop = () => page.evaluate(() => document.querySelector('#pdf-scroll').scrollTop)
const savedSettings = () => JSON.parse(readFileSync(join(userData, 'settings.json'), 'utf8'))
const compiled = async () => {
  await page.waitForFunction(() => document.querySelector('#status').dataset.state === 'building', null, { timeout: 8000 }).catch(() => {})
  await waitStatus(['ok', 'warning', 'error'])
  await page.waitForTimeout(500)
}

// 組み直しても、差し替えた時点で、描いたページには文字とリンクの層もそろっている（ちらつかない）
await page.evaluate(() => {
  window.__swaps = []
  new MutationObserver((records) => {
    for (const r of records) {
      for (const n of r.addedNodes) {
        if (!n.classList?.contains('pages')) continue
        const drawn = [...n.querySelectorAll('.page')].filter((p) => p.querySelector(':scope > canvas'))
        window.__swaps.push({
          drawn: drawn.length,
          text: drawn.filter((p) => p.querySelector('.textLayer span')).length,
          links: drawn.filter((p) => p.querySelector('.annotationLayer')).length
        })
      }
    }
  }).observe(document.querySelector('#pdf-scroll'), { childList: true })
})
await clickMenu('コンパイル')
await compiled()
const swaps = await page.evaluate(() => window.__swaps)
check('PDF: 組み直しても層ごと差し替える', swaps.length > 0 && swaps.every((s) => s.drawn > 0 && s.text === s.drawn && s.links === s.drawn), JSON.stringify(swaps))

// 文字の層: なぞって選び、⌘C でコピーできる
await page.evaluate(() => (document.querySelector('#pdf-scroll').scrollTop = 0))
const pdfWord = await page.locator('.page[data-page="1"] .textLayer span').nth(20).boundingBox()
await page.mouse.move(pdfWord.x + 2, pdfWord.y + pdfWord.height / 2)
await page.mouse.down()
await page.mouse.move(pdfWord.x + 220, pdfWord.y + pdfWord.height / 2 + 30, { steps: 6 })
await page.mouse.up()
const pdfSelected = await page.evaluate(() => getSelection().toString())
await page.keyboard.press('Meta+c')
await page.waitForTimeout(200)
const pdfCopied = await app.evaluate(({ clipboard }) => clipboard.readText())
check('PDF: 文字を選んでコピー', pdfSelected.trim().length > 10 && pdfCopied === pdfSelected, JSON.stringify(pdfCopied.slice(0, 60)))
await page.evaluate(() => getSelection().removeAllRanges())

// リンク: 外のリンクは既定のブラウザへ（ここでは shell.openExternal を記録に差し替える）、文書の中のリンクはその場所へ
await app.evaluate(({ shell }) => {
  globalThis.__opened = []
  globalThis.__openExternal = shell.openExternal
  shell.openExternal = async (url) => void globalThis.__opened.push(url)
})
const pageUrl = page.url()
const externalLink = page.locator('.annotationLayer .linkAnnotation a[data-url]').first()
const externalUrl = await externalLink.getAttribute('data-url', { timeout: 3000 }).catch(() => null)
if (externalUrl) await externalLink.click()
await page.waitForTimeout(300)
const openedUrls = await app.evaluate(() => globalThis.__opened)
check('PDF: 外部のリンクをブラウザで開く', !!externalUrl && openedUrls.length === 1 && openedUrls[0] === externalUrl && page.url() === pageUrl, `${externalUrl} → ${JSON.stringify(openedUrls)}`)

const internalLinks = page.locator('.annotationLayer [data-internal-link] a')
const internalCount = await internalLinks.count()
let jumped = null
for (let i = internalCount - 1; i >= 0 && !jumped; i--) {
  await page.evaluate(() => (document.querySelector('#pdf-scroll').scrollTop = 1e6))
  await page.waitForTimeout(250)
  const from = await pdfScrollTop()
  await internalLinks.nth(i).click()
  await page.waitForTimeout(300)
  const to = await pdfScrollTop()
  if (Math.abs(to - from) > 20) jumped = { from, to }
}
check('PDF: 文書の中のリンクで移動', internalCount > 0 && !!jumped, `${internalCount} 個 ${JSON.stringify(jumped)}`)

// ⌘クリックはリンクより SyncTeX が先（行き先へは飛ばず、ソースへ移る）
await page.evaluate(() => (document.querySelector('#pdf-scroll').scrollTop = 0))
await page.waitForTimeout(250)
const beforeMeta = await pdfScrollTop()
await page.locator('.page[data-page="1"] .annotationLayer [data-internal-link] a').first().click({ modifiers: ['Meta'] })
await page.waitForTimeout(800)
const metaFile = await page.locator('#file-name').textContent()
check('PDF: ⌘クリックはリンクより SyncTeX', (await pdfScrollTop()) === beforeMeta && metaFile !== file, `${file} → ${metaFile}`)
await app.evaluate(({ shell }) => (shell.openExternal = globalThis.__openExternal))
await page.locator(`#file-list li[data-path="${filePath}"]`).click()
await compiled()

// 検索: プレビューに焦点があるときの ⌘F。⏎ で次、⇧⏎ で前、Esc で閉じる
await page.locator('#pdf-scroll').click({ position: { x: 6, y: 6 } })
await page.keyboard.press('Meta+f')
const findShown = await page.locator('#pdf-find').isVisible()
const cmSearch = await page.locator('.cm-search').count()
await page.keyboard.type('washi')
const counted = await waitFor(() => /^1 \/ \d+$/.test(document.querySelector('#pdf-find-count').textContent), null, 5000)
const findFirst = await page.locator('#pdf-find-count').textContent()
const findMarked = await page.evaluate(() => (CSS.highlights.get('pdf-find')?.size ?? 0) + (CSS.highlights.get('pdf-find-current')?.size ?? 0))
await page.keyboard.press('Enter')
await page.waitForTimeout(200)
const findSecond = await page.locator('#pdf-find-count').textContent()
await page.keyboard.press('Shift+Enter')
await page.waitForTimeout(200)
const findBack = await page.locator('#pdf-find-count').textContent()
await page.screenshot({ path: join(shots, '10-pdf-find.png') })
await page.keyboard.press('Escape')
const findClosed = (await page.locator('#pdf-find').isHidden()) && (await page.evaluate(() => CSS.highlights.get('pdf-find')?.size ?? 0)) === 0
const findTotal = Number(findFirst.split('/')[1])
check(
  'PDF: ⌘F で検索し、次と前へ',
  findShown && cmSearch === 0 && counted && findTotal >= 3 && findMarked >= findTotal && findSecond === `2 / ${findTotal}` && findBack === `1 / ${findTotal}` && findClosed,
  `${findFirst} → ${findSecond} → ${findBack}, 色 ${findMarked}`
)
await page.locator('.cm-content').click()
await clickMenu('PDF 内を検索')
await page.waitForTimeout(200)
const menuFind = (await page.locator('#pdf-find').isVisible()) && (await page.evaluate(() => document.activeElement?.id)) === 'pdf-find-input'
await page.keyboard.press('Escape')
check('PDF: メニューから検索を開く（⌥⇧⌘F）', menuFind)

// ページ: 12 ページの書類で、番号を入れて移り、← → でめくる。見えないページには層を作らない
const longDoc = join(folder, 'smoke-long.tex')
writeFileSync(longDoc, `\\documentclass{article}\n\\begin{document}\n${Array.from({ length: 12 }, (_, i) => `Page ${i + 1}.\\newpage`).join('\n')}\n\\end{document}\n`)
const longItem = page.locator(`#file-list li[data-path="${longDoc}"]`)
await longItem.waitFor({ timeout: 8000 })
await waitStatus(['ok', 'warning', 'error'])
await longItem.click()
await page.waitForFunction(() => document.querySelectorAll('#pdf-scroll .page').length === 12, null, { timeout: 60_000 })
await page.waitForTimeout(600)
const lazy = await page.evaluate(() => ({ text: document.querySelectorAll('.textLayer').length, drawn: document.querySelectorAll('.page > canvas').length }))
check('PDF: 見えないページには層を作らない', lazy.text > 0 && lazy.text < 12 && lazy.text === lazy.drawn, JSON.stringify(lazy))
const pageLabel = async () => `${await page.locator('#pdf-page').inputValue()} ${await page.locator('#pdf-total').textContent()}`
const firstLabel = await pageLabel()
await page.locator('#pdf-page').fill('7')
await page.locator('#pdf-page').press('Enter')
await page.waitForTimeout(300)
const typedLabel = await pageLabel()
await page.keyboard.press('ArrowRight')
await page.waitForTimeout(200)
const rightLabel = await pageLabel()
await page.keyboard.press('ArrowLeft')
await page.keyboard.press('ArrowLeft')
await page.waitForTimeout(200)
const leftLabel = await pageLabel()
check('PDF: ページ番号と移動', firstLabel === '1 / 12' && typedLabel === '7 / 12' && rightLabel === '8 / 12' && leftLabel === '6 / 12', [firstLabel, typedLabel, rightLabel, leftLabel].join(' → '))

// 表示: ページ全体・見開き。拡大率を出し、選んだものは設定に残る
const pdfLayout = () =>
  page.evaluate(() => {
    const scroller = document.querySelector('#pdf-scroll')
    const [a, b] = [...document.querySelectorAll('#pdf-scroll .page')].map((p) => p.getBoundingClientRect())
    return { zoom: document.querySelector('#pdf-zoom').textContent, room: scroller.clientHeight - 48, height: Math.round(a.height), sameRow: Math.round(a.top) === Math.round(b.top) && b.left > a.right }
  })
const widthView = await pdfLayout()
await page.locator('#pdf-views button[data-value="page"]').click()
await page.waitForTimeout(400)
const pageView = await pdfLayout()
await page.locator('#pdf-views button[data-value="spread"]').click()
await page.waitForTimeout(400)
const spreadView = await pdfLayout()
const savedView = savedSettings().pdfView
await page.screenshot({ path: join(shots, '11-pdf-spread.png') })
await page.locator('#pdf-views button[data-value="width"]').click()
await page.waitForTimeout(300)
check(
  'PDF: ページ全体と見開き、拡大率',
  /^\d+%$/.test(widthView.zoom) && pageView.height <= pageView.room && spreadView.zoom !== widthView.zoom && spreadView.sameRow && !widthView.sameRow && savedView === 'spread' && savedSettings().pdfView === 'width',
  JSON.stringify({ widthView, pageView, spreadView, savedView })
)

// ダークモードでの反転（既定は切）。暗いときだけ反転し、明るいときはそのまま
await page.locator('#open-settings').click()
const invertDefault = await page.locator('#settings-pdf-invert').isChecked()
await page.locator('#settings-pdf-invert').click()
await page.waitForTimeout(300)
await page.keyboard.press('Escape')
const canvasFilter = () => page.evaluate(() => getComputedStyle(document.querySelector('.page > canvas')).filter)
await page.emulateMedia({ colorScheme: 'dark' })
const darkFilter = await canvasFilter()
await page.screenshot({ path: join(shots, '12-pdf-dark.png') })
await page.emulateMedia({ colorScheme: 'light' })
const lightFilter = await canvasFilter()
await page.emulateMedia({ colorScheme: null })
const invertSaved = savedSettings().pdfInvert
await page.locator('#open-settings').click()
await page.locator('#settings-pdf-invert').click()
await page.waitForTimeout(300)
await page.keyboard.press('Escape')
check('PDF: ダークモードで反転', !invertDefault && /invert/.test(darkFilter) && lightFilter === 'none' && invertSaved === true && savedSettings().pdfInvert === false, `${darkFilter} / ${lightFilter}`)

await page.locator(`#file-list li[data-path="${filePath}"]`).click()
await compiled()
unlinkSync(longDoc)

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


// ---------- 班 2: コンパイル ----------
{
  const fileItem = (p) => page.locator(`#file-list li[data-path="${p}"]`)
  const statusText = () => page.locator('#status-text').textContent()
  const problemTexts = () => page.locator('#problem-list li').allTextContents()
  // 組み始めを待ってから終わりを待つ（始まりを見逃しても、終わった状態なら先へ進む）
  const built = async () => {
    await page.waitForFunction(() => document.querySelector('#status').dataset.state === 'building', null, { timeout: 8000 }).catch(() => {})
    return waitStatus(['ok', 'warning', 'error'])
  }
  const openAndBuild = async (p) => {
    await fileItem(p).waitFor({ timeout: 8000 })
    await waitStatus(['ok', 'warning', 'error', 'idle'])
    await fileItem(p).click()
    return built()
  }
  const engine = () => page.locator('#engine').textContent()
  const made = []
  const write = (name, text) => {
    const p = join(folder, name)
    writeFileSync(p, text)
    made.push(p)
    return p
  }

  // .bib: BibTeX の警告が「問題」に出て、未定義の引用はソースの行に結び付く。.bib を保存すると同じ本体を組み直す
  const bib = write('smoke-refs.bib', '@book{knuth,\n  author = {Donald Knuth},\n  title = {The TeXbook},\n  year = {1984}\n}\n')
  const bibDoc = write('smoke-bib.tex', '\\documentclass{article}\n\\begin{document}\nSee \\cite{knuth} and \\cite{smokemissing}.\n\\bibliographystyle{plain}\n\\bibliography{smoke-refs}\n\\end{document}\n')
  await openAndBuild(bibDoc)
  let texts = await problemTexts()
  check(
    'BibTeX の警告と未定義の引用',
    texts.some((t) => /\[BibTeX\] empty publisher in knuth/.test(t)) && texts.some((t) => t.startsWith('smoke-bib.tex:3') && /smokemissing/.test(t)) && !texts.some((t) => /database entry/.test(t)),
    texts.join(' | ')
  )
  await fileItem(bib).click()
  await page.waitForTimeout(400)
  const openedQuietly = (await status()) !== 'building'
  await page.locator('.cm-content').click()
  await page.keyboard.press('Meta+ArrowDown')
  await page.keyboard.type(' @misc{smokemissing, title = {Missing}, year = {2020}}')
  await built()
  texts = await problemTexts()
  const rootMark = await page.locator('#file-list li.root').getAttribute('data-path')
  check(
    '.bib を保存して組み直す',
    openedQuietly && rootMark === bibDoc && !texts.some((t) => /Citation .smokemissing/.test(t)) && /smokemissing/.test(readFileSync(bib, 'utf8')),
    `開いたとき組まない: ${openedQuietly} / 本体 ${rootMark} / ${(await statusText())} / ${texts.join(' | ')}`
  )

  // 中止: 終わらない書類を組み、ボタンと ⌘. で止める。latexmk の子（pdflatex）まで止まり、溜まった依頼も捨てる
  const slow = write('smoke-slow.tex', '\\documentclass{article}\n\\begin{document}\n\\def\\x{\\x}\\x\n\\end{document}\n')
  const running = () => spawnSync('pgrep', ['-f', 'smoke-slow']).stdout.toString().trim()
  await fileItem(slow).waitFor({ timeout: 8000 })
  await fileItem(slow).click()
  await page.waitForFunction(() => document.querySelector('#status').dataset.state === 'building', null, { timeout: 8000 }).catch(() => {})
  const stopShown = await page.locator('#build-stop').waitFor({ state: 'visible', timeout: 5000 }).then(() => true).catch(() => false)
  const beforeStop = running()
  await page.locator('#build-stop').click()
  const stoppedByButton = await page.waitForFunction(() => document.querySelector('#status-text').textContent === '中止しました', null, { timeout: 8000 }).then(() => true).catch(() => false)
  await page.waitForTimeout(500)
  const afterButton = running()
  await clickMenu('コンパイル')
  await page.waitForFunction(() => document.querySelector('#status').dataset.state === 'building', null, { timeout: 8000 }).catch(() => {})
  await page.waitForTimeout(800)
  await clickMenu('コンパイル') // 実行中の依頼は待ち行列に入る。中止したら一緒に捨てる
  await clickMenu('コンパイルを中止')
  const stoppedByMenu = await page.waitForFunction(() => document.querySelector('#status-text').textContent === '中止しました', null, { timeout: 8000 }).then(() => true).catch(() => false)
  await page.waitForTimeout(1500)
  const afterMenu = running()
  const stillStopped = (await status()) === 'idle' && !(await page.locator('#build-stop').isVisible())
  check(
    'コンパイルの中止',
    stopShown && beforeStop !== '' && stoppedByButton && afterButton === '' && stoppedByMenu && afterMenu === '' && stillStopped,
    JSON.stringify({ stopShown, beforeStop: beforeStop.split('\n').length, stoppedByButton, afterButton, stoppedByMenu, afterMenu, stillStopped })
  )

  // 中間ファイルを消す: 出力先の .aux などが消え、PDF と SyncTeX は残る
  await openAndBuild(filePath)
  // 雛形のテストも main.tex を組むので、同じ名前のキャッシュが複数ある。いま組んだもの（いちばん新しいもの）を見る
  const cache = readdirSync(join(userData, 'build'))
    .filter((d) => d.startsWith(`${base}-`))
    .map((d) => join(userData, 'build', d))
    .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)[0]
  const beforeClean = readdirSync(cache)
  await clickMenu('中間ファイルを消す')
  const cleaned = await page.waitForFunction(() => document.querySelector('#status-text').textContent === '中間ファイルを消しました', null, { timeout: 30_000 }).then(() => true).catch(() => false)
  const afterClean = readdirSync(cache)
  check(
    '中間ファイルを消す',
    cleaned && beforeClean.includes(`${base}.aux`) && !afterClean.some((f) => /\.(aux|log|fls|fdb_latexmk)$/.test(f)) && afterClean.includes(`${base}.pdf`) && afterClean.includes(`${base}.synctex.gz`),
    `${beforeClean.join(',')} → ${afterClean.join(',')}`
  )

  // % !TEX program と % !TEX TS-program
  const magic = write('smoke-magic.tex', '% !TEX program = xelatex\n\\documentclass{article}\n\\begin{document}\nMagic.\n\\end{document}\n')
  await openAndBuild(magic)
  const xe = await engine()
  writeFileSync(magic, '% !TEX TS-program = lualatex\n\\documentclass{article}\n\\begin{document}\nMagic.\n\\end{document}\n')
  await built()
  const lua = await engine()
  check('% !TEX program で処理系を選ぶ', xe === 'XeLaTeX' && lua === 'LuaLaTeX', `${xe} → ${lua}`)

  // 設定の既定の処理系: 替えるとすぐ組み直す
  const plain = write('smoke-plain.tex', '\\documentclass{article}\n\\begin{document}\nPlain.\n\\end{document}\n')
  await openAndBuild(plain)
  const auto = await engine()
  await page.locator('#open-settings').click()
  await page.locator('[data-setting="engine"] button[data-value="lualatex"]').click()
  await built()
  await page.screenshot({ path: join(shots, '11-compile-settings.png') })
  const chosen = await engine()
  await page.locator('[data-setting="engine"] button[data-value="auto"]').click()
  await built()
  const back = await engine()
  check('既定の処理系の設定', auto === 'pdfLaTeX' && chosen === 'LuaLaTeX' && back === 'pdfLaTeX', `${auto} → ${chosen} → ${back}`)

  // shell-escape: 既定は切。入れると \write18 が動く
  const ran = join(folder, 'smoke-shell-ran')
  made.push(ran)
  const shell = write('smoke-shell.tex', '\\documentclass{article}\n\\begin{document}\n\\immediate\\write18{touch smoke-shell-ran}Shell.\n\\end{document}\n')
  await page.keyboard.press('Escape')
  await openAndBuild(shell)
  const offRan = existsSync(ran)
  await page.locator('#open-settings').click()
  const hint = await page.locator('#settings-shell-escape').locator('xpath=..').locator('.setting-hint').textContent()
  await page.locator('#settings-shell-escape').click()
  await built()
  const onRan = existsSync(ran)
  await page.locator('#settings-shell-escape').click()
  await built()
  await page.keyboard.press('Escape')
  check('shell-escape の設定', !offRan && onRan && /信頼/.test(hint), `切: ${offRan} / 入: ${onRan} / ${hint}`)

  // 生のログ: 末尾から見せ、検索できる
  await page.locator('#problems').evaluate((el) => (el.hidden = false))
  await page.locator('#log-tab').click()
  await page.waitForFunction(() => /latexmk/.test(document.querySelector('#log-view').textContent), null, { timeout: 5000 }).catch(() => {})
  const log = await page.evaluate(() => {
    const v = document.querySelector('#log-view')
    return { text: v.textContent, atEnd: v.scrollTop + v.clientHeight >= v.scrollHeight - 4, visible: !v.hidden, list: !document.querySelector('#problem-list').hidden }
  })
  await page.locator('#log-search').fill('Latexmk:')
  await page.waitForTimeout(200)
  const found = { count: await page.locator('#log-count').textContent(), marks: await page.locator('#log-view mark').count(), current: await page.locator('#log-view mark.current').count() }
  await page.screenshot({ path: join(shots, '10-log.png') })
  await page.locator('#log-search').fill('')
  await page.locator('#problems-tab').click()
  const listBack = await page.locator('#problem-list').isVisible()
  await page.locator('#problems-close').click()
  check(
    'ログの表示と検索',
    log.visible && !log.list && log.atEnd && /──── smoke-shell\.log ────/.test(log.text) && /This is pdfTeX/.test(log.text) && /──── latexmk ────/.test(log.text) && /^\d+ \/ \d+$/.test(found.count) && found.marks > 0 && found.current === 1 && listBack,
    JSON.stringify({ ...found, atEnd: log.atEnd, length: log.text.length })
  )

  for (const p of made) rmSync(p, { force: true })
  await fileItem(filePath).click()
  await built()
}

// ---------- 班 1: エディター ----------
// 本体の \end{document} のあとに書く（組版には響かない）。この時点で画面は日本語
{
  writeFileSync(join(folder, 'smoke-refs.bib'), '@article{knuth1984,\n  title = {Literate {Programming}},\n  author = {Knuth, Donald E.},\n  year = {1984}\n}\n')
  writeFileSync(join(folder, 'smoke-figure.png'), '')
  const lines = () => page.evaluate(() => [...document.querySelectorAll('.cm-line')].map((l) => l.textContent))
  const tail = async (n) => (await lines()).slice(-n)
  const options = async () => {
    await page.waitForSelector('.cm-tooltip-autocomplete li', { timeout: 3000 }).catch(() => {})
    return page.locator('.cm-tooltip-autocomplete li').allTextContents()
  }
  // 候補は非同期に出るので、選びたいものが選ばれるまで待ってから Enter（出た直後の 75ms は Enter を受け付けない）
  const accept = async (prefix) => {
    await page
      .waitForFunction((p) => document.querySelector('.cm-tooltip-autocomplete li[aria-selected]')?.textContent.startsWith(p), prefix, { timeout: 3000 })
      .catch(() => {})
    await page.waitForTimeout(150)
    await page.keyboard.press('Enter')
  }
  const newLine = async () => {
    await page.keyboard.press('Escape')
    await page.keyboard.press('Meta+ArrowDown')
    await page.keyboard.press('Enter')
  }
  await page.locator(`#file-list li[data-path="${filePath}"]`).click()
  await page.locator('.cm-content').click()
  await page.keyboard.press('Meta+ArrowDown')

  // 命令の補完: 数式の中では \frac が先に出て、引数は Tab で移れる
  await page.keyboard.type('$\\fra')
  const commandOptions = await options()
  await accept('\\frac')
  await page.keyboard.type('a')
  await page.keyboard.press('Tab')
  await page.keyboard.type('b')
  await page.keyboard.press('End')
  await page.keyboard.type('$')
  const fracLine = (await tail(1))[0]
  check('補完: 命令とスニペット', commandOptions[0] === '\\frac' && fracLine === '$\\frac{a}{b}$', `${commandOptions.slice(0, 3).join(', ')} → ${fracLine}`)
  await page.waitForTimeout(200)
  const mathSpans = await page.locator('.cm-line', { hasText: '\\frac{a}{b}' }).locator('.cm-latex-math').count()
  check('数式の色分け', mathSpans > 0, `${mathSpans} 個`)

  // 環境: \begin{ のあとで名前を選ぶと \end まで入る。打ち終えて Enter でも閉じ、中は字下げされる
  await newLine()
  await page.keyboard.type('\\begin{ite')
  const envOptions = await options()
  await accept('itemize')
  await page.keyboard.type('first')
  const itemize = await tail(3)
  await newLine()
  await page.keyboard.type('\\begin{center}')
  await page.keyboard.press('Escape')
  await page.keyboard.press('Enter')
  await page.keyboard.type('inside')
  const center = await tail(3)
  check(
    '補完: 環境と \\end の自動挿入',
    envOptions[0] === 'itemize' && itemize.join('|') === '\\begin{itemize}|  \\item first|\\end{itemize}' && center.join('|') === '\\begin{center}|  inside|\\end{center}',
    `${itemize.join(' / ')} ; ${center.join(' / ')}`
  )

  // \ref: 開いていないファイルのラベルも出る。\cite: .bib の鍵を、2 つめの鍵でも
  await newLine()
  await page.keyboard.type('\\eqref{')
  const refOptions = await options()
  await page.keyboard.type('eq:wash')
  await accept('eq:washburn')
  await page.keyboard.press('End')
  await page.keyboard.type(' \\citep{other,')
  const citeOptions = await options()
  await page.keyboard.type('knu')
  await accept('knuth1984')
  const refLine = (await tail(1))[0]
  check(
    '補完: \\ref のラベルと \\cite の文献',
    refOptions.some((o) => o.startsWith('eq:washburn') && o.includes('model.tex:28')) && citeOptions.some((o) => o.startsWith('knuth1984') && o.includes('Knuth 1984')) && refLine === '\\eqref{eq:washburn} \\citep{other,knuth1984}',
    `${refOptions.length} 個 / ${citeOptions.join(', ')} / ${refLine}`
  )

  // パス: 画像とファイル
  await newLine()
  await page.keyboard.type('\\includegraphics{')
  const imageOptions = await options()
  await page.keyboard.press('Escape')
  await page.keyboard.press('End')
  await page.keyboard.type(' \\input{')
  const inputOptions = await options()
  check('補完: 画像とファイルのパス', imageOptions.includes('smoke-figure.png') && inputOptions.includes('sections/model') && !inputOptions.some((o) => o.endsWith('.tex')), `${imageOptions.join(', ')} / ${inputOptions.join(', ')}`)

  // 文書の中で定義した命令
  await newLine()
  await page.keyboard.type('\\newcommand{\\smokecmd}[1]{#1}')
  await newLine()
  await page.keyboard.type('\\smokec')
  const defOptions = await options()
  check('補完: \\newcommand で定義した命令', defOptions.some((o) => o.startsWith('\\smokecmd')), defOptions.join(', '))

  // スペルチェック: 本文の誤りだけに下線。ラベル・数式・コメントは調べない
  await newLine()
  await page.keyboard.type('This has a recieve error \\label{fig:definately} $definately$ % definately\n')
  await page.waitForTimeout(400)
  const spellLine = page.locator('.cm-line', { hasText: 'This has a recieve' })
  const marked = await spellLine.locator('.cm-misspelled').allTextContents()
  check('スペルチェック: 本文だけを調べる', marked.join(',') === 'recieve', marked.join(', '))
  await page.keyboard.type('recieve')
  await page.keyboard.press('Control+Space')
  const spellOptions = await options()
  await page.keyboard.press('Escape')
  // 右クリックのメニュー: macOS のメニューは操作できないので、最初の候補を選んだことにする
  await app.evaluate(({ Menu }) => {
    Menu.prototype.__popup = Menu.prototype.popup
    Menu.prototype.popup = function (opts) {
      this.items[0].click()
      opts?.callback?.()
    }
  })
  await spellLine.locator('.cm-misspelled').first().click({ button: 'right' })
  await page.waitForTimeout(300)
  await app.evaluate(({ Menu }) => (Menu.prototype.popup = Menu.prototype.__popup))
  const fixed = await page.locator('.cm-line', { hasText: 'This has a' }).first().textContent()
  check('スペルチェック: 候補（補完と右クリック）', spellOptions.includes('receive') && fixed.startsWith('This has a receive error'), `${spellOptions.join(', ')} / ${fixed}`)

  // 太字（メニュー）と斜体（⌘I）。選択があれば囲み、なければ {} の中へ
  await newLine()
  await page.keyboard.type('make bold')
  await page.keyboard.press('Alt+Shift+ArrowLeft')
  await clickMenu('太字')
  await page.keyboard.press('End')
  await page.keyboard.press('Meta+i')
  await page.keyboard.type('x')
  await page.keyboard.press('Meta+Shift+b')
  await page.keyboard.type('y')
  const formatLine = (await tail(1))[0]
  check('太字・斜体', formatLine === 'make \\textbf{bold}\\textit{x\\textbf{y}}', formatLine)

  // ⌘/ でコメントの付け外し。編集メニューの取り消す・やり直す
  await page.keyboard.press('Meta+/')
  const commented = (await tail(1))[0]
  await clickMenu('取り消す')
  await page.waitForTimeout(100)
  const undone = (await tail(1))[0]
  await clickMenu('やり直す')
  await page.waitForTimeout(100)
  const redone = (await tail(1))[0]
  check('コメントの付け外しと取り消し', commented.startsWith('% make') && undone.startsWith('make') && redone.startsWith('% make'), `${commented} → ${undone} → ${redone}`)

  // 編集メニュー: 検索・置換・行へ移動は CodeMirror の画面を開く
  await clickMenu('検索…')
  const searchOpen = await page.locator('.cm-search').isVisible()
  await page.keyboard.press('Escape')
  await clickMenu('置換…')
  const replaceFocused = await page.evaluate(() => document.activeElement?.getAttribute('name'))
  await page.keyboard.press('Escape')
  await clickMenu('行へ移動…')
  const gotoOpen = await page.locator('.cm-goto-line').isVisible()
  await page.keyboard.press('Escape')
  check('編集メニュー: 検索・置換・行へ移動', searchOpen && replaceFocused === 'replace' && gotoOpen, JSON.stringify({ searchOpen, replaceFocused, gotoOpen }))

  // 文字数: 選択中は選択範囲（命令は数えない）、押すと書類全体
  await page.locator('.cm-content').click()
  await page.keyboard.press('Meta+ArrowDown')
  await page.keyboard.press('Meta+/')
  await page.keyboard.press('End')
  const fileCount = await page.locator('#word-count').textContent()
  await page.keyboard.press('Shift+Home')
  await page.waitForTimeout(100)
  const selectionCount = await page.locator('#word-count').textContent()
  await page.keyboard.press('End')
  await page.waitForTimeout(100)
  await page.locator('#word-count').click()
  const documentCount = await page.locator('#word-count').textContent()
  await page.locator('#word-count').click()
  check('文字数', /^[\d,]+ 語 · [\d,]+ 文字$/.test(fileCount) && /^選択: 4 語 · 10 文字$/.test(selectionCount) && /^書類全体: [\d,]+ 語/.test(documentCount), `${fileCount} / ${selectionCount} / ${documentCount}`)

  // スペルチェックを切ると下線が消える
  await page.locator('#open-settings').click()
  await page.locator('#settings-spellcheck').click()
  await page.waitForTimeout(200)
  const offCount = await page.locator('.cm-misspelled').count()
  await page.locator('#settings-spellcheck').click()
  await page.waitForTimeout(200)
  const onCount = await page.locator('.cm-misspelled').count()
  await page.keyboard.press('Escape')
  check('スペルチェックの設定', offCount === 0 && onCount > 0, `切 ${offCount} / 入 ${onCount}`)

  // 折りたたみ: \begin{abstract} を畳む
  await page.locator('.cm-content').click()
  await page.keyboard.press('Meta+ArrowUp')
  // 下の方から先頭へ飛ぶと、CodeMirror が描き直すまで位置がずれる。印の位置が 2 回続けて同じになるまで待つ
  let marker = null
  for (let tries = 0, last = ''; tries < 20; tries++) {
    await page.waitForTimeout(100)
    marker = await page.evaluate(() => {
      const line = [...document.querySelectorAll('.cm-line')].find((l) => l.textContent.includes('\\begin{abstract}'))
      const top = line?.getBoundingClientRect().top ?? -1
      const el = [...document.querySelectorAll('.cm-foldGutter .cm-gutterElement')].find((g) => Math.abs(g.getBoundingClientRect().top - top) < 4 && g.querySelector('span[title]'))
      const r = el?.querySelector('span').getBoundingClientRect()
      if (!r) return null
      const x = r.x + r.width / 2
      const y = r.y + r.height / 2
      return { x, y, hit: document.elementFromPoint(x, y)?.closest('.cm-foldGutter') ? 'fold' : document.elementFromPoint(x, y)?.outerHTML.slice(0, 80) }
    })
    const key = JSON.stringify(marker)
    if (marker && key === last) break
    last = key
  }
  if (marker) await page.mouse.click(marker.x, marker.y)
  await page.waitForTimeout(200)
  const folded = await page.locator('.cm-foldPlaceholder').count()
  const hiddenText = !(await page.evaluate(() => document.querySelector('.cm-content').innerText.includes('A drop of sumi ink')))
  if (folded) await page.locator('.cm-foldPlaceholder').first().click()
  check('環境の折りたたみ', !!marker && folded === 1 && hiddenText, JSON.stringify({ marker, folded, hiddenText }))

  // アウトライン: \input をたどった見出し。押すとそのファイルのその行へ
  const headings = await page.locator('#outline-list li').allTextContents()
  await page.locator('#outline-list li', { hasText: 'Results' }).click()
  await page.waitForTimeout(300)
  const jumped = await page.locator('#file-name').textContent()
  const activeHeading = await page.locator('#outline-list li.active').textContent().catch(() => '')
  await page.locator('#outline-toggle').click()
  const collapsed = await page.locator('#outline-list').isHidden()
  await page.locator('#outline-toggle').click()
  check(
    'アウトライン',
    headings.join(',') === 'Introduction,A simple model,Results' && jumped === 'sections/results.tex' && activeHeading === 'Results' && collapsed && (await page.locator('#outline-list').isVisible()),
    `${headings.join(', ')} → ${jumped} (${activeHeading})`
  )
  await page.screenshot({ path: join(shots, '10-editor.png') })
}

// ---------- 複数ウィンドウ ----------
{
  const { basename } = await import('node:path')
  const folder2 = join(mkdtempSync(join(tmpdir(), 'calmpage-second-')), 'sample')
  cpSync(resolve('examples/sample'), folder2, { recursive: true })
  const windowCount = () => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)
  const frontId = () => app.evaluate(() => globalThis.__calmpageFront())
  const idOf = async (p) => (await app.browserWindow(p)).evaluate((w) => w.id)
  // メニューの項目をキーで探して、その窓から押したことにする（言語によらないように）
  const pressMenu = (accelerator, id) =>
    app.evaluate(({ Menu, BrowserWindow }, [accelerator, id]) => {
      const find = (items) => {
        for (const item of items) {
          if (item.accelerator === accelerator) return item
          const sub = item.submenu && find(item.submenu.items)
          if (sub) return sub
        }
      }
      find(Menu.getApplicationMenu().items)?.click(undefined, BrowserWindow.fromId(id))
    }, [accelerator, id])
  const openFromFinder = (path) => app.evaluate(({ app }, path) => app.emit('open-file', { preventDefault() {} }, path), path)
  const stateOf = (p) => p.evaluate(() => document.querySelector('#status').dataset.state)
  const settled = async (p) => {
    await p.waitForFunction(() => document.querySelector('#status').dataset.state === 'building', null, { timeout: 8000 }).catch(() => {})
    await p.waitForFunction(() => ['ok', 'warning', 'error'].includes(document.querySelector('#status').dataset.state), null, { timeout: 90_000 })
    return stateOf(p)
  }
  // 組版の始まりを記録しておき、ほかの窓の組版が混ざっていないかを確かめる
  const watchStates = (p) =>
    p.evaluate(() => {
      window.__states = []
      new MutationObserver(() => window.__states.push(document.querySelector('#status').dataset.state)).observe(document.querySelector('#status'), { attributes: true, attributeFilter: ['data-state'] })
    })
  const statesOf = (p) => p.evaluate(() => window.__states)

  const id1 = await idOf(page)
  await settled(page)

  // 1. 新しいウインドウは空で開き、Finder から開いたフォルダはその空の窓に入る
  const opened = app.waitForEvent('window')
  await pressMenu('Cmd+Ctrl+N', id1)
  const page2 = await opened
  page2.on('console', (m) => m.type() === 'error' && errors.push(`[2] ${m.text()}`))
  page2.on('pageerror', (e) => errors.push(`[2] ${e}`))
  // 空の窓ではステータスが隠れるので、見えるかではなく、ページにあるかを待つ
  await page2.waitForSelector('#status', { state: 'attached', timeout: 10_000 })
  await page2.waitForFunction(() => document.body.classList.contains('empty'), null, { timeout: 10_000 }).catch(() => {})
  const id2 = await idOf(page2)
  const emptyAtFirst = await page2.evaluate(() => document.body.classList.contains('empty'))
  const countAfterNew = await windowCount()
  const frontAfterNew = await frontId()
  await openFromFinder(folder2)
  await page2.waitForFunction((f) => document.querySelector('#ai-folder').title === f, folder2, { timeout: 10_000 }).catch(() => {})
  const state2 = await settled(page2)
  await page2.waitForSelector('.page canvas', { timeout: 30_000 }).catch(() => {})
  const title2 = await (await app.browserWindow(page2)).evaluate((w) => [w.getTitle(), w.getRepresentedFilename()])
  check(
    '複数ウィンドウ: 新しいウインドウを開き、別のフォルダで組版する',
    emptyAtFirst && countAfterNew === 2 && frontAfterNew === id2 && (await windowCount()) === 2 && state2 !== 'error' && (await page2.locator('.page canvas').count()) > 0 && title2[0] === 'sample' && title2[1] === folder2,
    JSON.stringify({ emptyAtFirst, countAfterNew, frontAfterNew, id2, state2, title2 })
  )

  // 2. 片方の外部の変更と組版は、もう片方に混ざらない
  await watchStates(page)
  appendFileSync(join(folder2, 'main.tex'), '\n% external edit in the second window\n')
  const external2 = await settled(page2)
  await page.waitForTimeout(800)
  const leakedTo1 = await statesOf(page)
  await watchStates(page2)
  await pressMenu('CmdOrCtrl+R', id1)
  const build1 = await settled(page)
  await page2.waitForTimeout(800)
  const leakedTo2 = await statesOf(page2)
  const folder1Shown = await page.locator('#ai-folder').getAttribute('title')
  check(
    '複数ウィンドウ: 外部の変更と組版が、ほかの窓に混ざらない',
    external2 !== 'error' && build1 !== 'error' && leakedTo1.length === 0 && leakedTo2.length === 0 && folder1Shown === folder,
    JSON.stringify({ external2, build1, leakedTo1, leakedTo2 })
  )

  // 3. 端末は窓ごとに、その窓のフォルダで動く。出力はその窓にだけ届く
  await page.evaluate(() => {
    window.__termData = ''
    window.sumi.onTermData((tab, data) => tab === 'smoke-mw' && (window.__termData += data))
  })
  await page2.evaluate(() => {
    window.__termData = ''
    window.sumi.onTermData((tab, data) => tab === 'smoke-mw' && (window.__termData += data))
  })
  const termError = await page2.evaluate(() => window.sumi.termStart('smoke-mw', 'shell', 120, 24))
  await page2.evaluate(() => window.sumi.termInput('smoke-mw', 'pwd\n'))
  const marker = basename(join(folder2, '..'))
  const termOk = await page2.waitForFunction((m) => window.__termData.includes(m), marker, { timeout: 8000 }).then(() => true).catch(() => false)
  const termLeak = await page.evaluate(() => window.__termData)
  await page2.evaluate(() => window.sumi.termClose('smoke-mw'))
  check('複数ウィンドウ: 端末はその窓のフォルダで動く', termError === null && termOk && termLeak === '', JSON.stringify({ termError, termOk, termLeak: termLeak.slice(0, 80) }))

  // 4. 全体の設定は、すべての窓へ届く
  const palette = await page.evaluate(() => document.documentElement.dataset.palette)
  const other = palette === 'moss' ? 'sand' : 'moss'
  await page.evaluate((p) => window.sumi.updateSettings({ palette: p }), other)
  const paletteShared = await page2.waitForFunction((p) => document.documentElement.dataset.palette === p, other, { timeout: 5000 }).then(() => true).catch(() => false)
  await page.evaluate((p) => window.sumi.updateSettings({ palette: p }), palette)
  await page2.waitForFunction((p) => document.documentElement.dataset.palette === p, palette, { timeout: 5000 }).catch(() => {})
  check('複数ウィンドウ: 配色の変更がすべての窓に届く', paletteShared)

  // 5. 同じフォルダを開こうとすると、もう開いている窓が前に出る（Finder からでも ⌘O でも）
  const frontBefore = await frontId()
  await openFromFinder(folder)
  await page.waitForTimeout(500)
  const frontFinder = await frontId()
  const countFinder = await windowCount()
  await app.evaluate(({ dialog }, dir) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [dir] })
  }, folder2)
  await pressMenu('CmdOrCtrl+O', id1)
  await page.waitForTimeout(800)
  const frontOpen = await frontId()
  const stillFolder1 = await page.locator('#ai-folder').getAttribute('title')
  check(
    '複数ウィンドウ: 同じフォルダを開くと、開いている窓が前に出る',
    frontBefore === id2 && frontFinder === id1 && countFinder === 2 && frontOpen === id2 && stillFolder1 === folder && (await windowCount()) === 2,
    JSON.stringify({ frontBefore, frontFinder, countFinder, frontOpen, stillFolder1 })
  )

  // 6. 復元: 開いている窓が、それぞれのフォルダ・ファイル・タブと位置ごと設定に残る
  await page2.waitForTimeout(800)
  const stored = JSON.parse(readFileSync(join(userData, 'settings.json'), 'utf8'))
  const restored = stored.windows ?? []
  check(
    '複数ウィンドウ: 開いている窓を復元の設定に書く',
    restored.length === 2 &&
      restored[0].folder === folder &&
      restored[1].folder === folder2 &&
      restored[1].file?.startsWith(folder2) &&
      Array.isArray(restored[1].tabs) &&
      restored.every((w) => w.bounds?.width > 0) &&
      stored.folder === folder,
    JSON.stringify(restored.map((w) => ({ folder: w.folder.slice(-24), file: w.file?.slice(-12), tabs: w.tabs?.length, bounds: !!w.bounds })))
  )

  // 7. ⌘Q は窓を 1 つずつ確かめ、どれかでキャンセルしたら終わらない。窓を閉じるときは、その窓のことだけを聞く
  const answers = (list) =>
    app.evaluate(({ dialog }, list) => {
      globalThis.__mwAsked = []
      dialog.showMessageBox = async (win, options) => {
        globalThis.__mwAsked.push([win?.id, options.message])
        return { response: list.shift() ?? 2 }
      }
    }, list)
  const asked = () => app.evaluate(() => globalThis.__mwAsked)
  await page.evaluate(() => window.sumi.updateSettings({ auto: false }))
  await page2.waitForFunction(() => !document.querySelector('#auto').checked)
  await page2.locator('.cm-content').click()
  await page2.keyboard.press('Meta+ArrowDown')
  await page2.keyboard.type('\n% unsaved in the second window')
  await page2.waitForTimeout(300)
  await answers([2])
  await app.evaluate(({ app }) => app.quit())
  await page.waitForTimeout(1000)
  const askedQuit = await asked()
  const aliveQuit = await windowCount()
  await answers([1])
  await (await app.browserWindow(page2)).evaluate((w) => w.close())
  for (let i = 0; i < 40 && (await windowCount()) > 1; i++) await page.waitForTimeout(100)
  const askedClose = await asked()
  await page.evaluate(() => window.sumi.updateSettings({ auto: true }))
  check(
    '複数ウィンドウ: ⌘Q は窓ごとに聞き、キャンセルで留まる。閉じるときはその窓だけ',
    askedQuit.length === 1 && askedQuit[0][0] === id2 && aliveQuit === 2 && askedClose.length === 1 && askedClose[0][0] === id2 && !readFileSync(join(folder2, 'main.tex'), 'utf8').includes('unsaved in the second window'),
    JSON.stringify({ askedQuit, aliveQuit, askedClose })
  )

  // 8. 片方を閉じても（7 で閉じた）、もう片方はそのまま動く。閉じた窓は復元の一覧から外れる
  for (let i = 0; i < 40 && (await windowCount()) > 1; i++) await page.waitForTimeout(100)
  const countAfterClose = await windowCount()
  appendFileSync(join(folder2, 'main.tex'), '\n% edit after the second window closed\n')
  await pressMenu('CmdOrCtrl+R', id1)
  const afterClose = await settled(page)
  await page.waitForTimeout(500)
  const left = JSON.parse(readFileSync(join(userData, 'settings.json'), 'utf8')).windows ?? []
  check(
    '複数ウィンドウ: 片方を閉じても、もう片方は動く',
    countAfterClose === 1 && afterClose !== 'error' && (await frontId()) === id1 && left.length === 1 && left[0].folder === folder,
    JSON.stringify({ countAfterClose, afterClose, left: left.length })
  )

  // 9. 起動時の復元: 覚えていた窓を、フォルダ・ファイル・位置ごと開き直す。前の版の folder / file / tabs も 1 つめの窓として読む
  const launchWith = async (settings) => {
    const data = mkdtempSync(join(tmpdir(), 'calmpage-restore-'))
    const agents = JSON.parse(readFileSync(join(userData, 'settings.json'), 'utf8')).agents
    writeFileSync(join(data, 'settings.json'), JSON.stringify({ agents, ...settings }))
    const other = await electron.launch({ args: ['.'], env: { ...process.env, CALMPAGE_OPEN: '', CALMPAGE_USER_DATA: data } })
    return { other, data }
  }
  const shownFolders = async (other, n) => {
    for (let i = 0; i < 100 && other.windows().length < n; i++) await new Promise((r) => setTimeout(r, 100))
    const pages = other.windows()
    for (const p of pages) await p.waitForFunction(() => document.querySelector('#ai-folder')?.title && document.querySelector('#file-name')?.textContent, null, { timeout: 15_000 }).catch(() => {})
    return Promise.all(pages.map(async (p) => [await p.locator('#ai-folder').getAttribute('title'), await p.locator('#file-name').textContent()]))
  }
  const bounds = { x: 120, y: 90, width: 1200, height: 800 }
  {
    const { other } = await launchWith({
      windows: [
        { folder, file: join(folder, 'sections', 'results.tex'), tabs: [join(folder, 'main.tex'), join(folder, 'sections', 'results.tex')] },
        { folder: folder2, file: join(folder2, 'main.tex'), tabs: [join(folder2, 'main.tex')], bounds }
      ]
    })
    const shown = await shownFolders(other, 2)
    const restoredBounds = await other.evaluate(({ BrowserWindow }, folder2) => BrowserWindow.getAllWindows().find((w) => w.getRepresentedFilename() === folder2)?.getBounds(), folder2)
    await other.close()
    check(
      '複数ウィンドウ: 起動時に窓を復元する',
      shown.length === 2 && shown.some(([f, name]) => f === folder && name === 'sections/results.tex') && shown.some(([f, name]) => f === folder2 && name === 'main.tex') && JSON.stringify(restoredBounds) === JSON.stringify(bounds),
      JSON.stringify({ shown: shown.map(([f, n]) => [f.slice(-24), n]), restoredBounds })
    )
  }
  {
    const { other, data } = await launchWith({ folder: folder2, file: join(folder2, 'main.tex'), tabs: [join(folder2, 'main.tex')] })
    const shown = await shownFolders(other, 1)
    await other.close()
    const after = JSON.parse(readFileSync(join(data, 'settings.json'), 'utf8'))
    check(
      '複数ウィンドウ: 前の版の設定を 1 つめの窓として引き継ぐ',
      shown.length === 1 && shown[0][0] === folder2 && after.windows?.length === 1 && after.windows[0].folder === folder2,
      JSON.stringify({ shown: shown.map(([f, n]) => [f.slice(-24), n]), windows: after.windows?.length })
    )
  }
}

// ---------- ACP の選択 ----------
{
  const { createHash } = await import('node:crypto')
  const fake = resolve('scripts/fake-acp-agent.mjs')
  // 入れる配布物の偽物: bin/smoke-agent（実行の印はわざと付けない）が、テスト用の ACP エージェントを起動する
  const pack = mkdtempSync(join(tmpdir(), 'calmpage-pack-'))
  mkdirSync(join(pack, 'bin'))
  writeFileSync(join(pack, 'bin', 'smoke-agent'), `#!/bin/sh\nexec '${process.execPath}' '${fake}'\n`, { mode: 0o644 })
  const archivePath = join(pack, 'smoke-agent.tar.gz')
  spawnSync('tar', ['-czf', archivePath, '-C', pack, 'bin'])
  const archive = readFileSync(archivePath)
  const sha256 = createHash('sha256').update(archive).digest('hex')
  const both = (target) => ({ 'darwin-aarch64': target, 'darwin-x86_64': target })
  const base = 'https://smoke.invalid/'
  const registry = {
    version: '1.0.0',
    agents: [
      { id: 'smoke-linux', name: 'Smoke Linux Only', version: '1.0.0', description: 'Only for Linux', distribution: { binary: { 'linux-x86_64': { archive: `${base}x.tar.gz`, cmd: './x' } } } },
      { id: 'smoke-install', name: 'Smoke Install', version: '1.0.0', description: 'Downloaded and unpacked by Calmpage', icon: `${base}huge.svg`, distribution: { binary: both({ archive: `${base}smoke-agent.tar.gz`, cmd: './bin/smoke-agent', sha256 }) } },
      { id: 'smoke-badsum', name: 'Smoke Bad Checksum', version: '1.0.0', description: 'The checksum does not match', distribution: { binary: both({ archive: `${base}smoke-agent.tar.gz`, cmd: './bin/smoke-agent', sha256: '0'.repeat(64) }) } },
      { id: 'smoke-ready', name: 'Smoke Ready', version: '1.0.0', description: 'Already on the PATH', distribution: { binary: both({ cmd: './sh', args: ['-c', `exec '${process.execPath}' '${fake}'`] }) } },
      { id: 'claude-acp', name: 'Claude Agent', version: '9.9.9', description: 'ACP wrapper for Anthropic’s Claude', icon: `${base}claude.svg`, distribution: { npx: { package: '@agentclientprotocol/claude-agent-acp@9.9.9' } } }
    ]
  }
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><circle cx="8" cy="8" r="7" fill="currentColor"/></svg>'
  // main の fetch を差し替える。offline の間は、つながらないときと同じく投げる
  await app.evaluate((_electron, [registry, svg, archive]) => {
    globalThis.__realFetch ??= globalThis.fetch
    globalThis.__fetchOffline = true
    globalThis.fetch = async (url) => {
      const u = String(url)
      if (globalThis.__fetchOffline) throw new TypeError('fetch failed')
      if (u.endsWith('/registry.json')) return new Response(JSON.stringify(registry), { headers: { 'content-type': 'application/json' } })
      if (u.endsWith('/claude.svg')) return new Response(svg, { headers: { 'content-type': 'image/svg+xml' } })
      if (u.endsWith('/huge.svg')) return new Response(`<svg xmlns="http://www.w3.org/2000/svg">${' '.repeat(100_000)}</svg>`)
      if (u.endsWith('/smoke-agent.tar.gz')) return new Response(Buffer.from(archive, 'base64'))
      return new Response('', { status: 404 })
    }
    globalThis.__calmpageResetRegistry()
  }, [registry, svg, archive.toString('base64')])
  const agentsRoot = join(userData, 'agents')
  // 前の版が残っていたら、新しい版を入れたときに片付く
  mkdirSync(join(agentsRoot, 'smoke-install', '0.9.0'), { recursive: true })
  const savedAgents = () => JSON.parse(readFileSync(join(userData, 'settings.json'), 'utf8')).agents
  const pickerRows = () => page.evaluate(() => [...document.querySelectorAll('#agent-picker .picker-row')].map((r) => ({
    id: r.dataset.id,
    state: r.dataset.state,
    action: r.querySelector('.picker-action')?.textContent ?? r.querySelector('.picker-reason')?.textContent ?? '',
    icon: !!r.querySelector('.picker-icon').style.getPropertyValue('--icon'),
    letter: r.querySelector('.picker-icon.letter')?.textContent ?? ''
  })))
  const openPicker = async () => {
    await page.locator('#new-tab').click()
    await page.locator('#agent-menu .agent-add').click()
    await page.locator('#agent-picker .picker-search').waitFor({ state: 'visible' })
  }
  if (!(await page.locator('#ai-col').isVisible())) await page.locator('#toggle-ai').click()

  // 1. 読めないとき（オフライン）は知らせ、「もう一度」で読み直す
  await openPicker()
  const offline = await waitFor(() => !document.querySelector('#agent-picker .picker-retry').hidden, null, 10_000)
  const offlineText = await page.locator('#agent-picker .picker-status').textContent()
  await app.evaluate(() => (globalThis.__fetchOffline = false))
  await page.locator('#agent-picker .picker-retry').click()
  const loaded = await waitFor(() => document.querySelectorAll('#agent-picker .picker-row').length === 5, null, 10_000)
  check('ACP の選択: 読めないときは知らせて、もう一度読める', offline && /オフライン/.test(offlineText) && loaded, offlineText)

  // 2. 「+」の「エージェントを追加…」で一覧が出る。並びは使える → 入れられる → 使えない、アイコンは data: URL か頭文字
  await waitFor(() => !!document.querySelector('#agent-picker .picker-row[data-id="claude-acp"] .picker-icon:not(.letter)'), null, 10_000)
  const rows = await pickerRows()
  const byId = Object.fromEntries(rows.map((r) => [r.id, r]))
  check(
    'ACP の選択: 「+」から一覧が出る',
    rows.map((r) => r.id).join(',') === 'claude-acp,smoke-ready,smoke-badsum,smoke-install,smoke-linux' &&
      byId['smoke-ready'].action === '追加' && byId['smoke-install'].action === '入れる' && byId['smoke-linux'].state === 'unavailable' && /この Mac/.test(byId['smoke-linux'].action) &&
      byId['claude-acp'].icon && byId['smoke-install'].letter === 'S',
    rows.map((r) => `${r.id}:${r.state}:${r.action}${r.icon ? ':icon' : ''}`).join(' ')
  )

  // 3. 既定の Claude Code（id は claude）は、登録簿の claude-acp と同じパッケージなので追加済み
  check('ACP の選択: 既定の Claude Code が追加済みと出る', byId['claude-acp'].state === 'added' && byId['claude-acp'].action === '開く', JSON.stringify(byId['claude-acp']))

  // 4. 検索で絞り、↑↓ で選ぶ。Esc で閉じる
  await page.keyboard.type('smoke')
  const narrowed = (await pickerRows()).map((r) => r.id)
  const firstActive = await page.locator('#agent-picker .picker-search').getAttribute('aria-activedescendant')
  await page.keyboard.press('ArrowDown')
  const secondActive = await page.locator('#agent-picker .picker-search').getAttribute('aria-activedescendant')
  await page.keyboard.press('ArrowUp')
  await page.keyboard.type(' bad')
  const single = (await pickerRows()).map((r) => r.id)
  await page.keyboard.press('Escape')
  const closed = await page.locator('#agent-picker').isHidden()
  check(
    'ACP の選択: 検索で絞れて、↑↓ と Esc で操作できる',
    narrowed.length === 4 && !narrowed.includes('claude-acp') && firstActive === 'picker-pillar-smoke-ready' && secondActive === 'picker-pillar-smoke-badsum' && single.join() === 'smoke-badsum' && closed,
    `${narrowed.join(',')} / ${firstActive} → ${secondActive} / ${single.join(',')}`
  )

  // 5. ⏎ で足して、そのまま新しいタブで開く（設定画面を通らない）
  await openPicker()
  await page.keyboard.type('ready')
  await page.keyboard.press('Enter')
  const readyOpened = await waitFor(() => document.querySelector('#agent-picker').hidden && document.querySelector('#ai-tabs .ai-tab.active')?.textContent.includes('Smoke Ready'), null, 10_000)
  const readyThread = await waitFor((t) => !!document.querySelector(`${t} .thread-hint`), thread, 20_000)
  const readyAgent = savedAgents().find((a) => a.id === 'smoke-ready')
  check('ACP の選択: 押すと足されてタブで開く', readyOpened && readyThread && readyAgent?.command === 'sh' && (await page.locator('#settings').isHidden()), JSON.stringify(readyAgent))

  // 6. binary を取ってきて入れる: 展開し、実行できるようにして、絶対パスで足す。古い版は片付ける
  await page.evaluate(() => {
    window.__notes = []
    new MutationObserver(() => {
      for (const n of document.querySelectorAll('#agent-picker .picker-note')) if (!window.__notes.includes(n.textContent)) window.__notes.push(n.textContent)
    }).observe(document.querySelector('#agent-picker'), { childList: true, subtree: true, characterData: true })
  })
  await openPicker()
  await page.keyboard.type('smoke install')
  await page.keyboard.press('Enter')
  const installed = await waitFor(() => document.querySelector('#agent-picker').hidden && document.querySelector('#ai-tabs .ai-tab.active')?.textContent.includes('Smoke Install'), null, 30_000)
  const installedThread = await waitFor((t) => !!document.querySelector(`${t} .thread-hint`), thread, 20_000)
  const installedAgent = savedAgents().find((a) => a.id === 'smoke-install')
  const binary = join(agentsRoot, 'smoke-install', '1.0.0', 'bin', 'smoke-agent')
  const executable = existsSync(binary) && (statSync(binary).mode & 0o111) !== 0
  const versions = existsSync(join(agentsRoot, 'smoke-install')) ? readdirSync(join(agentsRoot, 'smoke-install')) : []
  const notes = await page.evaluate(() => window.__notes)
  check(
    'ACP の選択: binary を取ってきて展開し、絶対パスで足す',
    installed && installedThread && installedAgent?.command === binary && executable && versions.join() === '1.0.0' && notes.some((n) => /取ってきています/.test(n)),
    `${installedAgent?.command} / 版 ${versions.join(',')} / ${notes.join(' → ')}`
  )

  // 7. sha256 が合わなければ断り、何も足さない
  await openPicker()
  await page.keyboard.type('checksum')
  await page.keyboard.press('Enter')
  const refused = await waitFor(() => /照合値/.test(document.querySelector('#agent-picker .picker-note.failed')?.textContent ?? ''), null, 30_000)
  const refusedText = await page.locator('#agent-picker .picker-note').first().textContent().catch(() => '')
  const badLeft = existsSync(join(agentsRoot, 'smoke-badsum')) ? readdirSync(join(agentsRoot, 'smoke-badsum')) : []
  await page.keyboard.press('Escape')
  check('ACP の選択: sha256 が合わないと断る', refused && !savedAgents().some((a) => a.id === 'smoke-badsum') && badLeft.length === 0, `${refusedText} / 残り ${badLeft.join(',')}`)

  // 8. 設定: 一覧は最初から出ていて、手で書く欄は畳んである。外したエージェントは、入れたファイルごと片付く
  for (const name of ['Smoke Install', 'Smoke Ready']) await page.locator('#ai-tabs .ai-tab', { hasText: name }).locator('.ai-tab-close').click()
  await page.locator('#open-settings').click()
  const settingsShown = await waitFor(() => document.querySelectorAll('#settings-picker .picker-row').length === 5, null, 10_000)
  const settingsClaude = await page.locator('#settings-picker .picker-row[data-id="claude-acp"] .picker-action').textContent()
  const customHidden = await page.locator('#agent-custom').isHidden()
  await page.locator('#agent-list .agent-row', { hasText: 'Smoke Install' }).locator('.agent-remove').click()
  for (let i = 0; i < 30 && existsSync(join(agentsRoot, 'smoke-install')); i++) await page.waitForTimeout(100)
  const cleaned = !existsSync(join(agentsRoot, 'smoke-install'))
  await page.locator('#agent-list .agent-row', { hasText: 'Smoke Ready' }).locator('.agent-remove').click()
  await page.keyboard.press('Escape')
  check('ACP の選択: 設定に一覧を出し、手で書く欄は畳む。外すとファイルも片付く', settingsShown && settingsClaude === '追加済み' && customHidden && cleaned, JSON.stringify({ settingsShown, settingsClaude, customHidden, cleaned }))

  await app.evaluate(() => {
    globalThis.fetch = globalThis.__realFetch
    globalThis.__calmpageResetRegistry()
  })
}

check('コンソールにエラーなし', errors.length === 0, errors.slice(0, 3).join(' | '))
await page.screenshot({ path: join(shots, '4-final.png') })
await app.close()
writeFileSync(join(shots, 'results.json'), JSON.stringify(results, null, 2))
process.exit(results.every((r) => r.ok) ? 0 : 1)
