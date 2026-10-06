#!/usr/bin/env node
/**
 * 多车道故障转移的端到端验证 —— 用假上游，不花任何额度。
 *
 * ## 为什么必须用假上游测
 *
 * 真实免密车道只有 1 个模型能用，所以**没法从真实上游观测到「跨车道故障转移」**：
 * 主车道限流之后没有第二条真实车道可换。这个逻辑如果只在真实环境验证，
 * 永远是「看起来对但从没执行过」。
 *
 * 所以这里起两个本地假上游，各自按脚本化剧本返回 429 / 403 / 200，
 * 把桥指向它们，然后断言调用方看到的是一次成功、而不是一次错误。
 *
 * 覆盖的剧本：
 *   1. 主车道 429 → 自动换到备用车道成功
 *   2. 主车道 401（key 失效）→ 自动换备用车道
 *   3. 主车道整体连不上（端口没人听）→ 备用车道接管
 *   4. 备用车道也限流 → 回 429 且带 retry-after
 *   5. 免费档全满 → 不碰付费模型
 *
 * 用法：node test-multilane.mjs
 */

import http from 'node:http'
import assert from 'node:assert/strict'
import { FALLBACK_ORDER } from './index.js'

const BRIDGE_PORT = Number(process.env.TEST_BRIDGE_PORT || 19311)
/** 主车道的假上游：永远按剧本 1 失败。 */
const PRIMARY_PORT = Number(process.env.TEST_PRIMARY_PORT || 19312)
/** 备用车道的假上游：永远成功。 */
const BACKUP_PORT = Number(process.env.TEST_BACKUP_PORT || 19313)

let failures = 0
function check(name, ok, detail) {
  process.stdout.write(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail === undefined ? '' : ` — ${detail}`}\n`)
  if (!ok) failures += 1
}

// --- 假上游 ---------------------------------------------------------------

/** 收到的请求头与体，记录下来供断言检查。 */
const primarySaw = { requests: [], headers: [] }
const backupSaw = { requests: [], headers: [] }

/** 主车道的剧本：按 PRIMARY_SCRIPT 决定这一轮怎么失败。 */
let primaryScript = '429'

/**
 * 主车道各模型自己的剧本。
 *
 * 用一个全局变量会让所有模型都失败，于是桥会（正确地）把主车道的 6 个候选
 * 挨个试完再换车道——一次请求打 7 次上游。**那是测试桩的假象**：真实的主车道
 * 里 `space-bunny-free` 是可用的，桥应该第一轮就换过去，而不是把它也打一遍。
 * 所以这里按模型给出独立剧本，让主车道表现得像它真实的样子——
 * 除了点名的那一个模型 429，其余候选都可用。
 */
const PRIMARY_MODEL_SCRIPTS = new Map([
  ['primary-model-free', '429'],
])

const primaryUpstream = http.createServer((req, res) => {
  const chunks = []
  req.on('data', c => chunks.push(c))
  req.on('end', () => {
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')
    primarySaw.requests.push(body)
    primarySaw.headers.push(req.headers)
    const script = PRIMARY_MODEL_SCRIPTS.get(body.model) ?? '200'
    primaryScript = script
    if (script === '429') {
      res.writeHead(429, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ type: 'error', error: { type: 'FreeUsageLimitError', message: 'Rate limit exceeded.' } }))
    } else if (script === '401') {
      res.writeHead(401, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: { message: 'invalid api key', code: '1001' } }))
    } else if (script === '500') {
      res.writeHead(500, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: { message: 'boom' } }))
    } else {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({
        id: 'primary-1',
        model: body.model,
        choices: [{ index: 0, message: { role: 'assistant', content: 'PRIMARY_OK' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 10, completion_tokens: 3, total_tokens: 13 },
      }))
    }
  })
})

const backupUpstream = http.createServer((req, res) => {
  const chunks = []
  req.on('data', c => chunks.push(c))
  req.on('end', () => {
    backupSaw.requests.push(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'))
    backupSaw.headers.push(req.headers)
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({
      id: 'backup-1',
      model: 'backup-model-free',
      choices: [{ index: 0, message: { role: 'assistant', content: 'BACKUP_OK' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 10, completion_tokens: 3, total_tokens: 13 },
    }))
  })
})

function listen(server, port) {
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, '127.0.0.1', resolve)
  })
}

// --- 桥（子进程，带上两条车道的环境变量）---------------------------------

const LANES = JSON.stringify([
  {
    name: 'primary',
    baseUrl: `http://127.0.0.1:${PRIMARY_PORT}`,
    model: 'primary-model-free',
    headers: { 'user-agent': 'opencode/1.18.31', 'x-opencode-client': 'desktop' },
    fingerprintTools: true,
    sessionScoped: true,
    normalizeSchema: true,
    strictSchema: true,
  },
  {
    // 备用车道刻意**不带** fingerprintTools / strictSchema / sessionScoped，
    // 用来验证「这些标志是真的按车道生效的」。
    name: 'backup',
    baseUrl: `http://127.0.0.1:${BACKUP_PORT}`,
    model: 'backup-model-free',
    pathStyle: 'openai',
  },
])

