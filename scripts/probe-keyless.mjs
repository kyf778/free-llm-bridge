#!/usr/bin/env node
/**
 * 摸清「哪些免费层是真免密、哪些只是有免费额度」。
 *
 * ## 这轮要回答的问题
 *
 * 上一轮确认：OpenCode 免密车道只有 1 个模型能用，多车道机制齐备但**没有第二条弹药**。
 * 那么除了它之外，还有没有别家是**真正免密**的（连 key 都不用）？
 *
 * ## 为什么关心这个
 *
 * 「有免费额度」和「免密」是两件不同的事：
 *
 *   - **有免费额度**：注册拿 key，用到额度为止（OpenRouter 50 RPD、Gemini 免费层、
 *     智谱 GLM-4-Flash……）。对自托管的记忆系统来说，**这就够了**——注册一次，
 *     额度用完再等，账单永远是 0。
 *   - **免密**：连 key 都不用。目前只确认 OpenCode 一家。
 *
 * 所以这个脚本探测的意义是：确认「除了 OpenCode 之外，没有第二家免密」，
 * 从而把「第二条车道必须自己注册 key」这件事说清楚，而不是让用户以为还有别的白嫖方式。
 *
 * 用法：node scripts/probe-keyless.mjs
 */

const TARGETS = [
  // 免密车道本体必须用它自己的模型名去探：拿别家模型名去问，它会回 401 且 body 是
  // 「ModelError: xxx is not supported」——那**不是**鉴权失败，只是模型不存在。
  // 第一版探测器把这条误判成「需要 key」，结论差点写反，所以这里把它单列并用对模型名。
  { name: 'OpenCode Zen（免密车道本体）', url: 'https://opencode.ai/zen/v1/chat/completions', model: 'space-bunny-free', noAuth: true },
  { name: 'OpenCode /zen/go', url: 'https://opencode.ai/zen/go/v1/chat/completions', model: 'space-bunny-free', noAuth: true },
  { name: '智谱 GLM-4-Flash', url: 'https://open.bigmodel.cn/api/paas/v4/chat/completions', model: 'glm-4-flash-250414' },
  { name: 'OpenRouter', url: 'https://openrouter.ai/api/v1/chat/completions', model: 'x-ai/grok-2-1315:free' },
  { name: 'SiliconFlow', url: 'https://api.siliconflow.cn/v1/chat/completions', model: 'Qwen/Qwen2.5-7B-Instruct' },
  { name: 'Moonshot / Kimi', url: 'https://api.moonshot.cn/v1/chat/completions', model: 'moonshot-v1-8k' },
  { name: 'Cerebras', url: 'https://api.cerebras.ai/v1/chat/completions', model: 'llama-3.3-70b' },
  { name: 'Groq', url: 'https://api.groq.com/openai/v1/chat/completions', model: 'llama-3.3-70b-versatile' },
  { name: 'NVIDIA NIM', url: 'https://integrate.api.nvidia.com/v1/chat/completions', model: 'meta/llama-3.1-8b-instruct' },
  { name: 'HF Router', url: 'https://router.huggingface.co/v1/chat/completions', model: 'meta-llama/Llama-3.1-8B-Instruct' },
  { name: 'Cloudflare Workers AI', url: 'https://api.cloudflare.com/client/v4/accounts/probe/ai/run/probe', model: '@cf/meta/llama-3.1-8b-instruct' },
]

/** 只发一个最小请求，看它认不认「没有 key」这件事。 */
async function probe(target) {
  const started = Date.now()
  try {
    const response = await fetch(target.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: target.model,
        messages: [{ role: 'user', content: 'hi' }],
        max_tokens: 16,
      }),
      signal: AbortSignal.timeout(30_000),
    })
    const text = await response.text().catch(() => '')
    const seconds = ((Date.now() - started) / 1000).toFixed(1)
    const flat = text.replace(/\s+/g, ' ').slice(0, 110)
    let verdict
    // 「模型不被支持」与「需要 key」是两件不同的事，判错会让结论整条反掉。
    if (/is not supported|model_not_found|not routed/i.test(flat)) {
      verdict = '模型不对（不是鉴权）'
    } else if (response.status === 401 || /missing api key|api key required|unauthorized|authorization|invalid|incorrect api key|token is/i.test(flat)) {
      verdict = '需要 key'
    } else if (response.status === 403) {
      verdict = '需要凭据/403'
    } else if (response.status === 404) {
      verdict = '端点不存在'
    } else if (response.status === 200) {
      verdict = '✅ 未鉴权即通过'
    } else {
      verdict = `HTTP ${response.status}`
    }
    return { ...target, status: response.status, verdict, detail: flat, seconds }
  } catch (error) {
    return { ...target, status: 0, verdict: '网络不可达', detail: error?.message ?? String(error), seconds: '0' }
  }
}

process.stdout.write('\n探测各家的未鉴权行为（找一个「真免密」的入口）\n\n')
const rows = []
for (const target of TARGETS) {
  const r = await probe(target)
  rows.push(r)
  process.stdout.write(`${r.name.padEnd(28)} ${String(r.status).padStart(4)}  ${r.verdict.padEnd(14)} ${r.detail}\n`)
  await new Promise(res => setTimeout(res, 400))
}

process.stdout.write('\n=== 结论 ===\n')
const keyless = rows.filter(r => r.status === 200)
const needsKey = rows.filter(r => r.verdict.startsWith('需要'))
process.stdout.write(`真免密（未带 key 就通）：${keyless.length > 0 ? keyless.map(r => r.name).join(', ') : '无'}\n`)
process.stdout.write(`需要自己注册 key：${needsKey.length} 家\n`)
process.stdout.write('\n')
process.stdout.write('所以「第二条车道」的现实形态是**自己注册一个免费 key**，而不是继续找免密白嫖：\n')
process.stdout.write('  - 智谱 GLM-4-Flash-250414：官方页明写免费，国内直连，不需要绑卡\n')
process.stdout.write('  - OpenRouter :free：注册即用，50 请求/天（充值后 1000）\n')
process.stdout.write('两条都足以让「Hindsight 每轮对话自动跑 4 个 LLM 环节」这类负载长期停在零成本。\n')
process.stdout.write('详见 README 的「多车道」一节。\n')
