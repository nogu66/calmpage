// 自動テスト用の ACP エージェント。標準入出力で 1 行 1 メッセージの JSON-RPC を話す。
// - 受け取った prompt の中身（種類と名前）を返事として報告する
// - 「edit」を含むと、差分付きで許可を求め、許可されたらクライアントの fs/write_text_file で smoke-note.tex を書く
// - 「slow」を含むと、session/cancel が届くまで待つ
import { createInterface } from 'node:readline'
import { join } from 'node:path'

let cwd = process.cwd()
let nextId = 1
const waiting = new Map()
let cancelled = null

const write = (msg) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...msg }) + '\n')
const notify = (method, params) => write({ method, params })
const request = (method, params) =>
  new Promise((resolve, reject) => {
    const id = nextId++
    waiting.set(id, { resolve, reject })
    write({ id, method, params })
  })
const update = (sessionId, u) => notify('session/update', { sessionId, update: u })

function describe(block) {
  if (block.type === 'text') return `text(${block.text.split('\n')[0].slice(0, 40)})`
  if (block.type === 'resource_link') return `resource_link ${block.name}`
  return block.type
}

async function prompt({ sessionId, prompt }) {
  const text = prompt.find((b) => b.type === 'text')?.text ?? ''
  const report = `Received ${prompt.length} blocks: ${prompt.map(describe).join(', ')}`
  update(sessionId, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: report.slice(0, 20) } })
  update(sessionId, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: report.slice(20) } })

  if (text.includes('edit')) {
    const path = join(cwd, 'smoke-note.tex')
    const toolCall = {
      toolCallId: 't1',
      title: 'Edit smoke-note.tex',
      kind: 'edit',
      status: 'pending',
      content: [{ type: 'diff', path, oldText: 'old line\nsame line\n', newText: 'new line\nsame line\n' }]
    }
    update(sessionId, { sessionUpdate: 'tool_call', ...toolCall })
    const answer = await request('session/request_permission', {
      sessionId,
      toolCall: { toolCallId: 't1' },
      options: [
        { optionId: 'yes', name: 'Allow edit', kind: 'allow_once' },
        { optionId: 'no', name: 'Reject edit', kind: 'reject_once' }
      ]
    })
    const allowed = answer.outcome.outcome === 'selected' && answer.outcome.optionId === 'yes'
    if (allowed) await request('fs/write_text_file', { sessionId, path, content: 'new line\nsame line\n' })
    update(sessionId, { sessionUpdate: 'tool_call_update', toolCallId: 't1', status: allowed ? 'completed' : 'failed' })
  }

  if (text.includes('slow')) {
    await new Promise((resolve) => {
      cancelled = resolve
      setTimeout(resolve, 15000)
    })
    cancelled = null
    return { stopReason: 'cancelled' }
  }
  return { stopReason: 'end_turn' }
}

const handlers = {
  initialize: () => ({ protocolVersion: 1, agentCapabilities: { promptCapabilities: { embeddedContext: true } }, authMethods: [] }),
  'session/new': (params) => {
    cwd = params.cwd
    return { sessionId: 'fake-session' }
  },
  'session/prompt': prompt
}

createInterface({ input: process.stdin }).on('line', async (line) => {
  if (!line.trim()) return
  const msg = JSON.parse(line)
  if (msg.method === 'session/cancel') return cancelled?.()
  if (msg.method && msg.id !== undefined) {
    const handler = handlers[msg.method]
    if (!handler) return write({ id: msg.id, error: { code: -32601, message: `no ${msg.method}` } })
    try {
      write({ id: msg.id, result: await handler(msg.params) })
    } catch (err) {
      write({ id: msg.id, error: { code: -32603, message: String(err) } })
    }
  } else if (msg.id !== undefined && waiting.has(msg.id)) {
    const w = waiting.get(msg.id)
    waiting.delete(msg.id)
    if (msg.error) w.reject(msg.error)
    else w.resolve(msg.result)
  }
})