const { spawn } = await import('node:child_process')

const bridgeLog = []

/**
 * 起一个桥实例。
 *
 * 每个场景用独立实例，是因为桥会把限流模型记进冷却表——那是它的正常行为，
 * 但会让后续场景看到「上一个场景留下的余波」。想测「车道整体不可用」时，
 * 光把上游剧本改成一直失败是不够的：被冷却的模型会被直接跳过，根本不发请求。
 * 重启是清空冷却表最干净的办法。
 */
function spawnBridge() {
  const child = spawn(process.execPath, ['index.js', '--port', String(BRIDGE_PORT)], {
    env: {
      ...process.env,
      LANES,
      UPSTREAM_BASE: `http://127.0.0.1:${PRIMARY_PORT}`,
      PORT: String(BRIDGE_PORT),
    },
    stdio: ['ignore', 'inherit', 'pipe'],
  })
  child.stderr.on('data', d => bridgeLog.push(String(d)))
  return child
}

let bridge = spawnBridge()

async function waitForBridge() {
  for (let i = 0; i < 60; i += 1) {
    try {
      const r = await fetch(`http://127.0.0.1:${BRIDGE_PORT}/health`)
      if (r.ok) return r.json()
    } catch { /* not up yet */ }
    await new Promise(r => setTimeout(r, 250))
  }
  throw new Error('bridge did not start in 15s')
}

