#!/usr/bin/env node
/**
 * 判定那 5 个「一直 429」的模型到底是**永久不可用**还是**只是这一刻被打满**。
 *
 * ## 为什么这个区分很重要
 *
 * 前四轮的实测表里，`mimo-v2.6-flash-free` / `deepseek-v4-flash-free` /
 * `ling-*.free` / `mimo-v2.5-free` 一直是 429。我据此把它们放进故障转移链，
 * 理由是「模型本身能用，只是这一刻被打满」——但那是**推断**，不是实测。
 *
 * 如果它们其实是永久限流（上游把额度池关了），那么把它们放在候选链里就是错的：
 * 每次故障转移都要白等一个 RTT 才得到另一个 429。
 *
 * ## 怎么区分
 *
 * 看两件事：
 *   1. 429 的响应体里有没有 `retry-after` 或具体限额数字——有的话是速率限制，会恢复；
 *      只说「Rate limit exceeded」不给线索的，多半是额度池关了。
 *   2. **换一个新的 session 再试**。如果换 session 也 429，说明限流不是按 session 记的
 *      （那是别的配额维度，比如按 IP 或按模型的日额度）。
 *
 * 用法：node scripts/probe-throttled-depth.mjs
 */

import crypto from 'node:crypto'

const HOST = process.env.UPSTREAM_BASE || 'https://opencode.ai'

const THROTTLED = [
  'mimo-v2.6-flash-free',
  'deepseek-v4-flash-free',
  'ling-3.0-flash-fin-free',
  'ling-3.1-flash-free',
  'mimo-v2.5-free',
]

const BASE62 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz'

/**
 * 铸一个形状合规的新 session id。
 *
 * 上游按 `ses_<12hex><14base62>` 认 id，所以不能直接用随机 hex——长度对不上会被
 * 当成非法格式，从而得到一个与「额度已满」无关的错误。这正是探测时要避免的干扰。
 */
function mintSession() {
  const bytes = crypto.randomBytes(14)
  let tail = ''
  for (const byte of bytes) tail += BASE62[byte % 62]
  return `ses_${crypto.randomBytes(6).toString('hex')}${tail}`
}

function headers(session) {
  return {
    'content-type': 'application/json',
    authorization: 'Bearer public',
    'user-agent': 'opencode/1.18.31',
    'x-opencode-client': 'desktop',
    'x-opencode-session': session,
    'x-opencode-request': `msg_${crypto.randomBytes(6).toString('hex')}${mintSession().slice(-14)}`,
    'x-opencode-project': 'global',
  }
}

const tools = ['bash', 'glob', 'grep', 'read'].map(name => ({
  type: 'function',
  function: { name, description: 'unavailable', parameters: { type: 'object', properties: {} } },
}))

async function tryOnce(model, session) {
  try {
    const response = await fetch(`${HOST}/zen/v1/chat/completions`, {
      method: 'POST',
      headers: headers(session),
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: 'Reply with exactly: OK' }],
        max_tokens: 128,
        tools,
      }),
      signal: AbortSignal.timeout(45_000),
    })
    const text = await response.text().catch(() => '')
    if (response.ok) {
      let content = ''
      try { content = JSON.parse(text)?.choices?.[0]?.message?.content ?? '' } catch { /* keep */ }
      return { status: response.status, verdict: 'OK', body: content.replace(/\s+/g, ' ').slice(0, 40) }
    }
    return {
      status: response.status,
      verdict: response.status === 429 ? 'throttled' : `http-${response.status}`,
      body: text.replace(/\s+/g, ' ').slice(0, 160),
      retryAfter: response.headers.get('retry-after'),
    }
  } catch (error) {
    return { status: 0, verdict: 'threw', body: error?.message ?? String(error) }
  }
}

process.stdout.write('\n对 5 个持续 429 的模型，判断是「速率限制」还是「额度池已关」\n')
process.stdout.write('每个模型试 2 个**不同的 session**——若换 session 也 429，则限流维度不是 session。\n\n')

const summary = []

for (const model of THROTTLED) {
  process.stdout.write(`${model}\n`)
  const attempts = []
  for (let i = 0; i < 2; i += 1) {
    const session = mintSession()
    const r = await tryOnce(model, session)
    attempts.push(r)
    process.stdout.write(`   session#${i + 1} ${session.slice(-6)}  ${String(r.status).padStart(4)} ${r.verdict.padEnd(10)} retry-after=${r.retryAfter ?? '—'}\n`)
    process.stdout.write(`      ${r.body}\n`)
    await new Promise(res => setTimeout(res, 1200))
  }
  const allThrottled = attempts.every(a => a.verdict === 'throttled')
  const hasRetryAfter = attempts.some(a => a.retryAfter !== null && a.retryAfter !== undefined)
  const verdict = allThrottled
    ? (hasRetryAfter ? '速率限制（带 retry-after，会恢复）' : '⚠️ 疑似额度池已关')
    : '至少有一次成功'
  summary.push({ model, verdict, allThrottled, hasRetryAfter })
  process.stdout.write(`   => ${verdict}\n\n`)
}

process.stdout.write('=== 汇总 ===\n')
for (const row of summary) {
  process.stdout.write(`${row.model.padEnd(28)} ${row.verdict}\n`)
}

const suspect = summary.filter(r => r.allThrottled && !r.hasRetryAfter)
process.stdout.write('\n')
if (suspect.length === 0) {
  process.stdout.write('全部都有 retry-after 或出现过成功 —— 属于速率限制，保留在故障转移链里是对的。\n')
} else {
  process.stdout.write(`⚠️ ${suspect.length} 个模型换 session 也 429 且不给 retry-after：\n`)
  for (const s of suspect) process.stdout.write(`   - ${s.model}\n`)
  process.stdout.write('\n这类更像「额度池已关」而不是速率限制。把它们留在故障转移链里，\n')
  process.stdout.write('每次转移都要白等一个 RTT 才得到同样的 429。\n')
  process.stdout.write('建议：移到 KNOWN_THROTTLED（与 opencode-only 同样处理），或至少降权到末尾。\n')
}
