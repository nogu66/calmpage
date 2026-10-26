// build/og.html から、GitHub の Social preview に使う build/brand/og.png（1280×640）を書き出す。
// 使い方: node scripts/og.mjs（Google Chrome を使う）
import { chromium } from 'playwright-core'
import { mkdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const browser = await chromium.launch({ channel: 'chrome' })
const page = await browser.newPage({ viewport: { width: 1280, height: 640 } })
await page.goto(pathToFileURL(resolve('build/og.html')).href)
await page.evaluate(() => Promise.all([...document.images].map(img => img.decode())))

mkdirSync('build/brand', { recursive: true })
await page.screenshot({ path: 'build/brand/og.png' })

await browser.close()
console.log('build/brand/og.png を書き出した')