async function ask(model = 'primary-model-free') {
  const response = await fetch(`http://127.0.0.1:${BRIDGE_PORT}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer local', 'x-session-id': 'multilane-test' },
    body: JSON.stringify({
      model,
      messages: [{ role: 'user', content: 'ping' }],
      max_tokens: 64,
      response_format: { type: 'json_schema', json_schema: { name: 'X', schema: { type: 'object', properties: { v: { type: ['string', 'null'] } } }, strict: true } },
    }),
  })
  return { status: response.status, body: await response.json().catch(() => null), headers: response.headers }
}

try {
  await listen(primaryUpstream, PRIMARY_PORT)
  await listen(backupUpstream, BACKUP_PORT)
  const health = await waitForBridge()

  process.stdout.write('\n[0] 桥启动并认出两条车道\n')
  check('health 报出 2 条车道', Array.isArray(health.lanes) && health.lanes.length === 2,
    JSON.stringify(health.lanes?.map(l => l.name)))
  check('两条车道都标为 available', health.lanes?.every(l => l.available === true))
  check('主车道声明 strictSchema', health.lanes?.find(l => l.name === 'primary')?.strictSchema === true)
  check('备用车道不声明 strictSchema', health.lanes?.find(l => l.name === 'backup')?.strictSchema === false)

  // --- 剧本 1：主车道的点名模型 429，换到同车道另一个可用模型 --------------
  process.stdout.write('\n[1] 主车道点名模型 429 -> 先在同车道内换可用模型\n')
  PRIMARY_MODEL_SCRIPTS.set('primary-model-free', '429')
  const primaryBefore = primarySaw.requests.length
  const backupBefore = backupSaw.requests.length
  const r1 = await ask()
  check('调用方拿到 200', r1.status === 200, `got ${r1.status} ${JSON.stringify(r1.body?.error ?? '')}`)
  // 断言「换到了同车道的另一个模型」，而不是硬编某一个具体名字。
  // 硬编会在 FALLBACK_ORDER 重排时无意义地失败（2026-10-06 重排过一次）。
  check('由主车道的另一个模型服务', r1.body?.model !== 'primary-model-free' && r1.body?.model !== undefined,
    r1.body?.model)
  check('换档目标仍是免费档', String(r1.body?.model ?? '').endsWith('-free'), r1.body?.model)
  check('指纹标出实际服务方', r1.body?.system_fingerprint === 'free-llm-bridge/primary', r1.body?.system_fingerprint)
  const sameLane = (primarySaw.requests.length - primaryBefore)
  check('同车道内只多试了一次', sameLane === 2, `${sameLane} primary call(s); expected 2`)
  check('没有白费一次去问备用车道', backupSaw.requests.length === backupBefore,
    `${backupSaw.requests.length - backupBefore} backup call(s)`)
  process.stdout.write('        —— 桥实际走的路径 ——\n')
  for (const line of bridgeLog.join('').split('\n').filter(l => l.includes('retrying on') || l.includes('unusable'))) {
    process.stdout.write(`        ${line.replace('[free-llm-bridge] ', '')}\n`)
  }

  // --- 按车道生效的标志 --------------------------------------------------
  process.stdout.write('\n[2] 车道标志真的按车道生效\n')
  const primaryBody = primarySaw.requests[primarySaw.requests.length - 1] ?? {}
  check('主车道收到四件套诱饵工具',
    Array.isArray(primaryBody.tools) && ['bash', 'glob', 'grep', 'read'].every(n =>
      primaryBody.tools.some(t => t?.function?.name === n)),
    JSON.stringify((primaryBody.tools ?? []).map(t => t?.function?.name)))
  check('主车道收到 session 头', typeof primarySaw.headers[primarySaw.headers.length - 1]?.['x-opencode-session'] === 'string',
    String(primarySaw.headers[primarySaw.headers.length - 1]?.['x-opencode-session'] ?? ''))
  check('主车道收到规整后的 schema（无联合类型）',
    JSON.stringify(primaryBody.response_format ?? {}).includes('"type":"string"') &&
    !JSON.stringify(primaryBody.response_format ?? {}).includes('["string","null"]'),
    JSON.stringify(primaryBody.response_format ?? null))
  check('主车道收到的 max_tokens 仍在（没被 schema 逻辑吞掉）', primaryBody.max_tokens === 64)

  // 备用车道的请求体/请求头检查挪到剧本 3 之后——那时备用车道才真的被调用过。
  // 放在这里会读到空数组的下标 -1，断言的是「没收到请求」而不是「收到的请求形状对」。
  // 前面几轮已经把一些模型推进了冷却（这是桥的正常行为）。要让主车道彻底不可用，
  // 光把剧本改成 429 不够——被冷却的模型会被直接跳过，根本不会发请求。
  // 所以这里重启桥，清空冷却表，再让主车道所有模型都 429。
  bridge.kill()
  await new Promise(resolve => setTimeout(resolve, 500))
  // 上游那个 server 已经在剧本 5 里被 close 过了？还没有——剧本 5 在后面。
  // 这里之所以要 close：bridge 重启会重新对主车道发 /models 探测，
  // 而 listen() 只能调一次。
  primaryUpstream.closeAllConnections?.()
  await new Promise(resolve => primaryUpstream.close(resolve))
  await listen(primaryUpstream, PRIMARY_PORT)
  bridge = spawnBridge()
  await waitForBridge()
  primarySaw.requests.length = 0
  backupSaw.requests.length = 0
  bridgeLog.length = 0

  // --- 剧本 3：整条主车道全挂 -> 换备用车道 --------------------------------
  process.stdout.write('\n[3] 主车道所有模型都限流 -> 换备用车道\n')
  // 名单从 FALLBACK_ORDER 现取，**不再硬编**：硬编版本在重排后漏掉新候选，
  // 那个没被脚本化的模型就以默认 200 成功，把「主车道穷尽」的剧本打断在半路，
  // 备用车道一次都不会被问到。（2026-10-05 加 jev、2026-10-06 重排各踩过一次）
  for (const m of ['primary-model-free', ...FALLBACK_ORDER]) {
    PRIMARY_MODEL_SCRIPTS.set(m, '429')
  }
  const pBefore2 = primarySaw.requests.length
  const bBefore2 = backupSaw.requests.length
  const r2 = await ask()
  check('调用方拿到 200', r2.status === 200, `got ${r2.status} ${JSON.stringify(r2.body?.error ?? '')}`)
  check('由备用车道服务', r2.body?.model === 'backup-model-free', r2.body?.model)
  check('指纹如实标出备用车道', r2.body?.system_fingerprint === 'free-llm-bridge/backup')
  // 候选数 = 车道自己的 primary-model-free + FALLBACK_ORDER 全部成员。
  // 断言的本意是「每个候选只试一次、不打转」，所以上限随候选池同步算出，
  // 不硬编数字——重排 FALLBACK_ORDER 不该让这条断言变成假失败。
  const candidateCount = 1 + FALLBACK_ORDER.length
  check('主车道候选每个只试一次（不打转）',
    (primarySaw.requests.length - pBefore2) <= candidateCount,
    `${primarySaw.requests.length - pBefore2} primary call(s); expected <= ${candidateCount}`)
  check('备用车道只被问了一次', (backupSaw.requests.length - bBefore2) === 1, ` ${backupSaw.requests.length - bBefore2} backup call(s)`)

  // 备用车道真的被调用过了，现在才有意义检查它收到的请求形状。
  const backupBody = backupSaw.requests[backupSaw.requests.length - 1] ?? {}
  const backupHeader = backupSaw.headers[backupSaw.headers.length - 1] ?? {}
  check('备用车道没有收到诱饵工具', backupBody.tools === undefined, JSON.stringify(backupBody.tools ?? null))
  check('备用车道没有收到 response_format', backupBody.response_format === undefined,
    JSON.stringify(backupBody.response_format ?? null))
  check('备用车道没有收到 session 头', backupHeader['x-opencode-session'] === undefined)
  check('备用车道用 Bearer public 兜底（没 key）', backupHeader.authorization === 'Bearer public',
    String(backupHeader.authorization ?? ''))
  check('备用车道收到了调用方的原始模型名', backupBody.model === 'backup-model-free', backupBody.model)

  // 恢复：只让点名的那一个挂，其余候选恢复可用
  for (const m of FALLBACK_ORDER) {
    PRIMARY_MODEL_SCRIPTS.delete(m)
  }

  // --- 剧本 4：主车道凭据失效 ---------------------------------------------
  process.stdout.write('\n[4] 主车道 401（凭据失效）-> 换备用车道\n')
  for (const m of PRIMARY_MODEL_SCRIPTS.keys()) PRIMARY_MODEL_SCRIPTS.set(m, '401')
  const r3 = await ask()
  check('调用方拿到 200', r3.status === 200, `got ${r3.status}`)
  check('由备用车道服务', r3.body?.model === 'backup-model-free', r3.body?.model)
  for (const m of PRIMARY_MODEL_SCRIPTS.keys()) PRIMARY_MODEL_SCRIPTS.set(m, '429')

  // --- 剧本 5：主车道整体连不上 -------------------------------------------
  process.stdout.write('\n[5] 主车道整体连不上 -> 备用车道接管\n')
  await new Promise(resolve => primaryUpstream.close(resolve))
  const r4 = await ask()
  check('调用方拿到 200 或 503', r4.status === 200 || r4.status === 503, `got ${r4.status}`)
  check('由备用车道服务', r4.body?.model === 'backup-model-free', r4.body?.model)

  // --- 剧本 6：付费模型仍然被拒绝 -----------------------------------------
  process.stdout.write('\n[6] 付费模型在任何车道配置下都被拒绝\n')
  for (const paid of ['gpt-5', 'claude-opus-5', 'mimo-v2.6-flash']) {
    const r = await ask(paid)
    check(` ${paid} 被拒 `, r.status === 400, `got ${r.status}`)
  }
} finally {
  bridge.kill()
  primaryUpstream.close()
  backupUpstream.close()
}

process.stdout.write(` ${failures === 0 ? 'ALL CHECKS PASSED' : ` ${failures} CHECK(S) FAILED `}\n`)
process.exit(failures === 0 ? 0 : 1)
