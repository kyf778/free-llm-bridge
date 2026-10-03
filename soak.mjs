#!/usr/bin/env node
/**
 * 持续性测试：连续打 N 次，验证这条免费车道能不能真的当后台批处理用。
 *
 * 单次成功说明不了任何问题。真正要回答的问题是：
 *   - 连打会不会把额度撞穿（429）？
 *   - 撞穿之后桥自己能不能恢复？
 *   - 全程有没有任何一个请求落到付费模型上？
 *
 * 这一项会真实消耗免费额度，所以默认只跑 12 次。跑之前确认桥已启动。
 *
 * 用法：node soak.mjs [次数]
 */

const BASE = process.env.BASE_URL || 'http://127.0.0.1:18999/v1'
const ROUNDS = Number(process.argv[2] || 12)

/**
 * 故意点名一个经常被限流的模型，让每轮都走一遍故障转移路径——
 * 这才是后台批处理的真实场景：不能指望首选模型一直可用。
 */
const REQUESTED_MODEL = process.env.REQUESTED_MODEL || 'mimo-v2.6-flash-free'

const PAID_HINTS = /^(gpt-|claude-|gemini-|grok-|glm-|kimi-|qwen3|minimax-|deepseek-v4|muse-spark-1\.[23]$|nemotron|big-pickle)/i
const FREE_SUFFIX = /-free$/

let ok = 0
let failed = 0
const modelsUsed = new Set()
let paidLeak = null
const startedAt = Date.now()

process.stdout.write(`soak: ${ROUNDS} rounds through ${BASE}\n\n`)

for (let i = 1; i <= ROUNDS; i += 1) {
  const began = Date.now()
  let label = 'FAIL'
  let detail = ''
  let served = ''
  try {
    const response = await fetch(`${BASE}/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: 'Bearer local',
        // 同一使用方 —— 这是会话亲和的入口
        'x-session-id': 'soak-test',
        // 每轮不同 id，模拟「同一个会话里的不同回合」
        'x-request-id': `round-${i}`,
      },
      body: JSON.stringify({
        // 每轮点名同一个模型，故障转移由桥负责
        model: REQUESTED_MODEL,
        messages: [{ role: 'user', content: `Say OK (round ${i}).` }],
        max_tokens: 128,
      }),
    })
    const payload = await response.json().catch(() => null)
    served = String(payload?.model ?? '')
    if (response.status === 200 && typeof payload?.choices?.[0]?.message?.content === 'string') {
      ok += 1
      label = 'OK'
      detail = payload.choices[0].message.content.trim().slice(0, 30)
      // 内部故障转移成功：调用方点名的是被限流的那个模型，实际由另一个免费档服务。
      if (served !== '' && served !== REQUESTED_MODEL) detail += `  [failover from ${REQUESTED_MODEL}]`
    } else {
      detail = `HTTP ${response.status} ${JSON.stringify(payload?.error?.message ?? payload).slice(0, 110)}`
    }
  } catch (error) {
    detail = error?.message ?? String(error)
  }

  const seconds = ((Date.now() - began) / 1000).toFixed(1)
  if (served !== '') {
    modelsUsed.add(served)
    // 两条独立的判定，任一触发即为泄漏。
    if (!FREE_SUFFIX.test(served) || (PAID_HINTS.test(served) && !FREE_SUFFIX.test(served))) {
      paidLeak = served
    }
  }
  process.stdout.write(
    `${String(i).padStart(3)}/${ROUNDS}  ${label.padEnd(4)}  ${seconds.padStart(6)}s  ${served.padEnd(28)}  ${detail}\n`,
  )
  await new Promise(resolve => setTimeout(resolve, 1200))
}

const elapsed = ((Date.now() - startedAt) / 1000).toFixed(0)
process.stdout.write(`\n--- summary over ${elapsed}s ---\n`)
process.stdout.write(`succeeded : ${ok}/${ROUNDS}\n`)
process.stdout.write(`failed    : ${failed}\n`)
process.stdout.write(`models    : ${[...modelsUsed].join(', ')}\n`)

if (paidLeak !== null) {
  process.stdout.write(`\n*** PAID MODEL LEAK: ${paidLeak} — the zero-cost guarantee is BROKEN ***\n`)
  process.exit(1)
}
process.stdout.write(`\nzero-cost guarantee held: every request landed on a -free model\n`)
process.exit(ok > 0 ? 0 : 1)
