// build/icon.svg から、electron-builder が使う build/icon.icns と build/icon.png を書き出す。
// あわせて SNS 用の画像を build/brand/ に書き出す。
// 使い方: node scripts/icon.mjs（Google Chrome と macOS の iconutil を使う）
import { chromium } from 'playwright-core'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const app = readFileSync('build/icon.svg', 'utf8')
const sns = readFileSync('build/icon-sns.svg', 'utf8')
const browser = await chromium.launch({ channel: 'chrome' })
const page = await browser.newPage()

// 32px 以下では艶の線が潰れて濁るので消す
const render = async (svg, size, path) => {
  const hide = size <= 32 ? '.shine{display:none}' : ''
  await page.setViewportSize({ width: size, height: size })
  await page.setContent(`<style>html,body{margin:0;background:transparent}svg{display:block;width:${size}px;height:${size}px}${hide}</style>${svg}`)
  await page.screenshot({ path, omitBackground: true })
}

const iconset = join(mkdtempSync(join(tmpdir(), 'sumi-icon-')), 'icon.iconset')
mkdirSync(iconset)
for (const base of [16, 32, 128, 256, 512]) {
  await render(app, base, join(iconset, `icon_${base}x${base}.png`))
  await render(app, base * 2, join(iconset, `icon_${base}x${base}@2x.png`))
}
execFileSync('iconutil', ['-c', 'icns', iconset, '-o', 'build/icon.icns'])
rmSync(join(iconset, '..'), { recursive: true })
await render(app, 1024, 'build/icon.png')

mkdirSync('build/brand', { recursive: true })
await render(sns, 1024, 'build/brand/sns-1024.png')
await render(sns, 400, 'build/brand/sns-400.png')
await render(sns, 32, 'build/brand/favicon-32.png')
await render(sns, 16, 'build/brand/favicon-16.png')

await browser.close()
console.log('build/icon.icns, build/icon.png, build/brand/ を書き出した')
