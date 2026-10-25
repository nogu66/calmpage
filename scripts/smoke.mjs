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
check('PDF: メニューから検索を開く（⌥⌘F）', menuFind)

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

check('コンソールにエラーなし', errors.length === 0, errors.slice(0, 3).join(' | '))
await page.screenshot({ path: join(shots, '4-final.png') })
await app.close()
writeFileSync(join(shots, 'results.json'), JSON.stringify(results, null, 2))
process.exit(results.every((r) => r.ok) ? 0 : 1)
