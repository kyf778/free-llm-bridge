#!/usr/bin/env node
/**
 * 实测：免费车道到底有多少个模型是**真正**能用的。
 *
 * ## 为什么要重做这个表
 *
 * 之前的报告写了「11 个 `-free` 模型可用」，那是**错的**——错的来源是插件
 * （Our Free Model）的可用性探测，它是在 DSH 进程里跑的，而 DSH 插件的身份
 * 可能让上游把它当成「来自 OpenCode 内部」。
 *
 * 直连上游重测的结果完全不同：大部分 `-free` 模型返回
 * `403 FreeTierError: OpenCode's free tier can only be used from within OpenCode`。
 * 只有 `space-bunny-free` 直连可用（它似乎由上游无条件放行）。
 *
 * 也就是说：我这轮验证的其实是**一个模型**，不是十一个。这个差别必须写进报告。
 *
 * 用法：node scripts/probe-free-models.mjs [bridgeUrl]
 */

const UPSTREAM = process.env.UPSTREAM_BASE || 'https://opencode.ai'
const SESSION = 'ses_0000000000000000000000'
const REQUEST = 'msg_0000000000000000000000'

const FINGERPRINT_TOOLS = ['bash', 'glob', 'grep', 'read']

function headers() {
  return {
    'content-type': 'application/json',
    authorization: 'Bearer public',
    'user-agent': 'opencode/1.18.31',
    'x-opencode-client': 'desktop',
    'x-opencode-session': SESSION,
    'x-opencode-request': REQUEST,
    'x-opencode-project': 'global',
  }
}

function tools() {
  return FINGERPRINT_TOOLS.map(name => ({
    type: 'function',
    function: { name, description: 'unavailable', parameters: { type: 'object', properties: {} } },
  }))
}

async function probe(model) {
  const body = {
    model,
    messages: [{ role: 'user', content: 'Reply with exactly: OK' }],
    max_tokens: 256,
    tools: tools(),
  }
  try {
    const response = await fetch(`${UPSTREAM}/zen/v1/chat/completions`, {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(60_000),
    })
    if (response.status === 200) {
      const payload = await response.json().catch(() => null)
      const text = payload?.choices?.[0]?.message?.content ?? ''
      return { state: 'available', note: JSON.stringify(text).slice(0, 50) }
    }
    const detail = await response.text().catch(() => '')
    if (response.status === 429) return { state: 'throttled', note: detail.slice(0, 60) }
    if (response.status === 403 && /only be used from within OpenCode/i.test(detail)) {
      return { state: 'opencode-only', note: '403: free tier restricted to OpenCode' }
    }
    if (response.status === 403 && /[Rr]egion/i.test(detail)) return { state: 'region-blocked', note: detail.slice(0, 60) }
    return { state: `http-${response.status}`, note: detail.slice(0, 80) }
  } catch (error) {
    return { state: 'error', note: error?.message ?? String(error) }
  }
}

const listResponse = await fetch(`${UPSTREAM}/zen/v1/models`, { headers: headers(), signal: AbortSignal.timeout(30_000) })
const all = listResponse.ok ? await listResponse.json().catch(() => ({ data: [] })) : { data: [] }
const free = (all.data ?? []).map(m => m.id).filter(id => id.endsWith('-free'))

process.stdout.write(`\nupstream: ${UPSTREAM}`)
process.stdout.write(`total models: ${(all.data ?? []).length}   -free models: ${free.length}\n`)
process.stdout.write(`\n逐个直连实测（每次一问「Reply with exactly: OK」）\n\n`)

const verdicts = new Map()
for (const model of free) {
  const began = Date.now()
  const verdict = await probe(model)
  verdicts.set(model, verdict)
  const seconds = ((Date.now() - began) / 1000).toFixed(1)
  process.stdout.write(`${model.padEnd(30)} ${verdict.state.padEnd(16)} ${seconds.padStart(6)}s  ${verdict.note}\n`)
  await new Promise(r => setTimeout(r, 700))
}

const tally = new Map()
for (const v of verdicts.values()) tally.set(v.state, (tally.get(v.state) ?? 0) + 1)
process.stdout.write(`\n=== 汇总 ===\n`)
for (const [state, count] of [...tally].sort((a, b) => b[1] - a[1])) {
  process.stdout.write(`${state.padEnd(20)} ${count}\n`)
}

const trulyUsable = [...verdicts].filter(([, v]) => v.state === 'available').map(([m]) => m)
process.stdout.write(`\n真正可用的模型: ${trulyUsable.length > 0 ? trulyUsable.join(', ') : '（无）'}\n`)
if (trulyUsable.length < free.length) {
  process.stdout.write(`\n注意：只有 ${trulyUsable.length}/${free.length} 个能直连使用。\n`)
  process.stdout.write(`桥的故障转移在这些模型上没有意义——它们会统一回 403。\n`)
}
