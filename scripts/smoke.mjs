// 組み上がったアプリを起動し、主な流れを自動で確かめる。
// 使い方: npm run build && node scripts/smoke.mjs [LaTeX のフォルダ] [スクリーンショットの出力先]
// フォルダの中身は書き換わるので、渡すときは必ずコピーにすること。省くと examples/sample を一時フォルダに写して使う。
import { _electron as electron } from 'playwright-core'
import { appendFileSync, cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { existsSync, rmSync } from 'node:fs'

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
  const cache = join(userData, 'build', readdirSync(join(userData, 'build')).find((d) => d.startsWith(`${base}-`)))
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

check('コンソールにエラーなし', errors.length === 0, errors.slice(0, 3).join(' | '))
await page.screenshot({ path: join(shots, '4-final.png') })
await app.close()
writeFileSync(join(shots, 'results.json'), JSON.stringify(results, null, 2))
process.exit(results.every((r) => r.ok) ? 0 : 1)
