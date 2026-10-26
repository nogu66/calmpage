// README 用の画面写真と GIF を撮る。examples/sample を一時フォルダに写して開くので、リポジトリは書き換えない。
// 使い方: npm run build && node scripts/screenshots.mjs [--ai]
//   --ai を付けると、本物の Claude Code に短い依頼を 1 回送り、書き換えの許可を求められた画面も撮る
//   （撮ったら「やめる」を押すので、ファイルは変わらない）。手元の claude のログインが要る。
// 出力: docs/images/（calmpage-light.png / calmpage-dark.png / calmpage-typing.gif / calmpage-typing.mp4 / calmpage-ai.png）
// 窓の枠（角丸・影・信号の 3 色）は Google Chrome で描いて重ねる。
// 動画は画面を撮り続けた連番の画像から ffmpeg で作る（Electron では Playwright の録画が起動を止めてしまうため）。
import { _electron as electron, chromium } from 'playwright-core'
import { execFileSync } from 'node:child_process'
import { cpSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const WIDTH = 1440
const HEIGHT = 900
const OUT = resolve('docs/images')
const withAi = process.argv.includes('--ai')
mkdirSync(OUT, { recursive: true })

const work = mkdtempSync(join(tmpdir(), 'calmpage-shots-'))
const folder = join(work, 'ink-in-washi')
cpSync(resolve('examples/sample'), folder, { recursive: true })

async function launch(settings) {
  const userData = mkdtempSync(join(work, 'user-'))
  writeFileSync(join(userData, 'settings.json'), JSON.stringify({ language: 'en', sidebar: true, split: 0.5, ...settings }))
  const app = await electron.launch({
    args: ['.', '--force-device-scale-factor=2'],
    colorScheme: null, // Playwright は既定でライトに固定するので、アプリの明るさの設定に任せる
    env: { ...process.env, CALMPAGE_OPEN: join(folder, 'main.tex'), CALMPAGE_USER_DATA: userData }
  })
  const page = await app.firstWindow()
  await app.evaluate(({ BrowserWindow }, [w, h]) => BrowserWindow.getAllWindows()[0].setContentSize(w, h), [WIDTH, HEIGHT])
  await compiled(page)
  return { app, page }
}

async function compiled(page) {
  await page.waitForFunction(() => ['ok', 'warning'].includes(document.querySelector('#status').dataset.state), null, { timeout: 120_000 })
  await page.waitForFunction(() => document.querySelectorAll('#pdf-scroll .page canvas').length > 0, null, { timeout: 30_000 })
  await page.waitForTimeout(600)
}

async function openFile(page, name) {
  // ファイル一覧のフォルダは閉じて出るので、開いてから選ぶ
  for (const dir of await page.locator('#file-list li.dir:not(.open)').all()) await dir.click()
  await page.locator('#file-list li.file', { hasText: name }).first().click()
  await page.waitForTimeout(300)
  await compiled(page)
}

// 行をクリックしてカーソルを置く（その行が「今の行」として薄く色づく）
async function placeCursor(page, text) {
  await page.locator('.cm-line', { hasText: text }).first().click()
  await page.keyboard.press('End')
}

// アプリの中身に macOS の窓の枠を付けて書き出す
let browser
async function framed(png, out, dark) {
  browser ??= await chromium.launch({ channel: 'chrome' })
  // 影が途中で切れないよう、影の広がりより広い余白を取る
  const page = await browser.newPage({ deviceScaleFactor: 2, viewport: { width: WIDTH + 160, height: HEIGHT + 170 } })
  const edge = dark ? 'rgba(255,255,255,0.14)' : 'rgba(0,0,0,0.22)'
  await page.setContent(`<style>
    html, body { margin: 0; background: transparent; }
    .window { position: relative; margin: 60px 80px 110px; width: ${WIDTH}px; height: ${HEIGHT}px; border-radius: 12px; overflow: hidden;
      box-shadow: 0 0 0 0.5px ${edge}, 0 18px 44px rgba(0,0,0,0.22), 0 4px 12px rgba(0,0,0,0.10); }
    .window img { display: block; width: 100%; height: 100%; }
    .lights { position: absolute; left: 14px; top: 13px; display: flex; gap: 8px; }
    .lights i { width: 12px; height: 12px; border-radius: 50%; box-shadow: inset 0 0 0 0.5px rgba(0,0,0,0.15); }
  </style>
  <div class="window"><img src="data:image/png;base64,${png.toString('base64')}" />
    <div class="lights"><i style="background:#ff5f57"></i><i style="background:#febc2e"></i><i style="background:#28c840"></i></div>
  </div>`)
  await page.locator('.window').evaluate((el) => el.querySelector('img').decode())
  await page.screenshot({ path: out, omitBackground: true })
  await page.close()
  console.log(`wrote ${out}`)
}

async function still(settings, out, prepare) {
  const { app, page } = await launch(settings)
  await prepare(page, app)
  await framed(await page.screenshot(), out, settings.theme === 'dark')
  await app.close()
}

// 1. ライトとダークの全体: 数式の多い節を開き、式の行にカーソルを置く
for (const theme of ['light', 'dark']) {
  await still({ theme, palette: 'paper' }, join(OUT, `calmpage-${theme}.png`), async (page) => {
    await openFile(page, 'model.tex')
    await placeCursor(page, 'D\\,\\nabla^2 c')
    await page.waitForTimeout(400)
  })
}

// 2. 打つと PDF が変わる GIF: 題名に言葉を足し、自動コンパイルで右の題名が変わるまで（窓の上側を切り出す）
const CLIP = 620
{
  const { app, page } = await launch({ theme: 'light', palette: 'paper' })
  await placeCursor(page, 'How Ink Spreads in Washi Paper')
  await page.keyboard.press('ArrowLeft')
  await page.waitForTimeout(500)

  // 画面を撮り続ける（撮った時刻も残し、その間隔のまま動画にする）
  const frames = []
  let recording = true
  const grabber = (async () => {
    while (recording) {
      const image = await page.screenshot({ type: 'jpeg', quality: 92, scale: 'css', clip: { x: 0, y: 0, width: WIDTH, height: CLIP } })
      frames.push({ at: Date.now(), image })
    }
  })()
  await page.waitForTimeout(700)
  await page.keyboard.type(': A Short Note', { delay: 90 })
  await page.waitForFunction(() => document.querySelector('#status').dataset.state === 'building', null, { timeout: 10_000 })
  await compiled(page)
  await page.waitForTimeout(1800)
  recording = false
  await grabber
  await app.close()

  const dir = mkdtempSync(join(work, 'frames-'))
  const list = []
  frames.forEach((f, i) => {
    const name = join(dir, `${String(i).padStart(4, '0')}.jpg`)
    writeFileSync(name, f.image)
    const next = frames[i + 1]?.at ?? f.at + 100
    list.push(`file '${name}'`, `duration ${((next - f.at) / 1000).toFixed(3)}`)
  })
  list.push(`file '${join(dir, `${String(frames.length - 1).padStart(4, '0')}.jpg`)}'`)
  writeFileSync(join(dir, 'list.txt'), list.join('\n'))
  // 左上の信号の 3 色を重ねる（静止画の枠とそろえる）
  browser ??= await chromium.launch({ channel: 'chrome' })
  const lights = await browser.newPage({ viewport: { width: WIDTH, height: CLIP } })
  await lights.setContent(`<style>html,body{margin:0;background:transparent}
    div{position:absolute;left:14px;top:13px;display:flex;gap:8px}
    i{width:12px;height:12px;border-radius:50%;box-shadow:inset 0 0 0 .5px rgba(0,0,0,.15)}</style>
    <div><i style="background:#ff5f57"></i><i style="background:#febc2e"></i><i style="background:#28c840"></i></div>`)
  await lights.screenshot({ path: join(dir, 'lights.png'), omitBackground: true })
  await lights.close()
  const input = ['-f', 'concat', '-safe', '0', '-i', join(dir, 'list.txt'), '-i', join(dir, 'lights.png')]
  const mp4 = join(OUT, 'calmpage-typing.mp4')
  const gif = join(OUT, 'calmpage-typing.gif')
  execFileSync('ffmpeg', ['-y', '-loglevel', 'error', ...input,
    '-filter_complex', '[0][1]overlay,fps=30,scale=1440:-2', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', mp4])
  execFileSync('ffmpeg', ['-y', '-loglevel', 'error', ...input, '-filter_complex',
    '[0][1]overlay,fps=12,scale=1200:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=96[p];[b][p]paletteuse=dither=bayer:bayer_scale=4', gif])
  console.log(`${frames.length} frames\nwrote ${mp4}\nwrote ${gif}`)
}

// 3. AI パネル: 本物の Claude Code に依頼し、差分と「許可 / やめる」が出たところを撮る
if (withAi) {
  // GIF で書き足した 1 文を消すため、サンプルを写し直す
  rmSync(folder, { recursive: true, force: true })
  cpSync(resolve('examples/sample'), folder, { recursive: true })
  await still({ theme: 'light', palette: 'paper', sidebar: false, ai: true, agent: 'claude' }, join(OUT, 'calmpage-ai.png'), async (page) => {
    const thread = '.thread:not([hidden])'
    await page.waitForFunction((t) => !!document.querySelector(`${t} .thread-hint`), thread, { timeout: 180_000 })
    await placeCursor(page, 'call \\emph{nijimi}.')
    await page.locator(`${thread} .composer-input`).fill('Make the abstract shorter: two sentences at most.')
    await page.locator(`${thread} .composer-input`).press('Enter')
    // 書き換え以外の許可（ファイルの読み込みなど）を求められたら許可して、差分の出る確認まで待つ
    for (;;) {
      await page.waitForFunction((t) => !!document.querySelector(`${t} .permission .permission-button`), thread, { timeout: 240_000 })
      const hasDiff = await page.evaluate((t) => !!document.querySelector(`${t} .permission`)?.closest('.tool')?.querySelector('.diff'), thread)
      if (hasDiff) break
      await page.locator(`${thread} .permission .permission-button.allow`).first().click()
    }
    await page.waitForTimeout(800)
  })
  // 書き換えの許可は出さずに閉じるので、ファイルは変わらない
}

await browser?.close()
rmSync(work, { recursive: true, force: true })
console.log(readdirSync(OUT).join('\n'))
