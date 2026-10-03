#!/usr/bin/env node
/**
 * 探路：找**第二条真正可直连的免费车道**。
 *
 * ## 为什么要找第二条
 *
 * 上一轮实测确认，免密车道 13 个 `-free` 模型里只有 1 个能第三方直连调用。
 * 多车道故障转移虽然已经实现并用假上游验证过，但**假上游不能证明真实存在第二条车道**。
 * 没有第二条真车道，多车道就只是「机制齐备、弹药为零」。
 *
 * ## 这轮探的几条线
 *
 *   1. `/zen/go/v1` —— Hindsight 配置文档里出现过这个 base_url
 *      （`HINDSIGHT_API_LLM_PROVIDER=opencode-go`），是同一网关的另一条路径。
 *   2. `/zen/go/chat/completions` —— 少一层 v1 的猜测路径。
 *   3. 顺带确认主路径此刻是否仍然可用（前面几轮把它限流过好几次）。
 *
 * 用法：node scripts/discover-second-lane.mjs
 */

const HOST = process.env.UPSTREAM_BASE || 'https://opencode.ai'
const SESSION = 'ses_0000000000000000000000'

const PATHS = [
  '/zen/v1/chat/completions',
  '/zen/go/v1/chat/completions',
  '/zen/go/chat/completions',
  '/go/v1/chat/completions',
  '/zen/v1/models',
]

function headers() {
  return {
    'content-type': 'application/json',
    authorization: 'Bearer public',
    'user-agent': 'opencode/1.18.31',
    'x-opencode-client': 'desktop',
    'x-opencode-session': SESSION,
    'x-opencode-request': `msg_000000000000000000000${Math.floor(Math.random() * 10)}`,
    'x-opencode-project': 'global',
  }
}

async function probe(path) {
  const url = `${HOST}${path}`
  const isModels = path.endsWith('/models')
  const body = isModels
    ? undefined
    : JSON.stringify({
      model: 'space-bunny-free',
      messages: [{ role: 'user', content: 'Reply with exactly: OK' }],
      max_tokens: 256,
    })
  const method = isModels ? 'GET' : 'POST'
  try {
    const response = await fetch(url, {
      method,
      headers: headers(),
      body,
      signal: AbortSignal.timeout(60_000),
    })
    const text = await response.text().catch(() => '')
    if (response.ok) {
      let detail = ''
      try {
        const json = JSON.parse(text)
        detail = isModels
          ? `${(json.data ?? []).length} models`
          : `content=${JSON.stringify(json?.choices?.[0]?.message?.content ?? '').slice(0, 40)}`
      } catch {
        detail = text.slice(0, 60)
      }
      return { status: response.status, verdict: 'OK', detail }
    }
    return { status: response.status, verdict: 'FAIL', detail: text.replace(/\s+/g, ' ').slice(0, 140) }
  } catch (error) {
    return { status: 0, verdict: 'THREW', detail: error?.message ?? String(error) }
  }
}

process.stdout.write(`\nupstream: ${HOST}\n\n`)
const results = []
for (const path of PATHS) {
  const r = await probe(path)
  results.push({ path, ...r })
  process.stdout.write(`${path.padEnd(32)} ${String(r.status).padStart(4)}  ${r.verdict.padEnd(6)} ${r.detail}\n`)
  await new Promise(res => setTimeout(res, 800))
}

process.stdout.write('\n=== 判定 ===\n')
const live = results.filter(r => r.verdict === 'OK' && r.path.endsWith('chat/completions'))
if (live.length === 0) {
  process.stdout.write('没有任何补全路径此刻可用。\n')
  process.stdout.write('可能是主车道被限流（稍后重试），或 /zen/go 需要授权 key。\n')
} else if (live.length === 1) {
  process.stdout.write(`唯一可用：${live[0].path}\n`)
  process.stdout.write('→ 没有发现第二条独立车道。多车道机制齐备，但目前只有一条弹药。\n')
} else {
  process.stdout.write(`发现 ${live.length} 条可用补全路径：\n`)
  for (const l of live) process.stdout.write(`  - ${l.path}\n`)
  process.stdout.write('→ /zen/go 与 /zen/v1 若凭据与限额各自独立，就是可以当第二条车道的候选。\n')
  process.stdout.write('  下一步：给 /zen/go 那条单独换一个 x-opencode-session，确认它的限流池与 /zen/v1 分离。\n')
}
process.stdout.write('')
