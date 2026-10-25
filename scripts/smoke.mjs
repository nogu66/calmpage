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
  const marker = await page.evaluate(() => {
    const line = [...document.querySelectorAll('.cm-line')].find((l) => l.textContent.includes('\\begin{abstract}'))
    const top = line?.getBoundingClientRect().top ?? -1
    const el = [...document.querySelectorAll('.cm-foldGutter .cm-gutterElement')].find((g) => Math.abs(g.getBoundingClientRect().top - top) < 4 && g.querySelector('span[title]'))
    const r = el?.querySelector('span').getBoundingClientRect()
    return r ? { x: r.x + r.width / 2, y: r.y + r.height / 2 } : null
  })
  if (marker) await page.mouse.click(marker.x, marker.y)
  const folded = await page.locator('.cm-foldPlaceholder').count()
  const hiddenText = !(await page.evaluate(() => document.querySelector('.cm-content').innerText.includes('A drop of sumi ink')))
  if (folded) await page.locator('.cm-foldPlaceholder').first().click()
  check('環境の折りたたみ', !!marker && folded === 1 && hiddenText, JSON.stringify({ marker: !!marker, folded, hiddenText }))

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

check('コンソールにエラーなし', errors.length === 0, errors.slice(0, 3).join(' | '))
await page.screenshot({ path: join(shots, '4-final.png') })
await app.close()
writeFileSync(join(shots, 'results.json'), JSON.stringify(results, null, 2))
process.exit(results.every((r) => r.ok) ? 0 : 1)
