#!/usr/bin/env node
/**
 * 最后一条防线：所有车道都不可用时，桥必须**如实**说，不能假装成功。
 *
 * ## 为什么值得单独测
 *
 * 「零成本」的失败模式有两种，第二种危险得多：
 *
 *   1. 不停地失败 —— 用户看得见，能处理。
 *   2. **假装成功** —— 比如回一个空 content、或把上游的错误当正常回答。
 *      Hindsight 会「成功」地抽出零条事实，用户以为记忆在工作，其实什么都没存。
 *
 * 第 2 种在前面几轮真的出现过：`json_schema` 不带 `strict` 时上游回 200 但 content
 * 是空字符串。所以这条防线必须有测试钉住。
 *
 * 覆盖：全部车道 429 / 全部连不上 / 部分车道坏。
 * 用法：node test-degradation.mjs
 */

import http from 'node:http'
import assert from 'node:assert/strict'

const BRIDGE_PORT = Number(process.env.TEST_BRIDGE_PORT || 19321)
const LANE_A_PORT = Number(process.env.TEST_LANE_A_PORT || 19322)
const LANE_B_PORT = Number(process.env.TEST_LANE_B_PORT || 19323)

let failures = 0
function check(name, ok, detail) {
  process.stdout.write(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail === undefined ? '' : ` — ${detail}`}\n`)
  if (!ok) failures += 1
}

const seen = { a: 0, b: 0 }
let mode = '429'

/** 两条永远失败的假车道：mode 决定回什么。 */
function makeLane(name, port) {
  return http.createServer((req, res) => {
    seen[name] += 1
    if (mode === '429') {
      res.writeHead(429, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: { type: 'FreeUsageLimitError', message: 'Rate limit exceeded.' } }))
    } else if (mode === 'empty') {
      // 最危险的那种：200 + 空 content。调用方会以为成功了。
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({
        id: `x-${name}`,
        model: 'lane-model-free',
        choices: [{ index: 0, message: { role: 'assistant', content: '' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 5, completion_tokens: 0, total_tokens: 5 },
      }))
    } else {
      res.writeHead(500, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: { message: 'boom' } }))
    }
  })
}

const laneA = makeLane('a', LANE_A_PORT)
const laneB = makeLane('b', LANE_B_PORT)

function listen(server, port) {
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, '127.0.0.1', resolve)
  })
}

const LANES = JSON.stringify([
  { name: 'a', baseUrl: `http://127.0.0.1:${LANE_A_PORT}`, model: 'lane-a-free' },
  { name: 'b', baseUrl: `http://127.0.0.1:${LANE_B_PORT}`, model: 'lane-b-free' },
])

const { spawn } = await import('node:child_process')
const bridge = spawn(process.execPath, ['index.js', '--port', String(BRIDGE_PORT)], {
  env: { ...process.env, LANES, PORT: String(BRIDGE_PORT) },
  stdio: ['ignore', 'inherit', 'pipe'],
})
const bridgeLog = []
bridge.stderr.on('data', d => bridgeLog.push(String(d)))

async function waitForBridge() {
  for (let i = 0; i < 60; i += 1) {
    try {
      const r = await fetch(`http://127.0.0.1:${BRIDGE_PORT}/health`)
      if (r.ok) return r.json()
    } catch { /* not up */ }
    await new Promise(r => setTimeout(r, 250))
  }
  throw new Error('bridge did not start')
}

async function ask() {
  const response = await fetch(`http://127.0.0.1:${BRIDGE_PORT}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer local', 'x-session-id': 'degrade' },
    body: JSON.stringify({ model: 'lane-a-free', messages: [{ role: 'user', content: 'ping' }], max_tokens: 32 }),
  })
  return { status: response.status, headers: response.headers, body: await response.json().catch(() => null) }
}

try {
  await listen(laneA, LANE_A_PORT)
  await listen(laneB, LANE_B_PORT)
  await waitForBridge()

  process.stdout.write('\n[1] 全部车道 429 —— 必须回 429 + retry-after\n')
  mode = '429'
  const r1 = await ask()
  check('HTTP 429', r1.status === 429, `got ${r1.status}`)
  check('带 Retry-After 头', r1.headers.get('retry-after') !== null, String(r1.headers.get('retry-after')))
  check('错误类型是 rate_limit_error', r1.body?.error?.type === 'rate_limit_error', r1.body?.error?.type)
  check('错误信息说清「全车道都限流」并给出可执行建议',
    /every configured lane is currently rate limited/.test(r1.body?.error?.message ?? ''),
    (r1.body?.error?.message ?? '').slice(0, 120))
  check('没有谎称成功', r1.body?.choices === undefined)

  process.stdout.write('\n[2] /health 必须如实报出两条车道都不可用\n')
  const h = await fetch(`http://127.0.0.1:${BRIDGE_PORT}/health`).then(r => r.json())
  check('两条车道 available=false', h.lanes?.every(l => l.available === false),
    JSON.stringify(h.lanes?.map(l => `${l.name}:${l.available}`)))
  check('报出被限流的目标数', h.throttled >= 1, String(h.throttled))
  check('报出最短重试等待', h.retryInSec > 0, String(h.retryInSec))

  process.stdout.write('\n[3] 全部车道 500 —— 不该假装成功\n')
  // 500 不在值得故障转移的名单里（换模型也救不了），所以第一次就应如实失败。
  bridge.kill()
  await new Promise(r => setTimeout(r, 400))
  const bridge2 = spawn(process.execPath, ['index.js', '--port', String(BRIDGE_PORT)], {
    env: { ...process.env, LANES, PORT: String(BRIDGE_PORT) },
    stdio: ['ignore', 'inherit', 'pipe'],
  })
  bridge2.stderr.on('data', d => bridgeLog.push(String(d)))
  await waitForBridge()
  mode = '500'
  const r3 = await ask()
  check('HTTP 502（上游错误如实上浮）', r3.status === 502, `got ${r3.status}`)
  check('没有回一个假的成功', r3.body?.choices === undefined)
  check('错误信息说清是哪条车道', /lane a|upstream error 500/.test(r3.body?.error?.message ?? ''),
    (r3.body?.error?.message ?? '').slice(0, 90))

  process.stdout.write('\n[4] 上游回 200 但 content 为空 —— 绝不能谎称成功\n')
  mode = 'empty'
  const r4 = await ask()
  const content = r4.body?.choices?.[0]?.message?.content
  // 这是最危险的情形。若桥把空 content 当正常回答返回，Hindsight 会「成功」地
  // 抽出零条事实而用户不知情——记忆看起来在工作，实际什么都没存。
  check('不会把空 content 当成功返回', !(r4.status === 200),
    `status=${r4.status} content=${JSON.stringify(content)}`)
  check('降级成明确的失败', r4.status === 502, `got ${r4.status}`)
  check('错误信息点明这是静默失败', /empty completion/i.test(r4.body?.error?.message ?? ''),
    (r4.body?.error?.message ?? '').slice(0, 110))
  bridge2.kill()
} finally {
  bridge.kill()
  laneA.close()
  laneB.close()
}

process.stdout.write(`\n${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`}\n`)
process.exit(failures === 0 ? 0 : 1)
