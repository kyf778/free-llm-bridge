#!/usr/bin/env node
/**
 * 端到端冒烟测试：把桥当成一个普通 OpenAI 兼容服务用，验证三件事。
 *
 *   1. 非流式补全能回来，并且用的是真模型（不是空 200）
 *   2. 真实结构化抽取场景——也就是 Hindsight 每轮对话后跑的 retain——
 *      能拿到可解析的 JSON
 *   3. 流式补全能逐帧到达（不少客户端要求这个，不能只回一整块）
 *
 * 用法：node smoke.mjs [baseUrl]
 */

const BASE = process.argv[2] || 'http://127.0.0.1:18999/v1'
const MODEL = process.env.MODEL || 'space-bunny-free'

let failures = 0

function check(name, ok, detail) {
  process.stdout.write(`${ok ? '  PASS' : '  FAIL'}  ${name}${detail === undefined ? '' : ` — ${detail}`}\n`)
  if (!ok) failures += 1
}

async function nonStreaming() {
  process.stdout.write('\n[1] non-streaming completion\n')
  const response = await fetch(`${BASE}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer local', 'x-session-id': 'smoke-1' },
    body: JSON.stringify({
      model: MODEL,
      messages: [{ role: 'user', content: 'Reply with exactly: BRIDGE_OK' }],
      max_tokens: 512,
    }),
  })
  const status = response.status
  const payload = await response.json().catch(() => null)
  const text = payload?.choices?.[0]?.message?.content ?? ''
  check('HTTP 200', status === 200, `got ${status}`)
  check('non-empty content', typeof text === 'string' && text.trim() !== '', JSON.stringify(text.slice(0, 120)))
  check('usage reported', payload?.usage?.total_tokens > 0, JSON.stringify(payload?.usage ?? null))
  check('model echoed', typeof payload?.model === 'string' && payload.model !== '', payload?.model)
}

async function structuredExtraction() {
  process.stdout.write('\n[2] structured JSON extraction (what Hindsight retain does)\n')
  const conversation = [
    { role: 'user', content: '我决定每天早上背单词到七点，然后吃早饭去上课。' },
    { role: 'assistant', content: '好的，已经记下你的晨间计划。' },
  ]
  const response = await fetch(`${BASE}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer local', 'x-session-id': 'smoke-1' },
    body: JSON.stringify({
      model: MODEL,
      messages: [
        {
          role: 'system',
          content: 'Extract durable facts from the conversation. Reply with ONLY a JSON array. Each element: {"type":"preference|plan|fact","text":"..."}. No prose, no markdown fence.',
        },
        { role: 'user', content: JSON.stringify(conversation) },
      ],
      max_tokens: 1024,
    }),
  })
  const status = response.status
  const payload = await response.json().catch(() => null)
  const text = payload?.choices?.[0]?.message?.content ?? ''
  check('HTTP 200', status === 200, `got ${status}`)

  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/)
  const candidate = fenced === null ? text : fenced[1]
  const start = candidate.indexOf('[')
  const end = candidate.lastIndexOf(']')
  let parsed = null
  if (start !== -1 && end > start) {
    try { parsed = JSON.parse(candidate.slice(start, end + 1)) } catch { parsed = null }
  }
  check('JSON array parses', Array.isArray(parsed) && parsed.length > 0, JSON.stringify(text.slice(0, 160)))
  check(
    'elements carry a type and text',
    Array.isArray(parsed) && parsed.every(item => item && typeof item.text === 'string' && typeof item.type === 'string'),
    Array.isArray(parsed) ? JSON.stringify(parsed[0]) : 'n/a',
  )
}

async function streaming() {
  process.stdout.write('\n[3] streaming completion\n')
  const response = await fetch(`${BASE}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer local', 'x-session-id': 'smoke-1' },
    body: JSON.stringify({
      model: MODEL,
      messages: [{ role: 'user', content: 'Count from 1 to 5, one number per line.' }],
      max_tokens: 512,
      stream: true,
    }),
  })
  check('HTTP 200', response.status === 200, `got ${response.status}`)
  check('sse content-type', String(response.headers.get('content-type') ?? '').includes('text/event-stream'),
    String(response.headers.get('content-type') ?? ''))

  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let raw = ''
  let frames = 0
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    raw += decoder.decode(value, { stream: true })
    frames += 1
  }
  const sawDone = raw.includes('[DONE]')
  const deltas = [...raw.matchAll(/"content":"((?:[^"\\]|\\.)*)"/g)].map(m => m[1]).join('')
  check('multiple frames arrived', frames > 1, `${frames} read chunks`)
  check('[DONE] terminator', sawDone)
  check('content deltas accumulated', deltas.trim().length > 0, JSON.stringify(deltas.slice(0, 80)))
}

async function health() {
  process.stdout.write('\n[4] health + model list\n')
  const root = BASE.replace(/\/v1$/, '')
  const health = await fetch(`${root}/health`).then(r => r.json()).catch(() => null)
  check('health ok', health?.ok === true, JSON.stringify(health))
  const models = await fetch(`${BASE}/models`).then(r => r.json()).catch(() => null)
  const free = (models?.data ?? []).filter(row => row.id.endsWith('-free'))
  check('free models listed', free.length >= 5, `${free.length} free models`)
}

await health()
await nonStreaming()
await structuredExtraction()
await streaming()

process.stdout.write(`\n${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`}\n`)
process.exit(failures === 0 ? 0 : 1)
