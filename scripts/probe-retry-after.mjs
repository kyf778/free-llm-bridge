#!/usr/bin/env node
/**
 * 验证 `retry-after` 是不是真的倒计时。
 *
 * ## 为什么要单独验证
 *
 * 上一轮实测发现那 5 个「一直 429」的模型都带 `retry-after: 5520`（约 92 分钟）。
 * 如果它是个**真实倒计时**，那么：
 *
 *   - 它们确实是「暂时打满」，不是永久关闭；
 *   - 每隔一段时间会自动恢复，成为故障转移链里真实的第二梯队；
 *   - 桥应该**尊重**这个值，而不是一律退避 60 秒。
 *
 * 如果它是个**固定值**（比如恒定 5520 或恒定 3600），那更可能是「配额池按天/按周重置」
 * 或者一个不打算让你等的固定退避——那样桥就不该把它当成精确的等待时间。
 *
 * 判据：间隔约 20 秒连打三次，`retry-after` 应该大致等量递减。
 *
 * 用法：node scripts/probe-retry-after.mjs
 */

import crypto from 'node:crypto'

const HOST = process.env.UPSTREAM_BASE || 'https://opencode.ai'
const MODEL = process.env.MODEL || 'mimo-v2.6-flash-free'
const SAMPLES = Number(process.env.SAMPLES || 3)
const GAP_MS = Number(process.env.GAP_MS || 20_000)

const BASE62 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz'

function mintSession() {
  let tail = ''
  for (const byte of crypto.randomBytes(14)) tail += BASE62[byte % 62]
  return `ses_${crypto.randomBytes(6).toString('hex')}${tail}`
}

const tools = ['bash', 'glob', 'grep', 'read'].map(name => ({
  type: 'function',
  function: { name, description: 'unavailable', parameters: { type: 'object', properties: {} } },
}))

async function once() {
  const session = mintSession()
  const started = Date.now()
  try {
    const response = await fetch(`${HOST}/zen/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: 'Bearer public',
        'user-agent': 'opencode/1.18.31',
        'x-opencode-client': 'desktop',
        'x-opencode-session': session,
        'x-opencode-request': `msg_${mintSession().slice(-14)}`,
        'x-opencode-project': 'global',
      },
      body: JSON.stringify({
        model: MODEL,
        messages: [{ role: 'user', content: 'Reply with exactly: OK' }],
        max_tokens: 64,
        tools,
      }),
      signal: AbortSignal.timeout(45_000),
    })
    const text = await response.text().catch(() => '')
    return {
      status: response.status,
      retryAfter: response.headers.get('retry-after'),
      elapsedMs: Date.now() - started,
      body: text.replace(/\s+/g, ' ').slice(0, 120),
    }
  } catch (error) {
    return { status: 0, retryAfter: null, elapsedMs: Date.now() - started, body: error?.message ?? String(error) }
  }
}

process.stdout.write(`\n模型：${MODEL}\n间隔：${GAP_MS / 1000}s，连打 ${SAMPLES} 次\n\n`)

const samples = []
for (let i = 0; i < SAMPLES; i += 1) {
  const r = await once()
  samples.push(r)
  const seconds = r.retryAfter === null ? '—' : `${r.retryAfter}s (${(Number(r.retryAfter) / 60).toFixed(1)}min)`
  process.stdout.write(`  #${i + 1}  HTTP ${String(r.status).padStart(4)}  retry-after=${seconds}\n`)
  if (i < SAMPLES - 1) await new Promise(res => setTimeout(res, GAP_MS))
}

const values = samples.map(s => s.retryAfter).filter(v => v !== null).map(Number)
process.stdout.write('\n=== 判定 ===\n')
if (values.length < 2) {
  process.stdout.write('样本不足，无法判定。\n')
  process.stdout.write('若全部返回 200，说明额度已恢复——这本身也是有价值的信息。\n')
} else {
  const first = values[0]
  const last = values[values.length - 1]
  const spanSeconds = (samples[samples.length - 1].elapsedMs - 0) / 1000
  const dropped = first - last
  process.stdout.write(`首次 ${first}s -> 末次 ${last}s，跨度约 ${spanSeconds.toFixed(0)}s，减少 ${dropped}s\n`)
  // 若它在按真实经过的时间递减，dropped 应该与两次采样之间的真实间隔同量级。
  const expected = samples.length > 1
    ? (samples[samples.length - 1].elapsedMs - samples[0].elapsedMs) / 1000 + GAP_MS / 1000 * 0
    : 0
  process.stdout.write(`预期按真实时间应减少约 ${Math.max(0, Math.round(expected))}s（另加每次请求的往返）\n\n`)
  if (dropped <= 0) {
    process.stdout.write('⚠️ 没有递减 —— 这是个**固定值**，不是倒计时。\n')
    process.stdout.write('含义：上游给的是一个固定退避建议（常见于「本小时/本日额度已用尽」），\n')
    process.stdout.write('      不是精确的剩余时间。桥不应把它当精确等待时长。\n')
  } else {
    process.stdout.write('✅ 在递减 —— 是真实的倒计时。\n')
    process.stdout.write('含义：这是**速率限制**，到点自动恢复。\n')
    process.stdout.write('      桥应当尊重这个值，而不是一律退避 60 秒——否则会在它恢复前反复撞墙。\n')
  }
}
